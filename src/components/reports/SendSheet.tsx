import { useId, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexAction } from '@convex-dev/react-query'
import { Check, CircleAlert, Plus, Send, ShieldAlert } from 'lucide-react'
import { Sheet } from '#/components/primitives/Sheet'
import { api } from '../../../convex/_generated/api'
import {
  emailDomain,
  emailProblem,
  emailTypoFix,
} from '../../../convex/lib/email'
import { FieldMessage } from '#/components/forms/FieldMessage'
import { describedBy, fieldMessageId } from '#/components/forms/FormField'
import { domainsWithoutMail, noMailMessage } from './fields/staticBlocks'
import { deliveryRecipients } from '#/lib/reportTemplates/delivery'
import type { ReportTemplate } from '#/lib/reportTemplates'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * Sending a finished report to the people it is for.
 *
 * What this replaces was one empty email box. A technician who had just
 * finished a form that asks, in writing, whether to send a copy to the client
 * then had to remember the client's address and type it, on a phone, in a
 * driveway — and if they typed it wrong the document went nowhere and nothing
 * said so.
 *
 * So the addresses the form already asked for are offered as chips, already
 * chosen. Anyone else is one tap and a typed address away, and the sheet says
 * plainly — before Send, not after — when that address is one only an owner
 * can approve.
 */

type Recipient = {
  address: string
  chosen: boolean
  known: boolean
  /** Why it can never be delivered to (convex/lib/email.ts), or null. */
  problem: string | null
  /** The address most likely meant, for the one-tap fix. */
  fix: string | null
}

export const SEND_ERROR: Record<string, string> = {
  // An address on file from before addresses were checked ("bob@gmail"):
  // the server refuses it, and saying only "could not send" hid why.
  INVALID_EMAIL: 'That address can’t receive email. Check it for a typo.',
  EMAIL_NOT_CONFIGURED: 'Email sending isn’t set up for this business yet.',
  RECIPIENT_NEEDS_APPROVAL:
    'Sent to the owner to approve — it will go once they say yes.',
  REPORT_NOT_FINALISED: 'This report isn’t finalised yet.',
  PDF_UNAVAILABLE: 'Could not prepare the PDF to attach.',
  EMAIL_SEND_FAILED: 'The email failed to send. The history below says why.',
  SEND_RATE_LIMITED:
    'That is a lot of reports in an hour. Try again shortly, or ask an owner.',
  NO_RECIPIENT: 'Choose at least one person to send it to.',
}

/**
 * The code a failed send came back with, or 'UNKNOWN'. A ConvexError carries
 * it as `data`; by the time it reaches here it may only be in the message.
 */
export function sendErrorCode(error: unknown): string {
  const data = (error as { data?: unknown } | null)?.data
  if (typeof data === 'string' && Object.hasOwn(SEND_ERROR, data)) return data
  const message = error instanceof Error ? error.message : String(error)
  return (
    Object.keys(SEND_ERROR).find((code) => message.includes(code)) ?? 'UNKNOWN'
  )
}

/**
 * Who the form asked for, plus anyone this report has already gone to.
 * Chosen by default only where the form asked: a second copy to someone who
 * already has one is a decision, not a default.
 *
 * An address that can never be delivered to is never chosen by default. One
 * saved before addresses were checked ("bob@gmail") still reaches here from
 * the client's record, and chosen it read "Needs approval", then failed at
 * the server with no reason given. It shows as "Can’t be delivered", with
 * the address most likely meant one tap away.
 */
export function suggestedRecipients(
  asked: ReadonlyArray<string>,
  before: ReadonlyArray<string>,
  knownAddresses: ReadonlyArray<string>,
): Array<Recipient> {
  const seen = new Set<string>()
  const out: Array<Recipient> = []
  for (const address of [...asked, ...before]) {
    if (seen.has(address)) continue
    seen.add(address)
    const problem = emailProblem(address)
    out.push({
      address,
      chosen: problem === null && asked.includes(address),
      known: knownAddresses.includes(address),
      problem,
      fix: problem === null ? null : emailTypoFix(address),
    })
  }
  return out
}

export function SendSheet({
  open,
  onClose,
  businessId,
  reportId,
  template,
  data,
  clientEmail,
  subject,
}: {
  open: boolean
  onClose: () => void
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
  /** The wording this report was signed against. */
  template: ReportTemplate
  data: Record<string, unknown>
  clientEmail?: string
  /** What the email will say it is — the document's own name. */
  subject: string
}) {
  const { data: known } = useQuery(
    convexQuery(api.deliveries.known, { businessId, reportId }),
  )
  const { data: history } = useQuery(
    convexQuery(api.deliveries.forReport, { businessId, reportId }),
  )

  // `undefined` means "not yet", which is not the same as "nobody is on
  // file" — and the difference matters, because the second one puts a "Needs
  // approval" warning against the client's own address. The same mistake the
  // finalise sheet made about signatures.
  const settled = known !== undefined
  const knownAddresses = known?.addresses ?? []
  const unrestricted = known?.unrestricted ?? false

  const suggested = useMemo(
    () =>
      suggestedRecipients(
        deliveryRecipients(template, data, { clientEmail }).to,
        (history ?? []).flatMap((row) => row.to),
        knownAddresses,
      ),
    [template, data, clientEmail, history, knownAddresses],
  )

  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  const [added, setAdded] = useState<Array<string>>([])
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)
  // What is wrong with the typed address shows once the field is left or Add
  // pressed, not while it is still going in. `typoAsked` is the address a
  // "Did you mean" was shown for: pressing Add again adds it as typed.
  const [draftShown, setDraftShown] = useState(false)
  const [typoAsked, setTypoAsked] = useState<string | null>(null)
  // Domains DNS has said take no mail (src/lib/emailDomainCheck.ts), asked as
  // a typed address is left or added. A warning only: it may still be sent.
  const [noMail, setNoMail] = useState<ReadonlyArray<string>>([])
  const draftRef = useRef<HTMLInputElement>(null)
  const draftId = useId()

  const recipients: Array<Recipient> = [
    ...suggested.map((entry) => ({
      ...entry,
      // One that can never arrive cannot be chosen at all.
      chosen:
        entry.problem === null && (overrides[entry.address] ?? entry.chosen),
    })),
    ...added.map((address) => ({
      address,
      chosen: overrides[address] ?? true,
      known: knownAddresses.includes(address),
      problem: null,
      fix: null,
    })),
  ]
  const chosen = recipients.filter((entry) => entry.chosen)
  const needsApproval =
    settled && !unrestricted && chosen.some((entry) => !entry.known)

  const convexSend = useConvexAction(api.email.sendReportPdf)

  /**
   * One send per recipient, and one outcome per recipient.
   *
   * They genuinely can differ — a client's own address goes while a strata
   * office's waits for the owner — so a single pass/fail for the whole tap
   * would report one of them wrongly. Nothing throws: the summary below says
   * what happened to each.
   */
  const send = useMutation({
    mutationFn: async (addresses: Array<string>) => {
      const results: Array<{ address: string; code: string | null }> = []
      for (const address of addresses) {
        try {
          await convexSend({ businessId, reportId, to: address })
          results.push({ address, code: null })
        } catch (error) {
          results.push({ address, code: sendErrorCode(error) })
        }
      }
      return results
    },
  })

  const outcomes = send.data ?? []
  const sent = outcomes.filter((result) => result.code === null)
  const held = outcomes.filter(
    (result) => result.code === 'RECIPIENT_NEEDS_APPROVAL',
  )
  const failed = outcomes.filter(
    (result) =>
      result.code !== null && result.code !== 'RECIPIENT_NEEDS_APPROVAL',
  )

  const typed = draft.trim().toLowerCase()
  const draftProblem = typed === '' ? null : emailProblem(typed)
  // Offered with the error too: "bob@gmail" is refused, and bob@gmail.com is
  // almost certainly what was meant.
  const draftFix = typed === '' ? null : emailTypoFix(typed)
  const showDraftProblem = draftShown && draftProblem !== null
  const showDraftTypo = draftShown && draftProblem === null && draftFix !== null
  const draftDomain = draftProblem === null ? emailDomain(typed) : null
  const showDraftNoMail =
    draftFix === null && draftDomain !== null && noMail.includes(draftDomain)
  const draftErrorId = fieldMessageId(draftId, 'error')
  const draftWarningId = fieldMessageId(draftId, 'warning')

  /** Asks DNS about these addresses' domains, and remembers the ones that
   * take no mail. Only ever added to: the answer is about the domain. */
  function askDomains(addresses: ReadonlyArray<string>) {
    void domainsWithoutMail(addresses).then((found) => {
      if (found.length === 0) return
      setNoMail((prev) => [...new Set([...prev, ...found])])
    })
  }

  /** The domain of `address`, when DNS has said it takes no mail. */
  function chipNoMail(address: string): string | null {
    const domain = emailDomain(address)
    return domain !== null && noMail.includes(domain) ? domain : null
  }

  /** "Use bob@gmail.com" on an address that can't be delivered: the one
   * meant is chosen in its place, and the bad one stays, unchosen, so it is
   * plain what is on file. */
  function takeChipFix(fix: string) {
    if (!recipients.some((entry) => entry.address === fix)) {
      setAdded((prev) => [...prev, fix])
    }
    setOverrides((prev) => ({ ...prev, [fix]: true }))
    askDomains([fix])
  }

  function takeDraftFix(fix: string) {
    setDraft(fix)
    setDraftShown(false)
    setTypoAsked(null)
    draftRef.current?.focus()
  }

  /**
   * An address that can never be delivered to stays in the box with the
   * reason under it. This used to drop anything without an @ without a word,
   * and let "bob@gmail" through to a send that could not arrive. A near miss
   * of a common provider asks once, and so does a domain DNS has already said
   * takes no mail; the second Add takes it as typed. An answer that comes
   * after Add shows under the address's chip instead.
   */
  function addTyped() {
    if (typed === '') return
    if (draftProblem !== null) {
      setDraftShown(true)
      draftRef.current?.focus()
      return
    }
    if ((draftFix !== null || showDraftNoMail) && typoAsked !== typed) {
      setTypoAsked(typed)
      setDraftShown(true)
      return
    }
    askDomains([typed])
    if (recipients.some((entry) => entry.address === typed)) {
      setOverrides((prev) => ({ ...prev, [typed]: true }))
    } else {
      setAdded((prev) => [...prev, typed])
    }
    setDraft('')
    setDraftShown(false)
    setTypoAsked(null)
    setAdding(false)
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Send this report"
      description={subject}
      footer={
        <button
          type="button"
          disabled={chosen.length === 0 || send.isPending || !settled}
          onClick={() => send.mutate(chosen.map((entry) => entry.address))}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-ink text-[17px] font-semibold text-surface transition active:scale-[.975] disabled:opacity-50"
        >
          <Send size={16} strokeWidth={2} />
          {send.isPending
            ? 'Sending…'
            : needsApproval
              ? 'Request approval'
              : `Send to ${chosen.length === 1 ? '1 person' : `${chosen.length} people`}`}
        </button>
      }
    >
      {recipients.length === 0 && !adding && (
        <p className="text-body text-muted">
          This form did not ask for a copy to go anywhere. Add an address below
          and it will go there.
        </p>
      )}

      <ul className="flex flex-col gap-1.5">
        {recipients.map((entry, index) => {
          const noMailDomain = chipNoMail(entry.address)
          const noMailId = fieldMessageId(`${draftId}-chip-${index}`, 'warning')
          return (
            <li key={entry.address}>
              {entry.problem !== null ? (
                <UndeliverableChip
                  entry={entry}
                  fixChosen={recipients.some(
                    (other) => other.address === entry.fix && other.chosen,
                  )}
                  onFix={takeChipFix}
                />
              ) : (
                <>
                  <button
                    type="button"
                    aria-pressed={entry.chosen}
                    aria-describedby={noMailDomain ? noMailId : undefined}
                    onClick={() =>
                      setOverrides((prev) => ({
                        ...prev,
                        [entry.address]: !entry.chosen,
                      }))
                    }
                    className={`flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition ${
                      entry.chosen
                        ? 'border-ink/15 bg-surface'
                        : 'border-hairline bg-surface-2 opacity-60'
                    }`}
                  >
                    <span
                      className={`flex size-5 shrink-0 items-center justify-center rounded-md ${
                        entry.chosen ? 'bg-ink text-surface' : 'bg-surface-3'
                      }`}
                    >
                      {entry.chosen && <Check size={13} strokeWidth={3} />}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-body text-ink">
                      {entry.address}
                    </span>
                    {/* Said before Send, not after: a technician should know
                        their request is going to the owner before they make
                        it. */}
                    {settled &&
                      entry.chosen &&
                      !entry.known &&
                      !unrestricted && (
                        <span className="flex shrink-0 items-center gap-1 text-caption text-amber-ink">
                          <ShieldAlert size={13} strokeWidth={2} />
                          Needs approval
                        </span>
                      )}
                  </button>
                  {noMailDomain && (
                    <FieldMessage id={noMailId} tone="warning">
                      {noMailMessage(noMailDomain)}
                    </FieldMessage>
                  )}
                </>
              )}
            </li>
          )
        })}
      </ul>

      {adding ? (
        <div className="mt-2">
          <div className="flex gap-2">
            <input
              ref={draftRef}
              id={draftId}
              autoFocus
              type="email"
              inputMode="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={draft}
              onChange={(event) => {
                const next = event.target.value.trim().toLowerCase()
                // Put right (or cleared), it goes quiet until next left.
                if (
                  next === '' ||
                  (emailProblem(next) === null && emailTypoFix(next) === null)
                ) {
                  setDraftShown(false)
                }
                setDraft(event.target.value)
              }}
              onBlur={() => {
                setDraftShown(draftProblem !== null || draftFix !== null)
                // Ask now, so Add has the answer waiting. Only the domain goes.
                if (
                  draftProblem === null &&
                  draftFix === null &&
                  typed !== ''
                ) {
                  askDomains([typed])
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  addTyped()
                }
              }}
              aria-label="Email address"
              aria-invalid={showDraftProblem || undefined}
              aria-describedby={describedBy(
                showDraftProblem && draftErrorId,
                (showDraftTypo || showDraftNoMail) && draftWarningId,
              )}
              placeholder="name@example.com"
              className={`h-11 min-w-0 flex-1 rounded-xl bg-surface-3 px-3 text-[16px] text-ink outline-none ${showDraftProblem ? 'ring-2 ring-red' : 'focus:ring-2 focus:ring-blue'}`}
            />
            <button
              type="button"
              onClick={addTyped}
              className="shrink-0 rounded-xl bg-surface-2 px-3.5 text-[15px] font-semibold text-ink"
            >
              {typoAsked === typed ? 'Add anyway' : 'Add'}
            </button>
          </div>
          {showDraftProblem && (
            <FieldMessage
              id={draftErrorId}
              tone="error"
              fix={
                draftFix
                  ? {
                      label: `Use ${draftFix}`,
                      onApply: () => takeDraftFix(draftFix),
                    }
                  : undefined
              }
            >
              {draftProblem}
            </FieldMessage>
          )}
          {showDraftTypo && (
            <FieldMessage
              id={draftWarningId}
              tone="warning"
              fix={{ label: 'Use it', onApply: () => takeDraftFix(draftFix) }}
            >
              Did you mean {draftFix}?
            </FieldMessage>
          )}
          {showDraftNoMail && (
            <FieldMessage id={draftWarningId} tone="warning">
              {noMailMessage(draftDomain)}
            </FieldMessage>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mt-2 flex items-center gap-1.5 rounded-xl px-1 py-2 text-body font-semibold text-ink"
        >
          <Plus size={15} strokeWidth={2.2} />
          Send to someone else
        </button>
      )}

      {outcomes.length > 0 && (
        <div role="status" className="mt-3 flex flex-col gap-1.5">
          {sent.length > 0 && (
            <p className="rounded-xl border border-hairline bg-surface-2 px-3 py-2 text-caption text-ink-2">
              Sent to {sent.map((result) => result.address).join(', ')}.
            </p>
          )}
          {held.length > 0 && (
            <p className="rounded-xl border border-hairline bg-surface-2 px-3 py-2 text-caption text-ink-2">
              {SEND_ERROR.RECIPIENT_NEEDS_APPROVAL}{' '}
              {held.map((result) => result.address).join(', ')}
            </p>
          )}
          {failed.map((result) => (
            <p
              key={result.address}
              className="rounded-xl border border-amber-line bg-amber-bg px-3 py-2 text-caption text-amber-ink"
            >
              {result.address} —{' '}
              {(result.code && SEND_ERROR[result.code]) ??
                'Could not send the email.'}
            </p>
          ))}
        </div>
      )}
    </Sheet>
  )
}

/**
 * An address on file that can never be delivered to, shown as it is — not a
 * choice, since the server refuses it — with the address most likely meant
 * one tap away.
 */
function UndeliverableChip({
  entry,
  fixChosen,
  onFix,
}: {
  entry: Recipient
  /** The fix is already on the list and chosen, so it is not offered again. */
  fixChosen: boolean
  onFix: (fix: string) => void
}) {
  const fix = entry.fix
  // Not a button: there is nothing to choose. The line under it is read
  // straight after, in order.
  return (
    <>
      <div className="flex w-full items-center gap-2.5 rounded-xl border border-hairline bg-surface-2 px-3 py-2.5">
        <span aria-hidden className="size-5 shrink-0 rounded-md bg-surface-3" />
        <span className="min-w-0 flex-1 truncate text-body text-ink">
          {entry.address}
        </span>
        <span className="flex shrink-0 items-center gap-1 text-caption text-red-ink">
          <CircleAlert size={13} strokeWidth={2} />
          Can’t be delivered
        </span>
      </div>
      <FieldMessage
        tone="warning"
        fix={
          fix && !fixChosen
            ? { label: `Use ${fix}`, onApply: () => onFix(fix) }
            : undefined
        }
      >
        {entry.problem}
      </FieldMessage>
    </>
  )
}

/**
 * Every attempt to send this report, and how each one went.
 *
 * Read from the delivery rows rather than the audit log: a row exists from the
 * moment someone asks, so a send that is waiting on an owner or that died
 * mid-flight appears here too, rather than only the ones that finished.
 */
export function DeliveryHistory({
  businessId,
  reportId,
}: {
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
}) {
  const { data: rows } = useQuery(
    convexQuery(api.deliveries.forReport, { businessId, reportId }),
  )

  // Loading is not the same as nothing: "Not sent yet." under a report the
  // form already opened a delivery for is a lie, and one a technician would
  // act on by sending it again.
  if (rows === undefined) {
    return <p className="text-caption text-muted">Loading…</p>
  }
  if (rows.length === 0) {
    return <p className="text-caption text-muted">Not sent yet.</p>
  }

  return (
    <ul className="divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation">
      {rows.map((row) => (
        <li key={row._id} className="px-3.5 py-3">
          <p className="text-body text-ink">
            {STATUS_LABEL[row.status]} — {row.to.join(', ')}
          </p>
          <p className="text-caption text-muted">
            {row.sentBy?.name ? `${row.sentBy.name} · ` : ''}
            {new Intl.DateTimeFormat('en-AU', {
              dateStyle: 'medium',
              timeStyle: 'short',
            }).format(new Date(row.sentAt ?? row.createdAt))}
            {row.trigger === 'finalise' ? ' · asked for by the form' : ''}
          </p>
          {row.status === 'pendingApproval' && row.approvedBy === null && (
            <p className="mt-1 text-caption text-amber-ink">
              Waiting for an owner to approve this address.
            </p>
          )}
          {row.waitingForEmailSetup && (
            <p className="mt-1 text-caption text-amber-ink">
              Not sent: email isn’t set up for this business yet. Download or
              share the PDF instead.
            </p>
          )}
          {row.error && (
            <p className="mt-1 text-caption text-amber-ink">{row.error}</p>
          )}
        </li>
      ))}
    </ul>
  )
}

const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  pendingApproval: 'Waiting for approval',
  sent: 'Sent',
  failed: 'Failed',
  bounced: 'Bounced',
}

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexAction } from '@convex-dev/react-query'
import {
  Check,
  ChevronRight,
  CircleAlert,
  LoaderCircle,
  Plus,
  Send,
  ShieldAlert,
  TriangleAlert,
} from 'lucide-react'
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
import type { Doc, Id } from '../../../convex/_generated/dataModel'
import { NEUTRAL_BUTTON } from '#/components/primitives/buttons'
import { RowPending } from '#/components/shell/Pending'
import { formatWhen } from '#/lib/format'
import { useBusinessTimezone } from '#/lib/useBusinessTimezone'
import { FormAlert } from '#/components/forms/FormAlert'
import { LoadFailed } from '#/components/primitives/EmptyState'
import { TickBox } from './TickBox'
import { useHydrated } from '#/lib/useHydrated'

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
  EMAIL_NOT_CONFIGURED:
    'Email sending isn’t set up for this business yet. Open the PDF and share it from there for now.',
  RECIPIENT_NEEDS_APPROVAL:
    'Sent to the owner to approve — it will go once they say yes.',
  REPORT_NOT_FINALISED:
    'This report isn’t finalised yet. Finalise it, then send it.',
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
  // The business's own blind copy (`lib/recipients.businessCopyAddress`),
  // which every email of this report carries.
  const copy = known?.copy ?? null

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
  // Said wherever it is true: an email to the copy address itself carries no
  // second, hidden one (`blindCopy`).
  const copied = (addresses: ReadonlyArray<string>) =>
    copy !== null && addresses.some((address) => address !== copy)
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
          className={`${NEUTRAL_BUTTON} flex w-full items-center justify-center gap-2`}
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
                    <TickBox on={entry.chosen} />
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
              className="shrink-0 rounded-xl bg-surface-2 px-3.5 text-body font-semibold text-ink"
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

      {copy && copied(chosen.map((entry) => entry.address)) && (
        <p className="mt-3 flex gap-2 rounded-xl border border-hairline bg-surface-2 px-3 py-2.5 text-caption text-ink-2">
          <Send
            size={13}
            strokeWidth={2}
            aria-hidden
            className="mt-0.5 shrink-0"
          />
          <span>
            A copy goes to{' '}
            <span className="break-words font-semibold text-ink">{copy}</span>.
          </span>
        </p>
      )}

      {outcomes.length > 0 && (
        <div role="status" className="mt-3 flex flex-col gap-1.5">
          {sent.length > 0 && (
            <p className="rounded-xl border border-hairline bg-surface-2 px-3 py-2 text-caption text-ink-2">
              Sent to {sent.map((result) => result.address).join(', ')}.
              {copied(sent.map((result) => result.address))
                ? ` A copy went to ${copy}.`
                : ''}
            </p>
          )}
          {held.length > 0 && (
            <p className="rounded-xl border border-hairline bg-surface-2 px-3 py-2 text-caption text-ink-2">
              {SEND_ERROR.RECIPIENT_NEEDS_APPROVAL}{' '}
              {held.map((result) => result.address).join(', ')}
            </p>
          )}
          {failed.map((result) => (
            <FormAlert key={result.address}>
              {result.address} —{' '}
              {(result.code && SEND_ERROR[result.code]) ??
                'Could not send the email.'}
            </FormAlert>
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
  const timezone = useBusinessTimezone()
  const history = useQuery(
    convexQuery(api.deliveries.forReport, { businessId, reportId }),
  )
  const rows = history.data

  if (rows === undefined && history.isError) {
    return (
      <LoadFailed
        what="the delivery history"
        onRetry={() => void history.refetch()}
      />
    )
  }
  // Loading is not the same as nothing: "Not sent yet." under a report the
  // form already opened a delivery for is a lie, and one a technician would
  // act on by sending it again.
  if (rows === undefined) {
    return <RowPending announce={false} className="py-1" />
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
            {formatWhen(row.sentAt ?? row.createdAt, timezone)}
            {row.trigger === 'finalise' ? ' · asked for by the form' : ''}
          </p>
          {copiesOf(row).length > 0 && (
            <p className="text-caption text-muted">
              Copy to {copiesOf(row).join(', ')}
            </p>
          )}
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

/**
 * Who else a delivery went to: the business's blind copy, and — on a row from
 * before copies were blind (29 Sept 2026), or one an API caller asked for —
 * its visible cc.
 */
function copiesOf(row: {
  cc: Array<string>
  bcc?: Array<string>
}): Array<string> {
  return [...new Set([...(row.bcc ?? []), ...row.cc])]
}

/**
 * The newest delivery of a finished report, in one line above its tabs.
 *
 * Locking is what sends a report — the form asks whether to send the client a
 * copy "when you submit this form" — so the page a technician lands on after
 * Finalise is where "did it go, and to whom?" gets answered: "Sending…" for
 * the few seconds the PDF takes to draw, then who it went to and where the
 * business's copy went. It opens the Email tab, which has the whole history.
 *
 * Nothing at all for a report nobody has emailed: that is most of them, and
 * a line saying so on every one would be noise.
 */
export function LatestDelivery({
  businessId,
  reportId,
  onOpen,
}: {
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
  /** Opens the Email tab. */
  onOpen: () => void
}) {
  const timezone = useBusinessTimezone()
  const hydrated = useHydrated()
  const { data: rows } = useQuery(
    convexQuery(api.deliveries.forReport, { businessId, reportId }),
  )
  const latest = rows?.[0]
  // A send takes seconds: the PDF is drawn, then Resend is called. A row
  // still queued minutes later is not on its way — its render failed, or it
  // was never scheduled — and a spinner beside it would be a promise.
  const stuck = useOlderThan(
    latest?.status === 'queued' && !latest.waitingForEmailSetup
      ? latest.createdAt
      : undefined,
    STUCK_AFTER_MS,
  )
  if (!latest) return null

  const who = latest.to.join(', ')
  const copies = copiesOf(latest)
  const line = deliveryLine(latest, who, stuck)
  const sending =
    latest.status === 'queued' && !latest.waitingForEmailSetup && !stuck
  const detail =
    latest.status === 'sent'
      ? `${formatWhen(latest.sentAt ?? latest.createdAt, timezone)}${
          copies.length > 0 ? ` · copy to ${copies.join(', ')}` : ''
        }`
      : sending
        ? copies.length > 0
          ? `A copy goes to ${copies.join(', ')}.`
          : null
        : line.next

  return (
    <div className="mx-4 mt-4">
      <button
        type="button"
        disabled={!hydrated}
        onClick={onOpen}
        className={`flex w-full items-center gap-2.5 rounded-2xl border px-3.5 py-3 text-left active:scale-[.99] ${
          line.warn
            ? 'border-amber-line bg-amber-bg'
            : 'border-hairline bg-surface shadow-elevation'
        }`}
      >
        {line.warn ? (
          <TriangleAlert
            size={16}
            strokeWidth={2}
            aria-hidden
            className="shrink-0 text-amber-ink"
          />
        ) : latest.status === 'sent' ? (
          <Check
            size={16}
            strokeWidth={2.2}
            aria-hidden
            className="shrink-0 text-green"
          />
        ) : (
          <LoaderCircle
            size={16}
            strokeWidth={2}
            aria-hidden
            className="shrink-0 animate-spin text-muted"
          />
        )}
        {/* Polite, so "Sending…" turning into "Emailed" is heard: it changes
            by itself a few seconds after the page opens. */}
        <span aria-live="polite" className="min-w-0 flex-1">
          <span
            className={`block break-words text-body ${line.warn ? 'text-amber-ink' : 'text-ink'}`}
          >
            {line.text}
          </span>
          {detail && (
            <span
              className={`block break-words text-caption ${line.warn ? 'text-amber-ink' : 'text-ink-2'}`}
            >
              {detail}
            </span>
          )}
        </span>
        <ChevronRight
          size={16}
          strokeWidth={2.2}
          aria-hidden
          className={`shrink-0 ${line.warn ? 'text-amber-ink' : 'text-muted'}`}
        />
      </button>
    </div>
  )
}

/** How long a delivery may sit queued before it is plainly not on its way. */
const STUCK_AFTER_MS = 2 * 60_000

/**
 * Whether `at` is more than `ms` ago — noticed when it becomes so, not only
 * on the next render, so a page left open stops saying "Sending…".
 */
function useOlderThan(at: number | undefined, ms: number): boolean {
  const [now, setNow] = useState(() => Date.now())
  const due = at === undefined ? null : at + ms
  useEffect(() => {
    if (due === null) return
    const wait = due - Date.now()
    if (wait <= 0) {
      setNow(Date.now())
      return
    }
    const timer = setTimeout(() => setNow(Date.now()), wait + 50)
    return () => clearTimeout(timer)
  }, [due])
  return due !== null && now >= due
}

/** What one delivery's state reads as, and what to do about it. */
function deliveryLine(
  row: {
    status: Doc<'reportDeliveries'>['status']
    error?: string
    waitingForEmailSetup: boolean
  },
  who: string,
  stuck: boolean,
): { text: string; next: string | null; warn: boolean } {
  switch (row.status) {
    case 'sent':
      return { text: `Emailed to ${who}`, next: null, warn: false }
    case 'queued':
      if (row.waitingForEmailSetup) {
        return {
          text: 'Not emailed: email isn’t set up for this business yet.',
          next: 'Download or share the PDF instead.',
          warn: true,
        }
      }
      return stuck
        ? {
            text: `Not sent to ${who} yet.`,
            next: 'Send it again from the Email tab.',
            warn: true,
          }
        : { text: `Sending to ${who}…`, next: null, warn: false }
    case 'pendingApproval':
      return {
        text: `Waiting for an owner to approve emailing ${who}.`,
        next: 'It goes once they say yes.',
        warn: true,
      }
    case 'bounced':
      return {
        text: `The email to ${who} bounced.`,
        next: 'Check the address, then send it again from the Email tab.',
        warn: true,
      }
    case 'failed':
      return row.error === 'Not approved'
        ? {
            text: `An owner didn’t approve emailing ${who}.`,
            next: 'Open the Email tab to send it somewhere else.',
            warn: true,
          }
        : {
            text: `Could not email ${who}.`,
            next: 'Send it again from the Email tab.',
            warn: true,
          }
  }
}

const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  pendingApproval: 'Waiting for approval',
  sent: 'Sent',
  failed: 'Failed',
  bounced: 'Bounced',
}

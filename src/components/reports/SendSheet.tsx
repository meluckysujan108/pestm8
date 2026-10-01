import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  convexQuery,
  useConvexAction,
  useConvexMutation,
} from '@convex-dev/react-query'
import { CircleAlert, Info, Plus, Send } from 'lucide-react'
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
import type { RefObject } from 'react'
import type { Id } from '../../../convex/_generated/dataModel'
import { PRIMARY_BUTTON } from '#/components/primitives/buttons'
import { FormAlert } from '#/components/forms/FormAlert'
import type { ErrorCopy } from '#/components/forms/describeError'
import { TickBox } from './TickBox'
import { formatWhen } from '#/lib/format'
import { useBusinessTimezone } from '#/lib/useBusinessTimezone'
import { LARGE_FOR_EMAIL } from './lockEmail'
import { isOffline } from '#/lib/online'

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
 * chosen. Anyone else is one tap and a typed address away. Nothing waits for
 * an owner (since 29 Sept 2026): an address that is not on the client's record
 * goes like any other, and the sheet points it out before Send — a typo there
 * is a compliance document gone to a stranger — as the report's history does
 * afterwards.
 */

type Recipient = {
  address: string
  chosen: boolean
  known: boolean
  /** Why it can never be delivered to (convex/lib/email.ts), or null. */
  problem: string | null
  /** The address most likely meant, for the one-tap fix. */
  fix: string | null
  /** Who it is, from the client book or the form: "Jane Nguyen · Client". */
  who: string | null
  /** When this report last went to them, if it has. */
  sentAt: number | null
}

/** Someone the client book says a report could go to (`deliveries.known`). */
export type Person = {
  address: string
  name: string
  kind: 'client' | 'contact'
  role: string | null
  primary: boolean
}

/** An earlier send of this report, as far as choosing goes. */
type Earlier = {
  to: ReadonlyArray<string>
  status: string
  sentAt?: number
}

export const SEND_ERROR: Record<string, string> = {
  // An address on file from before addresses were checked ("bob@gmail"):
  // the server refuses it, and saying only "could not send" hid why.
  INVALID_EMAIL: 'That address can’t receive email. Check it for a typo.',
  EMAIL_NOT_CONFIGURED:
    'Email sending isn’t set up for this business yet. Open the PDF and share it from there for now.',
  REPORT_NOT_FINALISED:
    'This report isn’t finalised yet. Finalise it, then send it.',
  PDF_UNAVAILABLE:
    'Could not prepare the PDF to attach. Try again in a moment.',
  // Only once a copy with smaller photos was tried and still did not fit
  // (convex/emailCopy.ts).
  PDF_TOO_LARGE:
    'The report is too large to email, even with its photos made smaller. Use Share on the report instead.',
  // The report's Email list is behind this sheet, not below it.
  EMAIL_SEND_FAILED:
    'The email failed to send. Close this to see why under Email, then try again.',
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
 * A tap of Send refused before anything went — only ever for want of signal
 * (`sendToEach`), since each address's own failure is said beside it.
 */
export const SEND_REFUSED: ErrorCopy = {
  offline:
    'Could not send: this device is offline. Nothing was sent — try again when you have signal.',
  default: 'Could not send. Check your signal and try again.',
}

/** How the send to one address went: no code when it went. */
export type SendOutcome = { address: string; code: string | null }

/**
 * One send per recipient, and one outcome per recipient.
 *
 * They genuinely can differ — the client's goes while the provider refuses
 * a strata office's, or the hourly limit is reached halfway — so a single
 * pass/fail for the whole tap would report one of them wrongly. Nothing an
 * address meets throws: the sheet says what happened to each.
 *
 * No signal is the exception, refused before the first send. The Convex
 * client would hold each one on the dropped socket and email it whenever the
 * signal came back — after the person had given up on the sheet, and perhaps
 * shared the PDF another way. Inside the loop, the refusal would read as each
 * address's own failure.
 */
export async function sendToEach(
  addresses: ReadonlyArray<string>,
  sendOne: (to: string) => Promise<unknown>,
): Promise<Array<SendOutcome>> {
  if (isOffline()) throw new Error('offline')
  const results: Array<SendOutcome> = []
  for (const address of addresses) {
    try {
      await sendOne(address)
      results.push({ address, code: null })
    } catch (error) {
      results.push({ address, code: sendErrorCode(error) })
    }
  }
  return results
}

/**
 * Who to offer, in the order they are likely to be wanted:
 *
 *  1. whoever the form asked for ("send a copy to the client", "email this
 *     report to");
 *  2. the client, from their record as it is now;
 *  3. the client's contacts — the strata manager, the agent — primary first;
 *  4. anyone else this report has already gone to.
 *
 * The form's people and the client are chosen; the rest are a tap away. A
 * technician asked for the report at the door should not have to type an
 * address the business already holds — the sheet used to offer the client
 * only when the form's own "send a copy" was Yes.
 *
 * Except anyone this report has already reached, who is listed with when and
 * left unchosen: a second copy is a decision, not a default.
 *
 * An address that can never be delivered to is never chosen. One saved
 * before addresses were checked ("bob@gmail") still reaches here from the
 * client's record; it shows as "Can’t be delivered", with the address most
 * likely meant one tap away.
 */
export function suggestedRecipients({
  asked,
  people,
  before,
  knownAddresses,
}: {
  asked: ReadonlyArray<string>
  people: ReadonlyArray<Person>
  before: ReadonlyArray<Earlier>
  knownAddresses: ReadonlyArray<string>
}): Array<Recipient> {
  const lastSent = new Map<string, number>()
  for (const row of before) {
    if (row.status !== 'sent') continue
    for (const address of row.to) {
      const at = row.sentAt ?? 0
      lastSent.set(address, Math.max(lastSent.get(address) ?? 0, at))
    }
  }
  const named = new Map<string, Person>()
  for (const person of people) {
    // The client before a contact who shares their address.
    if (!named.has(person.address)) named.set(person.address, person)
  }
  const client = people.filter((person) => person.kind === 'client')
  const contacts = people
    .filter((person) => person.kind === 'contact')
    .sort((a, b) => Number(b.primary) - Number(a.primary))

  const order = [
    ...asked,
    ...client.map((person) => person.address),
    ...contacts.map((person) => person.address),
    ...before.flatMap((row) => row.to),
  ]
  const seen = new Set<string>()
  const out: Array<Recipient> = []
  for (const address of order) {
    if (seen.has(address)) continue
    seen.add(address)
    const problem = emailProblem(address)
    const person = named.get(address)
    const wanted = asked.includes(address) || person?.kind === 'client'
    const sentAt = lastSent.get(address) ?? null
    out.push({
      address,
      chosen: problem === null && wanted && sentAt === null,
      known: knownAddresses.includes(address),
      problem,
      fix: problem === null ? null : emailTypoFix(address),
      who: person
        ? `${person.name} · ${personRole(person)}`
        : asked.includes(address)
          ? 'Asked for on the form'
          : null,
      sentAt,
    })
  }
  return out
}

/** "Client", a contact's own role, or what is known of it. */
function personRole(person: Person): string {
  if (person.kind === 'client') return 'Client'
  return person.role ?? (person.primary ? 'Primary contact' : 'Contact')
}

const NONE: ReadonlyArray<string> = []

export function SendSheet({
  open,
  onClose,
  businessId,
  reportId,
  template,
  data,
  clientEmail,
  clientName,
  subject,
  chosen: chosenAtOpen = NONE,
  returnFocusRef,
}: {
  open: boolean
  onClose: () => void
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
  /** The wording this report was signed against. */
  template: ReportTemplate
  data: Record<string, unknown>
  /** The client's address as the document printed it — used only by a
   * backend from before the client book was read out (`known.people`). */
  clientEmail?: string
  /** The client's name as the document printed it, for the same. */
  clientName?: string
  /** What the email will say it is — the document's own name. */
  subject: string
  /**
   * Addresses chosen as it opens, besides the form's own: "Send again" on a
   * send that failed brings its addresses back ticked.
   */
  chosen?: ReadonlyArray<string>
  /** Where focus goes as it closes, when what opened it has gone (the
   * viewer's Send). */
  returnFocusRef?: RefObject<HTMLElement | null>
}) {
  const timezone = useBusinessTimezone()
  const { data: known } = useQuery(
    convexQuery(api.deliveries.known, { businessId, reportId }),
  )
  const { data: history } = useQuery(
    convexQuery(api.deliveries.forReport, { businessId, reportId }),
  )

  // `undefined` means "not yet", which is not the same as "nobody is on
  // file" — and the difference matters, because the second one marks the
  // client's own address as new. The same mistake the finalise sheet made
  // about signatures.
  const settled = known !== undefined
  const knownAddresses = known?.addresses ?? []
  // The business's own blind copy (`lib/recipients.businessCopyAddress`),
  // which every email of this report carries.
  const copy = known?.copy ?? null

  // The client book as it is now: the client, then their contacts. Before a
  // backend that reads it out (1 Oct 2026), the address the document printed.
  const people = useMemo((): ReadonlyArray<Person> => {
    if (known === undefined) return []
    const fromBook = (known as { people?: ReadonlyArray<Person> }).people
    if (fromBook) return fromBook
    return clientEmail
      ? [
          {
            address: clientEmail.trim().toLowerCase(),
            name: clientName ?? 'Client',
            kind: 'client',
            role: null,
            primary: false,
          },
        ]
      : []
  }, [known, clientEmail, clientName])
  // The client the record names, for "Save to the client's record" — only
  // where the caller may see the client book, and only while it has no
  // address of its own.
  const recordClient =
    (
      known as
        | {
            client?: {
              clientId: Id<'clients'>
              name: string
              hasEmail: boolean
            } | null
          }
        | undefined
    )?.client ?? null

  const suggested = useMemo(() => {
    // "Send a copy to the client" means the client as the record has them
    // now, not an address the document printed that has since changed.
    const live = people.find((person) => person.kind === 'client')?.address
    return suggestedRecipients({
      asked: deliveryRecipients(template, data, {
        clientEmail: live ?? clientEmail,
      }).to,
      people,
      before: history ?? [],
      knownAddresses,
    })
  }, [template, data, clientEmail, people, history, knownAddresses])

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

  // Opened for particular addresses ("Send again" on one that failed): those
  // are chosen and nothing else is — the form's own recipients already have
  // their copy, and a second one to the client is a decision, not a default.
  const [onlyChosen, setOnlyChosen] = useState(false)

  const recipients: Array<Recipient> = [
    ...suggested.map((entry) => ({
      ...entry,
      // One that can never arrive cannot be chosen at all.
      chosen:
        entry.problem === null &&
        (overrides[entry.address] ?? (onlyChosen ? false : entry.chosen)),
    })),
    ...added.map((address) => ({
      address,
      chosen: overrides[address] ?? true,
      known: knownAddresses.includes(address),
      problem: null,
      fix: null,
      who: null,
      sentAt: null,
    })),
  ]
  const chosen = recipients.filter((entry) => entry.chosen)
  // Said wherever it is true: an email to the copy address itself carries no
  // second, hidden one (`blindCopy`).
  const copied = (addresses: ReadonlyArray<string>) =>
    copy !== null && addresses.some((address) => address !== copy)

  // A typed address saved to the client's record as well, when the record
  // has none: off unless asked for. What became of it is said after Send.
  const [saveToRecord, setSaveToRecord] = useState(false)
  const [saved, setSaved] = useState<'saved' | 'failed' | null>(null)
  const savable =
    recordClient !== null && !recordClient.hasEmail
      ? (added.at(0) ?? null)
      : null

  const convexSend = useConvexAction(api.email.sendReportPdf)
  const convexSaveEmail = useConvexMutation(api.clients.update)
  const send = useMutation({
    mutationFn: async (addresses: Array<string>) => {
      const outcomes = await sendToEach(addresses, (to) =>
        convexSend({ businessId, reportId, to }),
      )
      // Only an address that took the email: one that failed may be a typo.
      const keep =
        saveToRecord && savable !== null && recordClient !== null
          ? outcomes.find(
              (outcome) => outcome.address === savable && outcome.code === null,
            )
          : undefined
      if (keep && recordClient) {
        try {
          await convexSaveEmail({
            businessId,
            clientId: recordClient.clientId,
            email: keep.address,
          })
          setSaved('saved')
        } catch {
          setSaved('failed')
        }
      }
      return outcomes
    },
  })

  // Each opening starts afresh: what was ticked, typed and sent last time was
  // for then. Done as it opens rather than by a new sheet each time, which
  // would lose the sheet's slide down as it closes. Before paint, so the
  // last opening's ticks never show.
  //
  // Except while a send is still going (a big report takes up to a minute):
  // reopened then, the sheet must still say "Sending…" with Send held, or a
  // second tap would email everyone again while the first is on its way.
  const { reset: resetSend } = send
  const sending = useRef(false)
  sending.current = send.isPending
  useLayoutEffect(() => {
    if (!open || sending.current) return
    setOverrides(
      Object.fromEntries(chosenAtOpen.map((address) => [address, true])),
    )
    setOnlyChosen(chosenAtOpen.length > 0)
    setSaveToRecord(false)
    setSaved(null)
    setAdded([])
    setDraft('')
    setAdding(false)
    setDraftShown(false)
    setTypoAsked(null)
    resetSend()
  }, [open, chosenAtOpen, resetSend])

  const outcomes = send.data ?? []
  const sent = outcomes.filter((result) => result.code === null)
  const failed = outcomes.filter((result) => result.code !== null)

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
      returnFocusRef={returnFocusRef}
      footer={
        // Red: this is the tap that emails someone (design system §4.1).
        <button
          type="button"
          disabled={chosen.length === 0 || send.isPending || !settled}
          onClick={() => send.mutate(chosen.map((entry) => entry.address))}
          className={`${PRIMARY_BUTTON} flex w-full items-center justify-center gap-2`}
        >
          <Send size={16} strokeWidth={2} />
          {send.isPending
            ? 'Sending…'
            : chosen.length === 0
              ? 'Choose who to send to'
              : `Send to ${chosen.length === 1 ? '1 person' : `${chosen.length} people`}`}
        </button>
      }
    >
      {settled && recipients.length === 0 && (
        <p className="text-body text-ink-2">
          {`No email on file for ${recordClient?.name ?? clientName ?? 'the client'}. Add an address and it goes there.`}
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
                    <span className="min-w-0 flex-1">
                      {/* Who, from the client book or the form, then the
                          address whole, never cut off: the end of an address
                          is where a typo in its domain would be. */}
                      {entry.who && (
                        <span className="block break-words text-body font-semibold text-ink">
                          {entry.who}
                        </span>
                      )}
                      <span
                        className={`block break-words ${entry.who ? 'text-caption text-ink-2' : 'text-body text-ink'}`}
                      >
                        {entry.address}
                      </span>
                      {/* Why it is not chosen: it already has this report. */}
                      {entry.sentAt !== null && (
                        <span className="mt-0.5 block text-caption text-grey-ink">
                          Sent {formatWhen(entry.sentAt, timezone)}
                        </span>
                      )}
                      {/* Said before Send, not after: an address the business
                          has never used is where a typo would be. It goes all
                          the same. Shown chosen or not, so the button's name
                          does not change as it is toggled. */}
                      {settled && !entry.known && (
                        <span className="mt-0.5 flex items-center gap-1 text-caption text-ink-2">
                          <Info
                            size={13}
                            strokeWidth={2}
                            aria-hidden
                            className="shrink-0 text-blue"
                          />
                          Not on the client’s record
                        </span>
                      )}
                    </span>
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

      {/* Open by itself when there is nobody to offer — but without the
          keyboard: focus stays put as a sheet opens (design system §4.4),
          and rises only when "Send to someone else" asks for it. */}
      {adding || (settled && recipients.length === 0) ? (
        <div className="mt-2">
          <div className="flex gap-2">
            <input
              ref={draftRef}
              id={draftId}
              autoFocus={adding}
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

      {/* The address just typed, kept for next time — only for a client
          with none on their record, and only if asked. */}
      {savable && (
        <button
          type="button"
          aria-pressed={saveToRecord}
          onClick={() => setSaveToRecord((on) => !on)}
          className="mt-2 flex w-full items-center gap-2.5 rounded-xl px-1 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-blue"
        >
          <TickBox on={saveToRecord} />
          <span className="min-w-0 flex-1 break-words text-body text-ink">
            Also save {savable} to {recordClient?.name}’s record
          </span>
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
          {/* One email per person (see `send`), so one copy per email: the
              business's inbox then shows each email and who it went to. */}
          <span>
            {chosen.length > 1 ? 'A copy of each goes to ' : 'A copy goes to '}
            <span className="break-words font-semibold text-ink">{copy}</span>.
          </span>
        </p>
      )}

      {/* Said before Send: the client's photos will be smaller than the
          ones on this phone, and the first send of a big report makes its
          copy, which takes longer than an ordinary send. Not where email
          isn't set up: nothing would go, smaller or not. */}
      {known?.largeForEmail === true &&
        known.emailReady &&
        chosen.length > 0 && (
          <p className="mt-2 flex gap-2 rounded-xl border border-hairline bg-surface-2 px-3 py-2.5 text-caption text-ink-2">
            <Info
              size={13}
              strokeWidth={2}
              aria-hidden
              className="mt-0.5 shrink-0"
            />
            <span>{LARGE_FOR_EMAIL} Sending it can take up to a minute.</span>
          </p>
        )}

      {/* The whole tap refused, with no signal: nothing went to anyone. */}
      <FormAlert
        error={send.isError ? send.error : null}
        copy={SEND_REFUSED}
        className="mt-3"
      />

      {outcomes.length > 0 && (
        <div role="status" className="mt-3 flex flex-col gap-1.5">
          {sent.length > 0 && (
            <p className="rounded-xl border border-hairline bg-surface-2 px-3 py-2 text-caption text-ink-2">
              Sent to {sent.map((result) => result.address).join(', ')}.
              {copied(sent.map((result) => result.address))
                ? ` A copy went to ${copy}.`
                : ''}
              {saved === 'saved' && recordClient
                ? ` Saved to ${recordClient.name}’s record.`
                : ''}
            </p>
          )}
          {saved === 'failed' && recordClient && (
            <p role="alert" className="text-caption text-amber-ink">
              Sent, but could not save the address to {recordClient.name}’s
              record. Add it on their client page.
            </p>
          )}
          {failed.map((result) => (
            <FormAlert key={result.address}>
              {result.address} —{' '}
              {(result.code && SEND_ERROR[result.code]) ??
                'Could not send the email. Try again in a moment.'}
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

/** "Terence", or "Terence, in Kevin’s account" when it was sent from there —
 * as the report's Email list and Activity both say it. */
export function senderName(name: string, onBehalfOf?: string): string {
  return onBehalfOf ? `${name}, in ${onBehalfOf}’s account` : name
}

/**
 * The line a send to addresses new to this client carries, in the report's
 * Email list and its Activity alike. In the past tense: it is what was true
 * when it was sent, and the address may be on the record since.
 */
export function newAddressLine(addresses: ReadonlyArray<string>): string {
  return `${addresses.length === 1 ? 'Wasn’t' : 'Weren’t'} on the client’s record: ${addresses.join(', ')}`
}

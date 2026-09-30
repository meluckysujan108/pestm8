import { emailProblem } from '../../../convex/lib/email'
import { sectionsOf } from '#/lib/reportTemplates'
import { blindCopy, deliveryRecipients } from '#/lib/reportTemplates/delivery'
import { visibleSections } from '#/lib/reportTemplates/visibility'
import type { ReportTemplate } from '#/lib/reportTemplates'

/**
 * What locking a report will email, worked out the way `reports.finalise`
 * works it out (`queueFormDeliveries`), so the sheet that locks it can say so
 * before anyone presses the button.
 *
 * Locking sends: the form asks "Send copy of the report to the client email
 * above when you submit this form?", and when the answer is Yes the report is
 * emailed within seconds of the lock. The sheet used to say "Send it from the
 * report once it’s locked" — true before email was switched on, and an
 * instruction that, once it was, sent the client a second copy.
 */

/** What `deliveries.known` answers, as far as locking needs it. */
export type SendingKnown = {
  /**
   * The addresses on the client's record. Any other address is emailed all
   * the same — nothing waits for an owner — but is worth a second look.
   */
  addresses: ReadonlyArray<string>
  /** The business's blind copy on every email of this report. */
  copy: string | null
}

/**
 * The form's own send-a-copy question, when it is being asked and the client
 * has an address to send to. Needs nothing from the server, so the switch is
 * there the moment the sheet opens, signal or not.
 */
export type ClientToggle = {
  key: string
  address: string
  /** The answer as it stands. */
  on: boolean
  /** Why that address can never be delivered to, or null. */
  problem: string | null
}

export function clientToggleOf(
  template: ReportTemplate,
  data: Record<string, unknown>,
  clientEmail: string | null | undefined,
): ClientToggle | null {
  const field = visibleSections(sectionsOf(template), data)
    .flatMap((section) => section.fields)
    .find(
      (candidate) =>
        candidate.semantic === 'sendCopyToClient' &&
        candidate.kind === 'toggle',
    )
  const address = clientEmail?.trim().toLowerCase() ?? ''
  if (!field || address === '') return null
  return {
    key: field.key,
    address,
    on: data[field.key] === true,
    problem: emailProblem(address),
  }
}

export type LockEmail = {
  /** Emailed as soon as it is locked, in the form's order: one email. */
  sending: Array<string>
  /**
   * Those of `sending` that are not on the client's record. Emailed with the
   * rest, and recorded on the delivery as new (`queueFormDeliveries`) — a
   * compliance document sent to a typo is gone, so the sheet asks for a
   * second look before the lock rather than after.
   */
  newAddresses: Array<string>
  /** Addresses the form asks for that can never be delivered to. */
  undeliverable: Array<string>
  /**
   * The client's address, switched off here but typed into "Email Report
   * To" as well — so it is still emailed, and the switch has to say why.
   */
  stillTyped: string | null
  /** The business's blind copy on what goes now, if anything goes now. */
  copy: string | null
}

export function lockEmail(
  template: ReportTemplate,
  data: Record<string, unknown>,
  clientEmail: string | null | undefined,
  known: SendingKnown,
): LockEmail {
  const asked = deliveryRecipients(template, data, { clientEmail })
  // `isValidEmail` on the server is `emailProblem` on a non-blank address,
  // and nothing blank reaches here.
  const deliverable = asked.to.filter(
    (address) => emailProblem(address) === null,
  )
  const toggle = clientToggleOf(template, data, clientEmail)

  return {
    sending: deliverable,
    newAddresses: deliverable.filter(
      (address) => !known.addresses.includes(address),
    ),
    undeliverable: asked.to.filter((address) => emailProblem(address) !== null),
    stillTyped:
      toggle && !toggle.on && asked.to.includes(toggle.address)
        ? toggle.address
        : null,
    // Nothing sent, nothing copied: the copy rides on an email, it is not one
    // of its own.
    copy:
      deliverable.length > 0
        ? (blindCopy(known.copy, deliverable)[0] ?? null)
        : null,
  }
}

/** A run of words, with the addresses kept apart so they can be set bold. */
export type Sentence = Array<string | { address: string }>

/**
 * A report whose photos are more than an email carries goes as a copy with
 * smaller photos (convex/emailCopy.ts). The same words on the sheet that
 * locks it and the one that sends it.
 */
export const LARGE_FOR_EMAIL =
  'It’s too big to email as it is, so the email carries a copy with smaller photos. The report keeps them full size.'

/**
 * What the sheet says, in the order it says it. Pure, so every case can be
 * read in a test rather than found on a phone.
 *
 * An address that is not on the client's record is emailed with the rest:
 * nothing waits for an owner (since 29 Sept 2026). The sheet only asks for a
 * second look at it, because locking is what sends it.
 */
export function lockEmailSentences(
  plan: LockEmail,
  emailReady: boolean,
  {
    clientToggle,
    clientHasEmail,
    largeForEmail = false,
  }: {
    clientToggle: ClientToggle | null
    clientHasEmail: boolean
    /**
     * Its photos come to more than an email carries, so the email goes as a
     * copy with smaller photos (convex/emailCopy.ts; `deliveries.known`).
     */
    largeForEmail?: boolean
  },
): Array<Sentence> {
  const later = 'You can send it from the report once it’s locked.'

  if (!emailReady) {
    // Still recorded — the delivery is opened either way — but nothing on
    // this deployment will send it, and "emailed" would be a promise.
    return [
      [
        'Email isn’t set up for this business yet, so it won’t be emailed. Share the PDF from the report once it’s locked.',
      ],
    ]
  }

  const out: Array<Sentence> = []
  if (plan.sending.length > 0) {
    out.push(['Once it’s locked, it’s emailed to ', ...list(plan.sending), '.'])
  }
  if (plan.stillTyped) {
    out.push([
      { address: plan.stillTyped },
      ' is also in “Email Report To”, so it still gets it.',
    ])
  }
  if (plan.newAddresses.length > 0) {
    out.push([
      ...list(plan.newAddresses),
      plan.newAddresses.length === 1
        ? ' isn’t on the client’s record — check it’s right.'
        : ' aren’t on the client’s record — check they’re right.',
    ])
  }
  if (plan.undeliverable.length > 0) {
    const one = plan.undeliverable.length === 1
    out.push(
      plan.sending.length > 0
        ? [
            ...list(plan.undeliverable),
            one
              ? ' can’t receive email, so it’s left out.'
              : ' can’t receive email, so they’re left out.',
          ]
        : [
            'Not emailed: ',
            ...list(plan.undeliverable),
            ` can’t receive email. Fix ${one ? 'the address' : 'the addresses'}, then send it from the report once it’s locked.`,
          ],
    )
  }
  if (plan.copy) out.push(['A copy goes to ', { address: plan.copy }, '.'])
  // Said before the lock, because the lock is what sends it: a technician
  // who took fifty photos should not find out afterwards that the client's
  // are smaller than theirs.
  if (largeForEmail && plan.sending.length > 0) {
    out.push([LARGE_FOR_EMAIL])
  }
  if (out.length > 0) return out

  if (clientToggle) return [['Not emailed. ' + later]]
  if (!clientHasEmail) {
    return [['Not emailed: the client has no email address on file. ' + later]]
  }
  return [['Not emailed: the form didn’t ask for a copy. ' + later]]
}

/** "a", "a and b", "a, b and c". */
function list(addresses: ReadonlyArray<string>): Sentence {
  const out: Sentence = []
  addresses.forEach((address, index) => {
    if (index > 0) out.push(index === addresses.length - 1 ? ' and ' : ', ')
    out.push({ address })
  })
  return out
}

/** The words alone, as a screen reader or a test reads them. */
export function sentenceText(sentence: Sentence): string {
  return sentence
    .map((part) => (typeof part === 'string' ? part : part.address))
    .join('')
}

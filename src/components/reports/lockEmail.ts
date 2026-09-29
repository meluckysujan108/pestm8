import { emailProblem } from '../../../convex/lib/email'
import { sectionsOf } from '#/lib/reportTemplates'
import { deliveryRecipients } from '#/lib/reportTemplates/delivery'
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
  /** The addresses on file, which go without an owner's approval. */
  addresses: ReadonlyArray<string>
  /** An owner, or a business that lets anyone email anywhere. */
  unrestricted: boolean
  /** The business's blind copy on every email of this report. */
  copy: string | null
  /** Whether this deployment can send email at all. */
  emailReady: boolean
}

export type LockEmail = {
  /**
   * The form's own send-a-copy question, when it is being asked and the
   * client has an address to send to. `on` is the answer as it stands.
   */
  clientToggle: {
    key: string
    address: string
    on: boolean
    /** Why that address can never be delivered to, or null. */
    problem: string | null
  } | null
  /** Who it is emailed to once it is locked, in the form's order. */
  sending: Array<string>
  /** Of those, the ones not on file: the whole email waits for an owner. */
  held: Array<string>
  /** Addresses the form asks for that can never be delivered to. */
  undeliverable: Array<string>
  /** The business's blind copy, when anything is emailed at all. */
  copy: string | null
}

export function lockEmail(
  template: ReportTemplate,
  data: Record<string, unknown>,
  clientEmail: string | null | undefined,
  known: SendingKnown,
): LockEmail {
  const asked = deliveryRecipients(template, data, {
    clientEmail,
    businessCopyEmail: known.copy,
  })
  // `isValidEmail` on the server is `emailProblem` on a non-blank address,
  // and nothing blank reaches here.
  const sending = asked.to.filter((address) => emailProblem(address) === null)
  const undeliverable = asked.to.filter(
    (address) => emailProblem(address) !== null,
  )
  // One row per lock, held as a whole: `finalise` opens a single delivery,
  // and one address nobody has on file holds all of it.
  const held = known.unrestricted
    ? []
    : sending.filter((address) => !known.addresses.includes(address))

  const toggle = visibleSections(sectionsOf(template), data)
    .flatMap((section) => section.fields)
    .find(
      (field) =>
        field.semantic === 'sendCopyToClient' && field.kind === 'toggle',
    )
  const address = clientEmail?.trim().toLowerCase() ?? ''

  return {
    clientToggle:
      toggle && address !== ''
        ? {
            key: toggle.key,
            address,
            on: data[toggle.key] === true,
            problem: emailProblem(address),
          }
        : null,
    sending,
    held,
    undeliverable,
    // Nothing sent, nothing copied: the copy rides on an email, it is not
    // one of its own.
    copy: sending.length > 0 ? (asked.bcc[0] ?? null) : null,
  }
}

/** A run of words, with the addresses kept apart so they can be set bold. */
export type Sentence = Array<string | { address: string }>

/**
 * What the sheet says, in the order it says it. Pure, so every case can be
 * read in a test rather than found on a phone.
 */
export function lockEmailSentences(
  plan: LockEmail,
  emailReady: boolean,
  { clientHasEmail }: { clientHasEmail: boolean },
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

  if (plan.sending.length === 0) {
    if (plan.undeliverable.length > 0) {
      return [
        [
          'Not emailed: ',
          ...list(plan.undeliverable),
          ` can’t receive email. Fix ${plan.undeliverable.length === 1 ? 'the address' : 'the addresses'}, then send it from the report once it’s locked.`,
        ],
      ]
    }
    if (plan.clientToggle) return [['Not emailed. ' + later]]
    if (!clientHasEmail) {
      return [
        ['Not emailed: the client has no email address on file. ' + later],
      ]
    }
    return [['Not emailed: the form didn’t ask for a copy. ' + later]]
  }

  const out: Array<Sentence> = []
  if (plan.held.length > 0) {
    out.push([
      ...list(plan.held),
      plan.held.length === 1
        ? ' isn’t on the client’s record, so an owner approves this email first. Then it goes to '
        : ' aren’t on the client’s record, so an owner approves this email first. Then it goes to ',
      ...list(plan.sending),
      '.',
    ])
  } else {
    out.push(['Once it’s locked, it’s emailed to ', ...list(plan.sending), '.'])
  }
  if (plan.undeliverable.length > 0) {
    out.push([
      ...list(plan.undeliverable),
      plan.undeliverable.length === 1
        ? ' can’t receive email, so it’s left out.'
        : ' can’t receive email, so they’re left out.',
    ])
  }
  if (plan.copy) out.push(['A copy goes to ', { address: plan.copy }, '.'])
  return out
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

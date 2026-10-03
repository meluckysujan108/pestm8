import { emailProblem, emailTypoFix } from '../../../convex/lib/email'
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

/** An address typed into one of the form's own address boxes. */
export type TypedAddress = { key: string; address: string }

/**
 * The addresses typed into the form's own address boxes ("Email Report To"),
 * each with the box it is in: the people locking emails besides the client.
 * The sheet that locks the report lists them, so one can be taken off before
 * anything is sent. Read as `deliveryRecipients` reads them: only boxes the
 * form is asking, lower-cased, each address once, in the form's order.
 */
export function typedAddressesOf(
  template: ReportTemplate,
  data: Record<string, unknown>,
): Array<TypedAddress> {
  const seen = new Set<string>()
  const out: Array<TypedAddress> = []
  const fields = visibleSections(sectionsOf(template), data).flatMap(
    (section) => section.fields,
  )
  for (const field of fields) {
    if (field.semantic !== 'emailTo') continue
    const value = data[field.key]
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (typeof entry !== 'string') continue
      const address = entry.trim().toLowerCase()
      if (address === '' || seen.has(address)) continue
      seen.add(address)
      out.push({ key: field.key, address })
    }
  }
  return out
}

/**
 * A box's answer with one address taken off, or put back: what the sheet
 * writes as it is unticked or ticked again. An answer kept as one address
 * (a form's first version) comes back as a list, which every version takes.
 */
export function withAddress(
  value: unknown,
  address: string,
  on: boolean,
): Array<string> {
  const kept = (Array.isArray(value) ? value : [value]).filter(
    (entry): entry is string =>
      typeof entry === 'string' &&
      entry.trim() !== '' &&
      entry.trim().toLowerCase() !== address,
  )
  return on ? [...kept, address] : kept
}

/**
 * Where the lock sheet writes who the report goes to: the form's own
 * send-copy question, for the client, and its address boxes ("Email Report
 * To"), for everyone else — so what locking sends is still worked out from
 * the form's answers (`deliveryRecipients`, `reports.finalise`), unchanged.
 * The form shows neither: they are asked on the sheet that locks it.
 */
export type DeliveryQuestions = {
  /** The send-copy question's key, where the form asks one. */
  sendCopyKey: string | null
  /** The address boxes the form is asking, in its order: a choice made on
   * the sheet goes into the first, or the first the form requires while it
   * is empty. */
  boxKeys: Array<string>
  /** Those of `boxKeys` the form requires an address in. */
  requiredKeys: Array<string>
}

export function deliveryQuestionsOf(
  template: ReportTemplate,
  data: Record<string, unknown>,
): DeliveryQuestions {
  const fields = visibleSections(sectionsOf(template), data).flatMap(
    (section) => section.fields,
  )
  return {
    sendCopyKey:
      fields.find(
        (field) =>
          field.semantic === 'sendCopyToClient' && field.kind === 'toggle',
      )?.key ?? null,
    boxKeys: fields
      .filter((field) => field.semantic === 'emailTo')
      .map((field) => field.key),
    requiredKeys: fields
      .filter((field) => field.semantic === 'emailTo' && field.required)
      .map((field) => field.key),
  }
}

/** The addresses an answer holds, lower-cased: a list, or a form's first
 * version's one address. */
function addressesIn(value: unknown): Array<string> {
  return (Array.isArray(value) ? value : [value])
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '')
}

/** Someone the lock sheet offers, ticked or not. */
export type LockRecipient = {
  address: string
  on: boolean
  /** Who, from the client book: "Jane Nguyen · Client". */
  who: { name: string; role: string } | null
  /** The client: their tick is the form's send-copy question. */
  isClient: boolean
  /** Why it can never be delivered to, or null. */
  problem: string | null
  /** The address most likely meant, for the one-tap fix. */
  fix: string | null
  /** On the client's record. */
  known: boolean
}

/** Someone the client book names (`deliveries.known`'s `people`). */
type BookPerson = {
  address: string
  name: string
  kind: 'client' | 'contact'
  role: string | null
  primary: boolean
}

/**
 * Who the lock sheet offers, in the order they are likely to be wanted: the
 * client; their contacts, primary first; anyone typed in. Ticked where the
 * form's answers send to them. `listed` keeps anyone already shown on the
 * list after they are unticked, so a slip can be ticked back.
 *
 * Contacts and typed addresses only where the form has a box to keep them
 * in: a form without one can only send the client theirs, and the rest go
 * from the report once it is locked.
 */
export function lockRecipients({
  template,
  data,
  people,
  clientEmail,
  clientName,
  knownAddresses,
  listed = [],
}: {
  template: ReportTemplate
  data: Record<string, unknown>
  people: ReadonlyArray<BookPerson>
  clientEmail: string | null | undefined
  /** The client's name as the report has it, while the client book has not
   * answered (no signal, or the client is in the bin). */
  clientName?: string | null
  knownAddresses: ReadonlyArray<string>
  listed?: ReadonlyArray<string>
}): Array<LockRecipient> {
  const questions = deliveryQuestionsOf(template, data)
  const typed = typedAddressesOf(template, data).map((entry) => entry.address)
  const client =
    people.find((person) => person.kind === 'client')?.address ??
    (clientEmail?.trim().toLowerCase() || null)
  const clientPerson = people.find((person) => person.kind === 'client')
  const contacts = people
    .filter((person) => person.kind === 'contact')
    .sort((a, b) => Number(b.primary) - Number(a.primary))
  const canKeep = questions.boxKeys.length > 0

  const out: Array<LockRecipient> = []
  const seen = new Set<string>()
  const add = (
    address: string,
    on: boolean,
    who: LockRecipient['who'],
    isClient: boolean,
  ) => {
    if (seen.has(address)) return
    seen.add(address)
    const problem = emailProblem(address)
    out.push({
      address,
      on,
      who,
      isClient,
      problem,
      fix: problem === null ? null : emailTypoFix(address),
      known: knownAddresses.includes(address),
    })
  }

  if (client && (questions.sendCopyKey !== null || canKeep)) {
    add(
      client,
      (questions.sendCopyKey !== null &&
        data[questions.sendCopyKey] === true) ||
        typed.includes(client),
      // Named as the book or the report names them; with no name at all,
      // just "Client", once.
      clientPerson?.name || clientName
        ? { name: clientPerson?.name || (clientName as string), role: 'Client' }
        : { name: 'Client', role: '' },
      true,
    )
  }
  if (canKeep) {
    for (const person of contacts) {
      add(
        person.address,
        typed.includes(person.address),
        {
          name: person.name,
          role: person.role ?? (person.primary ? 'Primary contact' : 'Contact'),
        },
        false,
      )
    }
    for (const address of typed) add(address, true, null, false)
    for (const address of listed) add(address, false, null, false)
  }
  return out
}

/**
 * The answers that tick `address` on the lock sheet, or untick it. The
 * client is the send-copy question; everyone else goes into the first
 * address box, and comes out of every box that holds them. Unticking the
 * client takes them out of the boxes too, so off is off.
 */
export function answersFor(
  questions: DeliveryQuestions,
  data: Record<string, unknown>,
  { address, isClient }: { address: string; isClient: boolean },
  on: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const holds = (key: string) => addressesIn(data[key]).includes(address)
  // A box the form requires and nobody is in yet: where an address goes
  // first, the client's too, or the report could never be locked.
  const emptyRequired = questions.requiredKeys.find(
    (key) => addressesIn(data[key]).length === 0,
  )
  if (isClient && questions.sendCopyKey !== null) {
    out[questions.sendCopyKey] = on
    if (on && emptyRequired !== undefined && !holds(emptyRequired)) {
      out[emptyRequired] = withAddress(data[emptyRequired], address, true)
    }
    if (!on) {
      for (const key of questions.boxKeys) {
        if (holds(key)) out[key] = withAddress(data[key], address, false)
      }
    }
    return out
  }
  if (on) {
    const target = emptyRequired ?? questions.boxKeys.at(0)
    if (target !== undefined && !questions.boxKeys.some(holds)) {
      out[target] = withAddress(data[target], address, true)
    }
    return out
  }
  for (const key of questions.boxKeys) {
    if (holds(key)) out[key] = withAddress(data[key], address, false)
  }
  return out
}

/**
 * What stops the report locking, among who it goes to: an address in a box
 * that can never be delivered to (the lock refuses it, as `validateReport`
 * does), or a box the form requires with nobody in it. Said on the sheet,
 * where they are put right, rather than on a form that no longer shows them.
 */
export function deliveryProblems(
  template: ReportTemplate,
  data: Record<string, unknown>,
): Array<string> {
  const out: Array<string> = []
  const fields = visibleSections(sectionsOf(template), data).flatMap(
    (section) => section.fields,
  )
  for (const field of fields) {
    if (field.semantic !== 'emailTo') continue
    const value = data[field.key]
    const entries = (Array.isArray(value) ? value : [value]).filter(
      (entry): entry is string =>
        typeof entry === 'string' && entry.trim() !== '',
    )
    for (const entry of entries) {
      if (emailProblem(entry) !== null) {
        out.push(
          `${entry.trim().toLowerCase()} can’t receive email — untick it, or use the address meant.`,
        )
      }
      // (The client's own address, from their record, is not checked here:
      // it is left out of the email if it can't receive one, and the sheet
      // says so. Nothing in the form is wrong.)
    }
    if (field.required && entries.length === 0) {
      out.push(
        `${field.label.replace(/:$/, '')} needs at least one address — tick or add someone.`,
      )
    }
  }
  return out
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

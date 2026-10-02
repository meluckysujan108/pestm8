import { fieldsOf } from './index'
import { visibleSections } from './visibility'
import type { ReportTemplate } from './types'

/**
 * Who the form itself says should get a copy.
 *
 * Read through the semantics, never the labels: the three forms word the same
 * instruction three ways — "Send copy of the report to the client email above
 * when you submit this form?", "Send a copy of the Report to the email address
 * above…" — and the app has promised to reproduce that wording verbatim, so it
 * cannot key behaviour off it.
 *
 * Pure, so `finalise` and the send sheet work out the same recipients from the
 * same answers, and a test can check them without a database.
 */

export type Recipients = {
  /** Everyone the form asked for, de-duplicated and lower-cased. */
  to: Array<string>
  /**
   * The business's own copy, kept separate so it is never "the client" — and
   * sent blind, so the client never sees it on the email.
   */
  bcc: Array<string>
}

export function deliveryRecipients(
  template: ReportTemplate,
  data: Record<string, unknown>,
  records: {
    clientEmail?: string | null
    /** Where the business keeps its copy (`businessCopyAddress`), if anywhere. */
    businessCopyEmail?: string | null
  },
): Recipients {
  const asked = new Set<string>()

  // Only questions the form is actually asking. A send-copy toggle inside a
  // section the answers have hidden is not an instruction.
  const visible = new Set(
    visibleSections(template.sections ?? [], data).flatMap((section) =>
      section.fields.map((field) => field.key),
    ),
  )

  for (const field of fieldsOf(template)) {
    if (!visible.has(field.key)) continue

    if (field.semantic === 'sendCopyToClient' && data[field.key] === true) {
      const email = records.clientEmail
      if (email) asked.add(clean(email))
    }

    if (field.semantic === 'emailTo') {
      const value = data[field.key]
      for (const entry of Array.isArray(value) ? value : [value]) {
        if (typeof entry === 'string' && entry.trim() !== '')
          asked.add(clean(entry))
      }
    }
  }

  const to = [...asked]
  return { to, bcc: blindCopy(records.businessCopyEmail, to) }
}

/**
 * Whether the form was asked to send the client a copy and answered No.
 *
 * Not the same as not asking: a form with no such question says nothing,
 * and the Send sheet offers the client as usual. An explicit No is the
 * technician's — or the client's — choice, so the sheet lists the client
 * without choosing them.
 */
export function clientCopyDeclined(
  template: ReportTemplate,
  data: Record<string, unknown>,
): boolean {
  const visible = new Set(
    visibleSections(template.sections ?? [], data).flatMap((section) =>
      section.fields.map((field) => field.key),
    ),
  )
  return fieldsOf(template).some(
    (field) =>
      field.semantic === 'sendCopyToClient' &&
      visible.has(field.key) &&
      data[field.key] === false,
  )
}

/**
 * The business's own copy of one email, as its blind-copy list.
 *
 * Never both: a business that is also a recipient gets one copy, and it
 * arrives as the one it was sent rather than a second, hidden one. Shared by
 * the send a form asks for at finalise and the one a person asks for from the
 * send sheet, which is what "a copy of every report it emails" means.
 */
export function blindCopy(
  copyAddress: string | null | undefined,
  recipients: ReadonlyArray<string>,
): Array<string> {
  const copy = copyAddress ? clean(copyAddress) : null
  return copy && !recipients.includes(copy) ? [copy] : []
}

function clean(address: string): string {
  return address.trim().toLowerCase()
}

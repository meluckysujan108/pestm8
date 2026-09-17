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
  /** The business's own copy, kept separate so it is never "the client". */
  cc: Array<string>
}

export function deliveryRecipients(
  template: ReportTemplate,
  data: Record<string, unknown>,
  records: { clientEmail?: string | null; businessCopyEmail?: string | null },
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
        if (typeof entry === 'string' && entry.trim() !== '') asked.add(clean(entry))
      }
    }
  }

  const to = [...asked]
  const copy = records.businessCopyEmail ? clean(records.businessCopyEmail) : null
  return {
    to,
    // Never both: a business that is also the client gets one copy, and it
    // arrives as the copy the form asked for rather than a silent bcc.
    cc: copy && !to.includes(copy) ? [copy] : [],
  }
}

function clean(address: string): string {
  return address.trim().toLowerCase()
}

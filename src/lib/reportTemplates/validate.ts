import { fieldsOf, sectionsOf } from './index'
import { pruneHidden, visibleSections } from './visibility'
import { isEmptyRow } from './present'
import type { PrefillMap } from './seed'
import type { ReportTemplate } from './types'

/**
 * Whether a report may be finalised, and why not.
 *
 * Run in the browser so the technician hears it immediately, and again on the
 * server so it is true: until now every rule lived in `ReportBuilder`, which
 * means a stale tab, a direct API call or any future non-browser caller could
 * lock an unsigned, undated document. A compliance record whose rules are
 * advisory is not a compliance record.
 *
 * Both sides run this same function against the same payload, so the server
 * can never refuse something the screen said was finished.
 */

export type ReportIssue = {
  /** The field it belongs to, so the builder can mark it and jump to it. */
  key: string
  message: string
}

export type ValidationResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; issues: Array<ReportIssue> }

export type ValidationInput = {
  template: ReportTemplate
  data: Record<string, unknown>
  /** Signature slots the report actually holds an image for. */
  signedSlots?: Array<string>
  /** Photos held per field key. Absent means "cannot tell", which never blocks. */
  photoCounts?: Record<string, number>
  /** Answers the app suggested; unconfirmed ones block. */
  prefill?: PrefillMap | null
}

/**
 * The answers as they will be stored: questions no longer being asked are
 * dropped, and a repeater row left entirely blank is discarded rather than
 * failing as incomplete — an inspection-only visit with a stray "Add Row" tap
 * still finalises, exactly as the Service Report's own notes promise.
 */
export function submittablePayload(
  template: ReportTemplate,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const pruned = pruneHidden(sectionsOf(template), data)
  for (const field of fieldsOf(template)) {
    if (field.kind !== 'repeater') continue
    const rows = pruned[field.key]
    if (Array.isArray(rows)) {
      pruned[field.key] = rows.filter(
        (row: Record<string, unknown>) => !isEmptyRow(field.columns, row),
      )
    }
  }
  return pruned
}

export function validateReport(input: ValidationInput): ValidationResult {
  const { template, data, signedSlots, photoCounts, prefill } = input
  const payload = submittablePayload(template, data)
  const issues: Array<ReportIssue> = []
  const seen = new Set<string>()
  const add = (key: string, message: string) => {
    if (seen.has(key)) return
    seen.add(key)
    issues.push({ key, message })
  }

  const parsed = template.schema.safeParse(payload)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      // `path[0]`, not the joined path: the areas checklist reports its refine
      // failures at ['areas', '<row>'], and the message belongs on the one
      // control that owns every row.
      const key = String(issue.path[0] ?? '')
      if (key) add(key, issue.message)
    }
  }

  // The questions actually being asked right now. Not the pruned payload's
  // keys — an unanswered question has no key there at all, which would make
  // every empty required field look like one that is no longer asked.
  const visible = new Set(
    visibleSections(sectionsOf(template), data).flatMap((section) =>
      section.fields.map((field) => field.key),
    ),
  )

  for (const field of fieldsOf(template)) {
    if (!visible.has(field.key)) continue

    // A signature is an image, not a timestamp. The schema can only see the
    // `{ signedAt }` the control writes into `data`; whether a signature was
    // actually drawn is a fact about storage, so it is checked here.
    if (field.kind === 'signature' && field.required && signedSlots) {
      if (!signedSlots.includes(field.slot)) add(field.key, `${field.label} is required`)
    }

    if (field.kind === 'gallery' || field.kind === 'cover' || field.kind === 'photos') {
      if (!field.required) continue
      const count = photoCounts?.[field.key]
      // Unknown never blocks: refusing a report because the count was
      // unavailable would lock a technician out of their own work.
      if (count !== undefined && count === 0) add(field.key, `${field.label} is required`)
    }
  }

  for (const [key, entry] of Object.entries(prefill ?? {})) {
    if (entry.confirmedAt !== undefined) continue
    if (!visible.has(key)) continue
    const label = fieldsOf(template).find((field) => field.key === key)?.label ?? key
    add(key, `Check ${label.replace(/:$/, '')} — the app suggested this answer`)
  }

  return issues.length === 0 ? { ok: true, payload } : { ok: false, issues }
}

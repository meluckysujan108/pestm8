import { isDataField, sectionsOf } from './index'
import { isFilled, visibleSections } from './visibility'
import type { PrefillMap } from './seed'
import type { ReportTemplate, SectionDef } from './types'

/**
 * How far through a report is, section by section.
 *
 * One computation, used by the overview's status rows, the section screens'
 * counters, the Finalise button's state and the "what is still missing" sheet
 * — because those four disagreeing is how a form comes to say "2 to go" on one
 * screen and lock on another. The server runs it too, so an incomplete report
 * cannot be finalised by a stale tab or a direct API call.
 *
 * Pure. Photos and signatures live outside `data`, so whatever holds them is
 * passed in rather than read here.
 */

export type SectionProgress = {
  /** Stable across answers, for `?s=` and jump links. */
  id: string
  /** Position among the sections currently VISIBLE — answers can hide one. */
  index: number
  number?: number
  title: string
  /** Visible questions in this section. */
  questions: number
  /** Of those, how many have an answer. */
  answered: number
  /** Required questions with no answer, by field key, in the order asked. */
  missing: Array<string>
  /** Suggested answers here the technician has not confirmed yet. */
  toConfirm: Array<string>
  /** Nothing to fill: terms, a preamble, a notice. Never blocks anything. */
  readingOnly: boolean
  /** Ready to leave alone: nothing required missing, nothing left to confirm. */
  done: boolean
}

export type ReportProgress = {
  sections: Array<SectionProgress>
  /** Every required answer still missing, across the form. */
  missingRequired: Array<string>
  /** Every suggestion still unconfirmed, across the form. */
  toConfirm: Array<string>
  /** The first section that still wants something, for "Continue". */
  firstIncomplete: SectionProgress | null
  /** True when the report can be finalised. */
  complete: boolean
}

export type ProgressInput = {
  /** What the app suggested, and what has been confirmed. */
  prefill?: PrefillMap | null
  /**
   * How many photos each photo-bearing field holds. Absent means unknown, and
   * unknown never blocks: a required photo the app cannot count is not a
   * reason to refuse a report the technician says is finished.
   */
  photoCounts?: Record<string, number>
}

export function reportProgress(
  template: ReportTemplate,
  data: Record<string, unknown>,
  input: ProgressInput = {},
): ReportProgress {
  const prefill = input.prefill ?? {}
  const sections = visibleSections(sectionsOf(template), data).map(
    (section, index) =>
      progressOf(section, index, data, prefill, input.photoCounts),
  )

  const missingRequired = sections.flatMap((section) => section.missing)
  const toConfirm = sections.flatMap((section) => section.toConfirm)

  return {
    sections,
    missingRequired,
    toConfirm,
    firstIncomplete:
      sections.find((section) => !section.done && !section.readingOnly) ?? null,
    complete: missingRequired.length === 0 && toConfirm.length === 0,
  }
}

function progressOf(
  section: SectionDef,
  index: number,
  data: Record<string, unknown>,
  prefill: PrefillMap,
  photoCounts: Record<string, number> | undefined,
): SectionProgress {
  const questions = section.fields.filter(isDataField)
  const missing: Array<string> = []
  let answered = 0

  for (const field of questions) {
    const filled = isFilled(data[field.key])
    if (filled) answered++
    if (field.required && !filled) missing.push(field.key)
  }

  // A photo field asks for something without storing it in `data`, so it is
  // counted only where the caller could tell us what it holds.
  for (const field of section.fields) {
    if (
      field.kind !== 'gallery' &&
      field.kind !== 'cover' &&
      field.kind !== 'photos'
    )
      continue
    const count = photoCounts?.[field.key]
    if (count === undefined) continue
    if (count > 0) answered++
    else if (field.required) missing.push(field.key)
  }

  const suggestions: Partial<PrefillMap> = prefill
  const toConfirm = section.fields
    .filter(
      (field) =>
        suggestions[field.key]?.confirmedAt === undefined &&
        field.key in prefill,
    )
    .map((field) => field.key)

  const counted =
    questions.length +
    section.fields.filter(
      (field) =>
        (field.kind === 'gallery' ||
          field.kind === 'cover' ||
          field.kind === 'photos') &&
        photoCounts?.[field.key] !== undefined,
    ).length

  return {
    id: sectionKey(section, index),
    index,
    number: section.number,
    title: section.title,
    questions: counted,
    answered,
    missing,
    toConfirm,
    // Terms, a recommendation notice, a disclaimer: pages to read, not fill.
    readingOnly: counted === 0,
    done: missing.length === 0 && toConfirm.length === 0,
  }
}

/**
 * The handle a section is addressed by.
 *
 * `SectionDef.id` where the template gives one — it is stable across wording
 * changes, which a title is not. The positional fallback covers the legacy
 * flat templates, whose single wrapper section has no id at all.
 */
export function sectionKey(section: SectionDef, index: number): string {
  return section.id ?? `s${index + 1}`
}

/** The section a `?s=` value refers to, or the overview when it names none. */
export function sectionByKey(
  progress: ReportProgress,
  key: string | undefined,
): SectionProgress | null {
  if (!key) return null
  return progress.sections.find((section) => section.id === key) ?? null
}

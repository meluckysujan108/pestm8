import { fieldsOf } from './index'
import { treatmentForJobType } from './suggest'
import { weatherAnswerFrom } from './weatherAnswer'
import type { DayForecast } from './weatherAnswer'
import type { CellDef, FieldDef, ReportTemplate } from './types'

/**
 * What a report already knows before anyone types.
 *
 * The rule this module exists to keep: **never re-ask what the system knows —
 * but never let a guess print under a signature unseen.** So an answer taken
 * from a record is a fact, written straight into the answers, while an answer
 * the app worked out — the forecast, the booked start time — is a suggestion
 * that the technician confirms before the report can be finalised. Both are
 * editable; only the second is tracked.
 *
 * Pure, and imported by the server (`reports.create`) as well as the builder,
 * so the same answers appear whichever side seeds them. Nothing here reads a
 * template by id: a field is seeded because of what it declares — `semantic`,
 * `defaultToday`, `defaultTo`, an option list bound to `treatments` — so a
 * business's own form gets the same treatment as the three built-ins.
 */

/** Where an answer the app guessed came from, so the builder can say so. */
export type SuggestionSource =
  'forecast' | 'scheduled' | 'lastVisit' | 'history'

export type Suggestion = { source: SuggestionSource; confirmedAt?: number }

/** Keyed by field key, exactly like the answers themselves. */
export type PrefillMap = Record<string, Suggestion>

export type SeedFacts = {
  /** Today in the TENANT's timezone, `YYYY-MM-DD`. Never the server's day. */
  today: string
  /** The day the job was booked for, `YYYY-MM-DD`. */
  jobDate?: string
  /** When work actually began, `HH:MM`. A fact: someone pressed start. */
  startedTime?: string
  /** When the job was booked to begin, `HH:MM`. A guess at when work began. */
  scheduledTime?: string
  /** The job's type, in the schedule's vocabulary. */
  jobType?: string
  /** The client's email, when one is on file. Decides the send-a-copy toggle. */
  clientEmail?: string | null
  /** The membership the job is assigned to, for a `member` field. */
  jobAssigneeMembershipId?: string
  /** Whoever is starting the report, for a `member` field that defaults to them. */
  authorMembershipId?: string
  /** The forecast for the job's day and suburb, when it is known. */
  forecast?: DayForecast | null
}

export type SeedResult = {
  /** Answers to write into `reports.data`. */
  data: Record<string, unknown>
  /** The subset of those answers the app guessed, and must have confirmed. */
  prefill: PrefillMap
}

/**
 * Seeds a fresh report's answers from the records behind it.
 *
 * Existing answers always win: this fills blanks and never overwrites, so it
 * is safe to run again when a report is attached to a job later.
 */
export function seedFromContext(
  template: ReportTemplate,
  facts: SeedFacts,
  existing: Record<string, unknown> = {},
): SeedResult {
  const data: Record<string, unknown> = {}
  const prefill: PrefillMap = {}
  const startHour = hourOf(facts.startedTime ?? facts.scheduledTime)

  const answered = (key: string) => {
    const value = existing[key] ?? data[key]
    if (value === undefined || value === null || value === '') return false
    return !(Array.isArray(value) && value.length === 0)
  }

  for (const field of fieldsOf(template)) {
    if (answered(field.key)) continue

    switch (field.semantic) {
      case 'sendCopyToClient':
        // Yes when there is an address to send to, No when there is not —
        // either way it is a fact about the client record, not a guess.
        if (field.kind === 'toggle')
          data[field.key] = Boolean(facts.clientEmail)
        continue
      case 'startTime': {
        if (field.kind !== 'time') continue
        if (facts.startedTime) data[field.key] = facts.startedTime
        else if (facts.scheduledTime) {
          data[field.key] = facts.scheduledTime
          prefill[field.key] = { source: 'scheduled' }
        }
        continue
      }
      case 'weather': {
        const words = weatherAnswerFrom(
          facts.forecast,
          optionsOf(field),
          startHour,
        )
        if (words.length === 0) continue
        // The same question is a checklist on one form and a single choice on
        // another, so the shape follows the control, not the key.
        if (field.kind === 'checks' || field.kind === 'chips')
          data[field.key] = words
        else if (field.kind === 'select' || field.kind === 'radio')
          data[field.key] = words[0]
        else continue
        prefill[field.key] = { source: 'forecast' }
        continue
      }
      // "Is it safe to commence work?" is the one question the form makes
      // mandatory. An app that answers it for the technician has defeated it.
      case 'safetyGate':
        continue
      default:
        break
    }

    if (field.kind === 'date' && field.defaultToday) {
      // The job's day, not today: a report written up the next morning is
      // still a record of yesterday's visit.
      data[field.key] = facts.jobDate ?? facts.today
      continue
    }

    if (field.kind === 'member' && field.defaultTo) {
      const membershipId =
        field.defaultTo === 'jobAssignee'
          ? facts.jobAssigneeMembershipId
          : facts.authorMembershipId
      if (membershipId) data[field.key] = membershipId
      continue
    }

    if (field.kind === 'repeater') {
      const row = seedTreatmentRow(field, facts.jobType)
      if (row) data[field.key] = [row]
      continue
    }
  }

  return { data, prefill }
}

/**
 * The first treatment row, pre-ticked from the job's type.
 *
 * Bound by the column's own option library rather than by template id, and
 * only when the business's list still contains that treatment — an owner who
 * renames "Rodents" gets no row rather than a row naming something their form
 * no longer offers.
 */
function seedTreatmentRow(
  field: Extract<FieldDef, { kind: 'repeater' }>,
  jobType: string | undefined,
): Record<string, unknown> | null {
  const treatment = treatmentForJobType(jobType)
  if (!treatment) return null
  const column = field.columns.find(
    (cell) => 'optionsFrom' in cell && cell.optionsFrom === 'treatments',
  )
  if (!column) return null
  if (!optionsOf(column).includes(treatment)) return null
  // Rows carry an id so the grid can key and reorder them; `crypto.randomUUID`
  // is available in the browser and in Convex's runtime alike.
  return { _id: crypto.randomUUID(), [column.key]: [treatment] }
}

function optionsOf(field: FieldDef | CellDef): Array<string> {
  return 'options' in field ? field.options.map((option) => option.value) : []
}

/** The hour from `HH:MM`, or undefined when there is no time to read. */
function hourOf(time: string | undefined): number | undefined {
  if (!time) return undefined
  const hour = Number(time.slice(0, 2))
  return Number.isFinite(hour) ? hour : undefined
}

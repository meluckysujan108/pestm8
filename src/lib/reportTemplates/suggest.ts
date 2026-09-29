import { splitJobTypes } from '../../../convex/lib/jobTypes'
import { CREATABLE_TEMPLATES } from './index'
import type { TemplateId } from './types'

/**
 * What the app knows about a job before the technician types anything.
 *
 * Two small vocabularies map the schedule's words onto the forms' words. They
 * are separate because they answer different questions — which form to start,
 * and which treatment that job records — and because only one of them touches
 * wording the business owns: a treatment name is a business's own option list
 * and may be renamed, so every value here is checked against the template's
 * live options before it is used (`seedFromContext`), never trusted blind.
 */

/**
 * The form a job of this type usually produces.
 *
 * A suggestion, not a rule: the picker still offers every form, and a
 * technician who starts the "wrong" one has lost nothing. Absent job types
 * (Bed Bugs) fall through to no suggestion rather than to a wrong one.
 *
 * A job for several services asks this of each (`suggestReports`): a general
 * pest treatment with a termite inspection is a Service Report AND a Timber
 * Pest Inspection.
 */
const TEMPLATE_BY_JOB_TYPE: Partial<Record<string, TemplateId>> = {
  'General Pest Control': 'serviceReport',
  Rodents: 'serviceReport',
  Ants: 'serviceReport',
  Cockroaches: 'serviceReport',
  Spiders: 'serviceReport',
  Wasps: 'serviceReport',
  'Termite Inspection': 'timberPestInspection',
  'Termite Treatment': 'termiteManagementCert',
}

/** One service's form, or null when it has none. */
function templateForService(service: string): TemplateId | null {
  const direct = lookUp(TEMPLATE_BY_JOB_TYPE, service)
  // Never suggest a form that can no longer be started — a retired template
  // would send the technician into a picker that refuses them.
  if (direct && CREATABLE_TEMPLATES.some((t) => t.id === direct)) return direct
  // A business that renames a job type ("Rodent Bait Top-Up") still gets the
  // obvious answer, without a table entry per wording.
  const lower = service.toLowerCase()
  if (lower.includes('termite') && lower.includes('inspect'))
    return 'timberPestInspection'
  if (lower.includes('termite')) return 'termiteManagementCert'
  if (lower.includes('timber') || lower.includes('borer'))
    return 'timberPestInspection'
  return null
}

/** A form a job produces, and which of the job's services it is for. */
export type ReportSuggestion = {
  templateId: TemplateId
  services: Array<string>
}

/**
 * Every form a job's services produce, each once, in the order the services
 * are listed — so the first is the one the job's first service needs.
 */
export function suggestReports(
  jobType: string | undefined,
): Array<ReportSuggestion> {
  const suggestions: Array<ReportSuggestion> = []
  for (const service of splitJobTypes(jobType)) {
    const templateId = templateForService(service)
    if (!templateId) continue
    const known = suggestions.find((s) => s.templateId === templateId)
    if (known) known.services.push(service)
    else suggestions.push({ templateId, services: [service] })
  }
  return suggestions
}

/** The forms alone, in the same order. Empty when no service has a form. */
export function suggestTemplates(
  jobType: string | undefined,
): Array<TemplateId> {
  return suggestReports(jobType).map((s) => s.templateId)
}

/** The first of them: the form a job of one service produces. */
export function suggestTemplate(
  jobType: string | undefined,
): TemplateId | null {
  return suggestTemplates(jobType)[0] ?? null
}

/**
 * The treatment a job of this type records on a service report, in the Service
 * Report's own words.
 *
 * Only the unambiguous ones. "Rodents" is a treatment on the form; "Bed Bugs"
 * is not on it at all, and guessing "Other" would be a wrong answer dressed as
 * a helpful one — the technician can see the list.
 */
const TREATMENT_BY_JOB_TYPE: Partial<Record<string, string>> = {
  'General Pest Control': 'General Pest Control',
  Rodents: 'Rodents',
  Ants: 'Ant Full Block Spray',
  Cockroaches: 'Cockroach Treatment',
  Spiders: 'Spider Spray External',
  Wasps: 'Wasps',
}

/**
 * Every treatment a job's services record, each once, in the order the
 * services are listed: "General Pest Control, Rodents" starts a service
 * report on both.
 */
export function treatmentsForJobType(
  jobType: string | undefined,
): Array<string> {
  const treatments: Array<string> = []
  for (const service of splitJobTypes(jobType)) {
    const treatment = lookUp(TREATMENT_BY_JOB_TYPE, service)
    if (treatment && !treatments.includes(treatment)) treatments.push(treatment)
  }
  return treatments
}

/** The first of them: the treatment a job of one service records. */
export function treatmentForJobType(
  jobType: string | undefined,
): string | null {
  return treatmentsForJobType(jobType)[0] ?? null
}

/**
 * A table's entry for a service as someone typed it: in any case ("rodents"
 * is Rodents), and never an entry it inherits — looked up plainly, "toString"
 * finds a function.
 */
function lookUp<T>(
  table: Partial<Record<string, T>>,
  service: string,
): T | undefined {
  const wanted = service.toLowerCase()
  for (const [name, value] of Object.entries(table)) {
    if (name.toLowerCase() === wanted) return value
  }
  return undefined
}

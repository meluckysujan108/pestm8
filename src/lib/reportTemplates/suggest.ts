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

export function suggestTemplate(jobType: string | undefined): TemplateId | null {
  if (!jobType) return null
  const direct = TEMPLATE_BY_JOB_TYPE[jobType]
  // Never suggest a form that can no longer be started — a retired template
  // would send the technician into a picker that refuses them.
  if (direct && CREATABLE_TEMPLATES.some((t) => t.id === direct)) return direct
  // A business that renames a job type ("Rodent Bait Top-Up") still gets the
  // obvious answer, without a table entry per wording.
  const lower = jobType.toLowerCase()
  if (lower.includes('termite') && lower.includes('inspect')) return 'timberPestInspection'
  if (lower.includes('termite')) return 'termiteManagementCert'
  if (lower.includes('timber') || lower.includes('borer')) return 'timberPestInspection'
  return null
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

export function treatmentForJobType(jobType: string | undefined): string | null {
  return (jobType && TREATMENT_BY_JOB_TYPE[jobType]) || null
}

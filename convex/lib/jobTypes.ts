/**
 * A job can be for several services at once — a general pest treatment with a
 * termite inspection and a rodent baiting is one visit, one price, one person
 * at the door. They are stored as one label, the services joined by a comma:
 * "General Pest Control, Termite Inspection, Rodents".
 *
 * One string rather than an array, on purpose. Everything that shows a job
 * already shows `jobType` — the card, the sheet's title, the week view, a
 * note's job link, the Recycle bin, a report's "Suggested for" — and each of
 * them reads right with the joined label unchanged. A series copies it onto
 * every visit, the bin restores it, and a phone still running last week's
 * build shows it and saves it back untouched. A second field would have to be
 * kept in step with the first by every one of those paths.
 *
 * What does need the services one by one — which report each produces, which
 * treatment a report starts on, the analytics count — splits the label here.
 * A comma is the one thing a service's name cannot hold: typed into a job
 * type, "Possums, rats" is two services. No job type in production held one
 * when this was introduced (checked 2026-09-29), so no stored label changes
 * meaning.
 */

/** Between two services in a job's label. */
export const JOB_TYPE_SEPARATOR = ', '

/**
 * The services a job is for, in the order they were chosen: each trimmed,
 * with its inner spaces collapsed, blanks dropped, and each named once
 * (ignoring case).
 */
export function splitJobTypes(label: string | undefined | null): Array<string> {
  if (!label) return []
  const seen = new Set<string>()
  const types: Array<string> = []
  for (const part of label.split(',')) {
    const type = part.replace(/\s+/g, ' ').trim()
    const key = type.toLowerCase()
    if (!type || seen.has(key)) continue
    seen.add(key)
    types.push(type)
  }
  return types
}

/** The same list, tidied the same way — a name typed with a comma in it becomes two. */
export function normaliseJobTypes(types: ReadonlyArray<string>): Array<string> {
  return splitJobTypes(types.join(','))
}

/** The label a job stores for these services. */
export function joinJobTypes(types: ReadonlyArray<string>): string {
  return normaliseJobTypes(types).join(JOB_TYPE_SEPARATOR)
}

// ——— A business's own list ————————————————————————————————————————————
//
// The services New Job offers are the business's own (Settings → Job types,
// `convex/jobTypes.ts`). A business that has never changed its list has no
// rows at all and is offered DEFAULT_JOB_TYPES, so nothing is migrated and a
// business that never opens the page sees exactly what it always has.
//
// A label stays one string (above). The list is what a label's services are
// checked against: which spelling is the business's own, which report each
// service produces, and — after a rename — which old name means which new one.

/** The form a service produces, or none. The built-in forms a report is started on. */
export type JobTypeReport =
  'serviceReport' | 'timberPestInspection' | 'termiteManagementCert' | 'none'

export const JOB_TYPE_REPORTS: ReadonlyArray<JobTypeReport> = [
  'serviceReport',
  'timberPestInspection',
  'termiteManagementCert',
  'none',
]

/** One service on the list, as everything that reads the list sees it. */
export type JobTypeEntry = {
  name: string
  report: JobTypeReport
  /** On the list and offered by New Job; false once deleted. */
  offered: boolean
  /** The names it had before a rename or a merge, newest last. */
  formerNames: ReadonlyArray<string>
}

/** Longest name a service may have — a phone's picker row, not an essay. */
export const MAX_JOB_TYPE_LENGTH = 60
/** How many services a list may offer at once. */
export const MAX_OFFERED_JOB_TYPES = 60
/** How many rows a list may hold, deleted ones included. */
export const MAX_JOB_TYPE_ROWS = 200
/** Old names remembered per service. */
export const MAX_FORMER_NAMES = 10

/**
 * The list every business starts with — the nine New Job always offered — and
 * the form each one produces, as `suggest.ts`'s table has always said. Bed Bugs
 * has no form: the Service Report has no treatment for it.
 */
export const DEFAULT_JOB_TYPES: ReadonlyArray<JobTypeEntry> = (
  [
    ['General Pest Control', 'serviceReport'],
    ['Rodents', 'serviceReport'],
    ['Termite Inspection', 'timberPestInspection'],
    ['Termite Treatment', 'termiteManagementCert'],
    ['Ants', 'serviceReport'],
    ['Cockroaches', 'serviceReport'],
    ['Spiders', 'serviceReport'],
    ['Bed Bugs', 'none'],
    ['Wasps', 'serviceReport'],
  ] as const
).map(([name, report]) => ({ name, report, offered: true, formerNames: [] }))

/** A name as it is kept: inner spaces collapsed, ends trimmed. */
export function tidyJobTypeName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim()
}

/** What two names are compared by: the same service whatever its capitals. */
export function jobTypeKey(name: string): string {
  return tidyJobTypeName(name).toLowerCase()
}

/**
 * Why a name cannot be a service, or null when it can. A comma is the one
 * thing a service's name cannot hold (it is what separates services).
 */
export function jobTypeNameProblem(
  raw: string,
): 'JOB_TYPE_EMPTY' | 'JOB_TYPE_TOO_LONG' | 'JOB_TYPE_COMMA' | null {
  const name = tidyJobTypeName(raw)
  if (name.length === 0) return 'JOB_TYPE_EMPTY'
  if (name.length > MAX_JOB_TYPE_LENGTH) return 'JOB_TYPE_TOO_LONG'
  if (name.includes(',')) return 'JOB_TYPE_COMMA'
  return null
}

/**
 * The list entry a service on a job means: by its name in any capitals, or by
 * a name it had before. A current name wins over someone else's old one.
 */
export function findJobType<
  T extends Pick<JobTypeEntry, 'name' | 'formerNames'>,
>(entries: ReadonlyArray<T>, service: string): T | undefined {
  const key = jobTypeKey(service)
  return (
    entries.find((entry) => jobTypeKey(entry.name) === key) ??
    entries.find((entry) =>
      entry.formerNames.some((former) => jobTypeKey(former) === key),
    )
  )
}

/**
 * A job's label in the business's own words: each service the list knows
 * spelled as the list spells it ("rodents" is Rodents), a renamed one under
 * its new name, anything else as typed — then tidied (`joinJobTypes`).
 *
 * `swap` replaces one service with others: a service typed into a job, swapped
 * for ones on the list ("Gpc & Tpi" → General Pest Control, Termite
 * Inspection).
 *
 * The label comes back untouched when nothing in it changes, so a job saved
 * long ago is not rewritten for its spacing alone.
 */
export function canonicalJobTypeLabel(
  label: string,
  entries: ReadonlyArray<Pick<JobTypeEntry, 'name' | 'formerNames'>>,
  swap?: { from: string; to: ReadonlyArray<string> },
): string {
  const services = splitJobTypes(label)
  if (services.length === 0) return label
  const swapKey = swap ? jobTypeKey(swap.from) : null
  let changed = false
  const next: Array<string> = []
  for (const service of services) {
    if (swap && jobTypeKey(service) === swapKey) {
      changed = true
      // Each as the list names it now: one renamed since the swap was asked
      // for is written under its new name, not the one the swap carried.
      next.push(
        ...swap.to.map((name) => findJobType(entries, name)?.name ?? name),
      )
      continue
    }
    const entry = findJobType(entries, service)
    if (entry && entry.name !== service) changed = true
    next.push(entry?.name ?? service)
  }
  return changed ? joinJobTypes(next) : label
}

/** Most jobs Settings → Job types reads to count what each service is on. */
export const MAX_JOBS_COUNTED = 4000

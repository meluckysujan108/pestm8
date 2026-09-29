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

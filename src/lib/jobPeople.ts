/**
 * Everyone on a job as the app draws them: its lead ("Assigned to") first,
 * then the people also going (convex/lib/jobPeople.ts), each with their own
 * colour. Pure, and light enough for the job card.
 */

export type PersonOnJob = { name: string; colour: string }

export function everyoneOnJob(job: {
  assigneeName?: string
  assigneeColour: string
  /** Absent from a backend older than shared jobs: then just the lead. */
  alsoGoing?: ReadonlyArray<{ name: string; colour: string }>
}): Array<PersonOnJob> {
  return [
    ...(job.assigneeName
      ? [{ name: job.assigneeName, colour: job.assigneeColour }]
      : []),
    ...(job.alsoGoing ?? []).filter((person) => person.name !== ''),
  ]
}

/** "Terence", "Terence and Kevin", "Terence, Kevin and Sam". */
export function namesOf(people: ReadonlyArray<{ name: string }>): string {
  const names = people.map((person) => person.name)
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** A person's first name, for a card row where space is short. */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name
}

/**
 * What the "Also going" picker says once as many are ticked as a job can take
 * (the edit form and New Job alike): why a tap on anyone else does nothing,
 * and how to make room. `leadName` is "you" on the lead's own job.
 */
export function alsoGoingFullLabel(leadName: string, max: number): string {
  return `That’s ${max}, the most who can go with ${leadName}. Untick someone to choose someone else.`
}

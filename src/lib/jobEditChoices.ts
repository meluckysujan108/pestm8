/**
 * What the job sheet's Edit offers: the job itself, its client, and the
 * property it is at, each a row in the Edit sheet (JobEditChooser) saying
 * what it changes and where. With only the job to edit, Edit opens its form
 * as it always has.
 *
 * Pure, and nothing from `#/`, so e2e can import the button's and the rows'
 * names from here.
 */

import { detailsLocked } from '../../convex/lib/jobStatus'

export type JobEditTarget = 'job' | 'client' | 'property'

/** The job as `jobs.get` answers it, as far as its Edit is concerned. */
export type EditableJob = {
  canEdit: boolean
  status: string
  pricesHidden?: boolean
  property?: {
    addressLine: string
    deletedAt?: number
    client: {
      name: string
      kind: 'person' | 'business'
      deletedAt?: number
    } | null
  } | null
}

export type JobEditChoice = {
  target: JobEditTarget
  /** "Client details": the row's name starts with it. */
  title: string
  /** What it changes, and where: "Name, phone and email — on all of J.
   * Nguyen’s jobs." */
  line: string
}

/**
 * The rows, in order: Job, Client, Property. None where the job's Edit
 * doesn't show — someone else's job seen read-only, or an invoiced one (the
 * same rule the kept copy's stand-in mirrors, KeptJobView `UnseenEdit`).
 * The client and the property only while the job still has them: binning a
 * client bins its sites and their jobs, so live data never gets here, but a
 * row must never open a form on a record that is gone.
 */
export function jobEditChoices(job: EditableJob): Array<JobEditChoice> {
  if (!job.canEdit || detailsLocked(job.status)) return []
  const choices: Array<JobEditChoice> = [
    {
      target: 'job',
      title: 'Job details',
      // "This job", not "this job only": the same form can make it a
      // recurring service.
      line: job.pricesHidden
        ? 'Date, times, property and who’s going — this job.'
        : 'Date, times, property, who’s going and price — this job.',
    },
  ]
  const property = job.property
  const client = property?.client
  if (client && client.deletedAt === undefined) {
    choices.push({
      target: 'client',
      title: 'Client details',
      // "Main phone": a business's contact person has a number of their
      // own, in Contacts, which this form doesn't change.
      line:
        client.kind === 'business'
          ? `Name, contact person, main phone and email — on all of ${client.name}’s jobs.`
          : `Name, phone and email — on all of ${client.name}’s jobs.`,
    })
  }
  if (property && property.deletedAt === undefined) {
    choices.push({
      target: 'property',
      title: 'Property details',
      line:
        client?.kind === 'business'
          ? `Correct the address or site contact — on every job at ${property.addressLine}.`
          : `Correct the address — on every job at ${property.addressLine}.`,
    })
  }
  return choices
}

/**
 * The Edit button's name. Always "Edit job…", so the word on the button is
 * the first thing heard and one pattern (`EDIT_TRIGGER`) finds it whatever
 * else it offers.
 */
export function editTriggerLabel(
  choices: ReadonlyArray<JobEditChoice>,
): string {
  const has = (target: JobEditTarget) =>
    choices.some((choice) => choice.target === target)
  if (has('client') && has('property')) return 'Edit job, client or property'
  if (has('client')) return 'Edit job or client'
  if (has('property')) return 'Edit job or property'
  return 'Edit job details'
}

/** The job sheet's Edit button, whichever rows it offers. */
export const EDIT_TRIGGER = /^Edit job/

/** Each row of the Edit sheet, by the start of its name. */
export const EDIT_ROW: Record<JobEditTarget, RegExp> = {
  job: /^Job details/,
  client: /^Client details/,
  property: /^Property details/,
}

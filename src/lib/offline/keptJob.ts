import type { LineDown } from './keeper'

/**
 * The job sheet with no answer from PestM8 (JobDetailSheet.tsx): when it
 * shows the job as its day lists it instead (`KeptJobView`), and what it
 * says about that. Pure, so the rules can be tested without a sheet.
 *
 * The sheet reads `jobs.get`, which is never kept: one subscription per job
 * opened would be one more for every job on every phone. A day the phone
 * keeps, or one in memory, already lists the job with what a technician
 * needs at the door, so with no answer the sheet shows that, read-only.
 */

/** How long the sheet waits for PestM8 on a line that looks up before it
 * shows the job from its day: about as long as a thumb waits on a sheet
 * before deciding it is stuck. */
export const KEPT_JOB_WAIT_MS = 3_000

/**
 * What the sheet shows while `jobs.get` has no answer and no refusal:
 * - `waiting`: its own placeholder. The line is up and the wait isn't over;
 *   or the day that lists the job is live, so PestM8 is answering on this
 *   line and the job is on its way; or the phone has nothing else to show,
 *   which on a line that looks up is ConnectionNotice's to say; or the
 *   phone's copy is still being read.
 * - `kept`: the job as a day lists it. Once shown, kept up while the answer
 *   is still to come, even with the line back, so the placeholder never
 *   comes back over a job already on screen.
 * - `not-kept`: with the line down, that the job isn't on this phone.
 */
export type KeptJobState = 'waiting' | 'kept' | 'not-kept'

export function keptJobState(at: {
  /** Why the line is down, or null while it is up (`useLineDown`). */
  down: LineDown | null
  /** The wait is over (KEPT_JOB_WAIT_MS), or the line has been down since
   * the sheet opened. */
  waitedOut: boolean
  /** The sheet has already shown the job from its day. */
  shown: boolean
  /** A day lists the job, in memory or kept on the phone. */
  found: boolean
  /** That day is live: pushed on this connection, which is still talking. */
  live: boolean
  /** The phone's copy has been read, or given up on, this page load. */
  copyRead: boolean
}): KeptJobState {
  if (at.shown && at.found) return 'kept'
  if (at.down === null) {
    return at.waitedOut && at.found && !at.live ? 'kept' : 'waiting'
  }
  if (at.found) return 'kept'
  return at.copyRead ? 'not-kept' : 'waiting'
}

/**
 * The day's listing of the job, if the day is this business's: a phone that
 * has switched business can still hold the last one's days in memory.
 */
export function dayOfBusiness<T extends { row: { businessId: string } }>(
  found: T | null,
  businessId: string,
): T | null {
  return found !== null && found.row.businessId === businessId ? found : null
}

/**
 * The line on a job shown from its day, under where it is and who to call:
 * why, how old it is (`formatUpdated`'s "9:42am"), and that it can't be
 * changed. The words for a line that can't reach PestM8 are the "Updated"
 * note's (KeptCopyNote), and stand for a sheet whose answer is late on a
 * line that looks up too.
 */
export function keptJobInset(down: LineDown | null, updated: string): string {
  return down === 'no-signal'
    ? `No signal — showing the copy kept on this phone, updated ${updated}. Editing needs signal.`
    : `Could not reach PestM8 — showing the kept copy, updated ${updated}. Editing needs signal.`
}

/** Said in the sheet's place with the line down, when no day the phone
 * holds lists the job. */
export const NOT_KEPT_JOB =
  'This job isn’t on this phone. It opens when you have signal.'

/**
 * Said under a job's status, on the live sheet and on one shown from its
 * day alike: the two are laid out alike down to the property's Call, so it
 * doesn't move when PestM8 answers. One for a job this person may not edit,
 * one for a job invoiced.
 */
export const SOMEONE_ELSES_JOB =
  'This job is assigned to someone else, so it is read-only.'
export const INVOICED_LOCKED =
  'This job has been invoiced, so its details are locked. Change its status to edit them.'

/**
 * Whether the live sheet would say the job is someone else's
 * (`SOMEONE_ELSES_JOB`, its `canEdit` false, and no Edit or status menu), as
 * far as the phone can tell. The server's rule (`canEditJob`,
 * convex/lib/capabilities.ts) is the account being worked in's: an owner may
 * edit any job, anyone on a job may edit it, and a contractor may edit their
 * own team's. The roster says that account's role, when it isn't the
 * person's own, and whom it may book onto (`bookable`: for a contractor,
 * themselves and their team, the team `canEditJob` reads). Anything unknown
 * (no access or roster in memory, a roster without `bookable`) is taken as
 * the live sheet most often has it: editable, with no line.
 */
export function keptJobReadOnly(
  access:
    | {
        membershipId: string
        role: string
        actingAs: { membershipId: string } | null
      }
    | undefined,
  roster:
    | ReadonlyArray<{ _id: string; role: string; bookable?: boolean }>
    | undefined,
  job: {
    assignedMembershipId: string
    alsoGoing: ReadonlyArray<{ _id: string }>
  },
): boolean {
  if (!access) return false
  const acting = access.actingAs?.membershipId ?? access.membershipId
  const role =
    access.actingAs === null
      ? access.role
      : roster?.find((member) => member._id === acting)?.role
  const onJob = [
    job.assignedMembershipId,
    ...job.alsoGoing.map((person) => person._id),
  ]
  if (onJob.includes(acting)) return false
  if (role === 'subcontractor') return true
  if (role !== 'contractor' || !roster) return false
  return !roster.some(
    (member) => onJob.includes(member._id) && member.bookable !== false,
  )
}

/**
 * The client's number, for the job's Property card, where the live sheet
 * has it beside their name ("Client #1916"): the day's row names the site,
 * and the client list (`clients.directory`) says whose it is. Undefined
 * where the list doesn't say: then the name has the row to itself, and
 * where it is long, wraps a line later than on the live sheet.
 */
export function keptClientNumber(
  directory:
    | {
        clients: ReadonlyArray<{ _id: string; clientNumber?: number }>
        sites: ReadonlyArray<{ _id: string; clientId: string }>
      }
    | undefined,
  propertyId: string,
): number | undefined {
  const site = directory?.sites.find((each) => each._id === propertyId)
  if (!site) return undefined
  return directory?.clients.find((client) => client._id === site.clientId)
    ?.clientNumber
}

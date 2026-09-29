import { ConvexError } from 'convex/values'

/**
 * Room for what a job's note is for — "Tenant home after 10, ring first. Side
 * gate code 4411. Dog in the back yard." — several times over, and short
 * enough that a pasted email thread is refused rather than carried on every
 * card that shows the job.
 */
export const MAX_JOB_NOTES_LENGTH = 1000

/**
 * A job's note as stored: one kind of line ending, trimmed, and absent when
 * blank. `undefined` in means "not given"; a blank string means "none", which
 * callers use to clear one.
 */
export function normaliseJobNotes(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const text = raw.replace(/\r\n?/g, '\n').trim()
  if (!text) return undefined
  if (text.length > MAX_JOB_NOTES_LENGTH) {
    throw new ConvexError('NOTES_TOO_LONG')
  }
  return text
}

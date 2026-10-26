import { ConvexError, v } from 'convex/values'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'

/**
 * Request ids made on the phone, so a save sent twice is made once.
 *
 * On one bar, a booking can reach the server and its answer never come back:
 * the phone cannot tell "not saved" from "saved, but I didn't hear", and the
 * only safe thing it can do is send it again. So each draft carries an id the
 * phone made (`crypto.randomUUID()`), sent with every attempt, and the record
 * the first attempt made keeps it. A later attempt with the same id finds that
 * record and gets its id back, and nothing else happens.
 *
 * Scoped by business, behind the membership check. Not by member: a v4 UUID
 * can't be guessed, and a job keeps no record of who made it. Each kind of
 * record is looked up in its own table only — a job's id among jobs, a
 * site's among sites — so a key seen on one record (every member reads them)
 * and sent again for another kind makes that one, under the sender's own
 * rights, and never changes what the first answers.
 *
 * Optional on every mutation that takes one, so every older screen still
 * saves exactly as before.
 *
 * Looked up before every check the handler makes, but not before Convex's
 * own argument validation, which runs first. So the arguments of
 * `jobs.create`, `recurrences.create`, `properties.create` and
 * `properties.createForClient` may only ever be widened: a field a phone's
 * held save still carries, dropped or narrowed, refuses that save's repeat
 * (an ArgumentValidationError, not a ConvexError) before its lookup can
 * answer it. That includes the ones only a booking kept on the phone sends
 * (lib/outboxGuards.ts): `asMembership` on both bookings, and
 * `refuseBackfill` on `recurrences.create`. Like every other check, theirs
 * come after the lookup. `convex/outboxArgs.test.ts` sends the bookings a
 * phone keeps, written out as the first phones to keep them do.
 *
 * And once any row carries an id, a schema without the field (or without
 * `wipedClientRequests`) can't be pushed to that deployment: Convex checks
 * the documents already there. Every branch pushed to a shared deployment
 * must have them, and a rollback must keep them.
 */
export const clientRequestIdArg = v.optional(v.string())

/** Lower-case only, as the phone makes them: one spelling per id. */
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/**
 * The id as sent, or INVALID_REQUEST_ID. Checked before anything is read or
 * written: anything else (a counter, a timestamp, a draft's own key) could be
 * sent again for a different booking and be answered with this one's record.
 */
export function checkClientRequestId(raw: string): string
export function checkClientRequestId(
  raw: string | undefined,
): string | undefined
export function checkClientRequestId(
  raw: string | undefined,
): string | undefined {
  if (raw === undefined) return undefined
  if (!UUID.test(raw)) throw new ConvexError('INVALID_REQUEST_ID')
  return raw
}

/** What a request made: the record, or only its id once a wipe took it. */
export type Made<T extends 'jobs' | 'recurrences' | 'properties'> = {
  id: Id<T>
  row: Doc<T> | null
}

/** The three kinds of record a request id can make, as `find` names them. */
export type RequestKind = Doc<'wipedClientRequests'>['kind']

// A record made and since put in the Recycle bin was still made, so none of
// the three filters on `deletedAt`; and one wiped for good was still made,
// so each asks `wipedClientRequests` when the record is gone. Sending it
// again must not make it again either way: the owner's delete stands.

function wipedBy(
  ctx: QueryCtx,
  businessId: Id<'businesses'>,
  kind: RequestKind,
  clientRequestId: string,
) {
  return ctx.db
    .query('wipedClientRequests')
    .withIndex('by_businessId_and_kind_and_clientRequestId', (q) =>
      q
        .eq('businessId', businessId)
        .eq('kind', kind)
        .eq('clientRequestId', clientRequestId),
    )
    .first()
}

/** The job a request made in this business, if it made one. */
export async function jobMadeBy(
  ctx: QueryCtx,
  businessId: Id<'businesses'>,
  clientRequestId: string,
): Promise<Made<'jobs'> | null> {
  const row = await ctx.db
    .query('jobs')
    .withIndex('by_businessId_and_clientRequestId', (q) =>
      q.eq('businessId', businessId).eq('clientRequestId', clientRequestId),
    )
    .first()
  if (row) return { id: row._id, row }
  const wiped = await wipedBy(ctx, businessId, 'job', clientRequestId)
  return wiped?.kind === 'job' ? { id: wiped.id, row: null } : null
}

/** The Recurring Job a request made in this business, if it made one. */
export async function seriesMadeBy(
  ctx: QueryCtx,
  businessId: Id<'businesses'>,
  clientRequestId: string,
): Promise<Made<'recurrences'> | null> {
  const row = await ctx.db
    .query('recurrences')
    .withIndex('by_businessId_and_clientRequestId', (q) =>
      q.eq('businessId', businessId).eq('clientRequestId', clientRequestId),
    )
    .first()
  if (row) return { id: row._id, row }
  const wiped = await wipedBy(ctx, businessId, 'series', clientRequestId)
  return wiped?.kind === 'series' ? { id: wiped.id, row: null } : null
}

/** The site a request made in this business, if it made one. */
export async function propertyMadeBy(
  ctx: QueryCtx,
  businessId: Id<'businesses'>,
  clientRequestId: string,
): Promise<Made<'properties'> | null> {
  const row = await ctx.db
    .query('properties')
    .withIndex('by_businessId_and_clientRequestId', (q) =>
      q.eq('businessId', businessId).eq('clientRequestId', clientRequestId),
    )
    .first()
  if (row) return { id: row._id, row }
  const wiped = await wipedBy(ctx, businessId, 'site', clientRequestId)
  return wiped?.kind === 'site' ? { id: wiped.id, row: null } : null
}

/**
 * Before a wipe deletes a record a request made: what it made, kept, so a
 * repeat still finds it (`wipedClientRequests`). Nothing for a record that
 * carries no id. Called in the transaction that deletes it, so the two go
 * together or not at all.
 */
export async function keepWipedRequest(
  ctx: MutationCtx,
  record: { businessId: Id<'businesses'>; clientRequestId?: string },
  made:
    | { kind: 'job'; id: Id<'jobs'> }
    | { kind: 'series'; id: Id<'recurrences'> }
    | { kind: 'site'; id: Id<'properties'> },
): Promise<void> {
  if (record.clientRequestId === undefined) return
  await ctx.db.insert('wipedClientRequests', {
    businessId: record.businessId,
    clientRequestId: record.clientRequestId,
    wipedAt: Date.now(),
    ...made,
  })
}

/**
 * A repeat is answered with the record already made, never compared and
 * refused: refusing would leave a booking the server holds looking unsent on
 * the phone. Logged so a phone sending a changed draft under one id can be
 * found — the names of the fields that differ, never their values, which
 * are a client's details.
 *
 * Compared with the record as it is now, not with what the first send
 * carried, so an edit made since (the office moved the job, a removed
 * member's work was reassigned, a merge moved the site to another client) is
 * logged too, and so is a field the save rewrote (a job type stored under the
 * name the list gives it). A line here is a lead, not proof of a bug on the
 * phone. A record wiped for good has nothing left to compare.
 *
 * A field not sent is not compared.
 */
export function noteRepeat(
  table: string,
  existing: Record<string, unknown>,
  sent: Record<string, unknown>,
  fields: ReadonlyArray<string>,
): void {
  const differ = fields.filter(
    (field) => sent[field] !== undefined && sent[field] !== existing[field],
  )
  if (differ.length > 0) {
    console.warn('clientRequest repeat differs', { table, fields: differ })
  }
}

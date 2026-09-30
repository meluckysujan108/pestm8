import { ConvexError, v } from 'convex/values'
import type { Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'

/**
 * A client's number, status and tags: the rules every writer shares — the
 * client form (`clients.update`), a new client (`properties.ts`) and an
 * import (`clientImports.ts`, checked first by `lib/clientImport.ts`).
 */

// ---------------------------------------------------------------- status

export const CLIENT_STATUSES = ['active', 'lead', 'inactive'] as const
export type ClientStatus = (typeof CLIENT_STATUSES)[number]

export const clientStatus = v.union(
  v.literal('active'),
  v.literal('lead'),
  v.literal('inactive'),
)

export const STATUS_LABELS: Record<ClientStatus, string> = {
  active: 'Active',
  lead: 'Lead',
  inactive: 'Inactive',
}

/** A status as a spreadsheet or another app writes it ("Active", "Prospect",
 * "Archived"), or null when it isn't one. */
export function statusFromText(text: string): ClientStatus | null {
  const word = text.trim().toLowerCase()
  if (/^(?:active|current|open|live|customer|client|yes|y)$/.test(word)) {
    return 'active'
  }
  if (
    /^(?:lead|leads|prospect|enquiry|inquiry|quote|quoted|potential|new lead)$/.test(
      word,
    )
  ) {
    return 'lead'
  }
  if (
    /^(?:inactive|archived?|closed|former|past|lost|cancel+ed|deleted|dormant|no|n|do not service)$/.test(
      word,
    )
  ) {
    return 'inactive'
  }
  return null
}

// ---------------------------------------------------------------- tags

export const MAX_TAGS = 20
export const MAX_TAG_LENGTH = 40

/**
 * Tags as stored: each trimmed and spaced once, blanks gone, one of each
 * whatever its capitals (the first spelling kept). Too many, or one too
 * long, is refused — a tag is a word or two, and a client with more than
 * twenty has stopped being filtered by them.
 */
export function normaliseTags(tags: ReadonlyArray<string>): Array<string> {
  const out: Array<string> = []
  const seen = new Set<string>()
  for (const raw of tags) {
    const tag = raw.replace(/\s+/g, ' ').trim()
    if (!tag) continue
    if (tag.length > MAX_TAG_LENGTH) throw new ConvexError('TAG_TOO_LONG')
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  if (out.length > MAX_TAGS) throw new ConvexError('TOO_MANY_TAGS')
  return out
}

/** A spreadsheet cell of tags: "GPC, Rodents; Real estate". */
export function tagsFromText(text: string): Array<string> {
  return text
    .split(/[,;|\n]/)
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

// ---------------------------------------------------------------- number

export const MAX_CLIENT_NUMBER = 999_999_999

export function isClientNumber(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= MAX_CLIENT_NUMBER
}

/** A number as a spreadsheet writes it: "1916", "#1916", "1916.0". */
export function clientNumberFromText(text: string): number | null {
  const m = /^#?\s*(\d{1,9})(?:\.0+)?$/.exec(text.trim())
  if (!m) return null
  const n = Number(m[1])
  return isClientNumber(n) ? n : null
}

/** The client of this business with this number, if any. */
export async function clientWithNumber(
  ctx: QueryCtx,
  businessId: Id<'businesses'>,
  clientNumber: number,
) {
  return ctx.db
    .query('clients')
    .withIndex('by_business_and_clientNumber', (q) =>
      q.eq('businessId', businessId).eq('clientNumber', clientNumber),
    )
    .first()
}

/**
 * Where the business's running count stands: its stored `nextClientNumber`,
 * or — for a business that has not numbered a client since the count began —
 * one past the highest number in use. Binned clients are in the index, so a
 * client waiting in the Recycle bin still holds its number.
 */
async function countFrom(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
): Promise<number> {
  const business = await ctx.db.get(businessId)
  if (business?.nextClientNumber !== undefined) return business.nextClientNumber
  const highest = await ctx.db
    .query('clients')
    .withIndex('by_business_and_clientNumber', (q) =>
      q.eq('businessId', businessId).gte('clientNumber', 1),
    )
    .order('desc')
    .first()
  return (highest?.clientNumber ?? 0) + 1
}

/**
 * Moves the count past a number that has just been taken — handed out, kept
 * from an import, or set by hand — so it is never handed out again. Never
 * moves it back.
 */
export async function claimClientNumber(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  taken: number,
): Promise<void> {
  const next = await countFrom(ctx, businessId)
  await ctx.db.patch(businessId, {
    nextClientNumber: Math.max(next, taken + 1),
  })
}

/**
 * The number a new client gets: the one asked for when it is free (an import
 * keeping the numbers its old system gave), otherwise the next from the
 * business's running count (`businesses.nextClientNumber`), stepping over
 * any number already held. Counted, not read off the highest in use: a client
 * wiped from the Recycle bin, or taken back by an import's Undo, used to give
 * its number to the next new client.
 *
 * Read and written inside the inserting mutation, so two clients made at once
 * can't both get one number: the second transaction sees the first's write
 * and retries.
 */
export async function assignClientNumber(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  wanted?: number,
): Promise<number> {
  if (wanted !== undefined && isClientNumber(wanted)) {
    const holder = await clientWithNumber(ctx, businessId, wanted)
    if (!holder) {
      await claimClientNumber(ctx, businessId, wanted)
      return wanted
    }
  }
  let number = await countFrom(ctx, businessId)
  // A number set by hand or kept from an import can sit ahead of the count.
  while (await clientWithNumber(ctx, businessId, number)) number++
  await ctx.db.patch(businessId, { nextClientNumber: number + 1 })
  return number
}

// ---------------------------------------------------------------- booking

/**
 * A lead becomes a client when work is booked for them: the client at this
 * property, if a lead, is made active. Called by the mutations that book —
 * `jobs.create`, `recurrences.create`, `recurrences.convertJobToRecurring`
 * and a job moved to another property in `jobs.update` — and never by the
 * recurrence engine, whose projected visits nobody has booked. An inactive
 * client is left inactive: that is a choice someone made.
 */
export async function activateLeadAt(
  ctx: MutationCtx,
  propertyId: Id<'properties'>,
): Promise<void> {
  const property = await ctx.db.get(propertyId)
  if (!property) return
  const client = await ctx.db.get(property.clientId)
  if (client?.status !== 'lead') return
  await ctx.db.patch(client._id, { status: 'active', updatedAt: Date.now() })
}

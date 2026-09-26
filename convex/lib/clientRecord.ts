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
 * The number a new client gets: the one asked for when it is free (an
 * import keeping the numbers its old system gave), otherwise one more than
 * the highest this business has used. Read from the index inside the
 * inserting mutation, so two clients made at once can't both get it — the
 * second transaction sees the first's and retries.
 */
export async function assignClientNumber(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  wanted?: number,
): Promise<number> {
  if (wanted !== undefined && isClientNumber(wanted)) {
    const holder = await clientWithNumber(ctx, businessId, wanted)
    if (!holder) return wanted
  }
  const highest = await ctx.db
    .query('clients')
    .withIndex('by_business_and_clientNumber', (q) =>
      q.eq('businessId', businessId).gte('clientNumber', 1),
    )
    .order('desc')
    .first()
  return (highest?.clientNumber ?? 0) + 1
}

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'

/**
 * A business client's contact person: its primary `clientContacts` row, the
 * one "who do we deal with here" (Prompt 6.1, `setContactPerson`). For the
 * job card's Contact line and the job sheet — the person to ask for when the
 * call reaches the business's own number, and the person rung when they have
 * a number of their own (`contactToCall` in lib/siteContact.ts).
 *
 * Null for a person client: they are their own contact, and one switched from
 * business to person keeps its contacts hidden, not shown (as its site
 * contacts are). Null too when nobody has the star, and for a contact in the
 * Recycle bin (lib/bin.ts).
 *
 * One indexed read per client, stopping at the star: a client's contacts are
 * a handful, but a day's list asks this for every business on it.
 */
export async function contactPersonOf(
  ctx: QueryCtx,
  client: Doc<'clients'> | null,
): Promise<{ name: string; phone: string | undefined } | null> {
  if (!client || client.kind !== 'business') return null
  const primary = await ctx.db
    .query('clientContacts')
    .withIndex('by_client', (q) => q.eq('clientId', client._id))
    .filter((q) =>
      q.and(
        q.eq(q.field('deletedAt'), undefined),
        q.eq(q.field('isPrimary'), true),
      ),
    )
    .first()
  const name = primary?.name.trim()
  if (!primary || !name) return null
  return { name, phone: primary.phone?.trim() || undefined }
}

import { isValidEmail } from './email'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'

/**
 * The addresses a business already corresponds with about this report.
 *
 * The recipient rule reads from here: a technician may send a report to the
 * people on the client's record, and anywhere else waits for an owner. That is
 * not distrust — a compliance document emailed to a typo is simply gone, and
 * the person who would notice a wrong address is the one who owns the client
 * relationship.
 *
 * Shared by `finalise` (which opens the deliveries the form asked for) and
 * `deliveries.request` (which opens the one a person asked for), because two
 * implementations of "is this address known?" would disagree the first time a
 * contact was added.
 */

/** Enough for a strata committee; far short of an unbounded read. */
const MAX_CONTACTS = 50

/** Case and surrounding space are not what makes two addresses different. */
export function normaliseAddress(address: string): string {
  return address.trim().toLowerCase()
}

export function normaliseAddresses(
  values: Array<string | undefined | null>,
): Array<string> {
  return [
    ...new Set(
      values
        .filter((value): value is string =>
          Boolean(value && value.trim() !== ''),
        )
        .map(normaliseAddress),
    ),
  ]
}

export async function knownRecipients(
  ctx: QueryCtx | MutationCtx,
  report: Doc<'reports'>,
  { withContacts = true }: { withContacts?: boolean } = {},
): Promise<Array<string>> {
  const property = await ctx.db.get(report.propertyId)
  const client = property ? await ctx.db.get(property.clientId) : null
  const contacts =
    client && withContacts
      ? await ctx.db
          .query('clientContacts')
          .withIndex('by_client', (q) => q.eq('clientId', client._id))
          // A contact in the Recycle bin gets no reports (lib/bin.ts).
          .filter((q) => q.eq(q.field('deletedAt'), undefined))
          .take(MAX_CONTACTS)
      : []
  const business = await ctx.db.get(report.businessId)

  return normaliseAddresses(
    [
      client?.email,
      ...contacts.map((contact) => contact.email),
      // The business's own copy address is always its own to use.
      business?.email,
      business?.reportCopyEmail,
    ].filter(deliverable),
  )
}

/**
 * Where a business keeps its own copy of every report it emails: its Business
 * copy address (Settings → Reports), else its business email. Every send
 * carries it as a blind copy (`blindCopy`), so the client never sees it.
 *
 * Null when the business has neither — or when the one it chose could never
 * be delivered to ("reports@coastal", saved before addresses were checked).
 * That is not a reason to send the copy to a different inbox than the one the
 * owner named, so it does not fall back past a bad Business copy address.
 */
export function businessCopyAddress(
  business: Pick<Doc<'businesses'>, 'email' | 'reportCopyEmail'> | null,
): string | null {
  const address =
    business?.reportCopyEmail?.trim() || business?.email?.trim() || ''
  return address !== '' && isValidEmail(address)
    ? normaliseAddress(address)
    : null
}

/**
 * Being on file is not the same as being right. An address saved before the
 * app checked them ("bob@gmail", "jan@hotmail..com") is the typo this rule
 * exists to catch, so it does not skip the owner's approval merely by having
 * been typed into the client record first.
 */
function deliverable(address: string | undefined): address is string {
  return address !== undefined && isValidEmail(address)
}

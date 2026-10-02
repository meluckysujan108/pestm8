import { isValidEmail } from './email'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'

/**
 * The addresses a business already corresponds with about this report.
 *
 * Nothing waits on this: since 29 Sept 2026 anyone who may send a report may
 * send it anywhere that can receive email. What it answers is which of a
 * send's addresses are new to this client — recorded on the delivery
 * (`newAddresses`) and pointed out by the Send and lock sheets, because a
 * compliance document emailed to a typo is simply gone, and an address the
 * business has never used is where a typo would be.
 *
 * Shared by `finalise` (which opens the delivery the form asked for) and
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

/** Someone a report could be sent to, as the client book names them. */
export type RecipientPerson = {
  address: string
  name: string
  /** The client themself, or one of their contacts. */
  kind: 'client' | 'contact'
  /** A contact's role as the client book has it ("Strata manager"). */
  role: string | null
  /** The client's primary contact (`clientContacts.isPrimary`). */
  primary: boolean
}

/**
 * Who a report is for, by name, for the Send sheet to offer: the client from
 * their record as it is NOW — an address added after the report was locked
 * included — and, where the caller may see the client book, the client's
 * contacts with an address. Addresses as stored, normalised; one that could
 * never be delivered to is still listed, for the sheet to show with its fix.
 *
 * `clientId` is there for "Save to the client's record", offered only when
 * the record has no address that can be delivered to and the caller may see
 * the client book.
 */
export async function recipientPeople(
  ctx: QueryCtx,
  report: Doc<'reports'>,
  { withContacts }: { withContacts: boolean },
): Promise<{
  client: { clientId: Id<'clients'>; name: string; hasEmail: boolean } | null
  people: Array<RecipientPerson>
}> {
  const property = await ctx.db.get(report.propertyId)
  const client = property ? await ctx.db.get(property.clientId) : null
  // A client in the Recycle bin gets no reports (lib/bin.ts).
  if (!client || client.deletedAt !== undefined) {
    return { client: null, people: [] }
  }
  const people: Array<RecipientPerson> = []
  const clientEmail = client.email?.trim()
  if (clientEmail) {
    people.push({
      address: normaliseAddress(clientEmail),
      name: client.name,
      kind: 'client',
      role: null,
      primary: false,
    })
  }
  if (withContacts) {
    const contacts = await ctx.db
      .query('clientContacts')
      .withIndex('by_client', (q) => q.eq('clientId', client._id))
      .filter((q) => q.eq(q.field('deletedAt'), undefined))
      .take(MAX_CONTACTS)
    for (const contact of contacts) {
      const email = contact.email?.trim()
      if (!email) continue
      people.push({
        address: normaliseAddress(email),
        name: contact.name,
        kind: 'contact',
        role: contact.role?.trim() || null,
        primary: contact.isPrimary === true,
      })
    }
  }
  return {
    client: withContacts
      ? {
          clientId: client._id,
          name: client.name,
          // One that can never be delivered to ("bob@gmail") is no address:
          // the Send sheet may offer to put a typed one in its place.
          hasEmail: clientEmail !== undefined && isValidEmail(clientEmail),
        }
      : null,
    people,
  }
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
 * app checked them ("bob@gmail", "jan@hotmail..com") is the kind of typo this
 * exists to catch, so it does not count as known merely by having been typed
 * into the client record first.
 */
function deliverable(address: string | undefined): address is string {
  return address !== undefined && isValidEmail(address)
}

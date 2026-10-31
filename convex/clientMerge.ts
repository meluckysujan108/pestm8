import { ConvexError, v } from 'convex/values'
import type { Infer } from 'convex/values'
import type { WithoutSystemFields } from 'convex/server'
import { mutation, query } from './_generated/server'
import { MAX_GROUP_ROWS, putInBin } from './bin'
import { settleHintsOnMerge } from './clientMatchHints'
import {
  hasCapability,
  requireActor,
  requireCapability,
  requireWriteActor,
} from './lib/actor'
import { recordAudit } from './lib/audit'
import { isBinned } from './lib/bin'
import { writeAttribution } from './lib/capabilities'
import { MAX_TAGS } from './lib/clientRecord'
import {
  dropXeroLinksForClient,
  handOverContacts,
  markClientForXero,
  mergeOutcomesOf,
} from './lib/xeroHooks'
import type { Doc, Id } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import type { ActorEnvelope } from './lib/actor'

/**
 * Merge one client into another: two PestM8 records of one customer become
 * one. Offered where the duplicate shows itself — a Xero contact one client
 * already has, proposed for another (Match your clients, "Same customer…") —
 * but nothing here is about Xero: it is the client book's own operation.
 *
 * `from` (B) goes into `into` (A):
 *
 * - B's sites move to A, and with them everything that hangs off a site —
 *   jobs, Recurring Jobs, reports, photos. Only the ones not in the Recycle
 *   bin: a site deleted on its own stays B's and goes with B.
 * - B's contact people move to A. A keeps its contact person; B's stops
 *   being one if A has one already (one star per client).
 * - B's notes move to A — every note about B, except the ones about a site
 *   that stays B's.
 * - A keeps its name, kind, number and status; its blank details are filled
 *   from B's (email, phone, ABN, mailing address, tags). A lead becomes
 *   active if B was: B had work.
 * - B goes into the Recycle bin, marked as merged into A. It can't be
 *   restored: its sites and jobs are A's now, and a restore would bring back
 *   an empty duplicate. It is wiped after 30 days like anything else.
 * - Xero, in each organisation: where B is a contact of its own and A is
 *   none, A takes B's contact over, and whoever shared B's contact follows
 *   it to A (lib/xeroHooks.ts `handOverContacts`) — so A is never added
 *   beside it as a duplicate. Where A has its own, A keeps it and B's stays
 *   in Xero, linked to nothing — PestM8 never deletes there. B's links go.
 *   A is queued, so what it gained (a phone, a contact person) goes over.
 *
 * Nothing is scheduled or rebooked: a job is at a site, not a client, so the
 * schedule and the Recurring Job engine never notice.
 *
 * Who: the people who manage the client book (`clients.manage` — the owner
 * and contractors), as themselves: a switch drops it. The same people may
 * delete a client, which a merge also does.
 *
 * Refused (KIND_MISMATCH) for a business into a person when the business has
 * what only a business shows — contact people, site contacts, an ABN, an
 * office address: on a person they would be kept but never shown, dialled or
 * sent to Xero, and gone for good with B's wipe. A is made a business first,
 * or the two are kept apart.
 */

/**
 * A merge bigger than this is refused (MERGE_TOO_BIG) rather than half done:
 * one transaction moves it all, so it is all or nothing. No client here has
 * anywhere near this many sites and contact people, or notes — it is a guard
 * on what one transaction can read and write, not a limit anyone meets.
 */
export const MERGE_MAX_ROWS = 500
export const MERGE_MAX_NOTES = 500

const mergeArgs = {
  businessId: v.id('businesses'),
  /** B: the duplicate, which goes. */
  fromClientId: v.id('clients'),
  /** A: the one that stays, and gets everything. */
  intoClientId: v.id('clients'),
}

const moves = v.object({
  properties: v.number(),
  jobs: v.number(),
  recurrences: v.number(),
  notes: v.number(),
  contacts: v.number(),
  reports: v.number(),
})

const side = v.object({
  name: v.string(),
  clientNumber: v.union(v.number(), v.null()),
})

type Moves = Infer<typeof moves>

type Plan = {
  from: Doc<'clients'>
  into: Doc<'clients'>
  /** B's sites outside the bin: they move. */
  sites: Array<Doc<'properties'>>
  /** B's contact people outside the bin: they move. */
  contacts: Array<Doc<'clientContacts'>>
  /** B's notes that move — those in Recently Deleted too, so one brought
   * back is on A, where everything else of B's is. */
  notes: Array<Doc<'notes'>>
  /** What moves, as the confirm and the audit say it: only what is not
   * deleted. */
  moves: Moves
}

/**
 * Everything a merge would do, read and checked: what `mergePreview` shows
 * and `merge` does, so the confirm never promises a merge that is then
 * refused. Throws as the merge would.
 */
async function planMerge(
  ctx: QueryCtx,
  {
    businessId,
    fromClientId,
    intoClientId,
  }: {
    businessId: Id<'businesses'>
    fromClientId: Id<'clients'>
    intoClientId: Id<'clients'>
  },
): Promise<Plan> {
  if (fromClientId === intoClientId) throw new ConvexError('SAME_CLIENT')
  const from = await inTheBook(ctx, businessId, fromClientId)
  const into = await inTheBook(ctx, businessId, intoClientId)

  // Read with the binned rows among them, and bounded: the check is on what
  // B has, whether or not it is in the bin.
  const allSites = await ctx.db
    .query('properties')
    .withIndex('by_client', (q) => q.eq('clientId', from._id))
    .take(MERGE_MAX_ROWS + 1)
  const allContacts = await ctx.db
    .query('clientContacts')
    .withIndex('by_client', (q) => q.eq('clientId', from._id))
    .take(MERGE_MAX_ROWS + 1)
  if (allSites.length + allContacts.length > MERGE_MAX_ROWS) {
    throw new ConvexError('MERGE_TOO_BIG')
  }
  const allNotes = await ctx.db
    .query('notes')
    .withIndex('by_client', (q) => q.eq('clientId', from._id))
    .take(MERGE_MAX_NOTES + 1)
  if (allNotes.length > MERGE_MAX_NOTES) throw new ConvexError('MERGE_TOO_BIG')

  const sites = allSites.filter((site) => !isBinned(site))
  const contacts = allContacts.filter((contact) => !isBinned(contact))
  if (
    from.kind === 'business' &&
    into.kind === 'person' &&
    onlyABusinessShows(from, sites, contacts)
  ) {
    throw new ConvexError('KIND_MISMATCH')
  }
  const moving = new Set(sites.map((site) => site._id))
  // A note about a site, a job there or the client carries the client too
  // (notes.ts `resolveLinks`), so `by_client` finds them all. One about a
  // site that stays B's (in the bin on its own) stays with it.
  const notes = allNotes.filter(
    (note) => note.propertyId === undefined || moving.has(note.propertyId),
  )

  return {
    from,
    into,
    sites,
    contacts,
    notes,
    moves: {
      properties: sites.length,
      contacts: contacts.length,
      notes: notes.filter((note) => note.deletedAt === undefined).length,
      ...(await workAt(ctx, sites)),
    },
  }
}

/**
 * Whether a business client has anything a person client never shows
 * (ClientSheet, lib/contactPerson.ts, lib/siteContact.ts, and Xero's copy):
 * contact people, a site contact at a site that would move, an ABN, or its
 * own office address.
 */
function onlyABusinessShows(
  from: Doc<'clients'>,
  sites: ReadonlyArray<Doc<'properties'>>,
  contacts: ReadonlyArray<Doc<'clientContacts'>>,
): boolean {
  return (
    contacts.length > 0 ||
    !blank(from.abn) ||
    MAILING.some((field) => !blank(from[field])) ||
    sites.some(
      (site) => !blank(site.siteContactName) || !blank(site.siteContactPhone),
    )
  )
}

/** A client of this business in the book — not in the Recycle bin, not
 * archived — or NOT_FOUND. */
async function inTheBook(
  ctx: QueryCtx,
  businessId: Id<'businesses'>,
  clientId: Id<'clients'>,
): Promise<Doc<'clients'>> {
  const client = await ctx.db.get('clients', clientId)
  if (
    !client ||
    client.businessId !== businessId ||
    isBinned(client) ||
    client.archivedAt !== undefined
  ) {
    throw new ConvexError('NOT_FOUND')
  }
  return client
}

/**
 * The jobs, Recurring Jobs and reports at the sites that move, for the
 * confirm's "4 sites, 31 jobs…". None of them is written — they hang off
 * their site — so they are only counted, under the same ceiling as deleting
 * a client (bin.ts `MAX_GROUP_ROWS`): a client this big needs a different
 * tool than a tap.
 */
async function workAt(
  ctx: QueryCtx,
  sites: ReadonlyArray<Doc<'properties'>>,
): Promise<Pick<Moves, 'jobs' | 'recurrences' | 'reports'>> {
  let budget = MAX_GROUP_ROWS
  const live = (rows: ReadonlyArray<{ deletedAt?: number }>) => {
    budget -= rows.length
    if (budget < 0) throw new ConvexError('MERGE_TOO_BIG')
    return rows.filter((row) => !isBinned(row)).length
  }
  const counts = { jobs: 0, recurrences: 0, reports: 0 }
  for (const site of sites) {
    counts.jobs += live(
      await ctx.db
        .query('jobs')
        .withIndex('by_property', (q) => q.eq('propertyId', site._id))
        .take(budget + 1),
    )
    counts.recurrences += live(
      await ctx.db
        .query('recurrences')
        .withIndex('by_property', (q) => q.eq('propertyId', site._id))
        .take(budget + 1),
    )
    counts.reports += live(
      await ctx.db
        .query('reports')
        .withIndex('by_property', (q) => q.eq('propertyId', site._id))
        .take(budget + 1),
    )
  }
  return counts
}

const xeroOutcome = v.union(
  v.literal('takes_over'),
  v.literal('stays'),
  v.literal('none'),
)

/**
 * The organisations the merge's confirm speaks of, and what the merge does
 * in each (lib/xeroHooks.ts `mergeOutcome`): A takes B's contact over, B's
 * own contact stays in Xero beside A's, or B has none there.
 *
 * Only the ones the caller sees on a client's sheet (xeroSync.ts
 * `clientLines`): the business's for whoever may manage the business, and
 * their own as a member. Another member's organisation is their own books,
 * not named to anyone else here — the merge does the same there just the
 * same.
 */
async function organisationsFor(
  ctx: QueryCtx,
  env: ActorEnvelope,
  from: Doc<'clients'>,
  into: Doc<'clients'>,
): Promise<Array<{ orgName: string; outcome: Infer<typeof xeroOutcome> }>> {
  const out: Array<{ orgName: string; outcome: Infer<typeof xeroOutcome> }> = []
  for (const org of await mergeOutcomesOf(ctx, from, into)) {
    if (org.kind === 'business') {
      if (!hasCapability(env, 'business.manage')) continue
    } else {
      const connection = await ctx.db.get('xeroConnections', org.connectionId)
      if (connection?.membershipId !== env.actor.real._id) continue
    }
    out.push({ orgName: org.orgName, outcome: org.outcome })
  }
  return out
}

/**
 * What a merge of B into A would do, for its confirm: the two clients, what
 * moves, and what happens in each organisation the caller sees. Refuses
 * exactly as `merge` would.
 */
export const mergePreview = query({
  args: mergeArgs,
  returns: v.object({
    from: side,
    into: side,
    moves,
    xero: v.array(v.object({ orgName: v.string(), outcome: xeroOutcome })),
  }),
  handler: async (ctx, args) => {
    const env = await requireActor(ctx, args.businessId)
    requireCapability(env, 'clients.manage')
    const plan = await planMerge(ctx, args)
    return {
      from: sideOf(plan.from),
      into: sideOf(plan.into),
      moves: plan.moves,
      xero: await organisationsFor(ctx, env, plan.from, plan.into),
    }
  },
})

function sideOf(client: Doc<'clients'>) {
  return { name: client.name, clientNumber: client.clientNumber ?? null }
}

/**
 * Merge B into A, as the module comment says — all of it in this one
 * transaction, so a merge is never half done.
 */
export const merge = mutation({
  args: mergeArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const env = await requireWriteActor(ctx, args.businessId)
    requireCapability(env, 'clients.manage')
    const plan = await planMerge(ctx, args)
    const { from, into } = plan
    const now = Date.now()

    // Sites first: jobs, Recurring Jobs, reports and photos point at the
    // site, not the client, so they follow without being touched. The
    // import's mark goes (`importedFrom` stays): moving a site to the client
    // it belongs with is work on it, and an Undo of that import must not
    // take it back from A.
    for (const site of plan.sites) {
      await ctx.db.patch('properties', site._id, {
        clientId: into._id,
        importId: undefined,
      })
    }

    // One contact person per client (clientContacts.ts `setPrimary`): A's
    // stays; B's comes over as one only if A has none.
    const intoStarred = await ctx.db
      .query('clientContacts')
      .withIndex('by_client', (q) => q.eq('clientId', into._id))
      .filter((q) =>
        q.and(
          q.eq(q.field('deletedAt'), undefined),
          q.eq(q.field('isPrimary'), true),
        ),
      )
      .first()
    let starred = intoStarred !== null
    for (const contact of plan.contacts) {
      const keepsStar = contact.isPrimary === true && !starred
      if (keepsStar) starred = true
      await ctx.db.patch('clientContacts', contact._id, {
        clientId: into._id,
        ...(contact.isPrimary === true && !keepsStar
          ? { isPrimary: false }
          : {}),
      })
    }

    // Its links only: what a note says, and when it was last edited, are
    // the note's own.
    for (const note of plan.notes) {
      await ctx.db.patch('notes', note._id, { clientId: into._id })
    }

    // A's import mark goes too: a merge into A is work on A, and an Undo of
    // the import that brought A must not delete it, and with it what it took
    // from B (its own unworked imported sites still go).
    const filled = blanksFilled(into, from)
    await ctx.db.patch('clients', into._id, {
      ...filled,
      importId: undefined,
      updatedAt: now,
    })

    // Xero, before the bin: where A has no contact of its own and B has,
    // A takes B's over, with whoever shares it — which the bin would
    // otherwise put To check as B goes. What is left of B's links goes
    // below.
    const handedOver = await handOverContacts(ctx, {
      from,
      into,
      by: env.actor.real._id,
      now,
    })
    const dropped = (
      await ctx.db
        .query('xeroContactLinks')
        .withIndex('by_client', (q) => q.eq('clientId', from._id))
        .collect()
    ).map((link) => ({
      tenantId: link.tenantId,
      state: link.state,
      ...(link.xeroContactId !== undefined
        ? { xeroContactId: link.xeroContactId }
        : {}),
    }))
    // Whoever still shares B's contact (where A had its own) is put To check
    // as B goes.
    const released = (
      await ctx.db
        .query('xeroContactLinks')
        .withIndex('by_sharedWithClientId', (q) =>
          q.eq('sharedWithClientId', from._id),
        )
        .take(200)
    )
      .filter((row) => row.state === 'shared')
      .map((row) => row.clientId)

    // B goes into the bin as merged into A, which is what refuses its
    // restore and what the bin page says of it. Nothing is left to go with
    // it but a site or contact already deleted on its own.
    await putInBin(
      ctx,
      args.businessId,
      { kind: 'client', id: from._id },
      { env, mergedInto: into._id },
    )

    // Xero: B's links that are left go in every organisation — a client
    // sharing B's contact there is asked about it again — and B's own
    // contact stays in Xero. After the bin, which has taken them out of the
    // counts and queued B: this drops that queued send too. A is queued for
    // what it gained, and for any contact it took over.
    await dropXeroLinksForClient(ctx, from._id)
    await markClientForXero(ctx, into._id)

    // "May be the same customer": theirs is answered, merged; B's with
    // anyone else become A's, B being part of A now (clientMatchHints.ts).
    await settleHintsOnMerge(ctx, {
      from: from._id,
      into: into._id,
      by: env.actor.real._id,
      now,
    })

    // Ids and numbers only, as every bin row: the audit log outlives B's
    // wipe, so it must not carry its name. Enough to say afterwards which
    // of A's records were B's, since the merge can't be undone: what moved,
    // which of A's details came from B, and what happened in Xero.
    await recordAudit(ctx, writeAttribution(env.actor), {
      businessId: args.businessId,
      action: 'clients.merge',
      entityType: 'clients',
      entityId: into._id,
      meta: {
        fromClientId: from._id,
        ...(from.clientNumber !== undefined
          ? { fromClientNumber: from.clientNumber }
          : {}),
        moved: plan.moves,
        movedSiteIds: plan.sites.map((site) => site._id),
        movedContactIds: plan.contacts.map((contact) => contact._id),
        movedNoteIds: plan.notes.map((note) => note._id),
        filled: Object.keys(filled),
        xero: { handedOver, dropped, released },
      },
      at: now,
    })
    return null
  },
})

/** Blank on a client: never set, or set to nothing. */
function blank(value: string | undefined): boolean {
  return value === undefined || value.trim() === ''
}

const MAILING = ['addressLine', 'suburb', 'state', 'postcode'] as const

/**
 * What A takes from B: only what A has none of. A's own details always win —
 * it is the record the holder chose to keep.
 */
function blanksFilled(
  into: Doc<'clients'>,
  from: Doc<'clients'>,
): Partial<WithoutSystemFields<Doc<'clients'>>> {
  const patch: Partial<WithoutSystemFields<Doc<'clients'>>> = {}
  if (blank(into.email) && !blank(from.email)) patch.email = from.email
  if (blank(into.phone) && !blank(from.phone)) patch.phone = from.phone
  // A person's ABN is kept hidden, not used (schema.ts `abn`): only one
  // business's goes to another.
  if (
    into.kind === 'business' &&
    from.kind === 'business' &&
    blank(into.abn) &&
    !blank(from.abn)
  ) {
    patch.abn = from.abn
  }
  // The four together, or a street from one and a postcode from the other
  // would be an address that is neither's.
  if (
    MAILING.every((field) => blank(into[field])) &&
    MAILING.some((field) => !blank(from[field]))
  ) {
    for (const field of MAILING) patch[field] = from[field]
  }
  const tags = unionTags(into.tags ?? [], from.tags ?? [])
  if (tags.length > (into.tags ?? []).length) patch.tags = tags
  // Booked work moves with B's sites, so A is no longer only a lead.
  if (into.status === 'lead' && (from.status ?? 'active') === 'active') {
    patch.status = 'active'
  }
  return patch
}

/**
 * A's tags, then B's that A hasn't (whatever their capitals), at most
 * `MAX_TAGS` — A's first, so a full list loses only B's. Both are stored
 * already normalised (lib/clientRecord.ts `normaliseTags`).
 */
function unionTags(
  into: ReadonlyArray<string>,
  from: ReadonlyArray<string>,
): Array<string> {
  const out: Array<string> = []
  const seen = new Set<string>()
  for (const tag of [...into, ...from]) {
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  return out.slice(0, MAX_TAGS)
}

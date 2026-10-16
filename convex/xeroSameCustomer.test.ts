/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import {
  createActor,
  createBusiness,
  joinBusiness,
  testApp,
} from '../test/harness'
import { connectAndFinish, contactsIn, fakeXero } from '../test/fakeXero'
import type { FakeContact, XeroContactView } from '../test/fakeXero'
import type { Doc, Id } from './_generated/dataModel'
import type { TestActor } from '../test/harness'

/**
 * Two PestM8 clients, one Xero contact (the build spec of 2026-10-16,
 * "same customer"): a To check card proposes contact X for client B while
 * another client in the book, A, is already linked to X. Same could only be
 * refused (CONTACT_TAKEN), a dead end — eight of them on prod. Now:
 *
 * - the card says who has X (`reviewPage` → `heldBy`), so it is no surprise;
 * - Keep both (`decide` 'share'): B uses A's contact. B is never written —
 *   its edits stay in PestM8, A's still go — and B never counts as holding
 *   X: A does. Unlink on it gives B a contact of its own;
 * - Give it to B (`decide` 'give'): A is unlinked exactly as Unlink does it
 *   (and so gets a contact of its own once syncing), and B is linked to X;
 * - whenever A stops holding X — unlinked, given away, binned, archived,
 *   merged into another client, wiped, or archived in Xero — every client
 *   sharing A's contact is put To check again, against X (`was_shared`),
 *   rather than left sharing nothing. When Xero merges X into another
 *   contact, A follows it, still its holder, and so do they.
 *
 * Merging B into A, the third way, is convex/clientMerge.test.ts.
 *
 * The business is the one the other Xero tests use: Terence owns Coastal
 * Pest and connects its Xero; Kevin, a subcontractor, and Jo, a contractor,
 * may connect their own. Xero is faked (test/fakeXero.ts), the clock
 * stopped.
 */

const XU = {
  terence: 'xu-terence',
  kevin: 'xu-kevin',
  mia: 'xu-mia',
} as const

const ORG = {
  coastal: 'tenant-coastal',
  harbour: 'tenant-harbour',
} as const

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function setup() {
  const t = testApp()
  const xero = fakeXero()
  xero.tenant({ tenantId: ORG.coastal, name: 'Coastal Pest Pty Ltd' })
  xero.tenant({ tenantId: ORG.harbour, name: 'Harbour Pest Pty Ltd' })

  const terence = await createActor(t, {
    email: 'terence@coastal.test',
    name: 'Terence',
  })
  const { businessId, ownerMembershipId } = await createBusiness(t, terence)
  const kevin = await createActor(t, {
    email: 'kevin@coastal.test',
    name: 'Kevin Walsh',
  })
  const kevinId = await joinBusiness(
    t,
    terence,
    kevin,
    businessId,
    'subcontractor',
  )
  const jo = await createActor(t, {
    email: 'jo@coastal.test',
    name: 'Jo Bloggs',
  })
  const joId = await joinBusiness(t, terence, jo, businessId, 'contractor')

  return {
    t,
    xero,
    businessId,
    terence,
    ownerMembershipId,
    kevin,
    kevinId,
    jo,
    joId,
  }
}

type Setup = Awaited<ReturnType<typeof setup>>

/** Runs whatever was scheduled, and whatever that schedules: the match run,
 * drains and their retries, a wipe's or an undo's steps. */
const settle = (s: Setup) =>
  s.t.finishAllScheduledFunctions(vi.runAllTimers, 1000)

const quietly = () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
}

// ─────────────────────────────────────────────────────────────── the book

type Site = { addressLine: string; suburb: string }

type ClientSeed = {
  name: string
  kind?: 'person' | 'business'
  clientNumber?: number
  email?: string
  phone?: string
  site: Site
}

/** A client as the app keeps one, inserted directly — before anything is
 * connected, when how it was made reaches nothing in Xero. */
async function addClient(
  s: Setup,
  seed: ClientSeed,
  businessId: Id<'businesses'> = s.businessId,
): Promise<Id<'clients'>> {
  return s.t.run(async (ctx) => {
    const now = Date.now()
    const clientId = await ctx.db.insert('clients', {
      businessId,
      kind: seed.kind ?? 'person',
      name: seed.name,
      ...(seed.clientNumber !== undefined
        ? { clientNumber: seed.clientNumber }
        : {}),
      ...(seed.email ? { email: seed.email } : {}),
      ...(seed.phone ? { phone: seed.phone } : {}),
      createdAt: now,
      updatedAt: now,
    })
    await ctx.db.insert('properties', {
      businessId,
      clientId,
      addressLine: seed.site.addressLine,
      suburb: seed.site.suburb,
      state: 'WA',
      postcode: '6000',
      createdAt: now,
    })
    return clientId
  })
}

async function addBook<TKey extends string>(
  s: Setup,
  seeds: Record<TKey, ClientSeed>,
  businessId: Id<'businesses'> = s.businessId,
): Promise<Record<TKey, Id<'clients'>>> {
  const ids = {} as Record<TKey, Id<'clients'>>
  for (const key of Object.keys(seeds) as Array<TKey>) {
    ids[key] = await addClient(s, seeds[key], businessId)
  }
  return ids
}

/**
 * Four Tom Joneses — one customer twice over, or four people; only Terence
 * can say — and one client nobody else is. Xero holds one "Tom Jones" and
 * nothing for Raj, so the match puts every Tom Jones To check against that
 * one contact (`contested`) and Raj Patel is new.
 */
const JONES = {
  /** The one Terence links to Xero's Tom Jones: the holder. */
  a: {
    name: 'Tom Jones',
    clientNumber: 13,
    email: 'tom@jones.test',
    phone: '0400 111 222',
    site: { addressLine: '1 Bay Road', suburb: 'Bayswater' },
  },
  b: {
    name: 'Tom Jones',
    clientNumber: 14,
    site: { addressLine: '2 Rock Road', suburb: 'Rockingham' },
  },
  c: {
    name: 'Tom Jones',
    clientNumber: 15,
    site: { addressLine: '3 Peel Street', suburb: 'Mandurah' },
  },
  d: {
    name: 'Tom Jones',
    clientNumber: 16,
    site: { addressLine: '4 Hannan Street', suburb: 'Kalgoorlie' },
  },
  patel: {
    name: 'Raj Patel',
    clientNumber: 11,
    email: 'raj@patel.test',
    site: { addressLine: '3 Banksia Road', suburb: 'Mirrabooka' },
  },
} satisfies Record<string, ClientSeed>

const XERO_JONES: Array<FakeContact> = [{ name: 'Tom Jones' }]

// ─────────────────────────────────────────────────────────── connecting

/** Connect, all the way — which runs the first match. Returns the row. */
async function connect(
  s: Setup,
  who: TestActor,
  opts: {
    kind: 'business' | 'member'
    xeroUserId: string
    tenantId: string
    businessId?: Id<'businesses'>
  },
): Promise<Doc<'xeroConnections'>> {
  const businessId = opts.businessId ?? s.businessId
  await connectAndFinish(s.t, who.as, {
    businessId,
    kind: opts.kind,
    xeroUserId: opts.xeroUserId,
    tenantId: opts.tenantId,
  })
  const row = (
    await s.t.run((ctx) => ctx.db.query('xeroConnections').collect())
  )
    .filter(
      (r) =>
        r.businessId === businessId &&
        r.tenantId === opts.tenantId &&
        r.status === 'connected',
    )
    .at(-1)
  if (!row) throw new Error(`${opts.tenantId} did not connect`)
  return row
}

/** The Joneses in the book, Xero's one Tom Jones, and Terence connecting
 * Coastal Pest's organisation: the first match, run. `X` is that contact. */
async function jones(s: Setup) {
  const book = await addBook(s, JONES)
  const [x] = s.xero.contacts(ORG.coastal, XERO_JONES)
  const connection = await connect(s, s.terence, {
    kind: 'business',
    xeroUserId: XU.terence,
    tenantId: ORG.coastal,
  })
  return { book, connection, X: x.contactId }
}

/** `jones`, and Terence saying Tom Jones A is Xero's Tom Jones: A holds X,
 * and every other Tom Jones is To check against a contact A has. */
async function heldByA(s: Setup) {
  const world = await jones(s)
  await decide(s, s.terence, world.connection._id, world.book.a, 'same')
  return world
}

const startSyncing = async (s: Setup, connectionId: Id<'xeroConnections'>) => {
  await s.terence.as.mutation(api.xeroSync.startSyncing, {
    businessId: s.businessId,
    connectionId,
  })
  await settle(s)
}

// ──────────────────────────────────────────────────────────────── reading

const linkOf = (
  s: Setup,
  clientId: Id<'clients'>,
  tenantId: string = ORG.coastal,
  businessId: Id<'businesses'> = s.businessId,
) =>
  s.t.run((ctx) =>
    ctx.db
      .query('xeroContactLinks')
      .withIndex('by_business_and_tenant_and_client', (q) =>
        q
          .eq('businessId', businessId)
          .eq('tenantId', tenantId)
          .eq('clientId', clientId),
      )
      .unique(),
  )

async function link(
  s: Setup,
  clientId: Id<'clients'>,
  tenantId: string = ORG.coastal,
): Promise<Doc<'xeroContactLinks'>> {
  const row = await linkOf(s, clientId, tenantId)
  if (!row) throw new Error(`no link for ${clientId} in ${tenantId}`)
  return row
}

/** Every link row of the business in one organisation. */
const linksOf = (s: Setup, tenantId: string = ORG.coastal) =>
  s.t.run(async (ctx) =>
    (await ctx.db.query('xeroContactLinks').collect()).filter(
      (row) => row.businessId === s.businessId && row.tenantId === tenantId,
    ),
  )

/** The clients linked to one Xero contact: never more than one. A client
 * sharing it is not linked to it. */
const linkedTo = async (s: Setup, contactId: string) =>
  (await linksOf(s))
    .filter((row) => row.state === 'linked' && row.xeroContactId === contactId)
    .map((row) => row.clientId)

/** The Xero contact a client is linked to, as Xero lists it now. */
async function contactOf(
  s: Setup,
  clientId: Id<'clients'>,
): Promise<XeroContactView> {
  const row = await link(s, clientId)
  if (row.state !== 'linked' || !row.xeroContactId) {
    throw new Error(`${clientId} has no contact of its own (${row.state})`)
  }
  return s.xero.view(row.xeroContactId)
}

const outbox = (s: Setup) =>
  s.t.run((ctx) => ctx.db.query('xeroOutbox').collect())

const syncStateOf = (s: Setup, connectionId: Id<'xeroConnections'>) =>
  s.t.run((ctx) =>
    ctx.db
      .query('xeroSyncState')
      .withIndex('by_connection', (q) => q.eq('connectionId', connectionId))
      .unique(),
  )

const audits = (s: Setup, action: string) =>
  s.t.run(async (ctx) =>
    (await ctx.db.query('auditLog').collect()).filter(
      (row) => row.action === action,
    ),
  )

/** The elements of every contact write since `from` (a request count). */
function written(s: Setup, from = 0): Array<Record<string, unknown>> {
  return s.xero
    .contactWrites()
    .filter((r) => s.xero.requests.indexOf(r) >= from)
    .flatMap((r) => contactsIn(r))
}

/**
 * The business's match counts, as kept on its organisation's row as
 * decisions move them — what Settings and the match page's chips are given
 * (`xero.status`; one test below holds it to passing `shared` on).
 */
async function matchOf(s: Setup) {
  return s.t.run(async (ctx) => {
    const connection = (await ctx.db.query('xeroConnections').collect()).find(
      (row) =>
        row.businessId === s.businessId &&
        row.kind === 'business' &&
        row.status === 'connected',
    )
    if (!connection) return null
    const sync = await ctx.db
      .query('xeroSyncState')
      .withIndex('by_connection', (q) => q.eq('connectionId', connection._id))
      .unique()
    const match = sync?.match
    // Absent only on a match finished before sharing existed.
    return match ? { ...match, shared: match.shared ?? 0 } : null
  })
}

/**
 * The match counts these rows should come to — of clients in the book only:
 * one in the Recycle bin or archived is on no list. A client kept apart
 * (Different, Unlink) is new to Xero too; one sharing another's contact is
 * counted on its own, for the Shared contact chip.
 */
async function countsOf(s: Setup) {
  const rows = await s.t.run(async (ctx) => {
    const inBook: Array<Doc<'xeroContactLinks'>> = []
    for (const row of await ctx.db.query('xeroContactLinks').collect()) {
      if (row.businessId !== s.businessId || row.tenantId !== ORG.coastal) {
        continue
      }
      const client = await ctx.db.get(row.clientId)
      if (client && !client.deletedAt && !client.archivedAt) inBook.push(row)
    }
    return inBook
  })
  const count = (...states: Array<string>) =>
    rows.filter((r) => states.includes(r.state)).length
  return {
    linked: count('linked'),
    review: count('needs_review'),
    fresh: count('new', 'separate'),
    different: count('separate'),
    shared: count('shared'),
  }
}

/** The match page's counts agree with its lists, without a run. */
async function expectMatchCountsRight(s: Setup): Promise<void> {
  expect(await matchOf(s)).toMatchObject(await countsOf(s))
}

/** Once syncing, the tallies kept as links move are what a recount makes
 * of the links: nothing a decision did was counted wrong. */
async function expectSyncCountsRight(
  s: Setup,
  connectionId: Id<'xeroConnections'>,
): Promise<void> {
  const kept = (await syncStateOf(s, connectionId))?.counts
  expect(kept).toBeDefined()
  await s.t.mutation(internal.xeroSync.recount, { connectionId })
  await settle(s)
  const recounted = (await syncStateOf(s, connectionId))?.counts
  const { waiting: _kept, ...keptCounts } = kept!
  const { waiting: _recounted, ...recountedCounts } = recounted!
  expect(keptCounts).toEqual(recountedCounts)
}

// ─────────────────────────────────────────────────────────── the API

type Filter = 'review' | 'matched' | 'new' | 'separate' | 'shared'

const reviewPage = (
  s: Setup,
  who: TestActor,
  connectionId: Id<'xeroConnections'>,
  filter: Filter,
  businessId: Id<'businesses'> = s.businessId,
) =>
  who.as.query(api.xeroMatch.reviewPage, {
    businessId,
    connectionId,
    filter,
    paginationOpts: { numItems: 100, cursor: null },
  })

/** One client's card on one of the match page's lists. */
async function cardOf(
  s: Setup,
  connectionId: Id<'xeroConnections'>,
  filter: Filter,
  clientId: Id<'clients'>,
  who: TestActor = s.terence,
) {
  const page = await reviewPage(s, who, connectionId, filter)
  const card = page.page.find((item) => item.clientId === clientId)
  if (!card) throw new Error(`${clientId} is not on ${filter}`)
  return card
}

const clientIds = (page: { page: Array<{ clientId: Id<'clients'> }> }) =>
  page.page.map((item) => item.clientId).sort()

type Choice = 'same' | 'different' | 'share' | 'give'

const decide = (
  s: Setup,
  who: TestActor,
  connectionId: Id<'xeroConnections'>,
  clientId: Id<'clients'>,
  choice: Choice,
  businessId: Id<'businesses'> = s.businessId,
) =>
  who.as.mutation(api.xeroMatch.decide, {
    businessId,
    connectionId,
    clientId,
    choice,
  })

const unlink = (
  s: Setup,
  who: TestActor,
  connectionId: Id<'xeroConnections'>,
  clientId: Id<'clients'>,
) =>
  who.as.mutation(api.xeroMatch.unlink, {
    businessId: s.businessId,
    connectionId,
    clientId,
  })

const edit = (
  s: Setup,
  clientId: Id<'clients'>,
  patch: { name?: string; email?: string; phone?: string },
) =>
  s.terence.as.mutation(api.clients.update, {
    businessId: s.businessId,
    clientId,
    ...patch,
  })

const merge = (
  s: Setup,
  who: TestActor,
  fromClientId: Id<'clients'>,
  intoClientId: Id<'clients'>,
) =>
  who.as.mutation(api.clientMerge.merge, {
    businessId: s.businessId,
    fromClientId,
    intoClientId,
  })

type Line = {
  connectionId: Id<'xeroConnections'>
  state: string
  sharedWithName?: string | null
}

/** A client's one Xero line, as the client sheet gets it. */
async function lineOf(s: Setup, clientId: Id<'clients'>): Promise<Line> {
  const lines = (await s.terence.as.query(api.xeroSync.clientLines, {
    businessId: s.businessId,
    clientId,
  })) as Array<Line>
  expect(lines).toHaveLength(1)
  return lines[0]
}

/** The same button pressed a second time, from a page that is behind:
 * refused as NOT_FOUND or let pass — the caller checks it changed nothing. */
async function pressedAgain(press: () => Promise<unknown>): Promise<void> {
  try {
    await press()
  } catch (error) {
    expect(String(error)).toMatch(/NOT_FOUND/)
  }
}

/** What a client sharing A's contact becomes once A no longer holds it: To
 * check against that contact, undecided, using nothing — and its card says
 * whose contact it was (`sharedWith`), while that client is still here to
 * name (`formerHolder`; null once wiped). */
async function expectWasShared(
  s: Setup,
  connectionId: Id<'xeroConnections'>,
  clientId: Id<'clients'>,
  X: string,
  formerHolder: { clientId: Id<'clients'>; name: string } | null,
  who: TestActor = s.terence,
): Promise<void> {
  const row = await link(s, clientId)
  expect(row).toMatchObject({
    state: 'needs_review',
    candidate: { contactId: X, reason: 'was_shared' },
  })
  for (const field of [
    'xeroContactId',
    'xeroName',
    'how',
    'decidedAt',
    'decidedByMembershipId',
  ] as const) {
    expect(row[field]).toBeUndefined()
  }
  const card = await cardOf(s, connectionId, 'review', clientId, who)
  expect(card.candidate).toMatchObject({ contactId: X, reason: 'was_shared' })
  expect(card.sharedWith).toEqual(formerHolder)
}

// ═══════════════════════════════════════════════ the card says who has it

describe('a To check card whose contact another client has', () => {
  test('names that client — its number, suburb, email and phone; a card whose contact nobody has names nobody', async () => {
    const s = await setup()
    const { book, connection } = await jones(s)

    // Four of a name, one contact, nobody's yet.
    const before = await reviewPage(s, s.terence, connection._id, 'review')
    expect(clientIds(before)).toEqual([book.a, book.b, book.c, book.d].sort())
    for (const item of before.page) expect(item.heldBy).toBeNull()

    await decide(s, s.terence, connection._id, book.a, 'same')

    const after = await reviewPage(s, s.terence, connection._id, 'review')
    expect(clientIds(after)).toEqual([book.b, book.c, book.d].sort())
    for (const item of after.page) {
      expect(item.heldBy).toEqual({
        clientId: book.a,
        name: 'Tom Jones',
        clientNumber: 13,
        suburb: 'Bayswater',
        email: 'tom@jones.test',
        phone: '0400 111 222',
      })
    }
    // The holder's own card names nobody: it is not held from itself.
    const own = await cardOf(s, connection._id, 'matched', book.a)
    expect(own.heldBy ?? null).toBeNull()
  }, 30_000)

  test('a holder with nothing on it but a name is named with nulls, not blanks', async () => {
    const s = await setup()
    const { book, connection } = await jones(s)
    // Tom Jones B holds it this time: no email, no phone of his own.
    await decide(s, s.terence, connection._id, book.b, 'same')
    expect((await cardOf(s, connection._id, 'review', book.a)).heldBy).toEqual({
      clientId: book.b,
      name: 'Tom Jones',
      clientNumber: 14,
      suburb: 'Rockingham',
      email: null,
      phone: null,
    })
  }, 30_000)

  test('a holder in the Recycle bin, or archived, holds nothing: nobody is named — and restored, it is again', async () => {
    const s = await setup()
    const { book, connection } = await heldByA(s)
    const heldBy = async () =>
      (await cardOf(s, connection._id, 'review', book.b)).heldBy

    const entryId = await s.terence.as.mutation(api.bin.deleteClient, {
      businessId: s.businessId,
      clientId: book.a,
    })
    expect(await heldBy()).toBeNull()
    await s.terence.as.mutation(api.bin.restore, {
      businessId: s.businessId,
      entryId,
    })
    expect((await heldBy())?.clientId).toBe(book.a)

    await s.terence.as.mutation(api.clients.archive, {
      businessId: s.businessId,
      clientId: book.a,
    })
    expect(await heldBy()).toBeNull()
  }, 30_000)
})

// ═════════════════════════════════════ Keep both, use the other's contact

describe('Keep both, using the other client’s contact', () => {
  test('shares it: decided, counted, audited, listed under Shared contact and not Matched — and the contact is still the other client’s', async () => {
    const s = await setup()
    const { book, connection, X } = await heldByA(s)
    const reads = s.xero.contactReads().length

    await decide(s, s.terence, connection._id, book.b, 'share')

    const b = await link(s, book.b)
    expect(b).toMatchObject({
      state: 'shared',
      xeroContactId: X,
      sharedWithClientId: book.a,
      decidedAt: Date.now(),
      decidedByMembershipId: s.ownerMembershipId,
    })
    expect(b.candidate).toBeUndefined()
    expect(await audits(s, 'xero.share')).toEqual([
      expect.objectContaining({
        businessId: s.businessId,
        actorMembershipId: s.ownerMembershipId,
        entityType: 'clients',
        entityId: book.b,
        meta: expect.objectContaining({ sharedWith: book.a, xeroContactId: X }),
      }),
    ])

    // One Xero contact is still one client's: A holds it, B only uses it.
    expect(await linkedTo(s, X)).toEqual([book.a])
    expect(await link(s, book.a)).toMatchObject({
      state: 'linked',
      xeroContactId: X,
    })

    // Its own list, with whose contact it uses; on neither Matched nor To
    // check.
    const shared = await reviewPage(s, s.terence, connection._id, 'shared')
    expect(clientIds(shared)).toEqual([book.b])
    expect(shared.page[0]).toMatchObject({
      state: 'shared',
      sharedWith: { clientId: book.a, name: 'Tom Jones' },
    })
    expect(
      clientIds(await reviewPage(s, s.terence, connection._id, 'matched')),
    ).toEqual([book.a])
    expect(
      clientIds(await reviewPage(s, s.terence, connection._id, 'review')),
    ).toEqual([book.c, book.d].sort())

    // Counted: To check down one, Shared contact up one.
    expect(await matchOf(s)).toMatchObject({
      linked: 1,
      review: 2,
      fresh: 1,
      different: 0,
      shared: 1,
    })
    await expectMatchCountsRight(s)

    // A double tap changes nothing, and is not counted or audited twice.
    await pressedAgain(() =>
      decide(s, s.terence, connection._id, book.b, 'share'),
    )
    expect(await link(s, book.b)).toEqual(b)
    expect(await audits(s, 'xero.share')).toHaveLength(1)
    expect(await matchOf(s)).toMatchObject({ review: 2, shared: 1 })

    // Deciding asks Xero nothing, and writes nothing there.
    expect(s.xero.contactReads()).toHaveLength(reads)
    expect(s.xero.contactWrites()).toEqual([])
  }, 30_000)

  test('Settings, and the match page’s Shared contact chip, are told how many share a contact', async () => {
    const s = await setup()
    const { book, connection } = await heldByA(s)
    await decide(s, s.terence, connection._id, book.b, 'share')

    const status = await s.terence.as.query(api.xero.status, {
      businessId: s.businessId,
    })
    expect(status.business?.match).toMatchObject({
      linked: 1,
      review: 2,
      fresh: 1,
      different: 0,
      shared: 1,
    })
  }, 30_000)

  test('several may share one client’s contact', async () => {
    const s = await setup()
    const { book, connection, X } = await heldByA(s)
    await decide(s, s.terence, connection._id, book.b, 'share')
    await decide(s, s.terence, connection._id, book.c, 'share')

    for (const clientId of [book.b, book.c]) {
      expect(await link(s, clientId)).toMatchObject({
        state: 'shared',
        xeroContactId: X,
        sharedWithClientId: book.a,
      })
    }
    expect(await linkedTo(s, X)).toEqual([book.a])
    expect(await matchOf(s)).toMatchObject({ review: 1, shared: 2 })
    await expectMatchCountsRight(s)
  }, 30_000)

  test('Unlink on a shared client parts it from the other’s contact: it gets one of its own', async () => {
    const s = await setup()
    const { book, connection, X } = await heldByA(s)
    await decide(s, s.terence, connection._id, book.b, 'share')

    await unlink(s, s.terence, connection._id, book.b)
    const b = await link(s, book.b)
    expect(b).toMatchObject({
      state: 'separate',
      decidedAt: Date.now(),
      decidedByMembershipId: s.ownerMembershipId,
    })
    expect(b.xeroContactId).toBeUndefined()
    expect(b.sharedWithClientId).toBeUndefined()
    // A keeps the contact.
    expect(await linkedTo(s, X)).toEqual([book.a])
    expect(
      (await reviewPage(s, s.terence, connection._id, 'shared')).page,
    ).toEqual([])
    expect(
      clientIds(await reviewPage(s, s.terence, connection._id, 'separate')),
    ).toEqual([book.b])
    expect(await matchOf(s)).toMatchObject({ shared: 0, different: 1 })
    await expectMatchCountsRight(s)

    // Syncing, it is added as its own contact — its suburb after the name,
    // the name being A's contact's.
    await startSyncing(s, connection._id)
    expect(await link(s, book.b)).toMatchObject({
      state: 'linked',
      how: 'created',
    })
    expect((await contactOf(s, book.b)).Name).toBe('Tom Jones (Rockingham)')
    expect(await linkedTo(s, X)).toEqual([book.a])
  }, 30_000)
})

// ═════════════════════════════════════════════ Give the contact to this one

describe('Giving the contact to this client', () => {
  test('the other client is unlinked as Unlink does it, and this one linked: counted and audited', async () => {
    const s = await setup()
    const { book, connection, X } = await heldByA(s)

    await decide(s, s.terence, connection._id, book.b, 'give')

    // A: exactly what Unlink leaves — kept apart, decided, and the contact
    // it was linked to kept to say which it isn't.
    const a = await link(s, book.a)
    expect(a).toMatchObject({
      state: 'separate',
      decidedAt: Date.now(),
      decidedByMembershipId: s.ownerMembershipId,
      candidate: { contactId: X, name: 'Tom Jones', reason: 'unlinked' },
    })
    for (const field of [
      'xeroContactId',
      'how',
      'xeroName',
      'runId',
      'sharedWithClientId',
      'sent',
      'seen',
      'different',
      'problem',
    ] as const) {
      expect(a[field]).toBeUndefined()
    }

    // B: linked by Terence's word.
    const b = await link(s, book.b)
    expect(b).toMatchObject({
      state: 'linked',
      how: 'chosen',
      xeroContactId: X,
      xeroName: 'Tom Jones',
      decidedAt: Date.now(),
      decidedByMembershipId: s.ownerMembershipId,
    })
    expect(b.candidate).toBeUndefined()
    expect(await linkedTo(s, X)).toEqual([book.b])

    expect(await audits(s, 'xero.give')).toEqual([
      expect.objectContaining({
        businessId: s.businessId,
        actorMembershipId: s.ownerMembershipId,
        meta: expect.objectContaining({
          from: book.a,
          to: book.b,
          xeroContactId: X,
        }),
      }),
    ])

    // B moves To check → Matched; A Matched → Different (and new to Xero).
    expect(await matchOf(s)).toMatchObject({
      linked: 1,
      review: 2,
      fresh: 2,
      different: 1,
      shared: 0,
    })
    await expectMatchCountsRight(s)
    expect(
      clientIds(await reviewPage(s, s.terence, connection._id, 'separate')),
    ).toEqual([book.a])
    // The rest now name B as the holder.
    expect((await cardOf(s, connection._id, 'review', book.c)).heldBy).toEqual(
      expect.objectContaining({ clientId: book.b, clientNumber: 14 }),
    )

    // A double tap changes nothing.
    const links = await linksOf(s)
    await pressedAgain(() =>
      decide(s, s.terence, connection._id, book.b, 'give'),
    )
    expect(await linksOf(s)).toEqual(links)
    expect(await audits(s, 'xero.give')).toHaveLength(1)
    expect(s.xero.contactWrites()).toEqual([])
  }, 30_000)

  test('given before Start syncing: Start syncing adds the client it was taken from as a contact of its own', async () => {
    const s = await setup()
    const { book, connection, X } = await heldByA(s)
    await decide(s, s.terence, connection._id, book.b, 'give')

    await startSyncing(s, connection._id)

    expect(await link(s, book.a)).toMatchObject({
      state: 'linked',
      how: 'created',
    })
    const own = await contactOf(s, book.a)
    expect(own.ContactID).not.toBe(X)
    expect(own.Name).toBe('Tom Jones (Bayswater)')
    expect(own.EmailAddress).toBe('tom@jones.test')
    expect(await linkedTo(s, X)).toEqual([book.b])
    expect(s.xero.view(X).ContactStatus).toBe('ACTIVE')
    await expectSyncCountsRight(s, connection._id)
  }, 30_000)

  test('given once syncing: both are queued; the client it was taken from gets a contact of its own, and the contact is never archived or deleted', async () => {
    const s = await setup()
    const { book, connection, X } = await heldByA(s)
    await startSyncing(s, connection._id)
    expect((await contactOf(s, book.a)).ContactID).toBe(X)
    expect(await outbox(s)).toEqual([])

    await decide(s, s.terence, connection._id, book.b, 'give')
    expect((await outbox(s)).map((row) => row.clientId).sort()).toEqual(
      [book.a, book.b].sort(),
    )
    await settle(s)

    const own = await contactOf(s, book.a)
    expect(own.ContactID).not.toBe(X)
    expect(own.Name).toBe('Tom Jones (Bayswater)')
    expect(await link(s, book.a)).toMatchObject({ how: 'created' })
    expect(await link(s, book.b)).toMatchObject({
      state: 'linked',
      xeroContactId: X,
    })
    expect(s.xero.view(X)).toMatchObject({
      Name: 'Tom Jones',
      ContactStatus: 'ACTIVE',
    })
    expect(
      s.xero.requests.filter(
        (r) => r.path.startsWith('/api.xro/') && r.method === 'DELETE',
      ),
    ).toEqual([])
    expect(await outbox(s)).toEqual([])
    await expectSyncCountsRight(s, connection._id)
  }, 30_000)
})

// ═══════════════════════════════════════════ what only the holder's cards get

describe('only a card whose contact another client has', () => {
  test('can be shared or given: one nobody has is NOT_HELD, anything not To check NOT_FOUND — and Same on a held one is still CONTACT_TAKEN', async () => {
    const s = await setup()
    const { book, connection } = await jones(s)
    const nothingChanged = async (
      press: () => Promise<unknown>,
      code: RegExp,
    ) => {
      const before = await linksOf(s)
      await expect(press()).rejects.toThrow(code)
      expect(await linksOf(s)).toEqual(before)
    }
    const on = (clientId: Id<'clients'>, choice: Choice) => () =>
      decide(s, s.terence, connection._id, clientId, choice)

    // Nobody has Xero's Tom Jones yet.
    await nothingChanged(on(book.a, 'share'), /NOT_HELD/)
    await nothingChanged(on(book.a, 'give'), /NOT_HELD/)

    await decide(s, s.terence, connection._id, book.a, 'same')
    // Not To check: linked, or new.
    for (const clientId of [book.a, book.patel]) {
      await nothingChanged(on(clientId, 'share'), /NOT_FOUND/)
      await nothingChanged(on(clientId, 'give'), /NOT_FOUND/)
    }
    // Same, offered no more on a held card, is refused if the page is
    // behind.
    await nothingChanged(on(book.b, 'same'), /CONTACT_TAKEN/)

    // A in the Recycle bin holds nothing, so there is nothing to share or
    // give — and Same is B's to say.
    await s.terence.as.mutation(api.bin.deleteClient, {
      businessId: s.businessId,
      clientId: book.a,
    })
    await nothingChanged(on(book.b, 'share'), /NOT_HELD/)
    await nothingChanged(on(book.b, 'give'), /NOT_HELD/)
    await decide(s, s.terence, connection._id, book.b, 'same')
    expect(await link(s, book.b)).toMatchObject({ state: 'linked' })

    expect(await audits(s, 'xero.share')).toEqual([])
    expect(await audits(s, 'xero.give')).toEqual([])
  }, 30_000)
})

// ════════════════════════════════════════════════════════════ once syncing

describe('once syncing', () => {
  test('a client sharing another’s contact is never written: not added, not sent — while the other client’s changes still go', async () => {
    const s = await setup()
    const { book, connection, X } = await heldByA(s)
    await decide(s, s.terence, connection._id, book.b, 'share')
    // Before Start syncing, its line already says whose contact it is.
    expect(await lineOf(s, book.b)).toMatchObject({
      state: 'shared',
      sharedWithName: 'Tom Jones',
    })

    await startSyncing(s, connection._id)

    // The book went: A filled X's blanks, Raj Patel was added. B made
    // nothing, and asked Xero nothing of its own.
    expect(s.xero.view(X).EmailAddress).toBe('tom@jones.test')
    expect(s.xero.named(ORG.coastal, 'Raj Patel')).toHaveLength(1)
    for (const name of ['Tom Jones (Rockingham)', 'Tom Jones #14']) {
      expect(s.xero.named(ORG.coastal, name)).toEqual([])
    }
    // Two left To check (C and D): nothing of theirs either.
    expect(s.xero.contactsOf(ORG.coastal)).toHaveLength(2)
    expect(await link(s, book.b)).toMatchObject({
      state: 'shared',
      xeroContactId: X,
      sharedWithClientId: book.a,
    })
    expect(await lineOf(s, book.b)).toMatchObject({
      state: 'shared',
      sharedWithName: 'Tom Jones',
    })
    expect(await lineOf(s, book.a)).toMatchObject({ state: 'in_xero' })

    // B's change stays in PestM8: nothing written, nothing left waiting.
    const from = s.xero.requests.length
    await edit(s, book.b, { email: 'b@jones.test', phone: '0411 999 888' })
    await settle(s)
    expect(
      written(s, from).filter((e) =>
        JSON.stringify(e).includes('b@jones.test'),
      ),
    ).toEqual([])
    expect(
      s.xero.contactWrites().filter((r) => s.xero.requests.indexOf(r) >= from),
    ).toEqual([])
    expect(s.xero.view(X).EmailAddress).toBe('tom@jones.test')
    expect(await outbox(s)).toEqual([])

    // A's still goes.
    await edit(s, book.a, { email: 'tom.jones@jones.test' })
    await settle(s)
    expect(s.xero.view(X).EmailAddress).toBe('tom.jones@jones.test')
    expect(await outbox(s)).toEqual([])
    expect(await linkedTo(s, X)).toEqual([book.a])
    await expectSyncCountsRight(s, connection._id)
  }, 30_000)

  test('shared once syncing: queued for nothing it would write, and its line says so', async () => {
    const s = await setup()
    const { book, connection, X } = await heldByA(s)
    await startSyncing(s, connection._id)
    const writes = s.xero.contactWrites().length

    await decide(s, s.terence, connection._id, book.b, 'share')
    await settle(s)

    expect(s.xero.contactWrites()).toHaveLength(writes)
    expect(await outbox(s)).toEqual([])
    expect(await linkedTo(s, X)).toEqual([book.a])
    expect(await lineOf(s, book.b)).toMatchObject({
      state: 'shared',
      sharedWithName: 'Tom Jones',
    })
    await expectSyncCountsRight(s, connection._id)
  }, 30_000)

  test('the backfill’s eight: a second record of a client PestM8 added, put To check against that client’s contact — named on the card, and given away it gets its own', async () => {
    // Prod, 15 Oct 2026: clients put To check against contacts PestM8 had
    // just made for other clients, and Same could only refuse.
    const s = await setup()
    const book = await addBook(s, {
      kim: {
        name: 'Kim Twice',
        clientNumber: 41,
        email: 'kim@twice.test',
        site: { addressLine: '4 Como Street', suburb: 'Como' },
      },
    })
    s.xero.contacts(ORG.coastal, [])
    const connection = await connect(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    await startSyncing(s, connection._id)
    const kims = (await link(s, book.kim)).xeroContactId!
    expect(await link(s, book.kim)).toMatchObject({ how: 'created' })

    const importId = await s.terence.as.mutation(api.clientImports.start, {
      businessId: s.businessId,
      fileName: 'dupes.csv',
    })
    const site = (n: number) => ({
      addressLine: `${n} Import Street`,
      suburb: 'Bassendean',
      state: 'WA',
      postcode: '6054',
    })
    const results = await s.terence.as.mutation(api.clientImports.addBatch, {
      businessId: s.businessId,
      importId,
      clients: [
        {
          key: 'again',
          kind: 'person',
          name: 'Kim Twice',
          email: 'kim@twice.test',
          sites: [site(1)],
        },
        // Enough to make it read Xero's book first, as the backfill did.
        ...Array.from({ length: 10 }, (_, i) => ({
          key: `f${i}`,
          kind: 'person' as const,
          name: `Fresh Twice ${i}`,
          sites: [site(10 + i)],
        })),
      ],
    })
    const again = results.find((r) => r.key === 'again')!.clientId!
    await settle(s)
    expect(await link(s, again)).toMatchObject({
      state: 'needs_review',
      candidate: { contactId: kims },
    })

    // The card says who has it.
    expect((await cardOf(s, connection._id, 'review', again)).heldBy).toEqual({
      clientId: book.kim,
      name: 'Kim Twice',
      clientNumber: 41,
      suburb: 'Como',
      email: 'kim@twice.test',
      phone: null,
    })

    // The newer record is the one Terence keeps in Xero: Kim's first record
    // — a contact PestM8 made — goes to a contact of its own.
    await decide(s, s.terence, connection._id, again, 'give')
    await settle(s)
    expect(await link(s, again)).toMatchObject({
      state: 'linked',
      xeroContactId: kims,
    })
    const own = await contactOf(s, book.kim)
    expect(own.ContactID).not.toBe(kims)
    expect(own.Name).toBe('Kim Twice (Como)')
    expect(s.xero.named(ORG.coastal, 'Kim Twice')).toHaveLength(1)
    expect(await outbox(s)).toEqual([])
    await expectSyncCountsRight(s, connection._id)
  }, 30_000)
})

// ═══════════════════════════════ when the other client stops holding it

describe('when the client whose contact is shared stops holding it', () => {
  type Trigger = {
    name: string
    act: (
      s: Setup,
      world: Awaited<ReturnType<typeof heldByA>>,
    ) => Promise<unknown>
    /** Who holds X afterwards, if anyone. */
    holder: 'd' | null
  }
  const triggers: Array<Trigger> = [
    {
      name: 'it is unlinked',
      act: (s, { book, connection }) =>
        unlink(s, s.terence, connection._id, book.a),
      holder: null,
    },
    {
      name: 'its contact is given to another client',
      act: (s, { book, connection }) =>
        decide(s, s.terence, connection._id, book.d, 'give'),
      holder: 'd',
    },
    {
      name: 'it goes in the Recycle bin',
      act: async (s, { book }) => {
        await s.terence.as.mutation(api.bin.deleteClient, {
          businessId: s.businessId,
          clientId: book.a,
        })
      },
      holder: null,
    },
    {
      name: 'it is archived',
      act: async (s, { book }) => {
        await s.terence.as.mutation(api.clients.archive, {
          businessId: s.businessId,
          clientId: book.a,
        })
      },
      holder: null,
    },
    {
      name: 'it is merged into a client with a contact of its own',
      act: async (s, { book, connection }) => {
        // Raj Patel is a contact in Xero too, so A's contact stays there,
        // held by nobody. Into a client with none, A's contact would go
        // with it instead, and those sharing it with it
        // (clientMerge.test.ts).
        s.xero.addContacts(ORG.coastal, [
          { name: 'Raj Patel', email: 'raj@patel.test' },
        ])
        await s.terence.as.mutation(api.xeroMatch.rematch, {
          businessId: s.businessId,
          connectionId: connection._id,
        })
        await settle(s)
        expect(await link(s, book.patel)).toMatchObject({ state: 'linked' })
        await merge(s, s.terence, book.a, book.patel)
      },
      holder: null,
    },
  ]

  test.each(triggers)(
    'when $name, every client sharing its contact is put To check against it again (was_shared)',
    async ({ act, holder }) => {
      const s = await setup()
      const world = await heldByA(s)
      const { book, connection, X } = world
      await decide(s, s.terence, connection._id, book.b, 'share')
      await decide(s, s.terence, connection._id, book.c, 'share')
      expect(await matchOf(s)).toMatchObject({ shared: 2 })

      await act(s, world)

      for (const clientId of [book.b, book.c]) {
        // Whose contact it was, and who has it now, if anyone.
        await expectWasShared(s, connection._id, clientId, X, {
          clientId: book.a,
          name: 'Tom Jones',
        })
        const card = await cardOf(s, connection._id, 'review', clientId)
        expect(card.heldBy?.clientId ?? null).toBe(
          holder === null ? null : book[holder],
        )
      }
      expect(
        (await reviewPage(s, s.terence, connection._id, 'shared')).page,
      ).toEqual([])
      expect(await matchOf(s)).toMatchObject({ shared: 0 })
      await expectMatchCountsRight(s)

      // Nobody holds X: Same is B's to say again — and, answered, it names
      // A no more.
      if (holder === null) {
        await decide(s, s.terence, connection._id, book.b, 'same')
        expect(await linkedTo(s, X)).toEqual([book.b])
        expect(
          (await cardOf(s, connection._id, 'matched', book.b)).sharedWith,
        ).toBeNull()
      } else {
        // Another holds it: B may share theirs instead.
        await decide(s, s.terence, connection._id, book.b, 'share')
        expect(await link(s, book.b)).toMatchObject({
          state: 'shared',
          sharedWithClientId: book[holder],
        })
      }
    },
    30_000,
  )

  test('let go while a run is reading Xero: the run’s finish counts it To check, not still shared', async () => {
    const s = await setup()
    const { book, connection } = await heldByA(s)
    await decide(s, s.terence, connection._id, book.b, 'share')
    const counted = await matchOf(s)
    expect(counted).toMatchObject({ linked: 1, review: 2, shared: 1 })

    // Check Xero again is reading the organisation, and has read B as
    // sharing A's contact (and proposed the rest afresh), when A goes in the
    // Recycle bin.
    const runId = 'run-under-way'
    await s.t.run(async (ctx) => {
      const sync = await ctx.db
        .query('xeroSyncState')
        .withIndex('by_connection', (q) => q.eq('connectionId', connection._id))
        .unique()
      await ctx.db.patch(sync!._id, {
        match: { ...sync!.match!, state: 'reading', runId },
      })
      for (const row of await ctx.db.query('xeroContactLinks').collect()) {
        if (row.decidedAt === undefined) await ctx.db.patch(row._id, { runId })
      }
    })
    await s.terence.as.mutation(api.bin.deleteClient, {
      businessId: s.businessId,
      clientId: book.a,
    })
    // Let go — but no count moves while the match is reading.
    expect(await link(s, book.b)).toMatchObject({
      state: 'needs_review',
      candidate: { reason: 'was_shared' },
    })

    await s.t.mutation(internal.xeroMatch.finishMatch, {
      connectionId: connection._id,
      holder: 'run-holder',
      runId,
      counts: {
        contacts: counted!.contacts,
        linked: counted!.linked,
        review: counted!.review,
        fresh: counted!.fresh,
        different: counted!.different,
        leads: counted!.leads,
        shared: counted!.shared,
      },
    })

    // B is on To check, and the Shared contact chip has nothing under it.
    // (A, read as linked, is the drift any client binned mid-run has.)
    expect(await matchOf(s)).toMatchObject({
      state: 'ready',
      shared: 0,
      review: 3,
    })
    expect(
      (await reviewPage(s, s.terence, connection._id, 'shared')).page,
    ).toEqual([])
  }, 30_000)

  test('a client nobody shares with changes nothing for those sharing another’s', async () => {
    const s = await setup()
    const { book, connection } = await heldByA(s)
    await decide(s, s.terence, connection._id, book.b, 'share')
    const b = await link(s, book.b)

    // Raj Patel goes in the bin, and comes back.
    const entryId = await s.terence.as.mutation(api.bin.deleteClient, {
      businessId: s.businessId,
      clientId: book.patel,
    })
    await s.terence.as.mutation(api.bin.restore, {
      businessId: s.businessId,
      entryId,
    })
    expect(await link(s, book.b)).toEqual(b)
  }, 30_000)

  test('when an import that brought it is undone, it is deleted for good: those sharing its contact are put To check', async () => {
    const s = await setup()
    // Ivy in the book, and Ivy again in an import: one Xero contact.
    const ivyOld = await addClient(s, {
      name: 'Ivy Imported',
      clientNumber: 30,
      site: { addressLine: '9 Old Street', suburb: 'Morley' },
    })
    const importId = await s.terence.as.mutation(api.clientImports.start, {
      businessId: s.businessId,
      fileName: 'clients.csv',
    })
    const results = await s.terence.as.mutation(api.clientImports.addBatch, {
      businessId: s.businessId,
      importId,
      clients: [
        {
          key: 'ivy',
          kind: 'person',
          name: 'Ivy Imported',
          sites: [
            {
              addressLine: '3 Wattle Street',
              suburb: 'Bayswater',
              state: 'WA',
              postcode: '6053',
            },
          ],
        },
      ],
    })
    const ivyNew = results[0].clientId!
    const [x] = s.xero.contacts(ORG.coastal, [{ name: 'Ivy Imported' }])
    const connection = await connect(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    await decide(s, s.terence, connection._id, ivyNew, 'same')
    await decide(s, s.terence, connection._id, ivyOld, 'share')
    expect(await link(s, ivyOld)).toMatchObject({
      state: 'shared',
      sharedWithClientId: ivyNew,
    })

    await s.terence.as.mutation(api.clientImports.undo, {
      businessId: s.businessId,
      importId,
    })
    await settle(s)

    expect(await s.t.run((ctx) => ctx.db.get(ivyNew))).toBeNull()
    // Wiped, it is nobody to name.
    await expectWasShared(s, connection._id, ivyOld, x.contactId, null)
    await expectMatchCountsRight(s)
  }, 30_000)

  test('once syncing, merged in Xero: the client follows its contact into the one it was merged into — still its holder — and those sharing it follow too, still never written', async () => {
    // A departure from the build spec, which had them put To check: the
    // contact Xero kept IS the holder's (convex/lib/xeroHooks.ts
    // `moveSharesOf`), so "the same customer" still stands, and nobody is
    // asked about a contact that is gone.
    const s = await setup()
    const { book, connection, X } = await heldByA(s)
    await decide(s, s.terence, connection._id, book.b, 'share')
    await startSyncing(s, connection._id)
    quietly()

    const [survivor] = s.xero.addContacts(ORG.coastal, [
      { name: 'Thomas Jones' },
    ])
    s.xero.merge(X, survivor.contactId)
    const from = s.xero.requests.length
    await edit(s, book.a, { phone: '0400 333 444' })
    await settle(s)

    expect(await link(s, book.a)).toMatchObject({
      state: 'linked',
      how: 'relinked',
      xeroContactId: survivor.contactId,
    })
    expect(await link(s, book.b)).toMatchObject({
      state: 'shared',
      xeroContactId: survivor.contactId,
      xeroName: 'Thomas Jones',
      sharedWithClientId: book.a,
    })
    expect(await lineOf(s, book.b)).toMatchObject({
      state: 'shared',
      sharedWithName: 'Tom Jones',
    })
    // A's change went to the survivor; nothing of B's went anywhere.
    expect(
      written(s, from).filter((e) => e.ContactID === survivor.contactId),
    ).not.toEqual([])
    await edit(s, book.b, { email: 'b@jones.test' })
    await settle(s)
    expect(
      written(s).filter((e) => JSON.stringify(e).includes('b@jones.test')),
    ).toEqual([])
    expect(await outbox(s)).toEqual([])
    await expectSyncCountsRight(s, connection._id)
  }, 30_000)

  test('once syncing: archived in Xero — the client stopped — those sharing its contact are put To check, and nothing is written', async () => {
    const s = await setup()
    const { book, connection, X } = await heldByA(s)
    await decide(s, s.terence, connection._id, book.b, 'share')
    await startSyncing(s, connection._id)
    quietly()

    s.xero.archive(X)
    const before = s.xero.view(X)
    await edit(s, book.a, { phone: '0400 333 444' })
    await settle(s)

    expect(await link(s, book.a)).toMatchObject({ state: 'archived_in_xero' })
    await expectWasShared(s, connection._id, book.b, X, {
      clientId: book.a,
      name: 'Tom Jones',
    })
    expect(s.xero.view(X)).toEqual(before)
    await expectSyncCountsRight(s, connection._id)
  }, 30_000)
})

// ══════════════════════════════════════════════════════════════════ who may

describe('who may share and give', () => {
  test('the business’s Xero is the owner’s: not Kevin’s or Jo’s, not the owner’s while switched, and another business’s connection or client is NOT_FOUND', async () => {
    const s = await setup()
    const { book, connection } = await heldByA(s)
    const before = await linksOf(s)

    for (const who of [s.kevin, s.jo]) {
      for (const choice of ['share', 'give'] as const) {
        await expect(
          decide(s, who, connection._id, book.b, choice),
        ).rejects.toThrow(/NO_ACCESS/)
      }
      await expect(
        reviewPage(s, who, connection._id, 'shared'),
      ).rejects.toThrow(/NO_ACCESS/)
    }

    await s.terence.as.mutation(api.accountSwitches.start, {
      businessId: s.businessId,
      targetMembershipId: s.kevinId,
    })
    for (const choice of ['share', 'give'] as const) {
      await expect(
        decide(s, s.terence, connection._id, book.b, choice),
      ).rejects.toThrow(/NO_ACCESS|SWITCHED/)
    }
    await s.terence.as.mutation(api.accountSwitches.stop, {
      businessId: s.businessId,
    })

    // Mia, of Harbour Pest, naming Coastal Pest's connection from her own
    // business; Terence naming her client on his.
    const mia = await createActor(s.t, {
      email: 'mia@harbour.test',
      name: 'Mia',
    })
    const harbour = await createBusiness(s.t, mia, 'Harbour Pest')
    const hers = await addClient(
      s,
      {
        name: 'Tom Jones',
        clientNumber: 1,
        site: { addressLine: '1 Harbour Road', suburb: 'Hillarys' },
      },
      harbour.businessId,
    )
    for (const choice of ['share', 'give'] as const) {
      await expect(
        decide(s, mia, connection._id, book.b, choice, harbour.businessId),
      ).rejects.toThrow(/NOT_FOUND/)
      await expect(
        decide(s, s.terence, connection._id, hers, choice),
      ).rejects.toThrow(/NOT_FOUND/)
    }

    expect(await linksOf(s)).toEqual(before)
    expect(await audits(s, 'xero.share')).toEqual([])
    expect(await audits(s, 'xero.give')).toEqual([])

    // Back as himself, it is his.
    await decide(s, s.terence, connection._id, book.b, 'share')
    expect((await link(s, book.b)).state).toBe('shared')
  }, 30_000)

  test('Kevin, a Xero user on the business’s own organisation, connects it as his own: his to share and give, and nobody else’s', async () => {
    const s = await setup()
    const book = await addBook(s, JONES)
    const [x] = s.xero.contacts(ORG.coastal, XERO_JONES)
    const kevins = await connect(s, s.kevin, {
      kind: 'member',
      xeroUserId: XU.kevin,
      tenantId: ORG.coastal,
    })
    await decide(s, s.kevin, kevins._id, book.a, 'same')
    expect(
      (await cardOf(s, kevins._id, 'review', book.b, s.kevin)).heldBy,
    ).toMatchObject({ clientId: book.a, clientNumber: 13 })

    // Not the owner's, and not Jo's.
    for (const who of [s.terence, s.jo]) {
      for (const choice of ['share', 'give'] as const) {
        await expect(
          decide(s, who, kevins._id, book.b, choice),
        ).rejects.toThrow(/NO_ACCESS/)
      }
    }
    expect((await link(s, book.b)).state).toBe('needs_review')

    await decide(s, s.kevin, kevins._id, book.b, 'share')
    expect(await link(s, book.b)).toMatchObject({
      state: 'shared',
      xeroContactId: x.contactId,
      sharedWithClientId: book.a,
      decidedByMembershipId: s.kevinId,
    })
    expect(await audits(s, 'xero.share')).toEqual([
      expect.objectContaining({ actorMembershipId: s.kevinId }),
    ])

    // He gives Xero's Tom Jones to D instead: A is unlinked, and B, which
    // shared A's, is put To check again.
    await decide(s, s.kevin, kevins._id, book.d, 'give')
    expect(await linkedTo(s, x.contactId)).toEqual([book.d])
    expect(await link(s, book.a)).toMatchObject({
      state: 'separate',
      decidedByMembershipId: s.kevinId,
    })
    await expectWasShared(
      s,
      kevins._id,
      book.b,
      x.contactId,
      { clientId: book.a, name: 'Tom Jones' },
      s.kevin,
    )
    expect(await audits(s, 'xero.give')).toEqual([
      expect.objectContaining({ actorMembershipId: s.kevinId }),
    ])
  }, 30_000)
})

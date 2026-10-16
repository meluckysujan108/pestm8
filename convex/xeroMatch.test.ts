/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import {
  createActor,
  createBusiness,
  joinBusiness,
  testApp,
} from '../test/harness'
import {
  connectAndFinish,
  connectVia,
  fakeXero,
  finishFrom,
} from '../test/fakeXero'
import { DEMO_PLAN } from './demo/shared'
import type { FakeContact, StoredContact } from '../test/fakeXero'
import type { Doc, Id } from './_generated/dataModel'
import type { TestActor } from '../test/harness'

/**
 * Release 2 of Xero: matching the client book to a connected organisation's
 * contacts (convex/xeroMatch.ts; the rules themselves are
 * convex/lib/xeroMatch.ts, tested one by one beside it), with Xero faked
 * (test/fakeXero.ts) and the clock stopped.
 *
 * The business: Terence owns Coastal Pest and connects its Xero. Kevin, a
 * subcontractor, and Jo, a contractor, may connect their own, which receive
 * the whole client book too (decision of 2026-10-06).
 *
 * Release 2 only READS Xero — every request to the Accounting API must be a
 * GET — and writes nothing but PestM8's own record of which client is which
 * contact. What matters most: a decision the holder made is never overridden
 * by a later match; one Xero contact is never two clients; leads wait and
 * binned or archived clients are never offered; only the connection's holder
 * sees or decides anything; one organisation is read by one run at a time;
 * and a client deleted for good takes its links with it.
 */

const XU = {
  terence: 'xu-terence',
  kevin: 'xu-kevin',
  mia: 'xu-mia',
} as const

const ORG = {
  coastal: 'tenant-coastal',
  kevin: 'tenant-kevin',
  harbour: 'tenant-harbour',
} as const

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

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
  xero.tenant({ tenantId: ORG.kevin, name: 'Kevin Walsh Pest Services' })
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

/** Runs whatever was scheduled: the organisation read, the match run and
 * its retries, a wipe's steps. */
const settle = (s: Setup) => s.t.finishAllScheduledFunctions(vi.runAllTimers)

// ─────────────────────────────────────────────────────────────── the book

type ClientSeed = {
  name: string
  kind?: 'person' | 'business'
  clientNumber?: number
  email?: string
  phone?: string
  /** Its one site's suburb. */
  suburb?: string
  status?: 'active' | 'lead' | 'inactive'
  binned?: boolean
  archived?: boolean
  /** A business client's contact person (its primary contact), by email. */
  contactEmail?: string
}

/** A client as the app keeps one, inserted directly: what matching reads is
 * the rows, however they were made. */
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
      ...(seed.status ? { status: seed.status } : {}),
      ...(seed.binned ? { deletedAt: now } : {}),
      ...(seed.archived ? { archivedAt: now } : {}),
      createdAt: now,
      updatedAt: now,
    })
    if (seed.suburb) {
      await ctx.db.insert('properties', {
        businessId,
        clientId,
        addressLine: '1 Test Street',
        suburb: seed.suburb,
        state: 'WA',
        postcode: '6000',
        createdAt: now,
      })
    }
    if (seed.contactEmail) {
      await ctx.db.insert('clientContacts', {
        businessId,
        clientId,
        name: 'Accounts',
        email: seed.contactEmail,
        isPrimary: true,
        createdAt: now,
      })
    }
    return clientId
  })
}

/**
 * Coastal Pest's client book: one client for each thing the match must get
 * right, named for it. Fourteen clients, of which eleven are offered to Xero
 * — the lead waits, the binned and the archived never go.
 */
async function coastalBook(s: Setup) {
  const add = (seed: ClientSeed) => addClient(s, seed)
  return {
    /** #42; Xero has "ACME Holdings" with account number 0042. */
    acme: await add({
      name: 'Acme Holdings Pty Ltd',
      kind: 'business',
      clientNumber: 42,
      suburb: 'Osborne Park',
    }),
    /** Xero has "Smith, John" with the same email, in capitals. */
    smith: await add({
      name: 'John Smith',
      clientNumber: 7,
      email: 'john@smith.test',
    }),
    /** Same email as Xero's "S Brown Family Trust"; nothing else agrees. */
    brown: await add({
      name: 'Sarah Brown',
      clientNumber: 8,
      email: 'Sarah@Brown.test',
    }),
    /** Only the name agrees with Xero's. */
    nguyen: await add({
      name: 'Linh Nguyen',
      clientNumber: 9,
      phone: '0400 333 444',
      suburb: 'Mirrabooka',
    }),
    /** Its contact person's email, and its name, are the Xero contact's. */
    harbour: await add({
      name: 'Harbourside Strata',
      kind: 'business',
      clientNumber: 10,
      contactEmail: 'accounts@harbourside.test',
    }),
    /** Nowhere in Xero. */
    patel: await add({ name: 'Raj Patel', clientNumber: 11 }),
    /** In Xero only as an ARCHIVED contact, which is no contact. */
    lee: await add({ name: 'Grace Lee', clientNumber: 12 }),
    /** Two clients of one name, and one Xero contact of it. */
    jonesA: await add({
      name: 'Tom Jones',
      clientNumber: 13,
      suburb: 'Bayswater',
    }),
    jonesB: await add({
      name: 'Tom Jones',
      clientNumber: 14,
      suburb: 'Rockingham',
    }),
    /** In Xero only as a contact being erased (GDPRREQUEST). */
    gdpr: await add({ name: 'Gina Gdpr', clientNumber: 15 }),
    /** No longer serviced, but still the business's client: it goes too. */
    quiet: await add({
      name: 'Quentin Quiet',
      clientNumber: 16,
      status: 'inactive',
    }),
    /** A lead: waits until its first job is booked. */
    lead: await add({ name: 'Lena Lead', clientNumber: 17, status: 'lead' }),
    /** In the Recycle bin. */
    binned: await add({ name: 'Barry Binned', clientNumber: 18, binned: true }),
    /** Archived the old way. */
    archived: await add({
      name: 'Alma Archived',
      clientNumber: 19,
      archived: true,
    }),
  }
}

/** Coastal Pest's organisation in Xero: 11 contacts, 9 of them ACTIVE. */
function coastalContacts(): Array<FakeContact> {
  return [
    { name: 'ACME Holdings', accountNumber: '0042' },
    {
      name: 'Smith, John',
      email: 'JOHN@smith.test',
      firstName: 'John',
      lastName: 'Smith',
    },
    { name: 'S Brown Family Trust', email: 'sarah@brown.test' },
    {
      name: 'Linh Nguyen',
      phone: { areaCode: '08', number: '9345 6789' },
      city: 'Mirrabooka',
    },
    { name: 'Harbourside Strata', email: 'accounts@harbourside.test' },
    { name: 'Grace Lee', status: 'ARCHIVED' },
    { name: 'Tom Jones' },
    { name: 'Gina Gdpr', status: 'GDPRREQUEST' },
    { name: 'Lena Lead' },
    { name: 'Barry Binned' },
    { name: 'Alma Archived' },
  ]
}

/** Contacts that match nobody, to make an organisation big. */
function filler(count: number): Array<FakeContact> {
  return Array.from({ length: count }, (_, i) => ({
    name: `Filler Contact ${String(i + 1).padStart(5, '0')}`,
    email: `filler${i + 1}@xero.test`,
  }))
}

function idOf(rows: Array<StoredContact>, name: string): string {
  const row = rows.find((r) => r.name === name)
  if (!row) throw new Error(`no Xero contact named ${name}`)
  return row.contactId
}

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

/** Coastal Pest's book, its organisation's contacts (after `filler` others
 * that match nobody), and Terence connecting it: the first match, run. */
async function matched(s: Setup, opts: { filler?: number } = {}) {
  const book = await coastalBook(s)
  const contacts = s.xero.contacts(ORG.coastal, [
    ...filler(opts.filler ?? 0),
    ...coastalContacts(),
  ])
  const connection = await connect(s, s.terence, {
    kind: 'business',
    xeroUserId: XU.terence,
    tenantId: ORG.coastal,
  })
  return {
    book,
    contacts,
    connection,
    id: (name: string) => idOf(contacts, name),
  }
}

// ──────────────────────────────────────────────────────────────── reading

const connectionRow = (s: Setup, id: Id<'xeroConnections'>) =>
  s.t.run(async (ctx) => {
    const row = await ctx.db.get(id)
    if (!row) throw new Error('connection gone')
    return row
  })

/** Every link row of one business and organisation. */
const linksOf = (
  s: Setup,
  tenantId: string = ORG.coastal,
  businessId: Id<'businesses'> = s.businessId,
) =>
  s.t.run(async (ctx) =>
    (await ctx.db.query('xeroContactLinks').collect()).filter(
      (row) => row.businessId === businessId && row.tenantId === tenantId,
    ),
  )

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
  businessId: Id<'businesses'> = s.businessId,
): Promise<Doc<'xeroContactLinks'>> {
  const row = await linkOf(s, clientId, tenantId, businessId)
  if (!row) throw new Error(`no link for ${clientId} in ${tenantId}`)
  return row
}

const syncStateOf = (s: Setup, connectionId: Id<'xeroConnections'>) =>
  s.t.run((ctx) =>
    ctx.db
      .query('xeroSyncState')
      .withIndex('by_connection', (q) => q.eq('connectionId', connectionId))
      .unique(),
  )

/** What Settings shows of the match: the business's, or the caller's own. */
async function matchOf(
  s: Setup,
  who: TestActor = s.terence,
  which: 'business' | 'mine' = 'business',
  businessId: Id<'businesses'> = s.businessId,
) {
  const status = await who.as.query(api.xero.status, { businessId })
  return status[which]?.match ?? null
}

/** The counts Settings should show for these rows: "Matched", "To check",
 * and "New to Xero" — which a client kept apart ("Different", "Unlink") is
 * too, since Release 3 creates a contact for it — with the kept-apart ones
 * also counted on their own, for the match page's Different list. */
function countsOf(rows: Array<Doc<'xeroContactLinks'>>) {
  return {
    linked: rows.filter((r) => r.state === 'linked').length,
    review: rows.filter((r) => r.state === 'needs_review').length,
    fresh: rows.filter((r) => r.state === 'new' || r.state === 'separate')
      .length,
    different: rows.filter((r) => r.state === 'separate').length,
  }
}

/** Released: the run let the organisation go, however it ended — not merely
 * a lease left to lapse. */
function released(state: Doc<'xeroSyncState'> | null): boolean {
  return state !== null && state.lease === undefined
}

const audits = (s: Setup, action: string) =>
  s.t.run(async (ctx) =>
    (await ctx.db.query('auditLog').collect()).filter(
      (row) => row.action === action,
    ),
  )

/** Every match run ever scheduled, pending or done. */
const scheduledRuns = (s: Setup) =>
  s.t.run(async (ctx) =>
    (await ctx.db.system.query('_scheduled_functions').collect()).filter(
      (job) => /xeroMatch(\.js)?:run$/.test(job.name),
    ),
  )

// ─────────────────────────────────────────────────────────── the API

type Filter = 'review' | 'matched' | 'new' | 'separate'

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

const decide = (
  s: Setup,
  who: TestActor,
  connectionId: Id<'xeroConnections'>,
  clientId: Id<'clients'>,
  choice: 'same' | 'different',
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
  businessId: Id<'businesses'> = s.businessId,
) =>
  who.as.mutation(api.xeroMatch.unlink, { businessId, connectionId, clientId })

const rematch = (
  s: Setup,
  who: TestActor,
  connectionId: Id<'xeroConnections'>,
  businessId: Id<'businesses'> = s.businessId,
) => who.as.mutation(api.xeroMatch.rematch, { businessId, connectionId })

const reopen = (
  s: Setup,
  who: TestActor,
  connectionId: Id<'xeroConnections'>,
  clientId: Id<'clients'>,
  businessId: Id<'businesses'> = s.businessId,
) =>
  who.as.mutation(api.xeroMatch.reopen, { businessId, connectionId, clientId })

/** A run, `holder`, that has the organisation and is part-way through:
 * what the run's own mutations see between its steps. */
async function midRun(
  s: Setup,
  connectionId: Id<'xeroConnections'>,
  holder: string,
) {
  const claim = await s.t.mutation(internal.xeroMatch.claimTenant, {
    connectionId,
    holder,
  })
  expect(claim).toEqual({ claimed: true })
}

/** The link rows linked to one Xero contact: never more than one client. */
const linkedTo = async (s: Setup, contactId: string) =>
  (await linksOf(s))
    .filter((row) => row.state === 'linked' && row.xeroContactId === contactId)
    .map((row) => row.clientId)

const clientIds = (page: { page: Array<{ clientId: Id<'clients'> }> }) =>
  page.page.map((item) => item.clientId).sort()

/** The same button pressed a second time, from a page that is behind:
 * refused as NOT_FOUND or let pass — the caller checks it changed nothing. */
async function pressedAgain(press: () => Promise<unknown>): Promise<void> {
  try {
    await press()
  } catch (error) {
    expect(String(error)).toMatch(/NOT_FOUND/)
  }
}

// ─────────────────────────────────────────────────────────────── reading

describe('reading an organisation’s contacts', () => {
  test('reads every contact, a thousand a page, archived ones too, a little over a second apart — and only ever with GET', async () => {
    const s = await setup()
    // 1,189 that match nobody, then Coastal Pest's own on the second page.
    const { connection } = await matched(s, { filler: 1189 })

    const reads = s.xero.contactReads()
    expect(reads.map((r) => r.query.get('page'))).toEqual(['1', '2'])
    for (const read of reads) {
      expect(read.query.get('pageSize')).toBe('1000')
      expect(read.query.get('includeArchived')).toBe('true')
      expect(read.headers['xero-tenant-id']).toBe(ORG.coastal)
      expect(read.headers.accept).toBe('application/json')
      expect(read.headers.authorization).toMatch(
        /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/,
      )
    }
    // Starter allows each organisation 60 calls a minute.
    expect(reads[1].at - reads[0].at).toBeGreaterThanOrEqual(1100)

    const state = await syncStateOf(s, connection._id)
    expect(state).toMatchObject({
      businessId: s.businessId,
      tenantId: ORG.coastal,
      // ACTIVE ones only: 1,200 less the archived and the erased.
      match: { state: 'ready', contacts: 1198 },
    })
    // Done, and holding nothing: the next run for the organisation may go.
    expect(released(state)).toBe(true)

    // Read-only: the organisation and its contacts, by GET, nothing else.
    const accounting = s.xero.accountingRequests()
    expect(accounting.length).toBe(3)
    for (const r of accounting) {
      expect(r.method).toBe('GET')
      expect(['/api.xro/2.0/Organisation', '/api.xro/2.0/Contacts']).toContain(
        r.path,
      )
    }
    expect(
      s.xero.requests.filter(
        (r) => r.host === 'api.xero.com' && r.method !== 'GET',
      ),
    ).toEqual([])
    expect(s.xero.unmodelled()).toEqual([])
  }, 30_000)

  test('proposes a link, a check or a new contact for every client — leads wait, binned and archived clients are left out', async () => {
    const s = await setup()
    const { book, connection, id } = await matched(s, { filler: 1189 })
    const rows = await linksOf(s)
    const of = (clientId: Id<'clients'>) =>
      rows.find((row) => row.clientId === clientId)

    // Two pieces of evidence that agree: linked without asking. The account
    // number (0042 is #42) and the name less its "Pty Ltd"; the email (in
    // any capitals) and the name either way round; the contact person's
    // email and the name.
    expect(of(book.acme)).toMatchObject({
      state: 'linked',
      how: 'matched',
      xeroContactId: id('ACME Holdings'),
      xeroName: 'ACME Holdings',
    })
    expect(of(book.smith)).toMatchObject({
      state: 'linked',
      how: 'matched',
      xeroContactId: id('Smith, John'),
      xeroName: 'Smith, John',
    })
    expect(of(book.harbour)).toMatchObject({
      state: 'linked',
      how: 'matched',
      xeroContactId: id('Harbourside Strata'),
      xeroName: 'Harbourside Strata',
    })
    for (const clientId of [book.acme, book.smith, book.harbour]) {
      expect(of(clientId)?.candidate).toBeUndefined()
      expect(of(clientId)?.decidedAt).toBeUndefined()
    }

    // One piece only: put to Terence, with what the card shows of the
    // contact — its main phone, as Xero holds it, and its street's city.
    expect(of(book.brown)).toMatchObject({
      state: 'needs_review',
      candidate: {
        contactId: id('S Brown Family Trust'),
        name: 'S Brown Family Trust',
        email: 'sarah@brown.test',
        reason: 'email_only',
      },
    })
    expect(of(book.nguyen)).toMatchObject({
      state: 'needs_review',
      candidate: {
        contactId: id('Linh Nguyen'),
        name: 'Linh Nguyen',
        phone: '08 9345 6789',
        place: 'Mirrabooka',
        reason: 'name_only',
      },
    })
    // One contact, two clients of its name: both asked, neither linked.
    for (const clientId of [book.jonesA, book.jonesB]) {
      expect(of(clientId)).toMatchObject({
        state: 'needs_review',
        candidate: { contactId: id('Tom Jones'), reason: 'contested' },
      })
      expect(of(clientId)?.xeroContactId).toBeUndefined()
    }
    for (const clientId of [book.brown, book.nguyen]) {
      expect(of(clientId)?.xeroContactId).toBeUndefined()
    }

    // Nothing in Xero — and an archived or erased contact is nothing.
    for (const clientId of [book.patel, book.lee, book.gdpr, book.quiet]) {
      expect(of(clientId)).toMatchObject({ state: 'new' })
      expect(of(clientId)?.xeroContactId).toBeUndefined()
      expect(of(clientId)?.candidate).toBeUndefined()
    }

    // Leads wait for their first job; binned and archived never go.
    for (const clientId of [book.lead, book.binned, book.archived]) {
      expect(of(clientId)).toBeUndefined()
    }
    expect(rows).toHaveLength(11)

    // Every proposal is this run's.
    const state = await syncStateOf(s, connection._id)
    expect(state?.match?.runId).toBeTruthy()
    for (const row of rows) expect(row.runId).toBe(state?.match?.runId)

    // And Settings counts them.
    expect(await matchOf(s)).toEqual({
      state: 'ready',
      at: expect.any(Number),
      linked: 3,
      review: 4,
      fresh: 4,
      different: 0,
      leads: 1,
      shared: 0,
      problem: null,
      staleAfter: null,
    })
    expect(countsOf(rows)).toEqual({
      linked: 3,
      review: 4,
      fresh: 4,
      different: 0,
    })
  }, 30_000)

  test('the review page lists one state at a time, with what each card shows', async () => {
    const s = await setup()
    const { book, connection, id } = await matched(s)

    const toCheck = await reviewPage(s, s.terence, connection._id, 'review')
    expect(toCheck.isDone).toBe(true)
    expect(clientIds(toCheck)).toEqual(
      [book.brown, book.nguyen, book.jonesA, book.jonesB].sort(),
    )
    expect(
      toCheck.page.find((item) => item.clientId === book.nguyen),
    ).toMatchObject({
      clientName: 'Linh Nguyen',
      clientNumber: 9,
      clientPhone: '0400 333 444',
      clientSuburb: 'Mirrabooka',
      state: 'needs_review',
      candidate: {
        contactId: id('Linh Nguyen'),
        name: 'Linh Nguyen',
        phone: '08 9345 6789',
        place: 'Mirrabooka',
        reason: 'name_only',
      },
    })
    // Two clients of one name tell apart by their sites.
    expect(
      toCheck.page.find((item) => item.clientId === book.jonesB),
    ).toMatchObject({ clientNumber: 14, clientSuburb: 'Rockingham' })

    const matchedPage = await reviewPage(
      s,
      s.terence,
      connection._id,
      'matched',
    )
    expect(clientIds(matchedPage)).toEqual(
      [book.acme, book.smith, book.harbour].sort(),
    )
    expect(
      matchedPage.page.find((item) => item.clientId === book.acme),
    ).toMatchObject({
      clientName: 'Acme Holdings Pty Ltd',
      clientNumber: 42,
      clientSuburb: 'Osborne Park',
      state: 'linked',
      how: 'matched',
      xeroName: 'ACME Holdings',
    })

    expect(
      clientIds(await reviewPage(s, s.terence, connection._id, 'new')),
    ).toEqual([book.patel, book.lee, book.gdpr, book.quiet].sort())
    expect(
      (await reviewPage(s, s.terence, connection._id, 'separate')).page,
    ).toEqual([])
  })
})

// ─────────────────────────────────────────────────── the run, and its lease

describe('the match run', () => {
  test('Settings shows nothing before a connect is finished and “reading” while the run runs; a second run for the organisation waits its turn', async () => {
    const s = await setup()
    await coastalBook(s)
    s.xero.contacts(ORG.coastal, coastalContacts())
    const location = await connectVia(s.t, s.terence.as, {
      businessId: s.businessId,
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    // Back from Xero, not finished: no match to speak of.
    expect(await matchOf(s)).toBeNull()

    await s.terence.as.action(api.xero.finishConnect, {
      businessId: s.businessId,
      token: finishFrom(location),
    })
    const [connection] = await s.t.run((ctx) =>
      ctx.db.query('xeroConnections').collect(),
    )

    // Finished: the run is scheduled, and the page already says it is
    // reading, in the same write — with nothing counted, because nothing has
    // been read, and a time after which a run that never started is called
    // stopped: every busy retry, and five minutes more.
    expect(await matchOf(s)).toMatchObject({
      state: 'reading',
      linked: 0,
      review: 0,
      fresh: 0,
      different: 0,
      leads: 0,
      staleAfter: Date.now() + 15 * MINUTE,
    })
    expect(s.xero.contactReads()).toEqual([])
    expect(await scheduledRuns(s)).toEqual([
      expect.objectContaining({
        args: [expect.objectContaining({ connectionId: connection._id })],
        state: { kind: 'pending' },
      }),
    ])

    // A run, held at Xero mid-read: it has the organisation's lease.
    const held = s.xero.holdContacts()
    const running = s.t.action(internal.xeroMatch.run, {
      connectionId: connection._id,
    })
    await held.arrived
    const lease = (await syncStateOf(s, connection._id))?.lease
    expect(lease?.until).toBeGreaterThan(Date.now())
    // Stopped, if it comes to that, two minutes after its lease would lapse.
    expect(await matchOf(s)).toMatchObject({
      state: 'reading',
      problem: null,
      staleAfter: lease!.until + 2 * MINUTE,
    })

    // Another finds the lease taken: it asks Xero for nothing, leaves the
    // lease as it was, and comes back in a minute.
    await s.t.action(internal.xeroMatch.run, { connectionId: connection._id })
    expect(s.xero.contactReads()).toHaveLength(1)
    expect((await syncStateOf(s, connection._id))?.lease).toEqual(lease)
    const retries = (await scheduledRuns(s)).filter(
      (job) => job.state.kind === 'pending' && job.args[0].attempt === 1,
    )
    expect(retries).toEqual([
      expect.objectContaining({
        args: [{ connectionId: connection._id, attempt: 1 }],
        scheduledTime: Date.now() + MINUTE,
      }),
    ])

    // Check Xero again, pressed now, is answered by the run under way: it
    // is refused, and starts no other.
    const pending = (await scheduledRuns(s)).filter(
      (job) => job.state.kind === 'pending',
    ).length
    await expect(rematch(s, s.terence, connection._id)).rejects.toThrow(
      /XERO_MATCH_RUNNING/,
    )
    expect(
      (await scheduledRuns(s)).filter((job) => job.state.kind === 'pending'),
    ).toHaveLength(pending)

    held.release()
    await running
    expect(await matchOf(s)).toMatchObject({ state: 'ready', linked: 3 })
    expect(released(await syncStateOf(s, connection._id))).toBe(true)

    // The waiting ones run in their turn, and come to the same answer.
    await settle(s)
    expect(await matchOf(s)).toMatchObject({
      state: 'ready',
      linked: 3,
      review: 4,
      fresh: 4,
      leads: 1,
    })
    expect(await linksOf(s)).toHaveLength(11)
  })

  test('waits while another business reads the same organisation, trying each minute, and reads once the lease is free', async () => {
    const s = await setup()
    s.xero.contacts(ORG.coastal, coastalContacts())
    // Terence's second business uses the same organisation, and its run
    // holds the lease for the next two and a half minutes.
    const { businessId: north } = await createBusiness(
      s.t,
      s.terence,
      'Coastal Pest North',
    )
    const northern = await connect(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
      businessId: north,
    })
    const until = Date.now() + 150_000
    await s.t.run(async (ctx) => {
      const state = await ctx.db
        .query('xeroSyncState')
        .withIndex('by_connection', (q) => q.eq('connectionId', northern._id))
        .unique()
      await ctx.db.patch(state!._id, {
        lease: { holder: 'north-run', until },
      })
    })
    const readsBefore = s.xero.contactReads().length

    await coastalBook(s)
    const coastal = await connect(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })

    // Not one read while the lease was held.
    const reads = s.xero.contactReads().slice(readsBefore)
    expect(reads.length).toBeGreaterThan(0)
    for (const read of reads) expect(read.at).toBeGreaterThanOrEqual(until)
    // Tried at once, then at one, two and three minutes.
    const attempts = (await scheduledRuns(s))
      .filter((job) => job.args[0].connectionId === coastal._id)
      .map((job) => job.args[0].attempt ?? 0)
      .sort()
    expect(attempts).toEqual([0, 1, 2, 3])
    expect(await matchOf(s)).toMatchObject({
      state: 'ready',
      linked: 3,
      review: 4,
      fresh: 4,
      leads: 1,
    })
  })

  test('…and gives up after ten tries, as busy, leaving the other run’s lease alone; Check Xero again then works', async () => {
    const s = await setup()
    s.xero.contacts(ORG.coastal, coastalContacts())
    const { businessId: north } = await createBusiness(
      s.t,
      s.terence,
      'Coastal Pest North',
    )
    const northern = await connect(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
      businessId: north,
    })
    const northState = async () =>
      (await syncStateOf(s, northern._id)) as Doc<'xeroSyncState'>
    const northStateId = (await northState())._id
    const lease = { holder: 'north-run', until: Date.now() + HOUR }
    await s.t.run((ctx) => ctx.db.patch(northStateId, { lease }))
    const readsBefore = s.xero.contactReads().length

    await coastalBook(s)
    const coastal = await connect(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })

    expect(await matchOf(s)).toMatchObject({ state: 'failed', problem: 'busy' })
    expect(s.xero.contactReads()).toHaveLength(readsBefore)
    expect(await linksOf(s)).toEqual([])
    expect((await northState()).lease).toEqual(lease)
    const tries = (await scheduledRuns(s)).filter(
      (job) => job.args[0].connectionId === coastal._id,
    )
    expect(tries.length).toBeGreaterThanOrEqual(10)
    expect(tries.length).toBeLessThanOrEqual(11)

    // North's run finishes; Terence asks again.
    await s.t.run((ctx) => ctx.db.patch(northStateId, { lease: undefined }))
    await rematch(s, s.terence, coastal._id)
    await settle(s)
    expect(await matchOf(s)).toMatchObject({
      state: 'ready',
      linked: 3,
      problem: null,
    })
  })

  test('a sign-in Xero no longer accepts fails the match as reconnect, keeping what it had; reconnecting reads again', async () => {
    const s = await setup()
    const { connection } = await matched(s)
    const before = await linksOf(s)
    const reads = s.xero.contactReads().length
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    // The access token has lapsed, and Xero refuses the refresh.
    await s.t.run((ctx) =>
      ctx.db.patch(connection.grantId, { accessExpiresAt: Date.now() - 1000 }),
    )
    s.xero.knobs.failRefresh = 'invalid_grant'
    await rematch(s, s.terence, connection._id)
    await settle(s)

    expect(await matchOf(s)).toMatchObject({
      state: 'failed',
      problem: 'reconnect',
    })
    expect((await connectionRow(s, connection._id)).status).toBe(
      'needs_reconnect',
    )
    expect(s.xero.contactReads()).toHaveLength(reads)
    expect(released(await syncStateOf(s, connection._id))).toBe(true)
    // What the last match proposed waits for it to come back.
    expect(await linksOf(s)).toEqual(before)

    // Terence reconnects the same organisation: it is read again.
    s.xero.knobs.failRefresh = null
    await connect(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    expect((await connectionRow(s, connection._id)).status).toBe('connected')
    expect(s.xero.contactReads()).toHaveLength(reads + 1)
    expect(await matchOf(s)).toMatchObject({
      state: 'ready',
      linked: 3,
      review: 4,
      fresh: 4,
      leads: 1,
      problem: null,
    })
  })

  test('a reconnect reads Xero again only when the last match failed or is over a week old', async () => {
    const s = await setup()
    const { connection } = await matched(s)
    const reads = s.xero.contactReads().length
    const reconnect = () =>
      connect(s, s.terence, {
        kind: 'business',
        xeroUserId: XU.terence,
        tenantId: ORG.coastal,
      })

    const again = await reconnect()
    expect(again._id).toBe(connection._id)
    expect(s.xero.contactReads()).toHaveLength(reads)

    // Eight days on.
    await s.t.run(async (ctx) => {
      const state = await ctx.db
        .query('xeroSyncState')
        .withIndex('by_connection', (q) => q.eq('connectionId', connection._id))
        .unique()
      await ctx.db.patch(state!._id, {
        match: { ...state!.match!, at: Date.now() - 8 * DAY },
      })
    })
    await reconnect()
    expect(s.xero.contactReads()).toHaveLength(reads + 1)
    expect(await matchOf(s)).toMatchObject({ state: 'ready' })
  })

  test('Xero failing part-way through fails the match, and nothing is dropped or half-saved', async () => {
    const s = await setup()
    const { book, connection } = await matched(s, { filler: 1189 })
    await decide(s, s.terence, connection._id, book.brown, 'same')
    // A client binned since: a finished match would drop its proposal.
    await s.t.run((ctx) => ctx.db.patch(book.patel, { deletedAt: Date.now() }))
    const before = await linksOf(s)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    // The second page fails, however often it is asked for.
    s.xero.contactsFail(503, {}, { page: 2 })
    await rematch(s, s.terence, connection._id)
    await settle(s)

    expect(await matchOf(s)).toMatchObject({
      state: 'failed',
      problem: expect.any(String),
    })
    expect(await linksOf(s)).toEqual(before)
    expect(released(await syncStateOf(s, connection._id))).toBe(true)
    // Asked for page 2, never for a page 3 it had no reason to think was
    // there, and never with anything but GET.
    expect(
      new Set(s.xero.contactReads().map((r) => r.query.get('page'))),
    ).toEqual(new Set(['1', '2']))
    expect(
      s.xero.accountingRequests().filter((r) => r.method !== 'GET'),
    ).toEqual([])
  }, 30_000)

  test('with the organisation’s minute nearly spent by others, it waits for the next minute rather than be refused', async () => {
    const s = await setup()
    await coastalBook(s)
    s.xero.contacts(ORG.coastal, [...filler(1189), ...coastalContacts()])
    // Xero allows each organisation 60 calls a minute, from every app
    // together; something else has just made 58 of this one's.
    s.xero.spend(ORG.coastal, 58)
    await connect(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })

    const reads = s.xero.contactReads()
    expect(reads.map((r) => r.status)).toEqual([200, 200])
    expect(s.xero.accountingRequests().filter((r) => r.status === 429)).toEqual(
      [],
    )
    expect(await matchOf(s)).toMatchObject({
      state: 'ready',
      linked: 3,
      review: 4,
      fresh: 4,
    })
  }, 30_000)

  test('an organisation of more than fifty thousand contacts is too big to match', async () => {
    const s = await setup()
    await coastalBook(s)
    s.xero.contacts(ORG.coastal, filler(50_001))
    await connect(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })

    expect(await matchOf(s)).toMatchObject({
      state: 'failed',
      problem: 'too_many_contacts',
    })
    const reads = s.xero.contactReads().length
    expect(reads).toBeGreaterThanOrEqual(50)
    expect(reads).toBeLessThanOrEqual(51)
    expect(await linksOf(s)).toEqual([])
  }, 120_000)

  test('a connection no longer connected, or a business that became the demo, is not read', async () => {
    const s = await setup()
    const { connection } = await matched(s)
    const reads = s.xero.contactReads().length
    const before = await linksOf(s)

    await s.t.run((ctx) => ctx.db.patch(s.businessId, { plan: DEMO_PLAN }))
    await s.t.action(internal.xeroMatch.run, { connectionId: connection._id })
    await s.t.run((ctx) => ctx.db.patch(s.businessId, { plan: undefined }))

    await s.terence.as.mutation(api.xero.disconnect, {
      businessId: s.businessId,
      connectionId: connection._id,
    })
    await s.t.action(internal.xeroMatch.run, { connectionId: connection._id })
    await settle(s)

    expect(s.xero.contactReads()).toHaveLength(reads)
    expect(await linksOf(s)).toEqual(before)
  })

  test('a connection that needs reconnecting before its run starts fails the match as reconnect, rather than leave it reading', async () => {
    const s = await setup()
    const { connection } = await matched(s)
    const reads = s.xero.contactReads().length

    await rematch(s, s.terence, connection._id)
    expect(await matchOf(s)).toMatchObject({ state: 'reading' })
    await s.t.run((ctx) =>
      ctx.db.patch(connection._id, { status: 'needs_reconnect' }),
    )
    await settle(s)

    expect(await matchOf(s)).toMatchObject({
      state: 'failed',
      problem: 'reconnect',
      staleAfter: null,
    })
    expect(s.xero.contactReads()).toHaveLength(reads)
  })

  test('a run that dies part-way is past believing once its lease lapses; Check Xero again then reads afresh, and the dead run can change nothing if it wakes', async () => {
    const s = await setup()
    const { book, connection, id } = await matched(s)
    const connectionId = connection._id

    // A run takes the organisation, and dies — a deploy, or the action time
    // limit — before it can say so.
    await midRun(s, connectionId, 'dead-run')
    const lease = (await syncStateOf(s, connectionId))?.lease
    const reading = await matchOf(s)
    expect(reading).toMatchObject({
      state: 'reading',
      staleAfter: lease!.until + 2 * MINUTE,
    })

    // While its lease is live, it is the read under way.
    await expect(rematch(s, s.terence, connectionId)).rejects.toThrow(
      /XERO_MATCH_RUNNING/,
    )

    // Past that time the page calls it stopped and offers Check Xero again,
    // which starts a run of its own.
    vi.setSystemTime(reading!.staleAfter! + 1)
    await rematch(s, s.terence, connectionId)
    await settle(s)
    const after = await syncStateOf(s, connectionId)
    expect(after?.match).toMatchObject({
      state: 'ready',
      linked: 3,
      review: 4,
      fresh: 4,
    })
    expect(after?.match?.runId).not.toBe('dead-run')
    expect(released(after)).toBe(true)
    const links = await linksOf(s)

    // The dead run wakes: every write it would make is refused or ignored.
    await expect(
      s.t.mutation(internal.xeroMatch.renewLease, {
        connectionId,
        holder: 'dead-run',
      }),
    ).rejects.toThrow(/LEASE_LOST/)
    await expect(
      s.t.mutation(internal.xeroMatch.saveProposals, {
        connectionId,
        holder: 'dead-run',
        runId: 'dead-run',
        proposals: [{ clientId: book.acme, outcome: 'new' }],
      }),
    ).rejects.toThrow(/LEASE_LOST/)
    expect(
      await s.t.mutation(internal.xeroMatch.setMatchState, {
        connectionId,
        state: 'failed',
        problem: 'failed',
        runId: 'dead-run',
      }),
    ).toEqual({ written: false })
    expect(
      await s.t.mutation(internal.xeroMatch.finishMatch, {
        connectionId,
        holder: 'dead-run',
        runId: 'dead-run',
        counts: {
          contacts: 0,
          linked: 0,
          review: 0,
          fresh: 0,
          different: 0,
          leads: 0,
        },
        cursor: null,
      }),
    ).toEqual({ done: true })
    expect(await syncStateOf(s, connectionId)).toEqual(after)
    expect(await linksOf(s)).toEqual(links)
    expect(await linkedTo(s, id('ACME Holdings'))).toEqual([book.acme])
  })

  test('a run overtaken after its lease lapsed is refused while the run that took the organisation holds it, in any business', async () => {
    const s = await setup()
    const { book, connection, id } = await matched(s)
    const { businessId: north } = await createBusiness(
      s.t,
      s.terence,
      'Coastal Pest North',
    )
    const northern = await connect(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
      businessId: north,
    })
    const before = await linksOf(s)

    // Coastal Pest's run takes the organisation and stalls past its lease
    // (a minute's wait at Xero, twice over); North's then takes it.
    await midRun(s, connection._id, 'run-a')
    vi.setSystemTime(Date.now() + 6 * MINUTE)
    await midRun(s, northern._id, 'run-b')
    const northLease = (await syncStateOf(s, northern._id))?.lease

    // Coastal's wakes: it may not renew, save or take the organisation back.
    await expect(
      s.t.mutation(internal.xeroMatch.renewLease, {
        connectionId: connection._id,
        holder: 'run-a',
      }),
    ).rejects.toThrow(/LEASE_LOST/)
    await expect(
      s.t.mutation(internal.xeroMatch.saveProposals, {
        connectionId: connection._id,
        holder: 'run-a',
        runId: 'run-a',
        proposals: [
          {
            clientId: book.patel,
            outcome: 'linked',
            contact: {
              contactId: id('ACME Holdings'),
              name: 'ACME Holdings',
              status: 'ACTIVE',
            },
          },
        ],
      }),
    ).rejects.toThrow(/LEASE_LOST/)
    expect(
      await s.t.mutation(internal.xeroMatch.claimTenant, {
        connectionId: connection._id,
        holder: 'run-a',
      }),
    ).toEqual({ claimed: false, reason: 'busy' })

    expect(await linksOf(s)).toEqual(before)
    expect((await syncStateOf(s, northern._id))?.lease).toEqual(northLease)
  })

  test('finishing a large match drops stale proposals five hundred at a time, keeping every decision and the run’s own, and only then is ready', async () => {
    const s = await setup()
    const { book, connection } = await matched(s)
    const connectionId = connection._id
    await decide(s, s.terence, connectionId, book.brown, 'same')

    // Run "run-x" has the organisation and has proposed Raj Patel afresh;
    // six hundred proposals an earlier run left behind are stale.
    await midRun(s, connectionId, 'run-x')
    await s.t.run(async (ctx) => {
      const patel = await ctx.db
        .query('xeroContactLinks')
        .withIndex('by_business_and_tenant_and_client', (q) =>
          q
            .eq('businessId', s.businessId)
            .eq('tenantId', ORG.coastal)
            .eq('clientId', book.patel),
        )
        .unique()
      await ctx.db.patch(patel!._id, { runId: 'run-x' })
      for (let i = 0; i < 600; i++) {
        await ctx.db.insert('xeroContactLinks', {
          businessId: s.businessId,
          tenantId: ORG.coastal,
          clientId: book.quiet,
          state: 'new',
          runId: 'old-run',
        })
      }
    })
    const counts = {
      contacts: 9,
      linked: 1,
      review: 0,
      fresh: 1,
      different: 0,
      leads: 1,
    }

    expect(
      await s.t.mutation(internal.xeroMatch.finishMatch, {
        connectionId,
        holder: 'run-x',
        runId: 'run-x',
        counts,
        cursor: null,
      }),
    ).toEqual({ done: false })
    // Not ready until the last of them has gone, in calls of their own.
    expect((await syncStateOf(s, connectionId))?.match?.state).toBe('reading')
    await settle(s)

    const rows = await linksOf(s)
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.decidedAt === undefined)).toMatchObject({
      clientId: book.patel,
      runId: 'run-x',
    })
    expect(rows.find((row) => row.decidedAt !== undefined)).toMatchObject({
      clientId: book.brown,
      state: 'linked',
    })
    const state = await syncStateOf(s, connectionId)
    expect(state?.match).toMatchObject({
      state: 'ready',
      runId: 'run-x',
      ...counts,
    })
    expect(released(state)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────── deciding

describe('deciding', () => {
  test('Same client links the two; Different client keeps them apart — both recorded, both counted', async () => {
    const s = await setup()
    const { book, connection, id } = await matched(s)

    await decide(s, s.terence, connection._id, book.brown, 'same')
    const brown = await link(s, book.brown)
    expect(brown).toMatchObject({
      state: 'linked',
      how: 'chosen',
      xeroContactId: id('S Brown Family Trust'),
      xeroName: 'S Brown Family Trust',
      decidedAt: Date.now(),
      decidedByMembershipId: s.ownerMembershipId,
    })
    expect(brown.candidate).toBeUndefined()
    expect(await audits(s, 'xero.link')).toEqual([
      expect.objectContaining({
        businessId: s.businessId,
        actorMembershipId: s.ownerMembershipId,
        entityType: 'clients',
        entityId: book.brown,
        meta: expect.objectContaining({
          tenantName: 'Coastal Pest Pty Ltd',
          xeroContactId: id('S Brown Family Trust'),
        }),
      }),
    ])
    expect(await matchOf(s)).toMatchObject({ linked: 4, review: 3, fresh: 4 })
    // A double tap changes nothing, and is not counted twice.
    await pressedAgain(() =>
      decide(s, s.terence, connection._id, book.brown, 'same'),
    )
    expect(await link(s, book.brown)).toEqual(brown)
    expect(await audits(s, 'xero.link')).toHaveLength(1)
    expect(await matchOf(s)).toMatchObject({ linked: 4, review: 3, fresh: 4 })

    await decide(s, s.terence, connection._id, book.nguyen, 'different')
    const nguyen = await link(s, book.nguyen)
    expect(nguyen).toMatchObject({
      state: 'separate',
      decidedAt: Date.now(),
      decidedByMembershipId: s.ownerMembershipId,
      // Kept, so the page can say what it was kept apart from.
      candidate: { contactId: id('Linh Nguyen'), reason: 'name_only' },
    })
    expect(nguyen.xeroContactId).toBeUndefined()
    expect(await audits(s, 'xero.separate')).toEqual([
      expect.objectContaining({
        actorMembershipId: s.ownerMembershipId,
        entityType: 'clients',
        entityId: book.nguyen,
        meta: expect.objectContaining({ tenantName: 'Coastal Pest Pty Ltd' }),
      }),
    ])
    expect(await matchOf(s)).toMatchObject({
      linked: 4,
      review: 2,
      fresh: 5,
      different: 1,
    })
    expect(countsOf(await linksOf(s))).toEqual({
      linked: 4,
      review: 2,
      fresh: 5,
      different: 1,
    })

    // The page moves them: to Matched, and to Different.
    expect(
      clientIds(await reviewPage(s, s.terence, connection._id, 'review')),
    ).toEqual([book.jonesA, book.jonesB].sort())
    const matchedPage = await reviewPage(
      s,
      s.terence,
      connection._id,
      'matched',
    )
    expect(
      matchedPage.page.find((item) => item.clientId === book.brown),
    ).toMatchObject({
      how: 'chosen',
      xeroName: 'S Brown Family Trust',
      decidedAt: Date.now(),
    })
    expect(
      clientIds(await reviewPage(s, s.terence, connection._id, 'separate')),
    ).toEqual([book.nguyen])

    // Deciding asks Xero nothing.
    expect(s.xero.contactReads()).toHaveLength(1)
  })

  test('one Xero contact is one client’s: Same on a second is CONTACT_TAKEN', async () => {
    const s = await setup()
    const { book, connection, id } = await matched(s)

    await decide(s, s.terence, connection._id, book.jonesA, 'same')
    expect(await link(s, book.jonesA)).toMatchObject({
      state: 'linked',
      how: 'chosen',
      xeroContactId: id('Tom Jones'),
    })

    const before = await link(s, book.jonesB)
    await expect(
      decide(s, s.terence, connection._id, book.jonesB, 'same'),
    ).rejects.toThrow(/CONTACT_TAKEN/)
    expect(await link(s, book.jonesB)).toEqual(before)
    expect(await audits(s, 'xero.link')).toHaveLength(1)
    expect(await matchOf(s)).toMatchObject({ linked: 4, review: 3, fresh: 4 })

    // Different is still his to say.
    await decide(s, s.terence, connection._id, book.jonesB, 'different')
    expect(await link(s, book.jonesB)).toMatchObject({ state: 'separate' })
    expect(await linkedTo(s, id('Tom Jones'))).toEqual([book.jonesA])
  })

  test('only a client waiting to be checked can be decided', async () => {
    const s = await setup()
    const { book, connection } = await matched(s)

    // Already matched; nothing in Xero to agree with; a lead, not offered.
    for (const clientId of [book.acme, book.patel, book.lead, book.binned]) {
      await expect(
        decide(s, s.terence, connection._id, clientId, 'same'),
      ).rejects.toThrow(/NOT_FOUND/)
    }
    for (const clientId of [book.patel, book.lead]) {
      await expect(
        decide(s, s.terence, connection._id, clientId, 'different'),
      ).rejects.toThrow(/NOT_FOUND/)
    }
    expect(await linkOf(s, book.lead)).toBeNull()
    expect((await link(s, book.patel)).state).toBe('new')

    // Different on one matched without asking is an Unlink.
    await decide(s, s.terence, connection._id, book.acme, 'different')
    expect(await link(s, book.acme)).toMatchObject({
      state: 'separate',
      decidedAt: Date.now(),
      decidedByMembershipId: s.ownerMembershipId,
    })
  })

  test('Unlink parts a linked client from its Xero contact, and no match links it again', async () => {
    const s = await setup()
    const { book, connection, id } = await matched(s)

    await unlink(s, s.terence, connection._id, book.acme)
    const acme = await link(s, book.acme)
    expect(acme).toMatchObject({
      state: 'separate',
      decidedAt: Date.now(),
      decidedByMembershipId: s.ownerMembershipId,
    })
    expect(acme.xeroContactId).toBeUndefined()
    // The contact it was linked to is kept, to say which it isn't — and for
    // Match again.
    expect(acme.candidate).toEqual({
      contactId: id('ACME Holdings'),
      name: 'ACME Holdings',
      reason: 'unlinked',
    })
    expect(await audits(s, 'xero.unlink')).toEqual([
      expect.objectContaining({
        actorMembershipId: s.ownerMembershipId,
        entityType: 'clients',
        entityId: book.acme,
        meta: expect.objectContaining({ tenantName: 'Coastal Pest Pty Ltd' }),
      }),
    ])
    expect(await matchOf(s)).toMatchObject({
      linked: 2,
      review: 4,
      fresh: 5,
      different: 1,
    })

    // One he matched himself comes apart the same way.
    await decide(s, s.terence, connection._id, book.brown, 'same')
    await unlink(s, s.terence, connection._id, book.brown)
    expect(await link(s, book.brown)).toMatchObject({ state: 'separate' })
    expect(await matchOf(s)).toMatchObject({
      linked: 2,
      review: 3,
      fresh: 6,
      different: 2,
    })
    expect(countsOf(await linksOf(s))).toEqual({
      linked: 2,
      review: 3,
      fresh: 6,
      different: 2,
    })

    // Unlinking again is a double tap: nothing changes, nothing is recorded.
    const apart = await link(s, book.acme)
    await pressedAgain(() => unlink(s, s.terence, connection._id, book.acme))
    expect(await link(s, book.acme)).toEqual(apart)
    // Only something linked can be unlinked.
    for (const clientId of [book.patel, book.jonesA]) {
      await expect(
        unlink(s, s.terence, connection._id, clientId),
      ).rejects.toThrow(/NOT_FOUND/)
    }
    expect(await audits(s, 'xero.unlink')).toHaveLength(2)
    expect(await matchOf(s)).toMatchObject({ linked: 2, review: 3, fresh: 6 })
  })

  test('Match again takes back a Different, or an Unlink, and asks again', async () => {
    const s = await setup()
    const { book, connection, id } = await matched(s)
    const connectionId = connection._id

    // A Different, tapped by mistake.
    await decide(s, s.terence, connectionId, book.nguyen, 'different')
    expect(await matchOf(s)).toMatchObject({
      review: 3,
      fresh: 5,
      different: 1,
    })
    expect(await reopen(s, s.terence, connectionId, book.nguyen)).toBe(
      'needs_review',
    )
    const nguyen = await link(s, book.nguyen)
    expect(nguyen).toMatchObject({
      state: 'needs_review',
      candidate: { contactId: id('Linh Nguyen'), reason: 'name_only' },
    })
    expect(nguyen.decidedAt).toBeUndefined()
    expect(nguyen.decidedByMembershipId).toBeUndefined()
    expect(await matchOf(s)).toMatchObject({
      linked: 3,
      review: 4,
      fresh: 4,
      different: 0,
    })
    expect(
      clientIds(await reviewPage(s, s.terence, connectionId, 'review')),
    ).toContain(book.nguyen)
    expect(await audits(s, 'xero.reopen')).toEqual([
      expect.objectContaining({
        actorMembershipId: s.ownerMembershipId,
        entityType: 'clients',
        entityId: book.nguyen,
        meta: expect.objectContaining({
          tenantName: 'Coastal Pest Pty Ltd',
          xeroContactId: id('Linh Nguyen'),
        }),
      }),
    ])
    // Answered the other way this time.
    await decide(s, s.terence, connectionId, book.nguyen, 'same')
    expect(await link(s, book.nguyen)).toMatchObject({
      state: 'linked',
      how: 'chosen',
      xeroContactId: id('Linh Nguyen'),
    })

    // An Unlink comes back as a question about the contact it was unlinked
    // from, and Same links them again.
    await unlink(s, s.terence, connectionId, book.acme)
    expect(await link(s, book.acme)).toMatchObject({
      state: 'separate',
      candidate: {
        contactId: id('ACME Holdings'),
        name: 'ACME Holdings',
        reason: 'unlinked',
      },
    })
    expect(await reopen(s, s.terence, connectionId, book.acme)).toBe(
      'needs_review',
    )
    await decide(s, s.terence, connectionId, book.acme, 'same')
    expect(await link(s, book.acme)).toMatchObject({
      state: 'linked',
      how: 'chosen',
      xeroContactId: id('ACME Holdings'),
      xeroName: 'ACME Holdings',
    })
    expect(await matchOf(s)).toMatchObject({
      linked: 4,
      review: 3,
      fresh: 4,
      different: 0,
    })
    expect(countsOf(await linksOf(s))).toEqual({
      linked: 4,
      review: 3,
      fresh: 4,
      different: 0,
    })

    // Only a Different can be matched again; a second tap changes nothing.
    const before = await linksOf(s)
    for (const clientId of [book.acme, book.patel, book.jonesA, book.lead]) {
      await expect(
        reopen(s, s.terence, connectionId, clientId),
      ).rejects.toThrow(/NOT_FOUND/)
    }
    expect(await linksOf(s)).toEqual(before)
    expect(await audits(s, 'xero.reopen')).toHaveLength(2)
  })

  test('a client in the Recycle bin holds no Xero contact: Same on its namesake takes it, and restored it is matched afresh', async () => {
    const s = await setup()
    const { book, connection, id } = await matched(s)
    const connectionId = connection._id

    await decide(s, s.terence, connectionId, book.jonesA, 'same')
    expect(await matchOf(s)).toMatchObject({ linked: 4, review: 3 })
    // Tom Jones A was a duplicate: it goes in the bin, off every list and
    // out of the counts.
    const entryId = await s.terence.as.mutation(api.bin.deleteClient, {
      businessId: s.businessId,
      clientId: book.jonesA,
    })
    expect(
      clientIds(await reviewPage(s, s.terence, connectionId, 'matched')),
    ).not.toContain(book.jonesA)
    expect(await matchOf(s)).toMatchObject({ linked: 3, review: 3 })

    // So Same on Tom Jones B is not refused over a client nobody can see:
    // B takes the contact, and A's link goes.
    await decide(s, s.terence, connectionId, book.jonesB, 'same')
    expect(await link(s, book.jonesB)).toMatchObject({
      state: 'linked',
      xeroContactId: id('Tom Jones'),
    })
    expect(await linkOf(s, book.jonesA)).toBeNull()
    expect(await linkedTo(s, id('Tom Jones'))).toEqual([book.jonesB])
    expect(await matchOf(s)).toMatchObject({ linked: 4, review: 2 })

    // Restored, A has no link to bring back; the next match asks about it,
    // and B keeps the contact.
    await s.terence.as.mutation(api.bin.restore, {
      businessId: s.businessId,
      entryId,
    })
    expect(await matchOf(s)).toMatchObject({ linked: 4, review: 2 })
    await rematch(s, s.terence, connectionId)
    await settle(s)
    expect(await link(s, book.jonesA)).toMatchObject({
      state: 'needs_review',
      candidate: { contactId: id('Tom Jones'), reason: 'contested' },
    })
    expect(await linkedTo(s, id('Tom Jones'))).toEqual([book.jonesB])
    expect(await matchOf(s)).toMatchObject({ linked: 4, review: 3 })
  })
})

// ──────────────────────────────────────────────────────────── matching again

describe('matching again', () => {
  test('keeps every decision, refreshes what is undecided, and drops what no longer belongs', async () => {
    const s = await setup()
    const { book, connection, contacts, id } = await matched(s)
    await decide(s, s.terence, connection._id, book.brown, 'same')
    await decide(s, s.terence, connection._id, book.nguyen, 'different')
    await unlink(s, s.terence, connection._id, book.acme)
    const decided = {
      brown: await link(s, book.brown),
      nguyen: await link(s, book.nguyen),
      acme: await link(s, book.acme),
    }
    const firstRun = (await syncStateOf(s, connection._id))?.match?.runId

    // Meanwhile Raj Patel turns up in Xero (a mobile, no main line), Grace
    // Lee is binned, John Smith is a lead again, and a client is added under
    // the very name and email of the contact Terence chose for Sarah Brown.
    const raj = s.xero
      .contacts(ORG.coastal, [
        ...contacts,
        { name: 'Raj Patel', mobile: { number: '0411 222 333' } },
      ])
      .at(-1)!
    await s.t.run(async (ctx) => {
      await ctx.db.patch(book.lee, { deletedAt: Date.now() })
      await ctx.db.patch(book.smith, { status: 'lead' })
    })
    const trust = await addClient(s, {
      name: 'S Brown Family Trust',
      clientNumber: 30,
      email: 'sarah@brown.test',
    })

    await rematch(s, s.terence, connection._id)
    // The page says so at once, before the run has started.
    expect(await matchOf(s)).toMatchObject({ state: 'reading' })
    await settle(s)

    const state = await syncStateOf(s, connection._id)
    const runId = state?.match?.runId
    expect(state?.match?.state).toBe('ready')
    expect(runId).toBeTruthy()
    expect(runId).not.toBe(firstRun)

    // His word stands — even for ACME, which the match would link again.
    expect(await link(s, book.brown)).toEqual(decided.brown)
    expect(await link(s, book.nguyen)).toEqual(decided.nguyen)
    expect(await link(s, book.acme)).toEqual(decided.acme)
    // The contact he chose for Sarah Brown is hers: the newcomer, with its
    // name and email, is asked about rather than linked to it.
    expect(await link(s, trust)).toMatchObject({
      state: 'needs_review',
      candidate: { contactId: id('S Brown Family Trust'), reason: 'contested' },
    })
    expect((await link(s, trust)).xeroContactId).toBeUndefined()
    // What is undecided says what Xero says now, as of this run.
    expect(await link(s, book.patel)).toMatchObject({
      state: 'needs_review',
      runId,
      candidate: {
        contactId: raj.contactId,
        name: 'Raj Patel',
        phone: '0411 222 333',
        reason: 'name_only',
      },
    })
    // Binned, or waiting as a lead: their proposals go.
    expect(await linkOf(s, book.lee)).toBeNull()
    expect(await linkOf(s, book.smith)).toBeNull()

    const rows = await linksOf(s)
    for (const row of rows) {
      if (row.decidedAt === undefined) expect(row.runId).toBe(runId)
    }
    expect(countsOf(rows)).toEqual({
      linked: 2,
      review: 4,
      fresh: 4,
      different: 2,
    })
    expect(await matchOf(s)).toEqual({
      state: 'ready',
      at: expect.any(Number),
      linked: 2,
      review: 4,
      fresh: 4,
      different: 2,
      leads: 2,
      shared: 0,
      problem: null,
      staleAfter: null,
    })

    // Read again — by GET, and nothing else.
    expect(s.xero.contactReads()).toHaveLength(2)
    expect(
      s.xero.accountingRequests().filter((r) => r.method !== 'GET'),
    ).toEqual([])
    expect(s.xero.unmodelled()).toEqual([])
  })

  test('another business on the same organisation keeps its own links throughout', async () => {
    const s = await setup()
    const { book, connection } = await matched(s)
    const { businessId: north } = await createBusiness(
      s.t,
      s.terence,
      'Coastal Pest North',
    )
    const northSmith = await addClient(
      s,
      { name: 'John Smith', clientNumber: 1, email: 'john@smith.test' },
      north,
    )
    const northLee = await addClient(
      s,
      { name: 'Grace Lee', clientNumber: 2 },
      north,
    )
    const northern = await connect(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
      businessId: north,
    })
    const theirs = await linksOf(s, ORG.coastal, north)
    expect(theirs).toHaveLength(2)
    // The same Xero contact can be John Smith in both: one per business.
    expect(theirs.find((r) => r.clientId === northSmith)).toMatchObject({
      state: 'linked',
      xeroContactId: (await link(s, book.smith)).xeroContactId,
    })
    expect(theirs.find((r) => r.clientId === northLee)).toMatchObject({
      state: 'new',
    })
    const theirMatch = await matchOf(s, s.terence, 'business', north)

    // Coastal Pest decides, bins Grace Lee, matches again, and deletes Raj
    // Patel for good.
    await decide(s, s.terence, connection._id, book.brown, 'same')
    await unlink(s, s.terence, connection._id, book.smith)
    await s.t.run((ctx) => ctx.db.patch(book.lee, { deletedAt: Date.now() }))
    await rematch(s, s.terence, connection._id)
    await settle(s)
    const entryId = await s.terence.as.mutation(api.bin.deleteClient, {
      businessId: s.businessId,
      clientId: book.patel,
    })
    await s.terence.as.mutation(api.bin.wipe, {
      businessId: s.businessId,
      entryId,
    })
    await settle(s)
    expect(await linkOf(s, book.lee)).toBeNull()
    expect(await linkOf(s, book.patel)).toBeNull()

    // North's are exactly as they were, and counted as they were.
    expect(await linksOf(s, ORG.coastal, north)).toEqual(theirs)
    expect(await matchOf(s, s.terence, 'business', north)).toEqual(theirMatch)
    expect(theirMatch).toMatchObject({ linked: 1, review: 0, fresh: 1 })
    expect(
      (await linksOf(s)).some(
        (r) => r.clientId === northSmith || r.clientId === northLee,
      ),
    ).toBe(false)
    expect((await syncStateOf(s, northern._id))?.match?.state).toBe('ready')
  })

  test('a contact linked to a client now in the Recycle bin goes to the client the run links to it, and the binned link goes', async () => {
    const s = await setup()
    const { book, connection, id } = await matched(s)
    await decide(s, s.terence, connection._id, book.brown, 'same')
    // A client under the very name and email of the contact Terence chose
    // for Sarah Brown — who then goes in the bin as its duplicate.
    const trust = await addClient(s, {
      name: 'S Brown Family Trust',
      clientNumber: 30,
      email: 'sarah@brown.test',
    })
    await s.terence.as.mutation(api.bin.deleteClient, {
      businessId: s.businessId,
      clientId: book.brown,
    })

    await rematch(s, s.terence, connection._id)
    await settle(s)

    expect(await link(s, trust)).toMatchObject({
      state: 'linked',
      how: 'matched',
      xeroContactId: id('S Brown Family Trust'),
    })
    expect(await linkOf(s, book.brown)).toBeNull()
    expect(await linkedTo(s, id('S Brown Family Trust'))).toEqual([trust])
  })

  test('a contact an earlier run linked to another client is this run’s to give: never two clients linked to it, even if the run stops between batches', async () => {
    const s = await setup()
    const { book, connection, id } = await matched(s)
    const acmeContact = id('ACME Holdings')
    expect(await link(s, book.acme)).toMatchObject({
      state: 'linked',
      how: 'matched',
      xeroContactId: acmeContact,
    })

    // Since then the contact was given Raj Patel's number and name in Xero.
    // A new run's first batch links him to it; ACME's batch, which would
    // have moved it on, never comes — the run stops there.
    await midRun(s, connection._id, 'run-2')
    await s.t.mutation(internal.xeroMatch.saveProposals, {
      connectionId: connection._id,
      holder: 'run-2',
      runId: 'run-2',
      proposals: [
        {
          clientId: book.patel,
          outcome: 'linked',
          contact: {
            contactId: acmeContact,
            name: 'Raj Patel',
            accountNumber: '11',
            status: 'ACTIVE',
          },
        },
      ],
    })

    expect(await link(s, book.patel)).toMatchObject({
      state: 'linked',
      xeroContactId: acmeContact,
      runId: 'run-2',
    })
    expect(await linkOf(s, book.acme)).toBeNull()
    expect(await linkedTo(s, acmeContact)).toEqual([book.patel])

    // One the holder linked by their word is never taken this way: the
    // run's proposal is put to them instead.
    await decide(s, s.terence, connection._id, book.brown, 'same')
    await s.t.mutation(internal.xeroMatch.saveProposals, {
      connectionId: connection._id,
      holder: 'run-2',
      runId: 'run-2',
      proposals: [
        {
          clientId: book.quiet,
          outcome: 'linked',
          contact: {
            contactId: id('S Brown Family Trust'),
            name: 'S Brown Family Trust',
            status: 'ACTIVE',
          },
        },
      ],
    })
    expect(await link(s, book.quiet)).toMatchObject({
      state: 'needs_review',
      candidate: {
        contactId: id('S Brown Family Trust'),
        reason: 'contested',
      },
    })
    expect(await linkedTo(s, id('S Brown Family Trust'))).toEqual([book.brown])
  })
})

// ──────────────────────────────────────────────────────────────── who may

describe('who may see and decide', () => {
  test('the business’s match is the owner’s alone', async () => {
    const s = await setup()
    const { book, connection } = await matched(s)
    await decide(s, s.terence, connection._id, book.nguyen, 'different')

    for (const who of [s.kevin, s.jo]) {
      const status = await who.as.query(api.xero.status, {
        businessId: s.businessId,
      })
      expect(status.business).toBeNull()
      await expect(
        reviewPage(s, who, connection._id, 'review'),
      ).rejects.toThrow(/NO_ACCESS/)
      await expect(
        decide(s, who, connection._id, book.brown, 'same'),
      ).rejects.toThrow(/NO_ACCESS/)
      await expect(
        decide(s, who, connection._id, book.brown, 'different'),
      ).rejects.toThrow(/NO_ACCESS/)
      await expect(unlink(s, who, connection._id, book.acme)).rejects.toThrow(
        /NO_ACCESS/,
      )
      await expect(reopen(s, who, connection._id, book.nguyen)).rejects.toThrow(
        /NO_ACCESS/,
      )
      await expect(rematch(s, who, connection._id)).rejects.toThrow(/NO_ACCESS/)
    }

    expect((await link(s, book.brown)).state).toBe('needs_review')
    expect((await link(s, book.acme)).state).toBe('linked')
    expect((await link(s, book.nguyen)).state).toBe('separate')
    expect(await audits(s, 'xero.link')).toEqual([])
    expect(await audits(s, 'xero.unlink')).toEqual([])
    expect(await audits(s, 'xero.reopen')).toEqual([])
    await settle(s)
    expect(s.xero.contactReads()).toHaveLength(1)
  })

  test('a member’s own match is theirs: the whole book, and nobody else’s to see or decide', async () => {
    const s = await setup()
    const book = await coastalBook(s)
    s.xero.contacts(ORG.kevin, [
      { name: 'Linh Nguyen', email: 'linh@nguyen.test' },
      { name: 'Tom Jones' },
      { name: 'ACME Holdings', accountNumber: '42' },
    ])
    const kevins = await connect(s, s.kevin, {
      kind: 'member',
      xeroUserId: XU.kevin,
      tenantId: ORG.kevin,
    })

    // Every client of the business goes to his organisation, not only
    // those of his own jobs.
    expect(await linksOf(s, ORG.kevin)).toHaveLength(11)
    expect(await matchOf(s, s.kevin, 'mine')).toMatchObject({
      state: 'ready',
      linked: 1,
      review: 3,
      fresh: 7,
      leads: 1,
    })
    expect(
      clientIds(await reviewPage(s, s.kevin, kevins._id, 'review')),
    ).toEqual([book.nguyen, book.jonesA, book.jonesB].sort())

    await decide(s, s.kevin, kevins._id, book.nguyen, 'same')
    expect(await link(s, book.nguyen, ORG.kevin)).toMatchObject({
      state: 'linked',
      how: 'chosen',
      decidedByMembershipId: s.kevinId,
    })
    expect(await audits(s, 'xero.link')).toEqual([
      expect.objectContaining({
        actorMembershipId: s.kevinId,
        entityId: book.nguyen,
        meta: expect.objectContaining({
          tenantName: 'Kevin Walsh Pest Services',
        }),
      }),
    ])

    // Not the owner's to look into, and not Jo's.
    for (const who of [s.terence, s.jo]) {
      await expect(reviewPage(s, who, kevins._id, 'review')).rejects.toThrow(
        /NO_ACCESS/,
      )
      await expect(
        decide(s, who, kevins._id, book.jonesA, 'same'),
      ).rejects.toThrow(/NO_ACCESS/)
      await expect(unlink(s, who, kevins._id, book.nguyen)).rejects.toThrow(
        /NO_ACCESS/,
      )
      await expect(rematch(s, who, kevins._id)).rejects.toThrow(/NO_ACCESS/)
    }
    expect((await link(s, book.jonesA, ORG.kevin)).state).toBe('needs_review')
    expect((await link(s, book.nguyen, ORG.kevin)).state).toBe('linked')
    expect(await audits(s, 'xero.unlink')).toEqual([])
  })

  test('not while the owner is working in someone else’s account', async () => {
    const s = await setup()
    const { book, connection } = await matched(s)
    s.xero.contacts(ORG.kevin, [{ name: 'Tom Jones' }])
    const kevins = await connect(s, s.kevin, {
      kind: 'member',
      xeroUserId: XU.kevin,
      tenantId: ORG.kevin,
    })

    await s.terence.as.mutation(api.accountSwitches.start, {
      businessId: s.businessId,
      targetMembershipId: s.kevinId,
    })
    // Neither the business's Xero, nor Kevin's own as Kevin.
    for (const target of [connection._id, kevins._id]) {
      await expect(reviewPage(s, s.terence, target, 'review')).rejects.toThrow(
        /NO_ACCESS|SWITCHED/,
      )
      await expect(
        decide(s, s.terence, target, book.jonesA, 'same'),
      ).rejects.toThrow(/NO_ACCESS|SWITCHED/)
      await expect(unlink(s, s.terence, target, book.acme)).rejects.toThrow(
        /NO_ACCESS|SWITCHED/,
      )
      await expect(reopen(s, s.terence, target, book.jonesA)).rejects.toThrow(
        /NO_ACCESS|SWITCHED/,
      )
      await expect(rematch(s, s.terence, target)).rejects.toThrow(
        /NO_ACCESS|SWITCHED/,
      )
    }
    expect((await link(s, book.jonesA)).state).toBe('needs_review')
    expect((await link(s, book.jonesA, ORG.kevin)).state).toBe('needs_review')

    // Back as himself, the business's is his again.
    await s.terence.as.mutation(api.accountSwitches.stop, {
      businessId: s.businessId,
    })
    await decide(s, s.terence, connection._id, book.jonesA, 'same')
    expect((await link(s, book.jonesA)).state).toBe('linked')
  })

  test('another business’s connection, or client, is NOT_FOUND', async () => {
    const s = await setup()
    const { book, connection } = await matched(s)
    const mia = await createActor(s.t, {
      email: 'mia@harbour.test',
      name: 'Mia',
    })
    const harbour = await createBusiness(s.t, mia, 'Harbour Pest')
    const harbourClient = await addClient(
      s,
      { name: 'Tom Jones', clientNumber: 1 },
      harbour.businessId,
    )
    s.xero.contacts(ORG.harbour, [{ name: 'Tom Jones' }])
    const theirs = await connect(s, mia, {
      kind: 'business',
      xeroUserId: XU.mia,
      tenantId: ORG.harbour,
      businessId: harbour.businessId,
    })

    // Mia, naming Coastal Pest's connection from her own business…
    const hers = harbour.businessId
    await expect(
      reviewPage(s, mia, connection._id, 'review', hers),
    ).rejects.toThrow(/NOT_FOUND/)
    await expect(
      decide(s, mia, connection._id, book.brown, 'same', hers),
    ).rejects.toThrow(/NOT_FOUND/)
    await expect(
      unlink(s, mia, connection._id, book.acme, hers),
    ).rejects.toThrow(/NOT_FOUND/)
    await expect(
      reopen(s, mia, connection._id, book.acme, hers),
    ).rejects.toThrow(/NOT_FOUND/)
    await expect(rematch(s, mia, connection._id, hers)).rejects.toThrow(
      /NOT_FOUND/,
    )
    // …or from Coastal Pest itself, where she is nobody.
    await expect(reviewPage(s, mia, connection._id, 'review')).rejects.toThrow(
      /NO_ACCESS/,
    )

    // Terence, naming Harbour's from his.
    await expect(
      reviewPage(s, s.terence, theirs._id, 'review'),
    ).rejects.toThrow(/NOT_FOUND/)
    await expect(
      decide(s, s.terence, theirs._id, harbourClient, 'same'),
    ).rejects.toThrow(/NOT_FOUND/)
    await expect(rematch(s, s.terence, theirs._id)).rejects.toThrow(/NOT_FOUND/)
    // And his own connection, with Harbour's client.
    await expect(
      decide(s, s.terence, connection._id, harbourClient, 'same'),
    ).rejects.toThrow(/NOT_FOUND/)

    expect(
      (await link(s, harbourClient, ORG.harbour, harbour.businessId)).state,
    ).toBe('needs_review')
    expect((await link(s, book.brown)).state).toBe('needs_review')
  })

  test('a connection disconnected since reads and changes nothing: the organisation’s answers are for whoever holds it now, who finds them there', async () => {
    const s = await setup()
    const book = await coastalBook(s)
    s.xero.contacts(ORG.coastal, coastalContacts())

    // Kevin is a Xero user on the business's own organisation, and connected
    // it as his own first. He answers one, and disconnects.
    const kevins = await connect(s, s.kevin, {
      kind: 'member',
      xeroUserId: XU.kevin,
      tenantId: ORG.coastal,
    })
    await decide(s, s.kevin, kevins._id, book.nguyen, 'same')
    await s.kevin.as.mutation(api.xero.disconnect, {
      businessId: s.businessId,
      connectionId: kevins._id,
    })
    await settle(s)
    // My Xero still shows him the connection he had, as disconnected.
    expect(
      (await s.kevin.as.query(api.xero.status, { businessId: s.businessId }))
        .mine,
    ).toMatchObject({ connectionId: kevins._id, status: 'disconnected' })

    // Terence connects it as the business's, and answers one of his own.
    const business = await connect(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    await decide(s, s.terence, business._id, book.brown, 'same')

    // Through the connection he once held, Kevin reads none of it — not the
    // contacts' details, not Terence's answers — and changes none of it.
    for (const filter of ['review', 'matched', 'new', 'separate'] as const) {
      await expect(reviewPage(s, s.kevin, kevins._id, filter)).rejects.toThrow(
        /NOT_FOUND/,
      )
    }
    await expect(
      decide(s, s.kevin, kevins._id, book.jonesA, 'same'),
    ).rejects.toThrow(/NOT_FOUND/)
    await expect(unlink(s, s.kevin, kevins._id, book.brown)).rejects.toThrow(
      /NOT_FOUND/,
    )
    await expect(rematch(s, s.kevin, kevins._id)).rejects.toThrow(/NOT_FOUND/)
    expect((await link(s, book.brown)).state).toBe('linked')
    expect((await link(s, book.jonesA)).state).toBe('needs_review')

    // Terence holds the organisation now, and with it Kevin's answer — the
    // organisation's, not Kevin's — shown as not his own.
    const matchedNow = await reviewPage(s, s.terence, business._id, 'matched')
    expect(
      matchedNow.page.find((item) => item.clientId === book.nguyen),
    ).toMatchObject({ how: 'chosen', decidedByYou: false })
    expect(
      matchedNow.page.find((item) => item.clientId === book.brown),
    ).toMatchObject({ how: 'chosen', decidedByYou: true })
  })
})

// ───────────────────────────────────────────────── deleting a client for good

describe('deleting a client for good', () => {
  test('Delete forever takes its links with it, in every organisation; the bin alone does not', async () => {
    const s = await setup()
    const { book } = await matched(s)
    s.xero.contacts(ORG.kevin, [{ name: 'ACME Holdings', accountNumber: '42' }])
    await connect(s, s.kevin, {
      kind: 'member',
      xeroUserId: XU.kevin,
      tenantId: ORG.kevin,
    })
    expect(await link(s, book.acme, ORG.kevin)).toMatchObject({
      state: 'linked',
    })
    expect(await matchOf(s)).toMatchObject({ linked: 3 })
    expect(await matchOf(s, s.kevin, 'mine')).toMatchObject({ linked: 1 })

    const entryId = await s.terence.as.mutation(api.bin.deleteClient, {
      businessId: s.businessId,
      clientId: book.acme,
    })
    // In the bin it can still come back, links and all — but it is on no
    // list, so it is out of every organisation's counts.
    expect(await linkOf(s, book.acme)).not.toBeNull()
    expect(await linkOf(s, book.acme, ORG.kevin)).not.toBeNull()
    expect(await matchOf(s)).toMatchObject({ linked: 2 })
    expect(await matchOf(s, s.kevin, 'mine')).toMatchObject({ linked: 0 })

    await s.terence.as.mutation(api.bin.wipe, {
      businessId: s.businessId,
      entryId,
    })
    await settle(s)
    expect(await s.t.run((ctx) => ctx.db.get(book.acme))).toBeNull()
    expect(
      await s.t.run((ctx) =>
        ctx.db
          .query('xeroContactLinks')
          .withIndex('by_client', (q) => q.eq('clientId', book.acme))
          .collect(),
      ),
    ).toEqual([])
    // Everyone else's are where they were, and counted as they were: the
    // bin had already taken ACME out.
    expect(await linksOf(s)).toHaveLength(10)
    expect(await linksOf(s, ORG.kevin)).toHaveLength(10)
    expect(await matchOf(s)).toMatchObject({ linked: 2, review: 4, fresh: 4 })
    expect(await matchOf(s, s.kevin, 'mine')).toMatchObject({ linked: 0 })
  })

  test('the Recycle bin, and archiving, take a client’s links out of the counts; a restore puts them back', async () => {
    const s = await setup()
    const { book } = await matched(s)
    const counts = { linked: 3, review: 4, fresh: 4 }
    expect(await matchOf(s)).toMatchObject(counts)

    // A To check client binned as a duplicate: the badge drops with it.
    const entryId = await s.terence.as.mutation(api.bin.deleteClient, {
      businessId: s.businessId,
      clientId: book.nguyen,
    })
    expect(await matchOf(s)).toMatchObject({ ...counts, review: 3 })
    await s.terence.as.mutation(api.bin.restore, {
      businessId: s.businessId,
      entryId,
    })
    expect(await matchOf(s)).toMatchObject(counts)

    // Archived the old way, and back.
    await s.terence.as.mutation(api.clients.archive, {
      businessId: s.businessId,
      clientId: book.patel,
    })
    expect(await matchOf(s)).toMatchObject({ ...counts, fresh: 3 })
    await s.terence.as.mutation(api.clients.unarchive, {
      businessId: s.businessId,
      clientId: book.patel,
    })
    expect(await matchOf(s)).toMatchObject(counts)
  })

  test('undoing an import takes the links of the clients it takes back', async () => {
    const s = await setup()
    const book = await coastalBook(s)
    const importId = await s.terence.as.mutation(api.clientImports.start, {
      businessId: s.businessId,
      fileName: 'clients.csv',
      source: 'Jobber',
    })
    const site = (addressLine: string) => ({
      addressLine,
      suburb: 'Bayswater',
      state: 'WA',
      postcode: '6053',
    })
    const results = await s.terence.as.mutation(api.clientImports.addBatch, {
      businessId: s.businessId,
      importId,
      clients: [
        {
          key: 'ivy',
          kind: 'person',
          name: 'Ivy Imported',
          email: 'ivy@imported.test',
          sites: [site('3 Wattle Street')],
        },
        {
          key: 'ian',
          kind: 'person',
          name: 'Ian Imported',
          sites: [site('5 Wattle Street')],
        },
      ],
    })
    const [ivy, ian] = results.map((r) => r.clientId!)
    s.xero.contacts(ORG.coastal, [
      ...coastalContacts(),
      { name: 'Ivy Imported', email: 'ivy@imported.test' },
    ])
    await connect(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    expect(await link(s, ivy)).toMatchObject({ state: 'linked' })
    expect(await link(s, ian)).toMatchObject({ state: 'new' })

    expect(await matchOf(s)).toMatchObject({ linked: 4, review: 4, fresh: 5 })

    await s.terence.as.mutation(api.clientImports.undo, {
      businessId: s.businessId,
      importId,
    })
    await settle(s)

    expect(await s.t.run((ctx) => ctx.db.get(ivy))).toBeNull()
    expect(await linkOf(s, ivy)).toBeNull()
    expect(await linkOf(s, ian)).toBeNull()
    // The book it did not bring is untouched, and the counts lose only the
    // two it took back.
    expect(await linksOf(s)).toHaveLength(11)
    expect((await link(s, book.acme)).state).toBe('linked')
    expect(await matchOf(s)).toMatchObject({ linked: 3, review: 4, fresh: 4 })
    expect(countsOf(await linksOf(s))).toMatchObject({
      linked: 3,
      review: 4,
      fresh: 4,
    })
  })
})

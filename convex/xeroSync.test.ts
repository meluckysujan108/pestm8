/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import crons from './crons'
import {
  createActor,
  createBusiness,
  joinBusiness,
  testApp,
} from '../test/harness'
import {
  TEST_REDIRECT_URI,
  XERO_TEST_CLIENT_ID,
  XERO_TEST_CLIENT_SECRET,
  ZERO_CONTACT_ID,
  connectAndFinish,
  contactsIn,
  fakeXero,
} from '../test/fakeXero'
import { DEMO_PLAN } from './demo/shared'
import type {
  FakeContact,
  StoredContact,
  XeroContactView,
  XeroPhone,
  XeroRequest,
} from '../test/fakeXero'
import type { Doc, Id } from './_generated/dataModel'
import type { TestActor } from '../test/harness'

/**
 * Release 3 of Xero: sending the client book to every connected organisation
 * (convex/xeroSync.ts, the hooks in convex/lib/xeroHooks.ts, the mapper in
 * convex/lib/xeroContact.ts), with Xero faked (test/fakeXero.ts) and the
 * clock stopped.
 *
 * The business: Terence owns Coastal Pest and connects its Xero. Kevin, a
 * subcontractor, and Jo, a contractor, connect their own; each gets the whole
 * book too (decision of 2026-10-06).
 *
 * What matters most, in roughly this order:
 * - nothing goes to Xero before Start syncing, and nothing that isn't the
 *   book's: leads wait for their first job, binned and archived clients
 *   never go, and PestM8 never deletes or archives anything in Xero;
 * - a contact is never made twice — not by a retry, an answer that never
 *   came back, or two clients of one name;
 * - what someone changed in Xero is never overwritten without the holder's
 *   word, and a list Xero holds (phones, addresses, people) is never cut
 *   short by sending part of it;
 * - one organisation is written by one drain at a time, across every
 *   business, within Xero's limits;
 * - only the connection's holder starts it, overrides it, or sees its line.
 *
 * The fake answers a write the harsher way wherever Xero's real behaviour is
 * unproven (a list sent replaces the list), so what passes here is safe
 * whichever way the Demo Company gate comes out.
 */

const XU = {
  terence: 'xu-terence',
  kevin: 'xu-kevin',
  jo: 'xu-jo',
  mia: 'xu-mia',
} as const

const ORG = {
  coastal: 'tenant-coastal',
  kevin: 'tenant-kevin',
  jo: 'tenant-jo',
  harbour: 'tenant-harbour',
} as const

const SECOND = 1000
const MINUTE = 60 * SECOND
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
  xero.tenant({ tenantId: ORG.jo, name: 'Jo Bloggs Pest Control' })
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

// ─────────────────────────────────────────────────────────────── the clock

/** Runs whatever was scheduled, and whatever that schedules, to the end:
 * drains, their retries and reschedules, a wipe's steps. */
const settle = (s: Setup) =>
  s.t.finishAllScheduledFunctions(vi.runAllTimers, 1000)

/** Waits on `promise` — an action called directly, which waits on timers of
 * its own (the drain's gaps between calls, its retries) — moving the clock a
 * tenth of a second at a time, and no further than it needs. */
async function pumpUntil(
  promise: Promise<unknown>,
  limit = 5000 * SECOND,
): Promise<void> {
  // An object, not a `let`: the callbacks set it, which narrowing can't see.
  const settled = { done: false }
  promise.then(
    () => (settled.done = true),
    () => (settled.done = true),
  )
  for (let waited = 0; !settled.done && waited < limit; waited += 100) {
    await vi.advanceTimersByTimeAsync(100)
  }
  if (!settled.done) {
    throw new Error(`still waiting after ${limit / SECOND} s`)
  }
}

async function pumped<T>(promise: Promise<T>): Promise<T> {
  await pumpUntil(promise)
  return promise
}

/** Lets `ms` of fake time pass, a quarter-second at a time, running what
 * comes due — and then lets whatever is part-way through finish. Unlike
 * `settle`, never jumps to something scheduled later than that. */
async function settleFor(s: Setup, ms: number): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    await vi.advanceTimersByTimeAsync(Math.min(250, until - Date.now()))
  }
  await pumpUntil(s.t.finishInProgressScheduledFunctions())
}

/** One drain of one connection, now. */
const drainNow = (s: Setup, connectionId: Id<'xeroConnections'>) =>
  pumped(s.t.action(internal.xeroSync.drain, { connectionId }))

/** What the cron does every ten minutes: the reconciler, ten minutes on. */
async function cron(s: Setup): Promise<void> {
  vi.setSystemTime(Date.now() + 10 * MINUTE)
  await s.t.mutation(internal.xeroSync.reconcile, {})
  await settle(s)
}

/** A run of the scheduler that never came: every drain asked for so far is
 * cancelled, as a deploy at the wrong moment would lose it. */
const dropScheduledDrains = (s: Setup) =>
  s.t.run(async (ctx) => {
    for (const job of await ctx.db.system
      .query('_scheduled_functions')
      .collect()) {
      if (
        /xeroSync(\.js)?:drain$/.test(job.name) &&
        job.state.kind === 'pending'
      ) {
        await ctx.scheduler.cancel(job._id)
      }
    }
  })

// ─────────────────────────────────────────────────────────────── the book

type Site = {
  addressLine: string
  suburb: string
  state?: string
  postcode?: string
}

type ClientSeed = {
  name: string
  kind?: 'person' | 'business'
  clientNumber?: number
  email?: string
  phone?: string
  abn?: string
  /** A business's head office (the client's own address fields). */
  office?: Site
  /** Its one site, unless `false`. */
  site?: Site | false
  status?: 'active' | 'lead' | 'inactive'
  binned?: boolean
  archived?: boolean
  /** Its contacts, oldest first; `primary` is the contact person. */
  contacts?: Array<{ name: string; email?: string; primary?: boolean }>
}

/** A client as the app keeps one, inserted directly — before Start syncing,
 * when how it was made reaches nothing in Xero. */
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
      ...(seed.abn ? { abn: seed.abn } : {}),
      ...(seed.office
        ? {
            addressLine: seed.office.addressLine,
            suburb: seed.office.suburb,
            state: seed.office.state ?? 'WA',
            postcode: seed.office.postcode ?? '6000',
          }
        : {}),
      ...(seed.status ? { status: seed.status } : {}),
      ...(seed.binned ? { deletedAt: now } : {}),
      ...(seed.archived ? { archivedAt: now } : {}),
      createdAt: now,
      updatedAt: now,
    })
    const site =
      seed.site === false
        ? null
        : (seed.site ?? { addressLine: '1 Test Street', suburb: 'Perth' })
    if (site) {
      await ctx.db.insert('properties', {
        businessId,
        clientId,
        addressLine: site.addressLine,
        suburb: site.suburb,
        state: site.state ?? 'WA',
        postcode: site.postcode ?? '6000',
        createdAt: now,
      })
    }
    for (const [i, contact] of (seed.contacts ?? []).entries()) {
      await ctx.db.insert('clientContacts', {
        businessId,
        clientId,
        name: contact.name,
        ...(contact.email ? { email: contact.email } : {}),
        ...(contact.primary ? { isPrimary: true } : {}),
        createdAt: now + i,
      })
    }
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

/** A valid ABN (the ATO's own). */
const ABN = '51824753556'

/**
 * Coastal Pest's book: one client for each thing the first sync must get
 * right. Ten in the book Xero gets, of which seven go to Xero at Start
 * syncing — three matched (filled in), four new (added) — one waits to be
 * checked, and the lead, the binned and the archived never go.
 */
const STANDARD = {
  /** Matched to "ACME Holdings" (#0042), which has no first or last name. A
   * business with a contact person, and another contact. */
  acme: {
    name: 'Acme Holdings Pty Ltd',
    kind: 'business',
    clientNumber: 42,
    site: { addressLine: '9 Factory Road', suburb: 'Osborne Park' },
    contacts: [
      { name: 'Ann Acme', primary: true },
      { name: 'Bob Books', email: 'bob@acme.test' },
    ],
  },
  /** Matched to "Smith, John" by email and name. Xero has his landline and
   * direct line and a PO box, no mobile and no street; another contact
   * there holds account number 7. */
  smith: {
    name: 'John Smith',
    clientNumber: 7,
    email: 'john@smith.test',
    phone: '0412 345 678',
    site: {
      addressLine: '12 Wattle Street',
      suburb: 'Bayswater',
      postcode: '6053',
    },
  },
  /** Matched by email and name; Xero has nothing else. */
  brown: {
    name: 'Sarah Brown',
    clientNumber: 8,
    email: 'sarah@brown.test',
    site: { addressLine: '4 Gum Road', suburb: 'Morley', postcode: '6062' },
  },
  /** New: a person with a landline. */
  patel: {
    name: 'Raj Patel',
    clientNumber: 11,
    email: 'raj@patel.test',
    phone: '08 9444 5555',
    site: {
      addressLine: '3 Banksia Road',
      suburb: 'Mirrabooka',
      postcode: '6061',
    },
  },
  /** New: a business with an ABN, a head office, a contact person with an
   * email and no email of its own, another contact, and a rental site. */
  harbour: {
    name: 'Harbourside Strata',
    kind: 'business',
    clientNumber: 10,
    abn: ABN,
    office: {
      addressLine: '10 Pier Street',
      suburb: 'Fremantle',
      postcode: '6160',
    },
    site: { addressLine: '1 Harbour Road', suburb: 'Hillarys' },
    contacts: [
      { name: 'Jan Brown', email: 'jan@harbourside.test', primary: true },
      { name: 'Sam Lee', email: 'sam@harbourside.test' },
    ],
  },
  /** New: a business with no head office — only a site it rents out. */
  kwik: {
    name: 'Kwik Kleen Pty Ltd',
    kind: 'business',
    clientNumber: 12,
    site: { addressLine: '8 Rental Way', suburb: 'Joondalup' },
  },
  /** Only its name is in Xero: waits to be checked. */
  nguyen: {
    name: 'Linh Nguyen',
    clientNumber: 9,
    phone: '0400 333 444',
    site: { addressLine: '7 Fig Street', suburb: 'Mirrabooka' },
  },
  /** No longer serviced, still the business's client: it goes. */
  quiet: {
    name: 'Quentin Quiet',
    clientNumber: 16,
    status: 'inactive',
    site: { addressLine: '2 Quiet Lane', suburb: 'Wembley' },
  },
  /** A lead: waits for its first job. */
  lead: {
    name: 'Lena Lead',
    clientNumber: 17,
    status: 'lead',
    site: { addressLine: '5 Lead Street', suburb: 'Balga' },
  },
  binned: { name: 'Barry Binned', clientNumber: 18, binned: true },
  archived: { name: 'Alma Archived', clientNumber: 19, archived: true },
} satisfies Record<string, ClientSeed>

/** Coastal Pest's organisation in Xero before Start syncing. */
function standardContacts(): Array<FakeContact> {
  return [
    { name: 'ACME Holdings', accountNumber: '0042' },
    {
      name: 'Smith, John',
      email: 'john@smith.test',
      firstName: 'John',
      lastName: 'Smith',
      phones: [
        phone('DDI', '08', '9111 2222'),
        phone('DEFAULT', '08', '9345 6789'),
        phone('FAX'),
        phone('MOBILE'),
      ],
      addresses: [
        {
          AddressType: 'POBOX',
          AddressLine1: 'PO Box 12',
          City: 'Perth',
          Region: 'WA',
          PostalCode: '6000',
          Country: 'Australia',
        },
        {
          AddressType: 'STREET',
          City: '',
          Region: '',
          PostalCode: '',
          Country: '',
        },
      ],
    },
    { name: 'Old Smith Co', accountNumber: '7' },
    { name: 'Sarah Brown', email: 'sarah@brown.test' },
    { name: 'Linh Nguyen' },
  ]
}

function phone(
  type: XeroPhone['PhoneType'],
  areaCode = '',
  number = '',
): XeroPhone {
  return {
    PhoneType: type,
    PhoneAreaCode: areaCode,
    PhoneNumber: number,
    PhoneCountryCode: '',
  }
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

const startSyncing = (
  s: Setup,
  who: TestActor,
  connectionId: Id<'xeroConnections'>,
  businessId: Id<'businesses'> = s.businessId,
) => who.as.mutation(api.xeroSync.startSyncing, { businessId, connectionId })

/**
 * A book, its organisation's contacts, Terence connecting it (the first
 * match), and Start syncing — run to the end: the whole book sent.
 */
async function startWith<TKey extends string>(
  s: Setup,
  seeds: Record<TKey, ClientSeed>,
  contacts: Array<FakeContact> = [],
) {
  const book = await addBook(s, seeds)
  const held = s.xero.contacts(ORG.coastal, contacts)
  const connection = await connect(s, s.terence, {
    kind: 'business',
    xeroUserId: XU.terence,
    tenantId: ORG.coastal,
  })
  const from = s.xero.requests.length
  await startSyncing(s, s.terence, connection._id)
  await settle(s)
  return {
    book,
    contacts: held,
    connection,
    /** Every Accounting call since Start syncing was pressed. */
    sinceStart: () =>
      s.xero
        .accountingRequests()
        .filter((r) => s.xero.requests.indexOf(r) >= from),
    id: (name: string) => idOf(held, name),
  }
}

/** The standard book, synced. */
const syncing = (s: Setup) => startWith(s, STANDARD, standardContacts())

// ──────────────────────────────────────────────────────────────── reading

const connectionRow = (s: Setup, id: Id<'xeroConnections'>) =>
  s.t.run(async (ctx) => {
    const row = await ctx.db.get(id)
    if (!row) throw new Error('connection gone')
    return row
  })

const clientRow = (s: Setup, id: Id<'clients'>) =>
  s.t.run(async (ctx) => {
    const row = await ctx.db.get(id)
    if (!row) throw new Error('client gone')
    return row
  })

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

/** The Xero contact a client is linked to, as Xero lists it now. */
async function contactOf(
  s: Setup,
  clientId: Id<'clients'>,
  tenantId: string = ORG.coastal,
  businessId: Id<'businesses'> = s.businessId,
): Promise<XeroContactView> {
  const row = await link(s, clientId, tenantId, businessId)
  if (!row.xeroContactId) {
    throw new Error(`${clientId} has no contact in ${tenantId} (${row.state})`)
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

/** Every drain ever scheduled, pending or done. */
const scheduledDrains = (s: Setup) =>
  s.t.run(async (ctx) =>
    (await ctx.db.system.query('_scheduled_functions').collect()).filter(
      (job) => /xeroSync(\.js)?:drain$/.test(job.name),
    ),
  )

/** The elements of every write since `from` (a request count), with the
 * request each came in. */
function written(
  s: Setup,
  from = 0,
): Array<{ r: XeroRequest; e: Record<string, unknown> }> {
  return s.xero
    .contactWrites()
    .filter((r) => s.xero.requests.indexOf(r) >= from)
    .flatMap((r) => contactsIn(r).map((e) => ({ r, e })))
}

/** The creates that sent this Name. */
const createsNamed = (s: Setup, name: string) =>
  written(s).filter(({ r, e }) => r.method === 'PUT' && e.Name === name)

/** The updates that named this contact. */
const updatesTo = (s: Setup, contactId: string, from = 0) =>
  written(s, from)
    .filter(({ r, e }) => r.method === 'POST' && e.ContactID === contactId)
    .map(({ e }) => e)

const digits = (text: string | undefined) => (text ?? '').replace(/\D/g, '')

/** A contact's number in one of Xero's phone slots, digits only, area code
 * first. */
function phoneIn(c: XeroContactView, type: XeroPhone['PhoneType']): string {
  const held = c.Phones.find((p) => p.PhoneType === type)
  return digits(`${held?.PhoneAreaCode ?? ''}${held?.PhoneNumber ?? ''}`)
}

/** A contact's address of one type, trimmed to what an address says. */
function addressIn(c: XeroContactView, type: 'POBOX' | 'STREET') {
  const held = c.Addresses.find((a) => a.AddressType === type)
  return {
    line1: held?.AddressLine1 ?? '',
    city: held?.City ?? '',
    region: held?.Region ?? '',
    postcode: held?.PostalCode ?? '',
  }
}

const NO_ADDRESS = { line1: '', city: '', region: '', postcode: '' }

/** Who a contact's people are, by name and email. */
const peopleOf = (c: XeroContactView) =>
  c.ContactPersons.map((p) =>
    [`${p.FirstName ?? ''} ${p.LastName ?? ''}`.trim(), p.EmailAddress ?? '']
      .filter(Boolean)
      .join(' '),
  ).sort()

type Line = {
  connectionId: Id<'xeroConnections'>
  orgName: string
  state: string
  lastSentAt: number | null
  different: Array<string>
  problemCode: string | null
  openUrl: string | null
}

/** A client's Xero lines, as the client sheet gets them. */
async function linesOf(
  s: Setup,
  who: TestActor,
  clientId: Id<'clients'>,
  businessId: Id<'businesses'> = s.businessId,
): Promise<Array<Line>> {
  const result: unknown = await who.as.query(api.xeroSync.clientLines, {
    businessId,
    clientId,
  })
  return (
    Array.isArray(result) ? result : (result as { lines: Array<Line> }).lines
  ) as Array<Line>
}

async function lineOf(
  s: Setup,
  clientId: Id<'clients'>,
  who: TestActor = s.terence,
): Promise<Line> {
  const lines = await linesOf(s, who, clientId)
  expect(lines).toHaveLength(1)
  return lines[0]
}

/** The client sheet's lines refused, or none: either way nothing shown. */
async function noLines(promise: Promise<Array<Line>>): Promise<void> {
  let lines: Array<Line>
  try {
    lines = await promise
  } catch (error) {
    expect(String(error)).toMatch(/NOT_FOUND|NO_ACCESS/)
    return
  }
  expect(lines).toEqual([])
}

// ───────────────────────────────────────────────────────── doing things

/** A new client with one site, from the app's own New client form. */
async function newClient(
  s: Setup,
  seed: {
    name: string
    suburb: string
    addressLine?: string
    kind?: 'person' | 'business'
    email?: string
    phone?: string
    contactPerson?: string
    status?: 'active' | 'lead' | 'inactive'
  },
  who: TestActor = s.terence,
  businessId: Id<'businesses'> = s.businessId,
): Promise<{ clientId: Id<'clients'>; propertyId: Id<'properties'> }> {
  const propertyId = await who.as.mutation(api.properties.create, {
    businessId,
    clientName: seed.name,
    ...(seed.kind ? { kind: seed.kind } : {}),
    ...(seed.email ? { email: seed.email } : {}),
    ...(seed.phone ? { phone: seed.phone } : {}),
    ...(seed.contactPerson ? { contactPerson: seed.contactPerson } : {}),
    ...(seed.status ? { status: seed.status } : {}),
    addressLine: seed.addressLine ?? '1 New Street',
    suburb: seed.suburb,
    state: 'WA',
    postcode: '6000',
  })
  const property = await s.t.run((ctx) => ctx.db.get(propertyId))
  return { clientId: property!.clientId, propertyId }
}

const edit = (
  s: Setup,
  clientId: Id<'clients'>,
  patch: {
    name?: string
    email?: string
    phone?: string
    status?: 'active' | 'lead' | 'inactive'
    tags?: Array<string>
  },
  businessId: Id<'businesses'> = s.businessId,
) =>
  s.terence.as.mutation(api.clients.update, { businessId, clientId, ...patch })

const siteOf = (s: Setup, clientId: Id<'clients'>) =>
  s.t.run(async (ctx) => {
    const site = await ctx.db
      .query('properties')
      .withIndex('by_client', (q) => q.eq('clientId', clientId))
      .first()
    if (!site) throw new Error('no site')
    return site._id
  })

/** A job booked at a client's site, by the owner. */
async function bookJob(s: Setup, clientId: Id<'clients'>) {
  return s.terence.as.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId: await siteOf(s, clientId),
    assignedMembershipId: s.ownerMembershipId,
    jobType: 'General Pest',
    price: 18000,
    scheduledAt: Date.now() + DAY,
    durationMinutes: 60,
  })
}

const decide = (
  s: Setup,
  connectionId: Id<'xeroConnections'>,
  clientId: Id<'clients'>,
  choice: 'same' | 'different',
) =>
  s.terence.as.mutation(api.xeroMatch.decide, {
    businessId: s.businessId,
    connectionId,
    clientId,
    choice,
  })

/** Lets the clock run until a held request reaches Xero: a drain that
 * was scheduled is there, and holds its organisation. */
const reachXero = (held: { arrived: Promise<void> }) =>
  pumpUntil(held.arrived, 10 * MINUTE)

const quietly = () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
}

// ═══════════════════════════════════════════════════════════ Start syncing

describe('Start syncing', () => {
  test('nothing is sent or queued before it; then the whole book goes — new clients added, matched ones filled in — and nothing else', async () => {
    const s = await setup()
    const book = await addBook(s, STANDARD)
    const contacts = s.xero.contacts(ORG.coastal, standardContacts())
    const connection = await connect(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    const untouched = ['Old Smith Co', 'Linh Nguyen'].map((name) =>
      s.xero.view(idOf(contacts, name)),
    )

    // Connected and matched, not started: an edit is queued for nobody.
    await edit(s, book.patel, { phone: '08 9444 5556' })
    await newClient(s, { name: 'Early Bird', suburb: 'Scarborough' })
    await settle(s)
    expect(await outbox(s)).toEqual([])
    expect(await scheduledDrains(s)).toEqual([])
    expect(s.xero.contactWrites()).toEqual([])

    await startSyncing(s, s.terence, connection._id)
    expect(await connectionRow(s, connection._id)).toMatchObject({
      syncStartedAt: Date.now(),
      syncStartedByMembershipId: s.ownerMembershipId,
    })
    expect(await audits(s, 'xero.start')).toEqual([
      expect.objectContaining({
        businessId: s.businessId,
        actorMembershipId: s.ownerMembershipId,
      }),
    ])
    await settle(s)

    // Added: every new client, once each.
    const early = await s.t.run(async (ctx) =>
      (await ctx.db.query('clients').collect()).find(
        (c) => c.name === 'Early Bird',
      ),
    )
    for (const name of [
      'Raj Patel',
      'Harbourside Strata',
      'Kwik Kleen Pty Ltd',
      'Quentin Quiet',
      'Early Bird',
    ]) {
      expect(s.xero.named(ORG.coastal, name)).toHaveLength(1)
    }
    for (const clientId of [
      book.patel,
      book.harbour,
      book.kwik,
      book.quiet,
      early!._id,
    ]) {
      const row = await link(s, clientId)
      expect(row).toMatchObject({ state: 'linked', how: 'created' })
      expect(s.xero.view(row.xeroContactId!).ContactStatus).toBe('ACTIVE')
    }
    // Matched: linked as they were.
    for (const clientId of [book.acme, book.smith, book.brown]) {
      expect(await link(s, clientId)).toMatchObject({
        state: 'linked',
        how: 'matched',
      })
    }
    // Waiting on Terence, a lead, binned, archived: nothing in Xero.
    expect(await link(s, book.nguyen)).toMatchObject({ state: 'needs_review' })
    for (const name of [
      'Lena Lead',
      'Barry Binned',
      'Alma Archived',
      'Linh Nguyen (Mirrabooka)',
    ]) {
      expect(s.xero.named(ORG.coastal, name)).toEqual([])
    }
    expect(s.xero.named(ORG.coastal, 'Linh Nguyen')).toHaveLength(1)
    for (const clientId of [book.lead, book.binned, book.archived]) {
      expect(await linkOf(s, clientId)).toBeNull()
    }
    // The contacts nobody here is linked to are exactly as they were.
    for (const before of untouched) {
      expect(s.xero.view(before.ContactID)).toEqual(before)
    }

    // How it was written: the organisation named on every call; creates
    // with per-item errors; updates naming their contact; a fresh key for
    // every request; nothing PestM8 doesn't own.
    const writes = s.xero.contactWrites()
    expect(writes.length).toBeGreaterThan(0)
    for (const r of writes) {
      expect(r.headers['xero-tenant-id']).toBe(ORG.coastal)
      expect(r.query.get('summarizeErrors')).toBe('false')
      expect(r.headers['idempotency-key']).toMatch(/^[0-9a-f]{128}$/)
      for (const e of contactsIn(r)) {
        for (const never of [
          'ContactNumber',
          'ContactStatus',
          'BankAccountDetails',
          'IsCustomer',
          'IsSupplier',
          'ContactGroups',
        ]) {
          expect(e).not.toHaveProperty(never)
        }
        if (r.method === 'POST') {
          expect(typeof e.ContactID).toBe('string')
          expect(e.ContactID).not.toBe(ZERO_CONTACT_ID)
        } else {
          expect(e).not.toHaveProperty('ContactID')
        }
      }
    }
    expect(new Set(writes.map((r) => r.headers['idempotency-key'])).size).toBe(
      writes.length,
    )
    // Never a delete, never an archive.
    expect(
      s.xero.requests.filter(
        (r) => r.path.startsWith('/api.xro/') && r.method === 'DELETE',
      ),
    ).toEqual([])
    for (const c of s.xero.contactsOf(ORG.coastal)) {
      expect(c.status).toBe('ACTIVE')
    }
    expect(s.xero.unmodelled()).toEqual([])

    // Done, and counted.
    const state = await syncStateOf(s, connection._id)
    expect(state?.backfillDoneAt).toBeTypeOf('number')
    expect(state?.lastSentAt).toBeTypeOf('number')
    expect(state?.lease).toBeUndefined()
    expect(state?.counts).toMatchObject({
      inXero: 8,
      review: 1,
      different: 0,
      failed: 0,
      stopped: 0,
    })
    expect(await outbox(s)).toEqual([])
  }, 30_000)

  test('a new contact carries what PestM8 owns: names, email, number, phone in its slot, the right address — and a business’s people', async () => {
    const s = await setup()
    const { book } = await syncing(s)

    // A person: split at the last word; the landline in DEFAULT with its
    // area code; the oldest site as the street address and, being new, the
    // PO box.
    const patel = await contactOf(s, book.patel)
    expect(patel).toMatchObject({
      Name: 'Raj Patel',
      FirstName: 'Raj',
      LastName: 'Patel',
      EmailAddress: 'raj@patel.test',
      AccountNumber: '11',
    })
    expect(patel.TaxNumber ?? '').toBe('')
    expect(phoneIn(patel, 'DEFAULT')).toBe('0894445555')
    expect(phoneIn(patel, 'MOBILE')).toBe('')
    const banksia = {
      line1: '3 Banksia Road',
      city: 'Mirrabooka',
      region: 'WA',
      postcode: '6061',
    }
    expect(addressIn(patel, 'STREET')).toEqual(banksia)
    expect(addressIn(patel, 'POBOX')).toEqual(banksia)
    expect(
      patel.Addresses.find((a) => a.AddressType === 'STREET')?.Country,
    ).toBe('Australia')
    expect(patel.ContactPersons).toEqual([])

    // A business: its contact person's name and (having none of its own)
    // email; its ABN as the ATO writes it; its head office, never the
    // rental site; its other contact as a person off the invoice emails.
    const harbour = await contactOf(s, book.harbour)
    expect(harbour).toMatchObject({
      Name: 'Harbourside Strata',
      FirstName: 'Jan',
      LastName: 'Brown',
      EmailAddress: 'jan@harbourside.test',
      AccountNumber: '10',
      TaxNumber: '51 824 753 556',
    })
    const pier = {
      line1: '10 Pier Street',
      city: 'Fremantle',
      region: 'WA',
      postcode: '6160',
    }
    expect(addressIn(harbour, 'STREET')).toEqual(pier)
    expect(addressIn(harbour, 'POBOX')).toEqual(pier)
    expect(harbour.ContactPersons).toEqual([
      expect.objectContaining({
        FirstName: 'Sam',
        LastName: 'Lee',
        EmailAddress: 'sam@harbourside.test',
        IncludeInEmails: false,
      }),
    ])

    // A business with no head office: no address at all — its site is a
    // rental, not where its invoices go.
    const kwik = await contactOf(s, book.kwik)
    expect(addressIn(kwik, 'STREET')).toEqual(NO_ADDRESS)
    expect(addressIn(kwik, 'POBOX')).toEqual(NO_ADDRESS)
    for (const { e } of createsNamed(s, 'Kwik Kleen Pty Ltd')) {
      expect(JSON.stringify(e)).not.toMatch(/Rental Way|Joondalup/)
    }

    // A create sends nothing blank.
    for (const { r, e } of written(s)) {
      if (r.method !== 'PUT') continue
      for (const value of Object.values(e)) expect(value).not.toBe('')
    }
  })

  test('a matched contact is filled in where Xero is blank and left alone everywhere else — sending whole lists, so a new mobile keeps the landline and direct line, and a street address keeps the PO box', async () => {
    const s = await setup()
    const { book, id } = await syncing(s)

    const smith = s.xero.view(id('Smith, John'))
    // Filled: the mobile, the street address.
    expect(phoneIn(smith, 'MOBILE')).toBe('0412345678')
    expect(addressIn(smith, 'STREET')).toEqual({
      line1: '12 Wattle Street',
      city: 'Bayswater',
      region: 'WA',
      postcode: '6053',
    })
    // Kept: what Xero held — the name it was matched under, the landline
    // and direct line, the PO box the bookkeeper uses.
    expect(smith.Name).toBe('Smith, John')
    expect(phoneIn(smith, 'DEFAULT')).toBe('0893456789')
    expect(phoneIn(smith, 'DDI')).toBe('0891112222')
    expect(addressIn(smith, 'POBOX')).toEqual({
      line1: 'PO Box 12',
      city: 'Perth',
      region: 'WA',
      postcode: '6000',
    })
    // The update sent Xero's lists whole, with only PestM8's slot changed.
    const [update] = updatesTo(s, id('Smith, John'))
    expect(update).toBeDefined()
    const sentPhones = update.Phones as Array<Record<string, string>>
    expect(sentPhones).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          PhoneType: 'DEFAULT',
          PhoneAreaCode: '08',
          PhoneNumber: '9345 6789',
        }),
        expect.objectContaining({
          PhoneType: 'DDI',
          PhoneAreaCode: '08',
          PhoneNumber: '9111 2222',
        }),
      ]),
    )
    expect(update.Addresses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          AddressType: 'POBOX',
          AddressLine1: 'PO Box 12',
        }),
      ]),
    )
    expect(update).not.toHaveProperty('Name')

    // Account number 7 is Old Smith Co's in Xero: never written into John
    // Smith's contact (Xero would refuse it, and it would be ambiguous).
    for (const e of updatesTo(s, id('Smith, John'))) {
      expect(e).not.toHaveProperty('AccountNumber')
    }
    expect(smith.AccountNumber ?? '').toBe('')
    expect(s.xero.view(id('Old Smith Co')).AccountNumber).toBe('7')
    // Sarah Brown's number is nobody's: filled in, with her blanks.
    const brown = s.xero.view(id('Sarah Brown'))
    expect(brown).toMatchObject({
      AccountNumber: '8',
      FirstName: 'Sarah',
      LastName: 'Brown',
    })
    expect(addressIn(brown, 'STREET').line1).toBe('4 Gum Road')

    // ACME keeps its own number and name; and a contact PestM8 only
    // matched gets none of PestM8's people.
    const acme = s.xero.view(id('ACME Holdings'))
    expect(acme).toMatchObject({ Name: 'ACME Holdings', AccountNumber: '0042' })
    expect(acme.ContactPersons).toEqual([])
    for (const e of updatesTo(s, id('ACME Holdings'))) {
      expect(e).not.toHaveProperty('ContactPersons')
    }

    // Filling in is not a difference.
    for (const clientId of [book.acme, book.smith, book.brown]) {
      expect((await link(s, clientId)).different ?? []).toEqual([])
    }

    // That number 7 is held elsewhere is remembered: John Smith's next
    // change reads his own contact, not the whole book again to check it.
    const booksRead = s.xero.bookReads().length
    await edit(s, book.smith, { phone: '0412 777 888' })
    await settle(s)
    expect(phoneIn(s.xero.view(id('Smith, John')), 'MOBILE')).toBe('0412777888')
    expect(s.xero.bookReads()).toHaveLength(booksRead)
    for (const e of updatesTo(s, id('Smith, John'))) {
      expect(e).not.toHaveProperty('AccountNumber')
    }
  })

  test('the Xero page shows how it stands, and the client sheet each client’s line', async () => {
    const s = await setup()
    const { book, connection } = await syncing(s)
    const { shortCode } = await connectionRow(s, connection._id)
    expect(shortCode).toBeTruthy()

    const patel = await lineOf(s, book.patel)
    expect(patel).toMatchObject({
      connectionId: connection._id,
      orgName: 'Coastal Pest Pty Ltd',
      state: 'in_xero',
      lastSentAt: expect.any(Number),
      different: [],
    })
    const contactId = (await link(s, book.patel)).xeroContactId!
    const open = new URL(patel.openUrl!)
    expect(`${open.origin}${open.pathname}`).toBe(
      'https://go.xero.com/organisationlogin/default.aspx',
    )
    expect(open.searchParams.get('shortcode')).toBe(shortCode)
    expect(open.searchParams.get('redirecturl')).toBe(
      `/Contacts/View/${contactId}`,
    )

    expect(await lineOf(s, book.nguyen)).toMatchObject({ state: 'to_check' })
    expect(await lineOf(s, book.lead)).toMatchObject({ state: 'lead' })

    // Something queued and not yet sent is waiting.
    await edit(s, book.quiet, { email: 'quentin@quiet.test' })
    expect(await lineOf(s, book.quiet)).toMatchObject({ state: 'waiting' })
    await settle(s)
    expect(await lineOf(s, book.quiet)).toMatchObject({ state: 'in_xero' })
  })
})

// ═══════════════════════════════════════════════════════════ live changes

describe('changes after Start syncing', () => {
  test('a change is queued, sent a few seconds later with only what changed, and the queue emptied', async () => {
    const s = await setup()
    const { book, connection } = await syncing(s)
    const contactId = (await link(s, book.patel)).xeroContactId!
    const from = s.xero.requests.length

    await edit(s, book.patel, { email: 'raj.patel@patel.test' })
    const [row] = await outbox(s)
    expect(row).toMatchObject({
      businessId: s.businessId,
      connectionId: connection._id,
      clientId: book.patel,
      rev: 1,
      attempts: 0,
      dueAt: Date.now() + 5 * SECOND,
      firstQueuedAt: Date.now(),
    })
    // A burst of edits is one send: the same row, a later rev.
    await edit(s, book.patel, { email: 'raj@patel-family.test' })
    expect(await outbox(s)).toEqual([
      expect.objectContaining({ _id: row._id, rev: 2 }),
    ])

    await settle(s)
    expect(updatesTo(s, contactId, from)).toEqual([
      { ContactID: contactId, EmailAddress: 'raj@patel-family.test' },
    ])
    expect(s.xero.view(contactId).EmailAddress).toBe('raj@patel-family.test')
    expect(await outbox(s)).toEqual([])
    expect((await link(s, book.patel)).lastSentAt).toBeGreaterThanOrEqual(
      s.xero.updates().at(-1)!.at,
    )
  })

  test('a change that changes nothing in Xero costs Xero nothing: no read, no write', async () => {
    const s = await setup()
    const { book } = await syncing(s)
    const calls = s.xero.accountingRequests().length

    // Tags, a status, are not on a Xero contact.
    await edit(s, book.patel, { tags: ['VIP'] })
    await edit(s, book.quiet, { status: 'active' })
    // A second site is not the oldest, so not the address.
    await s.terence.as.mutation(api.properties.createForClient, {
      businessId: s.businessId,
      clientId: book.patel,
      addressLine: '99 Second Street',
      suburb: 'Nollamara',
      state: 'WA',
      postcode: '6061',
    })
    // A job for a client already in Xero.
    await bookJob(s, book.patel)
    await settle(s)

    expect(s.xero.accountingRequests()).toHaveLength(calls)
    expect(await outbox(s)).toEqual([])
  })

  test('a change made while its send is at Xero is sent after it, not lost', async () => {
    const s = await setup()
    const { book, connection } = await syncing(s)
    const contactId = (await link(s, book.patel)).xeroContactId!

    await edit(s, book.patel, { email: 'first@patel.test' })
    const held = s.xero.holdWrites()
    await reachXero(held)

    // At Xero with the first email; the second is made meanwhile.
    await edit(s, book.patel, { email: 'second@patel.test' })
    expect(await outbox(s)).toEqual([
      expect.objectContaining({
        connectionId: connection._id,
        clientId: book.patel,
        rev: 2,
      }),
    ])
    held.release()
    // The send that comes back was of rev 1: the row stays for rev 2.
    await settle(s)

    expect(
      updatesTo(s, contactId).map((e) => e.EmailAddress as string),
    ).toEqual(['first@patel.test', 'second@patel.test'])
    expect(s.xero.view(contactId).EmailAddress).toBe('second@patel.test')
    expect(await outbox(s)).toEqual([])
  })

  test('a client added or booked straight from New Job goes too', async () => {
    const s = await setup()
    const { book } = await syncing(s)

    await s.terence.as.mutation(api.jobs.create, {
      businessId: s.businessId,
      newClient: {
        clientName: 'Nina Newjob',
        email: 'nina@newjob.test',
        addressLine: '6 Booking Road',
        suburb: 'Karrinyup',
        state: 'WA',
        postcode: '6018',
      },
      assignedMembershipId: s.ownerMembershipId,
      jobType: 'General Pest',
      price: 18000,
      scheduledAt: Date.now() + DAY,
      durationMinutes: 60,
    })
    // A new site for a client in Xero: not its oldest, so nothing to send.
    await s.terence.as.mutation(api.jobs.create, {
      businessId: s.businessId,
      newProperty: {
        clientId: book.brown,
        addressLine: '5 Other Road',
        suburb: 'Morley',
        state: 'WA',
        postcode: '6062',
      },
      assignedMembershipId: s.ownerMembershipId,
      jobType: 'General Pest',
      price: 18000,
      scheduledAt: Date.now() + DAY,
      durationMinutes: 60,
    })
    await settle(s)

    expect(s.xero.named(ORG.coastal, 'Nina Newjob')).toEqual([
      expect.objectContaining({ email: 'nina@newjob.test' }),
    ])
    expect(addressIn(await contactOf(s, book.brown), 'STREET').line1).toBe(
      '4 Gum Road',
    )
  })
})

// ════════════════════════════════════════════════════════ what Xero holds

describe('compare before set', () => {
  test('a field someone changed in Xero is never overwritten: PestM8’s change to it waits as Different, and Send PestM8’s details sends it', async () => {
    const s = await setup()
    const { book, connection, id } = await syncing(s)
    const smithId = id('Smith, John')

    // The bookkeeper corrects his email in Xero; the office changes it in
    // PestM8 too, differently.
    s.xero.editInXero(smithId, { email: 'js@smith.test' })
    await edit(s, book.smith, {
      email: 'john.smith@smith.test',
      phone: '0412 999 000',
    })
    await settle(s)

    const smith = s.xero.view(smithId)
    expect(smith.EmailAddress).toBe('js@smith.test')
    // Only the email was Xero's to keep: the new mobile still went.
    expect(phoneIn(smith, 'MOBILE')).toBe('0412999000')
    for (const e of updatesTo(s, smithId)) {
      expect(e).not.toHaveProperty('EmailAddress')
    }
    expect((await link(s, book.smith)).different).toEqual(['email'])
    expect(await lineOf(s, book.smith)).toMatchObject({
      state: 'different',
      different: ['email'],
    })
    expect((await syncStateOf(s, connection._id))?.counts?.different).toBe(1)

    // Terence: Send PestM8's details.
    await s.terence.as.mutation(api.xeroSync.overwrite, {
      businessId: s.businessId,
      connectionId: connection._id,
      clientId: book.smith,
    })
    expect(await audits(s, 'xero.overwrite')).toEqual([
      expect.objectContaining({
        actorMembershipId: s.ownerMembershipId,
        entityId: book.smith,
      }),
    ])
    await settle(s)

    expect(s.xero.view(smithId).EmailAddress).toBe('john.smith@smith.test')
    expect((await link(s, book.smith)).different ?? []).toEqual([])
    expect(await lineOf(s, book.smith)).toMatchObject({ state: 'in_xero' })
    expect((await syncStateOf(s, connection._id))?.counts?.different).toBe(0)
  })

  test('a value cleared in PestM8 stays in Xero, and Send PestM8’s details isn’t offered for it: nothing blank is sent', async () => {
    const s = await setup()
    const { book, connection } = await syncing(s)
    const contactId = (await link(s, book.patel)).xeroContactId!
    const from = s.xero.requests.length

    await edit(s, book.patel, { email: '' })
    await settle(s)

    expect(s.xero.view(contactId).EmailAddress).toBe('raj@patel.test')
    expect(updatesTo(s, contactId, from)).toEqual([])
    expect((await link(s, book.patel)).different).toEqual(['email'])
    // No button: pressing it could not send what the confirm promises.
    expect(await lineOf(s, book.patel)).toMatchObject({
      state: 'different',
      different: ['email'],
      canOverwrite: false,
    })

    // Asked anyway, it changes nothing and queues nothing.
    await s.terence.as.mutation(api.xeroSync.overwrite, {
      businessId: s.businessId,
      connectionId: connection._id,
      clientId: book.patel,
    })
    expect(await outbox(s)).toEqual([])
    expect((await link(s, book.patel)).different).toEqual(['email'])
    expect(await audits(s, 'xero.overwrite')).toEqual([])
    await settle(s)
    expect(s.xero.view(contactId).EmailAddress).toBe('raj@patel.test')
  })

  test('what Xero makes of a value it saves is what the next change is compared with — not what PestM8 sent', async () => {
    const s = await setup()
    // This Xero keeps phone numbers without their spaces.
    s.xero.normalise('PhoneNumber', (value) => value.replace(/\s+/g, ''))
    const { book } = await syncing(s)
    const contactId = (await link(s, book.patel)).xeroContactId!
    expect(
      s.xero.view(contactId).Phones.find((p) => p.PhoneType === 'DEFAULT')
        ?.PhoneNumber,
    ).toBe('94445555')

    // Not a change in Xero: sent as usual.
    await edit(s, book.patel, { phone: '08 9444 6666' })
    await settle(s)
    expect(phoneIn(s.xero.view(contactId), 'DEFAULT')).toBe('0894446666')
    expect((await link(s, book.patel)).different ?? []).toEqual([])
  })

  test('clearing a field in PestM8 leaves Xero’s value, and says so — never an empty value sent', async () => {
    const s = await setup()
    const { book } = await syncing(s)
    const contactId = (await link(s, book.patel)).xeroContactId!

    await edit(s, book.patel, { email: '' })
    await settle(s)

    expect(s.xero.view(contactId).EmailAddress).toBe('raj@patel.test')
    expect((await link(s, book.patel)).different).toEqual(['email'])
    for (const { e } of written(s)) {
      for (const [field, value] of Object.entries(e)) {
        if (field !== 'Phones' && field !== 'Addresses') {
          expect(value).not.toBe('')
        }
      }
    }
  })

  test('the people on a contact PestM8 made: a new one goes; with a bookkeeper’s added in Xero they wait as Different, and when sent join the bookkeeper’s — never replace them', async () => {
    const s = await setup()
    const { book, connection } = await syncing(s)
    const contactId = (await link(s, book.harbour)).xeroContactId!
    const addPerson = (name: string, email: string) =>
      s.terence.as.mutation(api.clientContacts.create, {
        businessId: s.businessId,
        clientId: book.harbour,
        name,
        email,
      })

    await addPerson('Pat Doe', 'pat@harbourside.test')
    await settle(s)
    expect(peopleOf(s.xero.view(contactId))).toEqual([
      'Pat Doe pat@harbourside.test',
      'Sam Lee sam@harbourside.test',
    ])

    // The bookkeeper adds Accounts in Xero; then the office adds Kim.
    s.xero.editInXero(contactId, {
      contactPersons: [
        ...s.xero.view(contactId).ContactPersons,
        { FirstName: 'Accounts', EmailAddress: 'accounts@harbourside.test' },
      ],
    })
    await addPerson('Kim Ng', 'kim@harbourside.test')
    await settle(s)
    expect((await link(s, book.harbour)).different).toEqual(['persons'])
    expect(peopleOf(s.xero.view(contactId))).toEqual([
      'Accounts accounts@harbourside.test',
      'Pat Doe pat@harbourside.test',
      'Sam Lee sam@harbourside.test',
    ])

    // Send PestM8's details: Kim joins, and Accounts stays.
    await s.terence.as.mutation(api.xeroSync.overwrite, {
      businessId: s.businessId,
      connectionId: connection._id,
      clientId: book.harbour,
    })
    await settle(s)
    expect(peopleOf(s.xero.view(contactId))).toEqual([
      'Accounts accounts@harbourside.test',
      'Kim Ng kim@harbourside.test',
      'Pat Doe pat@harbourside.test',
      'Sam Lee sam@harbourside.test',
    ])
    expect((await link(s, book.harbour)).different ?? []).toEqual([])
  })

  test('six people do not fit: five go, the client says some did not, and Xero’s own are kept', async () => {
    const s = await setup()
    const { book, connection } = await startWith(s, {
      busy: {
        name: 'Busy Body Corporate',
        kind: 'business',
        clientNumber: 30,
        contacts: [
          { name: 'Main Person', primary: true },
          ...['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven'].map(
            (n) => ({ name: `Person ${n}` }),
          ),
        ],
      },
    })

    const contact = await contactOf(s, book.busy)
    expect(contact.ContactPersons).toHaveLength(5)
    for (const { e } of createsNamed(s, 'Busy Body Corporate')) {
      expect((e.ContactPersons as Array<unknown>).length).toBeLessThanOrEqual(5)
    }
    const state = await syncStateOf(s, connection._id)
    expect([
      (await link(s, book.busy)).problem?.code,
      ...(state?.recent ?? []).map((p) => p.code),
    ]).toContain('persons_full')
  })

  test('an email Xero could not take (not plain ASCII) is left off, and the client says why', async () => {
    const s = await setup()
    await syncing(s)
    const { clientId } = await newClient(s, {
      name: 'Jörg Müller',
      email: 'jörg@müller.de',
      suburb: 'Leederville',
    })
    await settle(s)

    const contact = await contactOf(s, clientId)
    expect(contact.Name).toBe('Jörg Müller')
    expect(contact.EmailAddress).toBe('')
    for (const { e } of createsNamed(s, 'Jörg Müller')) {
      expect(e).not.toHaveProperty('EmailAddress')
    }
    expect((await link(s, clientId)).problem?.code).toBe('email_not_ascii')
  })
})

// ═══════════════════════════════════════════════════════════════ batches

describe('adding many at once', () => {
  test('sixty new clients: at most fifty to a PUT, each once, after one read of the book — calls a second apart, never two at once', async () => {
    const s = await setup()
    const seeds = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [
        `c${i}`,
        {
          name: `Client ${String(i + 1).padStart(2, '0')}`,
          clientNumber: 101 + i,
        },
      ]),
    ) as Record<string, ClientSeed>
    const { sinceStart } = await startWith(s, seeds)

    const creates = s.xero.creates()
    expect(creates.length).toBeGreaterThanOrEqual(2)
    for (const r of creates) {
      expect(contactsIn(r).length).toBeLessThanOrEqual(50)
    }
    const names = written(s).map(({ e }) => e.Name)
    expect(names).toHaveLength(60)
    expect(new Set(names).size).toBe(60)
    expect(s.xero.contactsOf(ORG.coastal)).toHaveLength(60)

    // Ten or more to add: Xero's book read once first, to match them.
    const calls = sinceStart()
    const reads = s.xero.bookReads()
    expect(calls.filter((r) => reads.includes(r))).toHaveLength(1)

    // Xero allows an organisation 60 calls a minute, from every app.
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i].at - calls[i - 1].at).toBeGreaterThanOrEqual(SECOND)
    }
    expect(s.xero.mostAtOnce(ORG.coastal)).toBe(1)
  }, 60_000)

  test('a live edit goes ahead of the walk of the book', async () => {
    const s = await setup()
    const seeds = Object.fromEntries(
      Array.from({ length: 120 }, (_, i) => [
        `c${i}`,
        { name: `Walk Client ${i + 1}`, clientNumber: 201 + i },
      ]),
    ) as Record<string, ClientSeed>
    const book = await addBook(s, {
      ...seeds,
      known: {
        name: 'Kara Known',
        clientNumber: 400,
        email: 'kara@known.test',
      },
    })
    const [kara] = s.xero.contacts(ORG.coastal, [
      { name: 'Kara Known', email: 'kara@known.test' },
    ])
    const connection = await connect(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })

    // Started, and before the walk begins Kara's number is changed: due by
    // the time the first page of work is taken.
    await startSyncing(s, s.terence, connection._id)
    await edit(s, book.known, { phone: '0412 000 111' })
    vi.setSystemTime(Date.now() + 6 * SECOND)
    await settle(s)

    const writes = s.xero.contactWrites()
    const karaAt = writes.findIndex((r) =>
      contactsIn(r).some((e) => e.ContactID === kara.contactId),
    )
    const puts = writes.filter((r) => r.method === 'PUT')
    expect(puts.length).toBeGreaterThanOrEqual(3)
    expect(karaAt).toBeGreaterThanOrEqual(0)
    expect(karaAt).toBeLessThan(writes.indexOf(puts[1]))
    expect(phoneIn(s.xero.view(kara.contactId), 'MOBILE')).toBe('0412000111')
    expect(s.xero.contactsOf(ORG.coastal)).toHaveLength(121)
  }, 60_000)

  test('ten or more new clients at once — an import after Start syncing — are matched to Xero’s contacts first, as the first match was', async () => {
    const s = await setup()
    await syncing(s)
    // Added in Xero since the first match.
    const [ivy] = s.xero.addContacts(ORG.coastal, [
      { name: 'Ivy Imported', email: 'ivy@imported.test' },
      { name: 'Ian Imported' },
    ])

    const importId = await s.terence.as.mutation(api.clientImports.start, {
      businessId: s.businessId,
      fileName: 'clients.csv',
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
          key: 'ivy',
          kind: 'person',
          name: 'Ivy Imported',
          email: 'ivy@imported.test',
          sites: [site(1)],
        },
        { key: 'ian', kind: 'person', name: 'Ian Imported', sites: [site(2)] },
        ...Array.from({ length: 10 }, (_, i) => ({
          key: `f${i}`,
          kind: 'person' as const,
          name: `Fresh Import ${i}`,
          sites: [site(10 + i)],
        })),
      ],
    })
    const byKey = Object.fromEntries(results.map((r) => [r.key, r.clientId!]))
    await settle(s)

    expect(await link(s, byKey.ivy)).toMatchObject({
      state: 'linked',
      xeroContactId: ivy.contactId,
    })
    expect(s.xero.named(ORG.coastal, 'Ivy Imported')).toHaveLength(1)
    expect(await link(s, byKey.ian)).toMatchObject({ state: 'needs_review' })
    expect(s.xero.named(ORG.coastal, 'Ian Imported')).toHaveLength(1)
    expect(createsNamed(s, 'Ivy Imported')).toEqual([])
    expect(createsNamed(s, 'Ian Imported')).toEqual([])
    for (let i = 0; i < 10; i++) {
      expect(s.xero.named(ORG.coastal, `Fresh Import ${i}`)).toHaveLength(1)
    }
  }, 30_000)
})

describe('contacts PestM8 already gave another client', () => {
  // Prod, 15 Oct 2026: a re-read of Xero's book mid-backfill put eight
  // clients To check against contacts PestM8 had just made for OTHER clients
  // (one shared their email, one their name), and Same could only refuse.
  test('are never offered to a new client: one sharing their email is added as its own contact, one sharing their name takes its suburb — none put To check', async () => {
    const s = await setup()
    const { book } = await startWith(s, {
      agency: {
        name: 'Pat Shared',
        clientNumber: 31,
        email: 'office@agency.test',
        site: { addressLine: '1 Como Street', suburb: 'Como' },
      },
    })
    const patsContact = (await link(s, book.agency)).xeroContactId

    const importId = await s.terence.as.mutation(api.clientImports.start, {
      businessId: s.businessId,
      fileName: 'more.csv',
    })
    const site = (n: number, suburb = 'Bassendean') => ({
      addressLine: `${n} Import Street`,
      suburb,
      state: 'WA',
      postcode: '6054',
    })
    const results = await s.terence.as.mutation(api.clientImports.addBatch, {
      businessId: s.businessId,
      importId,
      clients: [
        // Another tenant of the same agency: same office email, own name.
        {
          key: 'tenant',
          kind: 'person',
          name: 'Robin Tenant',
          email: 'office@agency.test',
          sites: [site(1)],
        },
        // Another Pat Shared altogether.
        {
          key: 'namesake',
          kind: 'person',
          name: 'Pat Shared',
          sites: [site(2, 'Dianella')],
        },
        // Enough to make it re-read Xero's book first, as the backfill did.
        ...Array.from({ length: 10 }, (_, i) => ({
          key: `f${i}`,
          kind: 'person' as const,
          name: `Fresh Shared ${i}`,
          sites: [site(10 + i)],
        })),
      ],
    })
    const byKey = Object.fromEntries(results.map((r) => [r.key, r.clientId!]))
    await settle(s)

    const tenant = await link(s, byKey.tenant)
    expect(tenant).toMatchObject({ state: 'linked', how: 'created' })
    expect(tenant.xeroContactId).not.toBe(patsContact)
    expect(s.xero.named(ORG.coastal, 'Robin Tenant')).toHaveLength(1)

    const namesake = await link(s, byKey.namesake)
    expect(namesake).toMatchObject({ state: 'linked', how: 'created' })
    expect(namesake.xeroContactId).not.toBe(patsContact)
    expect(s.xero.named(ORG.coastal, 'Pat Shared (Dianella)')).toHaveLength(1)

    // Pat's own contact is still Pat's alone, and nothing waits To check.
    expect(await link(s, book.agency)).toMatchObject({
      state: 'linked',
      xeroContactId: patsContact,
    })
    const toCheck = await s.t.run((ctx) =>
      ctx.db
        .query('xeroContactLinks')
        .filter((q) => q.eq(q.field('state'), 'needs_review'))
        .collect(),
    )
    expect(toCheck).toEqual([])
  }, 30_000)
})

describe('a second PestM8 record of one customer', () => {
  test('same name and email as a client already in Xero: put To check against that contact — never a second contact made on a guess', async () => {
    const s = await setup()
    const { book } = await startWith(s, {
      kim: {
        name: 'Kim Twice',
        clientNumber: 41,
        email: 'kim@twice.test',
        site: { addressLine: '4 Como Street', suburb: 'Como' },
      },
    })
    const kimsContact = (await link(s, book.kim)).xeroContactId

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
      candidate: { contactId: kimsContact, reason: 'contested' },
    })
    expect(s.xero.named(ORG.coastal, 'Kim Twice')).toHaveLength(1)
    expect(s.xero.named(ORG.coastal, 'Kim Twice (Bassendean)')).toHaveLength(0)
  }, 30_000)
})

// ═══════════════════════════════════════════════════════════════════ leads

describe('leads', () => {
  test('a lead waits for its first job — not sent, not queued, not booked by the nightly engine — and goes the moment one is booked', async () => {
    const s = await setup()
    const { book } = await syncing(s)
    expect(s.xero.named(ORG.coastal, 'Lena Lead')).toEqual([])

    // Edited, and given a series the nightly engine books visits for.
    await edit(s, book.lead, { phone: '0411 222 333' })
    await s.t.run(async (ctx) => {
      const propertyId = (await ctx.db
        .query('properties')
        .withIndex('by_client', (q) => q.eq('clientId', book.lead))
        .first())!._id
      await ctx.db.insert('recurrences', {
        businessId: s.businessId,
        propertyId,
        assignedMembershipId: s.ownerMembershipId,
        intervalCount: 1,
        intervalUnit: 'month',
        jobType: 'General Pest',
        price: 18000,
        anchorDate: Date.now() + DAY,
        active: true,
      })
    })
    const { created } = await s.t.mutation(
      internal.recurrences.materialiseAll,
      {},
    )
    expect(created).toBeGreaterThan(0)
    expect(await outbox(s)).toEqual([])
    await settle(s)
    expect(s.xero.named(ORG.coastal, 'Lena Lead')).toEqual([])
    expect((await clientRow(s, book.lead)).status).toBe('lead')
    expect(await lineOf(s, book.lead)).toMatchObject({ state: 'lead' })

    // Booked.
    await bookJob(s, book.lead)
    expect(await outbox(s)).toEqual([
      expect.objectContaining({ clientId: book.lead }),
    ])
    await settle(s)
    expect(s.xero.named(ORG.coastal, 'Lena Lead')).toHaveLength(1)
    expect(await link(s, book.lead)).toMatchObject({
      state: 'linked',
      how: 'created',
    })
  })

  test('a client in Xero made a lead again keeps getting its changes', async () => {
    const s = await setup()
    const { book, id } = await syncing(s)

    await edit(s, book.brown, { status: 'lead' })
    await edit(s, book.brown, { email: 'sarah.brown@brown.test' })
    await settle(s)

    expect(s.xero.view(id('Sarah Brown')).EmailAddress).toBe(
      'sarah.brown@brown.test',
    )
  })
})

// ════════════════════════════════════════════════════════════ name clashes

describe('two contacts of one name', () => {
  test('a second client of a name takes its suburb, a third its number — never a second contact of one name', async () => {
    const s = await setup()
    await startWith(s, {
      first: {
        name: 'Tom Jones',
        clientNumber: 13,
        site: { addressLine: '1 Bay Road', suburb: 'Bayswater' },
      },
    })
    const second = await newClient(s, {
      name: 'Tom Jones',
      suburb: 'Rockingham',
    })
    await settle(s)
    const third = await newClient(s, {
      name: 'Tom Jones',
      suburb: 'Rockingham',
      addressLine: '2 Other Street',
    })
    await settle(s)

    const thirdNumber = (await clientRow(s, third.clientId)).clientNumber
    expect(
      s.xero
        .contactsOf(ORG.coastal)
        .map((c) => c.name)
        .sort(),
    ).toEqual(
      [
        'Tom Jones',
        'Tom Jones (Rockingham)',
        `Tom Jones #${thirdNumber}`,
      ].sort(),
    )
    expect((await contactOf(s, second.clientId)).Name).toBe(
      'Tom Jones (Rockingham)',
    )
    expect((await contactOf(s, third.clientId)).Name).toBe(
      `Tom Jones #${thirdNumber}`,
    )
    for (const { clientId } of [second, third]) {
      expect(await link(s, clientId)).toMatchObject({
        state: 'linked',
        how: 'created',
      })
    }
  })

  test('two new clients of one name in one batch: the second takes its suburb', async () => {
    const s = await setup()
    const { book } = await startWith(s, {
      como: {
        name: 'Ann Lee',
        clientNumber: 21,
        site: { addressLine: '1 Como Street', suburb: 'Como' },
      },
      dianella: {
        name: 'Ann Lee',
        clientNumber: 22,
        site: { addressLine: '2 Dianella Drive', suburb: 'Dianella' },
      },
    })

    const como = await contactOf(s, book.como)
    const dianella = await contactOf(s, book.dianella)
    expect(como.ContactID).not.toBe(dianella.ContactID)
    expect(como.AccountNumber).toBe('21')
    expect(dianella.AccountNumber).toBe('22')
    const names = [como.Name, dianella.Name].sort()
    expect([
      ['Ann Lee', 'Ann Lee (Dianella)'],
      ['Ann Lee', 'Ann Lee (Como)'],
    ]).toContainEqual(names)
    expect(['Ann Lee', 'Ann Lee (Como)']).toContain(como.Name)
    expect(['Ann Lee', 'Ann Lee (Dianella)']).toContain(dianella.Name)
    expect(s.xero.contactsOf(ORG.coastal)).toHaveLength(2)
  })

  test('a name a contact nobody here is linked to already has: put to Terence, not added; Same links it, Different adds the client with its suburb', async () => {
    const s = await setup()
    const { connection } = await syncing(s)
    // Added in Xero after the match.
    const [wendy, wanda] = s.xero.addContacts(ORG.coastal, [
      { name: 'Wendy Walker' },
      { name: 'Wanda Wong' },
    ])
    const w1 = await newClient(s, { name: 'Wendy Walker', suburb: 'Subiaco' })
    const w2 = await newClient(s, { name: 'Wanda Wong', suburb: 'Cottesloe' })
    await settle(s)

    for (const [{ clientId }, contact] of [
      [w1, wendy],
      [w2, wanda],
    ] as const) {
      expect(await link(s, clientId)).toMatchObject({
        state: 'needs_review',
        candidate: { contactId: contact.contactId, reason: 'name_clash' },
      })
      expect(await lineOf(s, clientId)).toMatchObject({ state: 'to_check' })
    }
    expect(s.xero.named(ORG.coastal, 'Wendy Walker')).toHaveLength(1)
    expect(s.xero.named(ORG.coastal, 'Wanda Wong')).toHaveLength(1)

    await decide(s, connection._id, w1.clientId, 'same')
    await decide(s, connection._id, w2.clientId, 'different')
    await settle(s)

    expect(await link(s, w1.clientId)).toMatchObject({
      state: 'linked',
      xeroContactId: wendy.contactId,
    })
    expect(s.xero.named(ORG.coastal, 'Wendy Walker')).toHaveLength(1)
    expect((await contactOf(s, w2.clientId)).Name).toBe(
      'Wanda Wong (Cottesloe)',
    )
    expect(s.xero.named(ORG.coastal, 'Wanda Wong')).toHaveLength(1)
  })

  test('renamed to a name Xero already has: its suburb, then its number — and when every one is taken, not sent (name_taken)', async () => {
    const s = await setup()
    const { book, connection } = await syncing(s)
    const contactId = (await link(s, book.patel)).xeroContactId!

    // Linh Nguyen's contact is nobody's here (still to check).
    await edit(s, book.patel, { name: 'Linh Nguyen' })
    await settle(s)
    expect(s.xero.view(contactId).Name).toBe('Linh Nguyen (Mirrabooka)')

    s.xero.addContacts(ORG.coastal, [
      { name: 'Zed Zulu' },
      { name: 'Zed Zulu (Mirrabooka)' },
      { name: 'Zed Zulu #11' },
    ])
    await edit(s, book.patel, { name: 'Zed Zulu' })
    await settle(s)

    expect(s.xero.view(contactId).Name).toBe('Linh Nguyen (Mirrabooka)')
    const row = await link(s, book.patel)
    expect(row.xeroContactId).toBe(contactId)
    expect(row.problem?.code).toBe('name_taken')
    expect((await lineOf(s, book.patel)).problemCode).toBe('name_taken')
    expect((await syncStateOf(s, connection._id))?.recent?.[0]).toMatchObject({
      clientId: book.patel,
      code: 'name_taken',
    })
    expect(s.xero.named(ORG.coastal, 'Zed Zulu')).toHaveLength(1)
  })

  test('the contact an answer that never came back made is found by its account number and linked — not added again', async () => {
    const s = await setup()
    await syncing(s)
    quietly()

    // Xero saves it; the answer, and its retries' answers, are lost.
    s.xero.loseResponseAfterCommit({ retries: true })
    const { clientId } = await newClient(s, {
      name: 'Wendy West',
      suburb: 'Subiaco',
    })
    await settle(s)

    const [wendy] = s.xero.named(ORG.coastal, 'Wendy West')
    expect(s.xero.named(ORG.coastal, 'Wendy West')).toHaveLength(1)
    expect(s.xero.contactsOf(ORG.coastal).map((c) => c.name)).not.toContain(
      'Wendy West (Subiaco)',
    )
    expect(await link(s, clientId)).toMatchObject({
      state: 'linked',
      xeroContactId: wendy.contactId,
    })
    expect(wendy.accountNumber).toBe(
      String((await clientRow(s, clientId)).clientNumber),
    )
    // Its retries were the same request, under the same key; the later go
    // was a new one.
    const puts = createsNamed(s, 'Wendy West').map(({ r }) => r)
    expect(puts.length).toBeGreaterThanOrEqual(2)
    const firstKey = puts[0].headers['idempotency-key']
    const retries = puts.filter((r) => r.lost)
    for (const r of retries) {
      expect(r.headers['idempotency-key']).toBe(firstKey)
      expect(r.body).toBe(puts[0].body)
    }
    expect(puts.at(-1)!.headers['idempotency-key']).not.toBe(firstKey)
    expect(await outbox(s)).toEqual([])
  })
})

// ── the holder's word, and answers that never came back (review, 15 Oct)

describe('a contact the holder ruled out, and creates whose answer was lost', () => {
  test('unlinked after Start syncing: a contact of its own, with its suburb — never linked back to the contact unlinked, though that holds the name and the number', async () => {
    const s = await setup()
    const { book, connection, id } = await startWith(
      s,
      {
        jan: {
          name: 'Jan Morris',
          clientNumber: 118,
          site: { addressLine: '3 Casuarina Drive', suburb: 'Nightcliff' },
        },
      },
      [{ name: 'Jan Morris', accountNumber: '118' }],
    )
    const theirs = id('Jan Morris')
    expect(await link(s, book.jan)).toMatchObject({
      state: 'linked',
      xeroContactId: theirs,
    })
    const before = s.xero.view(theirs)

    await s.terence.as.mutation(api.xeroMatch.unlink, {
      businessId: s.businessId,
      connectionId: connection._id,
      clientId: book.jan,
    })
    await settle(s)

    const row = await link(s, book.jan)
    expect(row).toMatchObject({ state: 'linked', how: 'created' })
    expect(row.xeroContactId).not.toBe(theirs)
    const ours = await contactOf(s, book.jan)
    expect(ours.Name).toBe('Jan Morris (Nightcliff)')
    // The number stays on the contact that had it.
    expect(ours.AccountNumber ?? '').toBe('')
    expect(s.xero.view(theirs)).toEqual(before)
    expect(await outbox(s)).toEqual([])
  })

  test('a suffixed create whose answer never came back is found by its name and number — not made again as “#number”', async () => {
    const s = await setup()
    const { book, connection } = await syncing(s)
    quietly()
    // Xero saves "Linh Nguyen (Mirrabooka)"; its answer, and its retries',
    // are lost.
    let armed = false
    s.xero.onRequest((r) => {
      if (
        !armed &&
        r.method === 'PUT' &&
        contactsIn(r).some((e) => e.Name === 'Linh Nguyen (Mirrabooka)')
      ) {
        armed = true
        s.xero.loseResponseAfterCommit({ retries: true })
      }
    })

    await decide(s, connection._id, book.nguyen, 'different')
    await settle(s)

    expect(armed).toBe(true)
    const named = s.xero.named(ORG.coastal, 'Linh Nguyen (Mirrabooka)')
    expect(named).toHaveLength(1)
    expect(named[0].accountNumber).toBe('9')
    expect(s.xero.contactsOf(ORG.coastal).map((c) => c.name)).not.toContain(
      'Linh Nguyen #9',
    )
    expect(await link(s, book.nguyen)).toMatchObject({
      state: 'linked',
      xeroContactId: named[0].contactId,
    })
    expect(await outbox(s)).toEqual([])
  })

  test('a name Xero says is taken but can’t find: tried again later — never added with a suffix on a guess', async () => {
    const s = await setup()
    await syncing(s)
    quietly()
    const [wendy] = s.xero.addContacts(ORG.coastal, [{ name: 'Wendy Walker' }])
    // Renamed in Xero between the clash and the look-up.
    const stop = s.xero.onRequest((r) => {
      if (r.method === 'GET' && r.query.get('where')?.includes('Wendy')) {
        s.xero.editInXero(wendy.contactId, { name: 'Wendy Walker-Jones' })
      }
    })
    const { clientId } = await newClient(s, {
      name: 'Wendy Walker',
      suburb: 'Subiaco',
    })
    await settleFor(s, 30 * SECOND)
    stop()

    expect(s.xero.contactsOf(ORG.coastal).map((c) => c.name)).not.toContain(
      'Wendy Walker (Subiaco)',
    )
    expect(
      (await outbox(s)).find((row) => row.clientId === clientId),
    ).toMatchObject({ attempts: 1, lastError: { code: 'name_unread' } })

    await settle(s)
    expect((await contactOf(s, clientId)).Name).toBe('Wendy Walker')
    expect(s.xero.contactsOf(ORG.coastal).map((c) => c.name)).not.toContain(
      'Wendy Walker (Subiaco)',
    )
  })

  test('one client’s look-up refused outright fails that client alone: the rest of its page is sent', async () => {
    const s = await setup()
    const { book } = await syncing(s)
    quietly()
    s.xero.addContacts(ORG.coastal, [{ name: 'Wendy Walker' }])
    const stop = s.xero.onRequest((r) => {
      if (r.method === 'GET' && r.query.has('where')) {
        s.xero.contactsFail(400, {}, { times: 1 })
      }
    })
    const { clientId } = await newClient(s, {
      name: 'Wendy Walker',
      suburb: 'Subiaco',
    })
    await edit(s, book.brown, { email: 'sarah@brownfamily.test' })
    await settleFor(s, 20 * SECOND)
    stop()

    expect((await contactOf(s, book.brown)).EmailAddress).toBe(
      'sarah@brownfamily.test',
    )
    expect(await link(s, clientId)).toMatchObject({ state: 'failed' })
    expect(s.xero.named(ORG.coastal, 'Wendy Walker')).toHaveLength(1)
  })
})

// ════════════════════════════════════════════════════ retries and recovery

describe('when Xero fails', () => {
  test('an answer lost on its way back is asked again under the same Idempotency-Key, and answered from the first: one contact', async () => {
    const s = await setup()
    await syncing(s)
    quietly()

    s.xero.loseResponseAfterCommit()
    const { clientId } = await newClient(s, {
      name: 'Larry Lost',
      suburb: 'Floreat',
    })
    await settle(s)

    expect(s.xero.named(ORG.coastal, 'Larry Lost')).toHaveLength(1)
    const puts = createsNamed(s, 'Larry Lost').map(({ r }) => r)
    expect(puts).toHaveLength(2)
    expect(puts[0].lost).toBe(true)
    expect(puts[1].replayed).toBe(true)
    expect(puts[1].headers['idempotency-key']).toBe(
      puts[0].headers['idempotency-key'],
    )
    expect(puts[1].body).toBe(puts[0].body)
    expect(await link(s, clientId)).toMatchObject({
      state: 'linked',
      xeroContactId: s.xero.named(ORG.coastal, 'Larry Lost')[0].contactId,
    })
  })

  test('a 503 is tried again under the same key; Xero down for longer leaves the change waiting, later each time, and sends it when Xero is back', async () => {
    const s = await setup()
    const { connection } = await syncing(s)
    quietly()

    s.xero.next5xx(1)
    await newClient(s, { name: 'Fran Flaky', suburb: 'Mosman Park' })
    await settle(s)
    const flaky = createsNamed(s, 'Fran Flaky').map(({ r }) => r)
    expect(flaky.map((r) => r.status)).toEqual([503, 200])
    expect(flaky[1].headers['idempotency-key']).toBe(
      flaky[0].headers['idempotency-key'],
    )
    expect(flaky[1].at - flaky[0].at).toBeGreaterThanOrEqual(SECOND)
    expect(s.xero.named(ORG.coastal, 'Fran Flaky')).toHaveLength(1)

    // Down for every try this drain makes.
    s.xero.next5xx(4)
    const { clientId } = await newClient(s, {
      name: 'Dora Down',
      suburb: 'Claremont',
    })
    await settleFor(s, 40 * SECOND)
    const [row] = await outbox(s)
    expect(row).toMatchObject({ clientId })
    expect(row.attempts).toBeGreaterThanOrEqual(1)
    expect(row.lastError).toMatchObject({ code: expect.any(String) })
    expect(row.dueAt).toBeGreaterThan(Date.now())
    expect(s.xero.named(ORG.coastal, 'Dora Down')).toEqual([])

    await settle(s)
    expect(s.xero.named(ORG.coastal, 'Dora Down')).toHaveLength(1)
    expect(await outbox(s)).toEqual([])
    expect((await syncStateOf(s, connection._id))?.lease).toBeUndefined()
  })

  test('over the minute’s allowance: nothing more until Xero says, then it carries on', async () => {
    const s = await setup()
    const { book, connection } = await syncing(s)
    const contactId = (await link(s, book.patel)).xeroContactId!
    const from = s.xero.requests.length

    s.xero.next429('minute', 40, { tenantId: ORG.coastal })
    await edit(s, book.patel, { email: 'raj.p@patel.test' })
    await settleFor(s, 20 * SECOND)

    const state = await syncStateOf(s, connection._id)
    expect(state).toMatchObject({ pauseReason: 'minute' })
    const refused = s.xero
      .accountingRequests()
      .filter((r) => s.xero.requests.indexOf(r) >= from)
    expect(refused.map((r) => r.status)).toEqual([429])
    expect(state?.pausedUntil).toBe(refused[0].at + 40 * SECOND)
    expect(await outbox(s)).toEqual([
      expect.objectContaining({ clientId: book.patel }),
    ])

    await settle(s)
    const after = s.xero
      .accountingRequests()
      .filter((r) => s.xero.requests.indexOf(r) >= from)
    expect(after[1].at).toBeGreaterThanOrEqual(refused[0].at + 40 * SECOND)
    expect(s.xero.view(contactId).EmailAddress).toBe('raj.p@patel.test')
    expect(await outbox(s)).toEqual([])
  })

  test('over the day’s: paused until Xero says, and said so', async () => {
    const s = await setup()
    const { book, connection } = await syncing(s)
    const contactId = (await link(s, book.patel)).xeroContactId!

    s.xero.next429('day', 3 * 60 * 60, { tenantId: ORG.coastal })
    await edit(s, book.patel, { email: 'raj.day@patel.test' })
    await settleFor(s, 20 * SECOND)
    const state = await syncStateOf(s, connection._id)
    expect(state).toMatchObject({ pauseReason: 'day' })
    expect(state!.pausedUntil!).toBeGreaterThan(Date.now() + 2 * HOUR)
    expect(s.xero.view(contactId).EmailAddress).toBe('raj@patel.test')

    // Another change waits with it, asking Xero nothing.
    const calls = s.xero.accountingRequests().length
    await edit(s, book.quiet, { email: 'quentin@quiet.test' })
    await settleFor(s, MINUTE)
    expect(s.xero.accountingRequests()).toHaveLength(calls)

    await settle(s)
    expect(s.xero.view(contactId).EmailAddress).toBe('raj.day@patel.test')
    expect((await contactOf(s, book.quiet)).EmailAddress).toBe(
      'quentin@quiet.test',
    )
  })

  test('a pause is cleared the moment it runs out — even with nothing waiting to send', async () => {
    const s = await setup()
    const { connection } = await syncing(s)
    const sync = async () =>
      (await s.terence.as.query(api.xero.status, { businessId: s.businessId }))
        .business?.sync
    await s.t.mutation(internal.xeroSync.holdOff, {
      connectionId: connection._id,
      until: Date.now() + 10 * MINUTE,
      why: 'day',
    })
    expect((await sync())?.pausedUntil).not.toBeNull()
    expect(await outbox(s)).toEqual([])

    await settle(s)
    const row = await syncStateOf(s, connection._id)
    expect(row?.pausedUntil).toBeUndefined()
    expect(row?.pauseReason).toBeUndefined()
    expect(await sync()).toMatchObject({ pausedUntil: null, pauseReason: null })
  })

  test('too many at once is tried again in a few seconds, under the same key', async () => {
    const s = await setup()
    await syncing(s)
    quietly()

    s.xero.next429('concurrent', undefined, { tenantId: ORG.coastal })
    await newClient(s, { name: 'Connie Current', suburb: 'Nedlands' })
    await settle(s)

    const puts = createsNamed(s, 'Connie Current').map(({ r }) => r)
    expect(puts.map((r) => r.status)).toEqual([429, 200])
    expect(puts[1].headers['idempotency-key']).toBe(
      puts[0].headers['idempotency-key'],
    )
    expect(puts[1].at - puts[0].at).toBeGreaterThanOrEqual(SECOND)
    expect(s.xero.named(ORG.coastal, 'Connie Current')).toHaveLength(1)
  })

  test('with fewer than 200 calls left today, the walk of the book waits an hour — live edits still go', async () => {
    const s = await setup()
    const seeds = Object.fromEntries(
      Array.from({ length: 120 }, (_, i) => [
        `c${i}`,
        { name: `Walk Client ${i + 1}`, clientNumber: 201 + i },
      ]),
    ) as Record<string, ClientSeed>
    const book = await addBook(s, {
      ...seeds,
      known: {
        name: 'Kara Known',
        clientNumber: 400,
        email: 'kara@known.test',
      },
    })
    s.xero.contacts(ORG.coastal, [
      { name: 'Kara Known', email: 'kara@known.test' },
    ])
    const connection = await connect(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    // Other apps have used all but 150 of the organisation's day.
    s.xero.dayRemaining(150, ORG.coastal)

    await startSyncing(s, s.terence, connection._id)
    await settleFor(s, 2 * MINUTE)

    const state = await syncStateOf(s, connection._id)
    expect(state?.dayRemaining).toBeLessThan(200)
    expect(state?.backfillHeldUntil).toBeGreaterThan(Date.now() + 50 * MINUTE)
    expect(state?.backfillDoneAt).toBeUndefined()
    const added = s.xero.contactsOf(ORG.coastal).length - 1
    expect(added).toBeLessThan(120)

    // A live edit still goes, held walk or not.
    await edit(s, book.known, { phone: '0412 000 111' })
    await settleFor(s, 2 * MINUTE)
    expect(phoneIn(await contactOf(s, book.known), 'MOBILE')).toBe('0412000111')
    expect(s.xero.contactsOf(ORG.coastal).length - 1).toBe(added)
  }, 60_000)
})

// ═══════════════════════════════════════ Xero no longer taking the sign-in

describe('when Xero stops accepting the connection', () => {
  test('a lapsed access token is refreshed, once, and the change sent', async () => {
    const s = await setup()
    const { book } = await syncing(s)
    const contactId = (await link(s, book.patel)).xeroContactId!
    const refreshes = s.xero.refreshed.length

    s.xero.expireAccessTokens()
    await edit(s, book.patel, { email: 'raj.fresh@patel.test' })
    await settle(s)

    expect(s.xero.refreshed.length).toBe(refreshes + 1)
    expect(s.xero.view(contactId).EmailAddress).toBe('raj.fresh@patel.test')
  })

  test('removed in Xero (403): the connection needs reconnecting and the change waits; reconnected, it goes', async () => {
    const s = await setup()
    const { book, connection } = await syncing(s)
    const contactId = (await link(s, book.patel)).xeroContactId!
    quietly()

    const { syncStartedAt: startedAt } = await connectionRow(s, connection._id)
    expect(startedAt).toBeTypeOf('number')
    s.xero.removeInXero(XU.terence, ORG.coastal)
    await edit(s, book.patel, { email: 'raj.gone@patel.test' })
    await settle(s)
    expect((await connectionRow(s, connection._id)).status).toBe(
      'needs_reconnect',
    )
    expect(await outbox(s)).toEqual([
      expect.objectContaining({ clientId: book.patel }),
    ])
    expect(s.xero.view(contactId).EmailAddress).toBe('raj@patel.test')
    expect((await syncStateOf(s, connection._id))?.lease).toBeUndefined()

    // Changes keep queueing while it waits.
    await edit(s, book.quiet, { email: 'quentin@quiet.test' })
    expect((await outbox(s)).map((r) => r.clientId).sort()).toEqual(
      [book.patel, book.quiet].sort(),
    )

    const again = await connect(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    // The same connection, still syncing since it first started.
    expect(again._id).toBe(connection._id)
    expect(again.syncStartedAt).toBe(startedAt)
    await cron(s)
    expect(s.xero.view(contactId).EmailAddress).toBe('raj.gone@patel.test')
    expect((await contactOf(s, book.quiet)).EmailAddress).toBe(
      'quentin@quiet.test',
    )
    expect(await outbox(s)).toEqual([])
  })

  test('a sign-in Xero refuses to refresh (invalid_grant): the same', async () => {
    const s = await setup()
    const { book, connection } = await syncing(s)
    const contactId = (await link(s, book.patel)).xeroContactId!
    quietly()

    await s.t.run((ctx) =>
      ctx.db.patch(connection.grantId, { accessExpiresAt: Date.now() - 1000 }),
    )
    s.xero.knobs.failRefresh = 'invalid_grant'
    const writes = s.xero.contactWrites().length
    await edit(s, book.patel, { email: 'raj.dead@patel.test' })
    await settle(s)

    expect((await connectionRow(s, connection._id)).status).toBe(
      'needs_reconnect',
    )
    expect(s.xero.contactWrites()).toHaveLength(writes)
    expect(await outbox(s)).toEqual([
      expect.objectContaining({ clientId: book.patel }),
    ])

    s.xero.knobs.failRefresh = null
    await connect(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    await cron(s)
    expect(s.xero.view(contactId).EmailAddress).toBe('raj.dead@patel.test')
  })
})

// ═════════════════════════════════════════════════ changes made in Xero

describe('changes made in Xero', () => {
  test('merged in Xero: relinked to the contact it was merged into, and sent there', async () => {
    const s = await setup()
    const { book, id } = await syncing(s)
    const old = id('Smith, John')
    // The bookkeeper had a second John Smith, and merged the first into it.
    const [survivor] = s.xero.addContacts(ORG.coastal, [
      { name: 'John Smith', email: 'john@smith.test' },
    ])
    s.xero.merge(old, survivor.contactId)
    const before = s.xero.view(old)

    await edit(s, book.smith, { email: 'john@smithfamily.test' })
    await settle(s)

    expect(await link(s, book.smith)).toMatchObject({
      state: 'linked',
      how: 'relinked',
      xeroContactId: survivor.contactId,
    })
    expect(s.xero.view(survivor.contactId).EmailAddress).toBe(
      'john@smithfamily.test',
    )
    expect(s.xero.view(old)).toEqual(before)
    expect(updatesTo(s, old, 0).filter((e) => 'EmailAddress' in e)).toEqual([])
  })

  test('merged into a contact another client here has: put to Terence, never written', async () => {
    const s = await setup()
    const { book, id } = await syncing(s)
    const brownBefore = s.xero.view(id('Sarah Brown'))
    s.xero.merge(id('Smith, John'), id('Sarah Brown'))

    await edit(s, book.smith, { email: 'john@smithfamily.test' })
    await settle(s)

    expect(await link(s, book.smith)).toMatchObject({
      state: 'needs_review',
      candidate: { contactId: id('Sarah Brown'), reason: 'contested' },
    })
    expect(s.xero.view(id('Sarah Brown'))).toEqual(brownBefore)
    expect(await link(s, book.brown)).toMatchObject({
      state: 'linked',
      xeroContactId: id('Sarah Brown'),
    })
  })

  test('two clients’ contacts merged into one, both sent in one page: one follows it, the other is put to Terence — never two clients on one contact', async () => {
    const s = await setup()
    const { book, id } = await syncing(s)
    quietly()
    const [survivor] = s.xero.addContacts(ORG.coastal, [
      { name: 'Smith & Brown' },
    ])
    s.xero.merge(id('Smith, John'), survivor.contactId)
    s.xero.merge(id('Sarah Brown'), survivor.contactId)

    await edit(s, book.smith, { email: 'john@smithfamily.test' })
    await edit(s, book.brown, { email: 'sarah@brownfamily.test' })
    await settle(s)

    const rows = [await link(s, book.smith), await link(s, book.brown)]
    expect(
      rows.filter(
        (row) =>
          row.state === 'linked' && row.xeroContactId === survivor.contactId,
      ),
    ).toHaveLength(1)
    expect(
      rows.filter(
        (row) =>
          row.state === 'needs_review' &&
          row.candidate?.contactId === survivor.contactId &&
          row.candidate.reason === 'contested',
      ),
    ).toHaveLength(1)
    expect(await outbox(s)).toEqual([])
  })

  test('archived in Xero: stopped — never written, never added again, and asking Xero nothing after', async () => {
    const s = await setup()
    const { book, connection, id } = await syncing(s)
    s.xero.archive(id('Smith, John'))
    const before = s.xero.view(id('Smith, John'))

    await edit(s, book.smith, { email: 'john@smithfamily.test' })
    await settle(s)
    expect(await link(s, book.smith)).toMatchObject({
      state: 'archived_in_xero',
      xeroContactId: id('Smith, John'),
    })
    expect(s.xero.view(id('Smith, John'))).toEqual(before)
    expect(await lineOf(s, book.smith)).toMatchObject({ state: 'archived' })
    expect((await syncStateOf(s, connection._id))?.counts?.stopped).toBe(1)

    const calls = s.xero.accountingRequests().length
    await edit(s, book.smith, { phone: '0412 777 888' })
    await bookJob(s, book.smith)
    await settle(s)
    expect(s.xero.accountingRequests()).toHaveLength(calls)
    expect(createsNamed(s, 'John Smith')).toEqual([])
  })

  test('erased in Xero for privacy: stopped, and never added back', async () => {
    const s = await setup()
    const { book, id } = await syncing(s)
    s.xero.gdpr(id('Sarah Brown'))

    await edit(s, book.brown, { email: 'sarah@newmail.test' })
    await settle(s)
    await bookJob(s, book.brown)
    await settle(s)

    expect(await link(s, book.brown)).toMatchObject({ state: 'gdpr' })
    expect(await lineOf(s, book.brown)).toMatchObject({ state: 'gdpr' })
    expect(createsNamed(s, 'Sarah Brown')).toEqual([])
    expect(
      updatesTo(s, id('Sarah Brown')).filter((e) => 'EmailAddress' in e),
    ).toEqual([])
  })
})

// ═════════════════════════════════════════════════════════ refused by Xero

describe('refused by Xero', () => {
  test('an email Xero refuses: not added, kept as a code (never Xero’s words), and tried again when the client is booked or changed', async () => {
    const s = await setup()
    const { connection } = await syncing(s)
    quietly()
    s.xero.refuseItems((e) =>
      e.EmailAddress === 'olive@odd.test'
        ? 'Email address must be valid.'
        : null,
    )

    const { clientId } = await newClient(s, {
      name: 'Olive Odd',
      email: 'olive@odd.test',
      suburb: 'Shenton Park',
    })
    await settle(s)

    expect(s.xero.named(ORG.coastal, 'Olive Odd')).toEqual([])
    const row = await link(s, clientId)
    expect(row).toMatchObject({
      state: 'failed',
      problem: { code: 'email_invalid' },
    })
    expect(await lineOf(s, clientId)).toMatchObject({
      state: 'failed',
      problemCode: 'email_invalid',
    })
    const state = await syncStateOf(s, connection._id)
    expect(state?.recent?.[0]).toMatchObject({
      clientId,
      code: 'email_invalid',
    })
    expect(state?.counts?.failed).toBe(1)
    // Xero's own words go to the log, never into a row.
    const rows = await s.t.run(async (ctx) =>
      JSON.stringify([
        await ctx.db.query('xeroContactLinks').collect(),
        await ctx.db.query('xeroSyncState').collect(),
        await ctx.db.query('xeroOutbox').collect(),
      ]),
    )
    expect(rows).not.toMatch(/must be valid/)
    // Not tried again on its own.
    expect(createsNamed(s, 'Olive Odd')).toHaveLength(1)

    // Booked: tried again (and refused again).
    await bookJob(s, clientId)
    expect(await outbox(s)).toEqual([expect.objectContaining({ clientId })])
    await settle(s)
    expect(createsNamed(s, 'Olive Odd')).toHaveLength(2)

    // The email fixed: added.
    await edit(s, clientId, { email: 'olive@olive.test' })
    await settle(s)
    expect(s.xero.named(ORG.coastal, 'Olive Odd')).toHaveLength(1)
    expect(await link(s, clientId)).toMatchObject({
      state: 'linked',
      how: 'created',
    })
    expect((await link(s, clientId)).problem).toBeUndefined()
    expect((await syncStateOf(s, connection._id))?.counts?.failed).toBe(0)
  })
})

describe('what the pages say', () => {
  test('Recent problems lists what still stands, once a client, and says whether it is in Xero; one put right goes by itself', async () => {
    const s = await setup()
    const { book } = await syncing(s)
    quietly()
    s.xero.refuseItems((e) =>
      typeof e.EmailAddress === 'string' && e.EmailAddress.endsWith('@odd.test')
        ? 'Email address must be valid.'
        : null,
    )
    const { clientId: olive } = await newClient(s, {
      name: 'Olive Odd',
      email: 'olive@odd.test',
      suburb: 'Shenton Park',
    })
    await settle(s)
    await edit(s, book.patel, { email: 'raj@odd.test' })
    await settle(s)
    // Refused again: still one row for her.
    await edit(s, olive, { email: 'olive2@odd.test' })
    await settle(s)

    const recent = async () =>
      (await s.terence.as.query(api.xero.status, { businessId: s.businessId }))
        .business?.sync
    expect(await recent()).toMatchObject({
      recent: [
        { clientId: book.patel, code: 'email_invalid', inXero: true },
        { clientId: olive, code: 'email_invalid', inXero: false },
      ],
      problems: 2,
    })

    await edit(s, book.patel, { email: 'raj@patelfamily.test' })
    await settle(s)
    expect(await recent()).toMatchObject({
      recent: [{ clientId: olive, code: 'email_invalid', inXero: false }],
      problems: 1,
    })

    // Added, then refused again on a later change: one row, for the newest.
    await edit(s, olive, { email: 'olive@olive.test' })
    await settle(s)
    expect((await recent())?.recent).toEqual([])
    await edit(s, olive, { email: 'olive3@odd.test' })
    await settle(s)
    expect(await recent()).toMatchObject({
      recent: [{ clientId: olive, code: 'email_invalid', inXero: true }],
      problems: 1,
    })
  })

  test('before Start syncing, the client sheet says a client the match found is In Xero already, and one to check To check', async () => {
    const s = await setup()
    const book = await addBook(s, STANDARD)
    s.xero.contacts(ORG.coastal, standardContacts())
    await connect(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    await settle(s)

    const smith = await lineOf(s, book.smith)
    expect(smith).toMatchObject({ state: 'in_xero', lastSentAt: null })
    expect(smith.openUrl).toMatch(/^https:\/\/go\.xero\.com\//)
    expect(await lineOf(s, book.nguyen)).toMatchObject({ state: 'to_check' })
    expect(await lineOf(s, book.patel)).toMatchObject({ state: 'not_yet' })
    expect(await lineOf(s, book.lead)).toMatchObject({ state: 'lead' })
    expect(s.xero.contactWrites()).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════ lifecycle

describe('the Recycle bin, wipes and undos', () => {
  test('the bin stops the sync and a restore resumes it; the contact in Xero is never archived or deleted', async () => {
    const s = await setup()
    const { book, connection } = await syncing(s)
    const contactId = (await link(s, book.patel)).xeroContactId!
    const before = s.xero.view(contactId)

    const entryId = await s.terence.as.mutation(api.bin.deleteClient, {
      businessId: s.businessId,
      clientId: book.patel,
    })
    await settle(s)
    expect(s.xero.view(contactId)).toEqual(before)
    expect(
      s.xero.requests.filter(
        (r) => r.path.startsWith('/api.xro/') && r.method === 'DELETE',
      ),
    ).toEqual([])
    await noLines(linesOf(s, s.terence, book.patel))
    // Out of the book, out of the tallies.
    expect((await syncStateOf(s, connection._id))?.counts?.inXero).toBe(6)

    await s.terence.as.mutation(api.bin.restore, {
      businessId: s.businessId,
      entryId,
    })
    await settle(s)
    expect((await syncStateOf(s, connection._id))?.counts?.inXero).toBe(7)
    await edit(s, book.patel, { email: 'raj.back@patel.test' })
    await settle(s)
    expect(s.xero.view(contactId).EmailAddress).toBe('raj.back@patel.test')
    expect(s.xero.view(contactId).ContactStatus).toBe('ACTIVE')
  })

  test('a client binned before its first send is never sent; restored, it is', async () => {
    const s = await setup()
    await syncing(s)
    const { clientId } = await newClient(s, {
      name: 'Brief Client',
      suburb: 'Dalkeith',
    })
    const entryId = await s.terence.as.mutation(api.bin.deleteClient, {
      businessId: s.businessId,
      clientId,
    })
    await settle(s)
    expect(s.xero.named(ORG.coastal, 'Brief Client')).toEqual([])
    expect(createsNamed(s, 'Brief Client')).toEqual([])

    await s.terence.as.mutation(api.bin.restore, {
      businessId: s.businessId,
      entryId,
    })
    await settle(s)
    expect(s.xero.named(ORG.coastal, 'Brief Client')).toHaveLength(1)
  })

  test('deleted forever: its links and anything queued go; its contact stays in Xero', async () => {
    const s = await setup()
    const { book } = await syncing(s)
    const contactId = (await link(s, book.patel)).xeroContactId!
    const before = s.xero.view(contactId)

    await edit(s, book.patel, { email: 'raj.last@patel.test' })
    const entryId = await s.terence.as.mutation(api.bin.deleteClient, {
      businessId: s.businessId,
      clientId: book.patel,
    })
    await s.terence.as.mutation(api.bin.wipe, {
      businessId: s.businessId,
      entryId,
    })
    await settle(s)

    expect(await s.t.run((ctx) => ctx.db.get(book.patel))).toBeNull()
    expect(
      await s.t.run((ctx) =>
        ctx.db
          .query('xeroContactLinks')
          .withIndex('by_client', (q) => q.eq('clientId', book.patel))
          .collect(),
      ),
    ).toEqual([])
    expect(await outbox(s)).toEqual([])
    expect(s.xero.view(contactId)).toEqual(before)
  })

  test('undoing an import: the clients it added stay in Xero, the undo says how many, and their links go', async () => {
    const s = await setup()
    await syncing(s)
    const importId = await s.terence.as.mutation(api.clientImports.start, {
      businessId: s.businessId,
      fileName: 'clients.csv',
    })
    const results = await s.terence.as.mutation(api.clientImports.addBatch, {
      businessId: s.businessId,
      importId,
      clients: ['Una Undo', 'Ula Undo', 'Uma Undo'].map((name, i) => ({
        key: `u${i}`,
        kind: 'person' as const,
        name,
        sites: [
          {
            addressLine: `${i + 1} Undo Street`,
            suburb: 'Bayswater',
            state: 'WA',
            postcode: '6053',
          },
        ],
      })),
    })
    const ids = results.map((r) => r.clientId!)
    await settle(s)
    const contacts = s.xero.contactsOf(ORG.coastal).length

    const note: unknown = await s.terence.as.query(api.xeroSync.importNote, {
      businessId: s.businessId,
      importId,
    })
    expect(countIn(note)).toBe(3)

    await s.terence.as.mutation(api.clientImports.undo, {
      businessId: s.businessId,
      importId,
    })
    await settle(s)

    for (const clientId of ids) {
      expect(await s.t.run((ctx) => ctx.db.get(clientId))).toBeNull()
      expect(await linkOf(s, clientId)).toBeNull()
    }
    expect(s.xero.contactsOf(ORG.coastal)).toHaveLength(contacts)
    for (const name of ['Una Undo', 'Ula Undo', 'Uma Undo']) {
      expect(s.xero.named(ORG.coastal, name)).toHaveLength(1)
    }
    expect(await outbox(s)).toEqual([])
  })

  test('an import being undone sends nothing more of it — and a client the undo keeps goes once it is kept', async () => {
    const s = await setup()
    const { connection } = await syncing(s)
    const importId = await s.terence.as.mutation(api.clientImports.start, {
      businessId: s.businessId,
      fileName: 'clients.csv',
    })
    const names = ['Una Undo', 'Ula Undo', 'Uma Undo']
    const results = await s.terence.as.mutation(api.clientImports.addBatch, {
      businessId: s.businessId,
      importId,
      clients: names.map((name, i) => ({
        key: `u${i}`,
        kind: 'person' as const,
        name,
        sites: [
          {
            addressLine: `${i + 1} Undo Street`,
            suburb: 'Bayswater',
            state: 'WA',
            postcode: '6053',
          },
        ],
      })),
    })
    const [una] = results.map((r) => r.clientId!)
    // Una is booked: the undo keeps her.
    await bookJob(s, una)
    await dropScheduledDrains(s)
    // Undo pressed; its steps are still to come.
    await s.t.run((ctx) =>
      ctx.db.patch(importId, { undoneAt: Date.now(), undoState: 'running' }),
    )
    vi.setSystemTime(Date.now() + 6 * SECOND)
    await drainNow(s, connection._id)
    for (const name of names) {
      expect(s.xero.named(ORG.coastal, name)).toEqual([])
    }

    await s.t.mutation(internal.clientImports.undoStep, { importId })
    await settle(s)
    expect(s.xero.named(ORG.coastal, 'Una Undo')).toHaveLength(1)
    expect(await link(s, una)).toMatchObject({
      state: 'linked',
      how: 'created',
    })
    for (const name of ['Ula Undo', 'Uma Undo']) {
      expect(s.xero.named(ORG.coastal, name)).toEqual([])
    }
    expect(await outbox(s)).toEqual([])
  })

  test('a member who leaves: their Xero gets nothing more, and keeps what it has', async () => {
    const s = await setup()
    const { book } = await syncing(s)
    const kevins = await connect(s, s.kevin, {
      kind: 'member',
      xeroUserId: XU.kevin,
      tenantId: ORG.kevin,
    })
    await startSyncing(s, s.kevin, kevins._id)
    await settle(s)
    const held = s.xero.contactsOf(ORG.kevin).map((c) => ({ ...c }))
    expect(held.length).toBeGreaterThanOrEqual(8)

    await edit(s, book.patel, { email: 'raj.queued@patel.test' })
    await s.terence.as.mutation(api.team.remove, {
      businessId: s.businessId,
      membershipId: s.kevinId,
    })
    await settle(s)
    expect((await connectionRow(s, kevins._id)).status).toBe('disconnected')
    expect(
      (await outbox(s)).filter((r) => r.connectionId === kevins._id),
    ).toEqual([])

    const calls = s.xero
      .accountingRequests()
      .filter((r) => r.headers['xero-tenant-id'] === ORG.kevin).length
    await edit(s, book.patel, { email: 'raj.after@patel.test' })
    await newClient(s, { name: 'After Kevin', suburb: 'Ardross' })
    await settle(s)
    expect(
      (await outbox(s)).filter((r) => r.connectionId === kevins._id),
    ).toEqual([])
    expect(
      s.xero
        .accountingRequests()
        .filter((r) => r.headers['xero-tenant-id'] === ORG.kevin),
    ).toHaveLength(calls)
    expect(s.xero.contactsOf(ORG.kevin)).toHaveLength(held.length)
    // The business's own carries on.
    expect((await contactOf(s, book.patel)).EmailAddress).toBe(
      'raj.after@patel.test',
    )
  })
})

/** How many the undo dialog says are in Xero, whatever shape it comes in. */
function countIn(note: unknown): number {
  if (typeof note === 'number') return note
  if (note && typeof note === 'object') {
    const numbers = Object.values(note).filter(
      (value): value is number => typeof value === 'number',
    )
    if (numbers.length === 1) return numbers[0]
    const named = note as Record<string, unknown>
    for (const key of ['inXero', 'count', 'n', 'clients']) {
      const value = named[key]
      if (typeof value === 'number') return value
    }
  }
  throw new Error(`no count in ${JSON.stringify(note)}`)
}

// ══════════════════════════════════════════════════════ every organisation

describe('every connected organisation', () => {
  test('the business’s Xero and two members’ own each get the whole book, each call naming its own organisation', async () => {
    const s = await setup()
    const book = await addBook(s, {
      ava: { name: 'Ava Adams', clientNumber: 1, email: 'ava@adams.test' },
      ben: { name: 'Ben Brooks', clientNumber: 2 },
      cal: { name: 'Cal Cole', clientNumber: 3 },
    })
    const coastal = await connect(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    const kevins = await connect(s, s.kevin, {
      kind: 'member',
      xeroUserId: XU.kevin,
      tenantId: ORG.kevin,
    })
    const jos = await connect(s, s.jo, {
      kind: 'member',
      xeroUserId: XU.jo,
      tenantId: ORG.jo,
    })
    await startSyncing(s, s.terence, coastal._id)
    await startSyncing(s, s.kevin, kevins._id)
    await startSyncing(s, s.jo, jos._id)
    await settle(s)

    for (const tenantId of [ORG.coastal, ORG.kevin, ORG.jo]) {
      expect(
        s.xero
          .contactsOf(tenantId)
          .map((c) => c.name)
          .sort(),
      ).toEqual(['Ava Adams', 'Ben Brooks', 'Cal Cole'])
      for (const clientId of Object.values(book)) {
        expect(await link(s, clientId, tenantId)).toMatchObject({
          state: 'linked',
          how: 'created',
        })
      }
    }

    // One new client: one create in each, each to its own organisation.
    const from = s.xero.requests.length
    await newClient(s, { name: 'Nora New', suburb: 'Applecross' })
    await settle(s)
    const puts = written(s, from).filter(
      ({ r, e }) => r.method === 'PUT' && e.Name === 'Nora New',
    )
    expect(puts.map(({ r }) => r.headers['xero-tenant-id']).sort()).toEqual(
      [ORG.coastal, ORG.jo, ORG.kevin].sort(),
    )
    for (const tenantId of [ORG.coastal, ORG.kevin, ORG.jo]) {
      expect(s.xero.named(tenantId, 'Nora New')).toHaveLength(1)
      expect(s.xero.mostAtOnce(tenantId)).toBe(1)
    }

    // Each sees its own line; the owner, the business's.
    const nora = (
      await s.t.run((ctx) => ctx.db.query('clients').collect())
    ).find((c) => c.name === 'Nora New')!._id
    expect(
      (await linesOf(s, s.terence, nora)).map((l) => l.connectionId),
    ).toEqual([coastal._id])
    expect(
      (await linesOf(s, s.kevin, nora)).map((l) => l.connectionId),
    ).toEqual([kevins._id])
    expect((await linesOf(s, s.jo, nora)).map((l) => l.connectionId)).toEqual([
      jos._id,
    ])
  }, 30_000)

  test('one organisation in two businesses is written by one drain at a time', async () => {
    const s = await setup()
    const { book } = await syncing(s)
    const { businessId: north } = await createBusiness(
      s.t,
      s.terence,
      'Coastal Pest North',
    )
    const nora = await addClient(
      s,
      {
        name: 'Nora North',
        clientNumber: 1,
        site: { addressLine: '1 North Road', suburb: 'Hillarys' },
      },
      north,
    )
    const northern = await connect(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
      businessId: north,
    })
    await startSyncing(s, s.terence, northern._id, north)
    await settle(s)
    await cron(s)
    expect(s.xero.named(ORG.coastal, 'Nora North')).toHaveLength(1)

    // Coastal's drain is at Xero, holding the organisation…
    await edit(s, book.patel, { email: 'raj.held@patel.test' })
    let first = true
    const held = s.xero.holdRequests((r) => {
      if (!first || r.headers['xero-tenant-id'] !== ORG.coastal) return false
      first = false
      return true
    })
    await reachXero(held)
    const heldAt = s.xero.requests.length

    // …when North's comes due: it asks Xero nothing.
    await edit(s, nora, { email: 'nora@north.test' }, north)
    vi.setSystemTime(Date.now() + 6 * SECOND)
    await pumped(
      s.t.action(internal.xeroSync.drain, { connectionId: northern._id }),
    )
    expect(
      s.xero.requests.slice(heldAt).filter((r) => r.host === 'api.xero.com'),
    ).toEqual([])

    held.release()
    await settle(s)
    await cron(s)

    expect((await contactOf(s, book.patel)).EmailAddress).toBe(
      'raj.held@patel.test',
    )
    expect((await contactOf(s, nora, ORG.coastal, north)).EmailAddress).toBe(
      'nora@north.test',
    )
    expect(s.xero.mostAtOnce(ORG.coastal)).toBe(1)
  }, 30_000)
})

// ══════════════════════════════════════════════════════════════════ guards

describe('guards', () => {
  test('a deployment not set up for Xero: client writes queue nothing, schedule nothing and call nothing', async () => {
    const t = testApp()
    const xero = fakeXero({ configured: false })
    const terence = await createActor(t, { email: 'terence@coastal.test' })
    const { businessId, ownerMembershipId } = await createBusiness(t, terence)

    const propertyId = await terence.as.mutation(api.properties.create, {
      businessId,
      clientName: 'Una Configured',
      addressLine: '1 Test Street',
      suburb: 'Perth',
      state: 'WA',
      postcode: '6000',
    })
    const clientId = (await t.run((ctx) => ctx.db.get(propertyId)))!.clientId
    await terence.as.mutation(api.clients.update, {
      businessId,
      clientId,
      email: 'una@configured.test',
    })
    await terence.as.mutation(api.clientContacts.create, {
      businessId,
      clientId,
      name: 'Someone',
    })
    await terence.as.mutation(api.jobs.create, {
      businessId,
      propertyId,
      assignedMembershipId: ownerMembershipId,
      jobType: 'General Pest',
      price: 18000,
      scheduledAt: Date.now() + DAY,
      durationMinutes: 60,
    })
    const entryId = await terence.as.mutation(api.bin.deleteClient, {
      businessId,
      clientId,
    })
    await terence.as.mutation(api.bin.restore, { businessId, entryId })
    await t.finishAllScheduledFunctions(vi.runAllTimers)

    expect(await t.run((ctx) => ctx.db.query('xeroOutbox').collect())).toEqual(
      [],
    )
    expect(
      (
        await t.run((ctx) =>
          ctx.db.system.query('_scheduled_functions').collect(),
        )
      ).filter((job) => job.name.startsWith('xeroSync')),
    ).toEqual([])
    expect(xero.requests).toEqual([])
    await t.mutation(internal.xeroSync.reconcile, {})
    expect(xero.requests).toEqual([])
  })

  test('the kill switch: changes queue and nothing is sent; switched off, the reconciler sends them', async () => {
    const s = await setup()
    const { book, connection } = await syncing(s)
    const contactId = (await link(s, book.patel)).xeroContactId!
    const calls = s.xero.accountingRequests().length

    vi.stubEnv('XERO_SYNC_PAUSED', 'on')
    expect(
      (await s.terence.as.query(api.xero.status, { businessId: s.businessId }))
        .paused,
    ).toBe(true)
    await edit(s, book.patel, { email: 'raj.paused@patel.test' })
    await newClient(s, { name: 'Paula Paused', suburb: 'Kensington' })
    expect(await outbox(s)).toHaveLength(2)
    await settle(s)
    await s.t.action(internal.xeroSync.drain, { connectionId: connection._id })
    await cron(s)
    expect(s.xero.accountingRequests()).toHaveLength(calls)
    expect(await outbox(s)).toHaveLength(2)

    vi.stubEnv('XERO_SYNC_PAUSED', '')
    await cron(s)
    expect(s.xero.view(contactId).EmailAddress).toBe('raj.paused@patel.test')
    expect(s.xero.named(ORG.coastal, 'Paula Paused')).toHaveLength(1)
    expect(await outbox(s)).toEqual([])
  })

  test('the demo business sends nothing', async () => {
    const s = await setup()
    const { book, connection } = await syncing(s)
    const calls = s.xero.accountingRequests().length

    await s.t.run((ctx) => ctx.db.patch(s.businessId, { plan: DEMO_PLAN }))
    await edit(s, book.patel, { email: 'raj.demo@patel.test' })
    await settle(s)
    await drainNow(s, connection._id)
    await cron(s)

    expect(s.xero.accountingRequests()).toHaveLength(calls)
  })
})

// ═════════════════════════════════════════════════════════════ reconciler

describe('a drain that runs long, or is told to stop', () => {
  test('a page that runs longer than the lease keeps the organisation: the reconciler starts no second drain beside it', async () => {
    const s = await setup()
    const { book, connection } = await syncing(s)
    quietly()
    // A rename onto a name Xero has: a read, a refused write, a suffixed
    // one — each two minutes slow, six minutes in all.
    await edit(s, book.patel, { name: 'Linh Nguyen' })
    await dropScheduledDrains(s)
    vi.setSystemTime(Date.now() + 6 * SECOND)
    let calls = 0
    let alongside: number | null = null
    const stop = s.xero.onRequest(async (r) => {
      if (
        r.headers['xero-tenant-id'] !== ORG.coastal ||
        !r.path.startsWith('/api.xro/')
      ) {
        return
      }
      calls += 1
      if (calls < 3) {
        await new Promise((resolve) => setTimeout(resolve, 2 * MINUTE))
      } else if (calls === 3) {
        // Five and a half minutes after the drain took the organisation.
        await new Promise((resolve) => setTimeout(resolve, 90 * SECOND))
        alongside = (await s.t.mutation(internal.xeroSync.reconcile, {}))
          .scheduled
      }
    })
    await drainNow(s, connection._id)
    stop()

    expect(calls).toBeGreaterThanOrEqual(3)
    expect(alongside).toBe(0)
    expect((await contactOf(s, book.patel)).Name).toBe(
      'Linh Nguyen (Mirrabooka)',
    )
  })

  test('a drain that loses the organisation mid-page asks for another, rather than leaving its changes for the reconciler', async () => {
    const s = await setup()
    const { book, connection } = await syncing(s)
    quietly()
    const contactId = (await link(s, book.patel)).xeroContactId!
    await edit(s, book.patel, { email: 'raj.later@patel.test' })
    await dropScheduledDrains(s)
    vi.setSystemTime(Date.now() + 6 * SECOND)
    // Someone else takes the organisation while this drain reads Xero.
    let taken = false
    const stop = s.xero.onRequest(async (r) => {
      if (taken || r.method !== 'GET' || !r.query.has('IDs')) return
      taken = true
      await s.t.run(async (ctx) => {
        const row = await ctx.db
          .query('xeroSyncState')
          .withIndex('by_connection', (q) =>
            q.eq('connectionId', connection._id),
          )
          .unique()
        await ctx.db.patch(row!._id, {
          lease: { holder: 'someone-else', until: Date.now() + MINUTE },
        })
      })
    })
    await drainNow(s, connection._id)
    stop()
    expect(taken).toBe(true)
    expect(s.xero.view(contactId).EmailAddress).toBe('raj@patel.test')
    expect(
      (await scheduledDrains(s)).filter((job) => job.state.kind === 'pending'),
    ).not.toEqual([])

    await settle(s)
    expect(s.xero.view(contactId).EmailAddress).toBe('raj.later@patel.test')
  })

  test('the kill switch turned on mid-drain: nothing more is written, not even the rest of that page; switched off, it goes', async () => {
    const s = await setup()
    const { book, connection } = await syncing(s)
    quietly()
    const contactId = (await link(s, book.patel)).xeroContactId!
    await edit(s, book.patel, { email: 'raj.mid@patel.test' })
    await dropScheduledDrains(s)
    vi.setSystemTime(Date.now() + 6 * SECOND)
    const from = s.xero.requests.length
    const stop = s.xero.onRequest((r) => {
      if (r.method === 'GET' && r.query.has('IDs')) {
        vi.stubEnv('XERO_SYNC_PAUSED', 'on')
      }
    })
    await drainNow(s, connection._id)
    stop()

    expect(written(s, from)).toEqual([])
    expect(await outbox(s)).toHaveLength(1)
    await cron(s)
    expect(written(s, from)).toEqual([])

    vi.stubEnv('XERO_SYNC_PAUSED', '')
    await cron(s)
    expect(s.xero.view(contactId).EmailAddress).toBe('raj.mid@patel.test')
    expect(await outbox(s)).toEqual([])
  })

  test('disconnected mid-drain: nothing more is written to that Xero, and nothing is left queued for it', async () => {
    const s = await setup()
    const { book, connection } = await syncing(s)
    quietly()
    await edit(s, book.patel, { email: 'raj.gone@patel.test' })
    await edit(s, book.brown, { email: 'sarah.gone@brown.test' })
    await dropScheduledDrains(s)
    vi.setSystemTime(Date.now() + 6 * SECOND)
    const from = s.xero.requests.length
    let asked = false
    const stop = s.xero.onRequest(async (r) => {
      if (!asked && r.method === 'GET' && r.query.has('IDs')) {
        asked = true
        await s.terence.as.mutation(api.xero.disconnect, {
          businessId: s.businessId,
          connectionId: connection._id,
        })
      }
    })
    await drainNow(s, connection._id)
    stop()
    await settle(s)

    expect(asked).toBe(true)
    expect(written(s, from)).toEqual([])
    expect(await outbox(s)).toEqual([])
  })
})

describe('the reconciler', () => {
  test('sends what a lost schedule left waiting, and finishes a walk of the book that never ran', async () => {
    const s = await setup()
    const book = await addBook(s, STANDARD)
    s.xero.contacts(ORG.coastal, standardContacts())
    const connection = await connect(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })

    // Start syncing's drain is lost.
    await startSyncing(s, s.terence, connection._id)
    await dropScheduledDrains(s)
    await settle(s)
    expect(s.xero.contactWrites()).toEqual([])
    expect(
      (await syncStateOf(s, connection._id))?.backfillDoneAt,
    ).toBeUndefined()

    await cron(s)
    expect((await syncStateOf(s, connection._id))?.backfillDoneAt).toBeTypeOf(
      'number',
    )
    expect(s.xero.named(ORG.coastal, 'Raj Patel')).toHaveLength(1)

    // A change's drain is lost too.
    await edit(s, book.patel, { email: 'raj.lost@patel.test' })
    await dropScheduledDrains(s)
    await settle(s)
    expect(await outbox(s)).toHaveLength(1)
    await cron(s)
    expect((await contactOf(s, book.patel)).EmailAddress).toBe(
      'raj.lost@patel.test',
    )
    expect(await outbox(s)).toEqual([])

    // `kick` sends what waits, on demand.
    await edit(s, book.patel, { email: 'raj.kicked@patel.test' })
    await dropScheduledDrains(s)
    vi.setSystemTime(Date.now() + 10 * SECOND)
    await s.t.mutation(internal.xeroSync.kick, {
      connectionId: connection._id,
    })
    await settle(s)
    expect((await contactOf(s, book.patel)).EmailAddress).toBe(
      'raj.kicked@patel.test',
    )
  })

  test('leaves an organisation another run holds alone', async () => {
    const s = await setup()
    const { book, connection } = await syncing(s)
    await edit(s, book.patel, { email: 'raj.wait@patel.test' })
    await dropScheduledDrains(s)

    // Another run holds the organisation for the next five minutes.
    vi.setSystemTime(Date.now() + 2 * MINUTE)
    const stateId = (await syncStateOf(s, connection._id))!._id
    await s.t.run((ctx) =>
      ctx.db.patch(stateId, {
        lease: { holder: 'another-run', until: Date.now() + 5 * MINUTE },
      }),
    )
    const calls = s.xero.accountingRequests().length
    await s.t.mutation(internal.xeroSync.reconcile, {})
    await settleFor(s, 30 * SECOND)
    expect(s.xero.accountingRequests()).toHaveLength(calls)
    expect((await syncStateOf(s, connection._id))?.lease?.holder).toBe(
      'another-run',
    )

    await s.t.run((ctx) => ctx.db.patch(stateId, { lease: undefined }))
    await cron(s)
    expect((await contactOf(s, book.patel)).EmailAddress).toBe(
      'raj.wait@patel.test',
    )
  })

  test('runs every ten minutes, at five past', () => {
    const jobs = (
      crons as unknown as {
        crons: Record<string, { name: string; schedule: unknown }>
      }
    ).crons
    expect(jobs['send waiting Xero changes']).toMatchObject({
      name: 'xeroSync:reconcile',
      schedule: { type: 'cron', cron: '5,15,25,35,45,55 * * * *' },
    })
  })
})

// ══════════════════════════════════════════════ the match, once syncing

describe('the match once syncing has started', () => {
  test('Start syncing needs a finished match less than a week old', async () => {
    const s = await setup()
    await addBook(s, STANDARD)
    s.xero.contacts(ORG.coastal, standardContacts())
    const connection = await connect(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    const stateId = (await syncStateOf(s, connection._id))!._id

    // Eight days old.
    await s.t.run(async (ctx) => {
      const state = await ctx.db.get(stateId)
      await ctx.db.patch(stateId, {
        match: { ...state!.match!, at: Date.now() - 8 * DAY },
      })
    })
    await expect(startSyncing(s, s.terence, connection._id)).rejects.toThrow(
      /MATCH_STALE/,
    )
    // Being read again.
    await s.terence.as.mutation(api.xeroMatch.rematch, {
      businessId: s.businessId,
      connectionId: connection._id,
    })
    await expect(startSyncing(s, s.terence, connection._id)).rejects.toThrow(
      /MATCH_STALE/,
    )
    expect((await connectionRow(s, connection._id)).syncStartedAt).toBe(
      undefined,
    )

    await settle(s)
    await startSyncing(s, s.terence, connection._id)
    expect((await connectionRow(s, connection._id)).syncStartedAt).toBe(
      Date.now(),
    )
  })

  test('Check Xero again is refused once syncing; a To check answered still sends, and Match again still works', async () => {
    const s = await setup()
    const { book, connection, id } = await syncing(s)

    await expect(
      s.terence.as.mutation(api.xeroMatch.rematch, {
        businessId: s.businessId,
        connectionId: connection._id,
      }),
    ).rejects.toThrow(/SYNC_STARTED/)

    // Different on Linh Nguyen: added — with her suburb, the name being the
    // other contact's.
    await decide(s, connection._id, book.nguyen, 'different')
    expect(await outbox(s)).toEqual([
      expect.objectContaining({ clientId: book.nguyen }),
    ])
    // Changed their mind before it went: Match again.
    expect(
      await s.terence.as.mutation(api.xeroMatch.reopen, {
        businessId: s.businessId,
        connectionId: connection._id,
        clientId: book.nguyen,
      }),
    ).toBe('needs_review')
    await settle(s)
    expect(s.xero.named(ORG.coastal, 'Linh Nguyen (Mirrabooka)')).toEqual([])

    await decide(s, connection._id, book.nguyen, 'different')
    await settle(s)
    expect((await contactOf(s, book.nguyen)).Name).toBe(
      'Linh Nguyen (Mirrabooka)',
    )
    expect(s.xero.view(id('Linh Nguyen')).Name).toBe('Linh Nguyen')
  })
})

// ═════════════════════════════════════════════════════════════════ who may

describe('who may start, override and see', () => {
  test('the business’s Xero is the owner’s: nobody else starts it, overrides it, or sees its line', async () => {
    const s = await setup()
    await addBook(s, STANDARD)
    s.xero.contacts(ORG.coastal, standardContacts())
    const connection = await connect(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })

    for (const who of [s.kevin, s.jo]) {
      await expect(startSyncing(s, who, connection._id)).rejects.toThrow(
        /NO_ACCESS/,
      )
    }
    expect((await connectionRow(s, connection._id)).syncStartedAt).toBe(
      undefined,
    )
    expect(await audits(s, 'xero.start')).toEqual([])
    expect(await scheduledDrains(s)).toEqual([])

    await startSyncing(s, s.terence, connection._id)
    await settle(s)
    const smith = (
      await s.t.run((ctx) => ctx.db.query('clients').collect())
    ).find((c) => c.name === 'John Smith')!._id
    s.xero.editInXero((await link(s, smith)).xeroContactId!, {
      email: 'js@smith.test',
    })
    await edit(s, smith, { email: 'john.smith@smith.test' })
    await settle(s)
    expect((await link(s, smith)).different).toEqual(['email'])

    for (const who of [s.kevin, s.jo]) {
      await expect(
        who.as.mutation(api.xeroSync.overwrite, {
          businessId: s.businessId,
          connectionId: connection._id,
          clientId: smith,
        }),
      ).rejects.toThrow(/NO_ACCESS/)
      // No line of the business's for them: they have none of their own.
      expect(await linesOf(s, who, smith)).toEqual([])
    }
    expect((await link(s, smith)).different).toEqual(['email'])
    expect(await outbox(s)).toEqual([])
    expect(await audits(s, 'xero.overwrite')).toEqual([])
  })

  test('a member’s own Xero is theirs: not the owner’s to start, override or see', async () => {
    const s = await setup()
    const book = await addBook(s, {
      ava: { name: 'Ava Adams', clientNumber: 1, email: 'ava@adams.test' },
    })
    s.xero.contacts(ORG.kevin, [{ name: 'Ava Adams', email: 'ava@adams.test' }])
    const kevins = await connect(s, s.kevin, {
      kind: 'member',
      xeroUserId: XU.kevin,
      tenantId: ORG.kevin,
    })

    for (const who of [s.terence, s.jo]) {
      await expect(startSyncing(s, who, kevins._id)).rejects.toThrow(
        /NO_ACCESS/,
      )
    }
    expect((await connectionRow(s, kevins._id)).syncStartedAt).toBe(undefined)

    await startSyncing(s, s.kevin, kevins._id)
    await settle(s)
    const contactId = (await link(s, book.ava, ORG.kevin)).xeroContactId!
    s.xero.editInXero(contactId, { email: 'ava@kevins-books.test' })
    await edit(s, book.ava, { email: 'ava.adams@adams.test' })
    await settle(s)
    expect((await link(s, book.ava, ORG.kevin)).different).toEqual(['email'])

    for (const who of [s.terence, s.jo]) {
      await expect(
        who.as.mutation(api.xeroSync.overwrite, {
          businessId: s.businessId,
          connectionId: kevins._id,
          clientId: book.ava,
        }),
      ).rejects.toThrow(/NO_ACCESS/)
      expect(
        (await linesOf(s, who, book.ava)).map((l) => l.connectionId),
      ).not.toContain(kevins._id)
    }
    expect((await link(s, book.ava, ORG.kevin)).different).toEqual(['email'])

    // Kevin may.
    expect(
      (await linesOf(s, s.kevin, book.ava)).map((l) => l.connectionId),
    ).toEqual([kevins._id])
    await s.kevin.as.mutation(api.xeroSync.overwrite, {
      businessId: s.businessId,
      connectionId: kevins._id,
      clientId: book.ava,
    })
    await settle(s)
    expect(s.xero.view(contactId).EmailAddress).toBe('ava.adams@adams.test')
  })

  test('not while working in someone else’s account', async () => {
    const s = await setup()
    await addBook(s, STANDARD)
    s.xero.contacts(ORG.coastal, standardContacts())
    s.xero.contacts(ORG.kevin, [])
    const connection = await connect(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    const kevins = await connect(s, s.kevin, {
      kind: 'member',
      xeroUserId: XU.kevin,
      tenantId: ORG.kevin,
    })

    await s.terence.as.mutation(api.accountSwitches.start, {
      businessId: s.businessId,
      targetMembershipId: s.kevinId,
    })
    for (const target of [connection._id, kevins._id]) {
      await expect(startSyncing(s, s.terence, target)).rejects.toThrow(
        /NO_ACCESS|SWITCHED/,
      )
    }
    for (const target of [connection._id, kevins._id]) {
      expect((await connectionRow(s, target)).syncStartedAt).toBe(undefined)
    }
  })

  test('another business’s connection or client is NOT_FOUND', async () => {
    const s = await setup()
    const { book, connection } = await syncing(s)
    const mia = await createActor(s.t, {
      email: 'mia@harbour.test',
      name: 'Mia',
    })
    const harbour = await createBusiness(s.t, mia, 'Harbour Pest')
    const theirClient = await addClient(
      s,
      { name: 'Tom Harbour', clientNumber: 1 },
      harbour.businessId,
    )
    s.xero.contacts(ORG.harbour, [])
    const theirs = await connect(s, mia, {
      kind: 'business',
      xeroUserId: XU.mia,
      tenantId: ORG.harbour,
      businessId: harbour.businessId,
    })
    const hers = harbour.businessId

    // Mia, naming Coastal Pest's connection or client from her business…
    await expect(startSyncing(s, mia, connection._id, hers)).rejects.toThrow(
      /NOT_FOUND/,
    )
    await expect(
      mia.as.mutation(api.xeroSync.overwrite, {
        businessId: hers,
        connectionId: connection._id,
        clientId: book.patel,
      }),
    ).rejects.toThrow(/NOT_FOUND/)
    await noLines(linesOf(s, mia, book.patel, hers))
    // …or from Coastal Pest, where she is nobody.
    await expect(linesOf(s, mia, book.patel)).rejects.toThrow(
      /NO_ACCESS|NOT_FOUND/,
    )

    // Terence, naming hers.
    await expect(startSyncing(s, s.terence, theirs._id)).rejects.toThrow(
      /NOT_FOUND/,
    )
    await noLines(linesOf(s, s.terence, theirClient))
    expect((await connectionRow(s, theirs._id)).syncStartedAt).toBe(undefined)
  })
})

// ══════════════════════════════════════════════════════════════════ tools

describe('tools', () => {
  test('a dry run writes nothing — to Xero or here', async () => {
    const s = await setup()
    await addBook(s, STANDARD)
    s.xero.contacts(ORG.coastal, standardContacts())
    const connection = await connect(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    quietly()
    const before = await s.t.run(async (ctx) => ({
      links: await ctx.db.query('xeroContactLinks').collect(),
      outbox: await ctx.db.query('xeroOutbox').collect(),
      connection: await ctx.db.get(connection._id),
    }))

    await pumped(
      s.t.action(internal.xeroSync.dryRun, { connectionId: connection._id }),
    )

    expect(s.xero.contactWrites()).toEqual([])
    expect(
      s.xero.accountingRequests().filter((r) => r.method !== 'GET'),
    ).toEqual([])
    expect(
      await s.t.run(async (ctx) => ({
        links: await ctx.db.query('xeroContactLinks').collect(),
        outbox: await ctx.db.query('xeroOutbox').collect(),
        connection: await ctx.db.get(connection._id),
      })),
    ).toEqual(before)
  })

  test('resyncAll walks the book again and sends nothing unchanged — even with what was sent forgotten', async () => {
    const s = await setup()
    const { connection } = await syncing(s)
    const contacts = s.xero
      .contactsOf(ORG.coastal)
      .map((c) => s.xero.view(c.contactId))
    const writes = s.xero.contactWrites().length

    await s.t.mutation(internal.xeroSync.resyncAll, {
      connectionId: connection._id,
    })
    expect(
      (await syncStateOf(s, connection._id))?.backfillDoneAt,
    ).toBeUndefined()
    await cron(s)
    expect((await syncStateOf(s, connection._id))?.backfillDoneAt).toBeTypeOf(
      'number',
    )

    await s.t.mutation(internal.xeroSync.resyncAll, {
      connectionId: connection._id,
      force: true,
    })
    await cron(s)

    expect(s.xero.contactWrites()).toHaveLength(writes)
    expect(
      s.xero.contactsOf(ORG.coastal).map((c) => s.xero.view(c.contactId)),
    ).toEqual(contacts)
  })

  test('resyncAll with force keeps what is Different in Xero, and what the bookkeeper changed there stays theirs', async () => {
    const s = await setup()
    const { book, connection, id } = await syncing(s)
    const smithId = id('Smith, John')
    const brownId = id('Sarah Brown')
    s.xero.editInXero(smithId, { email: 'accounts@smith.test' })
    await edit(s, book.smith, { email: 'john@smithfamily.test' })
    await settle(s)
    expect((await link(s, book.smith)).different).toEqual(['email'])
    // Changed in Xero, where PestM8 has changed nothing yet.
    s.xero.editInXero(brownId, { email: 'accounts@brown.test' })

    await s.t.mutation(internal.xeroSync.resyncAll, {
      connectionId: connection._id,
      force: true,
    })
    await settle(s)
    expect((await link(s, book.smith)).different).toEqual(['email'])
    expect((await lineOf(s, book.smith)).state).toBe('different')

    await edit(s, book.smith, { email: 'john@another.test' })
    await edit(s, book.brown, { email: 'sarah@another.test' })
    await settle(s)
    expect(s.xero.view(smithId).EmailAddress).toBe('accounts@smith.test')
    expect(s.xero.view(brownId).EmailAddress).toBe('accounts@brown.test')
    expect((await link(s, book.brown)).different).toEqual(['email'])
  })

  test('recount puts the tallies right', async () => {
    const s = await setup()
    const { book, connection, id } = await syncing(s)
    s.xero.archive(id('Sarah Brown'))
    await edit(s, book.brown, { email: 'sarah@moved.test' })
    await settle(s)
    const counts = (await syncStateOf(s, connection._id))!.counts!
    expect(counts).toMatchObject({ inXero: 6, review: 1, stopped: 1 })

    const stateId = (await syncStateOf(s, connection._id))!._id
    await s.t.run((ctx) =>
      ctx.db.patch(stateId, {
        counts: {
          inXero: 0,
          review: 0,
          different: 0,
          failed: 0,
          stopped: 0,
          waiting: 0,
        },
      }),
    )
    await s.t.mutation(internal.xeroSync.recount, {
      connectionId: connection._id,
    })
    const { waiting: _w, ...recounted } = (await syncStateOf(
      s,
      connection._id,
    ))!.counts!
    const { waiting: _x, ...kept } = counts
    expect(recounted).toEqual(kept)
  })
})

// ═════════════════════════════════════════════ the fake, held to Xero's rules

/**
 * test/fakeXero.ts plays Xero for every test above, so its rules for writes
 * are checked here on their own: if the fake were lenient, a sync that
 * would duplicate or wipe something in the real Xero could pass.
 */
describe('the fake Xero these tests run against', () => {
  async function signedIn() {
    const xero = fakeXero()
    const code = xero.consent({ xeroUserId: 'xu-fake', tenantId: ORG.coastal })
    const answer = await fetch('https://identity.xero.com/connect/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${XERO_TEST_CLIENT_ID}:${XERO_TEST_CLIENT_SECRET}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: TEST_REDIRECT_URI,
      }).toString(),
    })
    const { access_token: token } = (await answer.json()) as {
      access_token: string
    }
    const call = async (
      method: 'GET' | 'PUT' | 'POST',
      query: string,
      body?: unknown,
      key?: string,
    ) => {
      const res = await fetch(
        `https://api.xero.com/api.xro/2.0/Contacts?${query}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            'xero-tenant-id': ORG.coastal,
            ...(body === undefined
              ? {}
              : { 'Content-Type': 'application/json' }),
            ...(key ? { 'Idempotency-Key': key } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      )
      return {
        status: res.status,
        body: (await res.json()) as { Contacts?: Array<XeroContactView> },
      }
    }
    return { xero, call }
  }

  test('a name is one ACTIVE contact’s: a clash is a per-item error in Xero’s words, the rest of the batch saved — or, summarised, nothing saved', async () => {
    const { xero, call } = await signedIn()
    xero.contacts(ORG.coastal, [{ name: 'Tom Jones' }])

    const perItem = await call('PUT', 'summarizeErrors=false', {
      Contacts: [{ Name: 'tom jones' }, { Name: 'Ann Lee' }],
    })
    expect(perItem.status).toBe(200)
    const [clash, saved] = perItem.body.Contacts!
    expect(clash).toMatchObject({
      ContactID: ZERO_CONTACT_ID,
      ValidationErrors: [
        {
          Message:
            'The contact name tom jones is already assigned to another contact. The contact name must be unique across all active contacts.',
        },
      ],
    })
    expect(saved).toMatchObject({ Name: 'Ann Lee', ContactStatus: 'ACTIVE' })

    const summarised = await call('PUT', '', {
      Contacts: [{ Name: 'Tom Jones' }, { Name: 'Cal Cole' }],
    })
    expect(summarised.status).toBe(400)
    expect(xero.named(ORG.coastal, 'Cal Cole')).toEqual([])
    // An archived one's name is free.
    xero.archive(xero.named(ORG.coastal, 'Tom Jones')[0].contactId)
    expect(
      (
        await call('PUT', 'summarizeErrors=false', {
          Contacts: [{ Name: 'Tom Jones' }],
        })
      ).body.Contacts![0].ContactStatus,
    ).toBe('ACTIVE')
  })

  test('an update must name its contact; a list sent replaces the list; an archived contact stays archived', async () => {
    const { xero, call } = await signedIn()
    const [smith] = xero.contacts(ORG.coastal, [
      {
        name: 'John Smith',
        phone: { areaCode: '08', number: '9345 6789' },
        contactPersons: [{ FirstName: 'Accounts' }],
      },
    ])

    expect(
      (
        await call('POST', 'summarizeErrors=false', {
          Contacts: [{ Name: 'X' }],
        })
      ).status,
    ).toBe(400)

    await call('POST', 'summarizeErrors=false', {
      Contacts: [
        {
          ContactID: smith.contactId,
          Phones: [{ PhoneType: 'MOBILE', PhoneNumber: '0412 345 678' }],
          ContactPersons: [{ FirstName: 'Sam' }],
        },
      ],
    })
    const after = xero.view(smith.contactId)
    expect(phoneIn(after, 'MOBILE')).toBe('0412345678')
    expect(phoneIn(after, 'DEFAULT')).toBe('')
    expect(after.ContactPersons).toEqual([{ FirstName: 'Sam' }])

    xero.archive(smith.contactId)
    await call('POST', 'summarizeErrors=false', {
      Contacts: [{ ContactID: smith.contactId, EmailAddress: 'j@s.test' }],
    })
    expect(xero.view(smith.contactId)).toMatchObject({
      ContactStatus: 'ARCHIVED',
      EmailAddress: 'j@s.test',
    })
    // Listed by id only when archived ones are asked for.
    expect((await call('GET', `IDs=${smith.contactId}`)).body.Contacts).toEqual(
      [],
    )
    expect(
      (await call('GET', `IDs=${smith.contactId}&includeArchived=true`)).body
        .Contacts,
    ).toHaveLength(1)
  })

  test('an Idempotency-Key answers the same request from the first answer for six minutes, refuses a different one, and is forgotten after', async () => {
    const { xero, call } = await signedIn()
    const key = 'a'.repeat(128)
    const create = { Contacts: [{ Name: 'Ivy Once' }] }

    const first = await call('PUT', 'summarizeErrors=false', create, key)
    const again = await call('PUT', 'summarizeErrors=false', create, key)
    expect(again).toEqual(first)
    expect(xero.named(ORG.coastal, 'Ivy Once')).toHaveLength(1)
    expect(
      (
        await call(
          'PUT',
          'summarizeErrors=false',
          { Contacts: [{ Name: 'Ivy Twice' }] },
          key,
        )
      ).status,
    ).toBe(400)
    expect(
      (await call('PUT', 'summarizeErrors=false', create, 'b'.repeat(129)))
        .status,
    ).toBe(400)

    vi.setSystemTime(Date.now() + 6 * MINUTE + SECOND)
    const later = await call('PUT', 'summarizeErrors=false', create, key)
    expect(later.body.Contacts![0].ContactID).toBe(ZERO_CONTACT_ID)
    expect(xero.named(ORG.coastal, 'Ivy Once')).toHaveLength(1)
  })
})

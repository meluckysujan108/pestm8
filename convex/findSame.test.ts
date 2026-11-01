/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ConvexError } from 'convex/values'
import { api } from './_generated/api'
import schema from './schema'
import {
  createActor,
  createBusiness,
  joinBusiness,
  testApp,
} from '../test/harness'
import { addDaysToKey, todayKeyInZone, zonedDateTimeToUtc } from './lib/dates'
import { requireActor } from './lib/actor'
import {
  automaticMoveOf,
  automaticSeriesMoveOf,
  backstop,
  proposedOf,
} from './lib/findSame'
import type { FunctionArgs } from 'convex/server'
import type { Value } from 'convex/values'
import type { Doc, Id, TableNames } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import type { ActorEnvelope } from './lib/actor'
import type { TestActor } from '../test/harness'

/**
 * The server's backstop when a booking or a new client saves
 * (lib/findSame.ts): is the new client someone already in the book
 * (MATCHED_CLIENT), is the address already booked that week (SITE_BOOKED),
 * or does it already repeat (SITE_REPEATS)?
 *
 * Asked only when the call sends `matchCheck` or `siteCheck`, so every
 * screen that sends neither books as before. With the sheet open, only a
 * Same match the person didn't book past refuses; with nobody there (a
 * booking a phone sends later), only the automatic rule does. A refusal
 * writes nothing at all, names only clients the caller may see, and carries
 * no stored number, email or address. Whatever the caller may know of the
 * team's numbers decides what is left out, exactly as on their phone, so
 * no outcome says whether a number is a team member's.
 */

const TZ = 'Australia/Perth'
const HOUR = 60 * 60 * 1000

/** A time on a day `offset` days from today, in the business's own zone:
 * a fixed hour, so no test depends on the hour it runs at. */
const on = (offset: number, hh = 9, mm = 0) =>
  zonedDateTimeToUtc(addDaysToKey(todayKeyInZone(TZ), offset), hh, mm, TZ)

beforeEach(() => {
  // The business syncs to Xero, so a refusal that queued a client would
  // show. Paused, so nothing is sent and what was queued stays to read.
  vi.stubEnv('XERO_CLIENT_ID', 'test-client-id')
  vi.stubEnv('XERO_CLIENT_SECRET', 'test-client-secret')
  vi.stubEnv('XERO_TOKEN_KEYS', '1:test-key')
  vi.stubEnv('XERO_SYNC_PAUSED', 'on')
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

type Address = {
  addressLine: string
  suburb: string
  state: string
  postcode: string
}

const WATTLE: Address = {
  addressLine: '12 Wattle St',
  suburb: 'Bayswater',
  state: 'WA',
  postcode: '6053',
}
const elm = (n: number, suburb = 'Bayswater'): Address => ({
  addressLine: `${n} Elm St`,
  suburb,
  state: 'WA',
  postcode: '6053',
})

type ClientSpec = {
  name: string
  kind?: 'person' | 'business'
  phone?: string
  email?: string
  status?: 'active' | 'lead' | 'inactive'
  archived?: boolean
  binned?: boolean
  sites?: Array<Address>
  contacts?: Array<{ name: string; phone?: string; email?: string }>
}

async function setup() {
  const t = testApp()
  const owner = await createActor(t, {
    email: 'terence@coastal.test',
    name: 'Terence',
  })
  const { businessId, ownerMembershipId } = await createBusiness(t, owner)
  const kevin = await createActor(t, {
    email: 'kevin@coastal.test',
    name: 'Kevin',
  })
  const kevinId = await joinBusiness(
    t,
    owner,
    kevin,
    businessId,
    'subcontractor',
  )
  const dana = await createActor(t, {
    email: 'dana@coastal.test',
    name: 'Dana',
  })
  const danaId = await joinBusiness(t, owner, dana, businessId, 'contractor')
  await t.run(async (ctx) => {
    const now = Date.now()
    await ctx.db.patch(businessId, {
      phone: '(08) 9272 0000',
      email: 'office@coastal.test',
    })
    await ctx.db.patch(ownerMembershipId, { phone: '0412 000 111' })
    await ctx.db.patch(kevinId, { phone: '0433 222 333' })
    await ctx.db.patch(danaId, { phone: '0455 444 555' })
    const grantId = await ctx.db.insert('xeroGrants', {
      xeroUserId: 'xu-terence',
      accessCipher: 'not-a-token',
      accessExpiresAt: now + HOUR,
      refreshCipher: 'not-a-token',
      scopes: [],
      refreshedAt: now,
      status: 'active',
    })
    await ctx.db.insert('xeroConnections', {
      businessId,
      membershipId: ownerMembershipId,
      kind: 'business',
      grantId,
      tenantId: 'tenant-coastal',
      tenantName: 'Coastal Pest Pty Ltd',
      xeroConnectionId: 'connection-coastal',
      status: 'connected',
      createdAt: now,
      connectedAt: now,
      syncStartedAt: now,
      syncStartedByMembershipId: ownerMembershipId,
    })
  })
  const base = {
    t,
    owner,
    kevin,
    dana,
    businessId,
    ownerMembershipId,
    kevinId,
    danaId,
  }
  const jane = await addClient(base, {
    name: 'Jane Nguyen',
    phone: '0412 345 678',
    email: 'jane@nguyen.test',
    sites: [WATTLE],
  })
  return { ...base, jane }
}

type Base = {
  t: ReturnType<typeof testApp>
  businessId: Id<'businesses'>
}
type Setup = Awaited<ReturnType<typeof setup>>

/** A client written as it is stored, with its sites and contact people. */
async function addClient(s: Base, spec: ClientSpec) {
  return s.t.run(async (ctx) => {
    const now = Date.now()
    const binned = spec.binned ? { deletedAt: now } : {}
    const clientId = await ctx.db.insert('clients', {
      businessId: s.businessId,
      kind: spec.kind ?? 'person',
      name: spec.name,
      ...(spec.phone ? { phone: spec.phone } : {}),
      ...(spec.email ? { email: spec.email } : {}),
      ...(spec.status ? { status: spec.status } : {}),
      ...(spec.archived ? { archivedAt: now } : {}),
      createdAt: now,
      updatedAt: now,
      ...binned,
    })
    const siteIds: Array<Id<'properties'>> = []
    for (const site of spec.sites ?? []) {
      siteIds.push(
        await ctx.db.insert('properties', {
          businessId: s.businessId,
          clientId,
          ...site,
          createdAt: now,
          ...binned,
        }),
      )
    }
    for (const contact of spec.contacts ?? []) {
      await ctx.db.insert('clientContacts', {
        businessId: s.businessId,
        clientId,
        ...contact,
        createdAt: now,
      })
    }
    return { clientId, siteId: siteIds[0], siteIds }
  })
}

type Booking = FunctionArgs<typeof api.jobs.create>
type Series = FunctionArgs<typeof api.recurrences.create>
type NewClient = NonNullable<Booking['newClient']>
/** What a booking says it saw, as `siteCheck.seen` and SITE_BOOKED's `more`
 * carry it. */
type Seen = NonNullable<Booking['siteCheck']>['seen']

/** A one-off for the owner, ten days out. */
function job(s: Setup, fields: Partial<Booking> = {}): Booking {
  return {
    businessId: s.businessId,
    assignedMembershipId: s.ownerMembershipId,
    jobType: 'General Pest Control',
    price: 20000,
    scheduledAt: on(10),
    durationMinutes: 60,
    ...fields,
  }
}

/** A quarterly series for the owner, starting ten days out. */
function series(s: Setup, fields: Partial<Series> = {}): Series {
  return {
    businessId: s.businessId,
    assignedMembershipId: s.ownerMembershipId,
    intervalCount: 3,
    intervalUnit: 'month',
    jobType: 'General Pest Control',
    price: 20000,
    anchorDate: on(10),
    durationMinutes: 60,
    ...fields,
  }
}

/** A new client as New Job's New client tab sends one. */
function typed(
  person: { name: string; phone?: string; email?: string },
  at: Address,
): NewClient {
  return {
    clientName: person.name,
    ...(person.phone ? { phone: person.phone } : {}),
    ...(person.email ? { email: person.email } : {}),
    ...at,
  }
}

const sheet = (dismissed: Array<Id<'clients'>> = []) => ({
  by: 'sheet' as const,
  dismissed,
})
const outbox = (dismissed: Array<Id<'clients'>> = []) => ({
  by: 'outbox' as const,
  dismissed,
})
const nothingSeen = { seen: [], seenSeries: [] }

/** The refusal's data: a ConvexError, nothing else. */
async function refusalOf(call: Promise<unknown>): Promise<Value> {
  const error = await call.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(ConvexError)
  return (error as ConvexError<Value>).data
}

/** Every row a booking or a new client can write, and what it schedules. */
function everything(s: Setup) {
  return s.t.run(async (ctx) => ({
    businesses: await ctx.db.query('businesses').collect(),
    clients: await ctx.db.query('clients').collect(),
    clientContacts: await ctx.db.query('clientContacts').collect(),
    properties: await ctx.db.query('properties').collect(),
    jobs: await ctx.db.query('jobs').collect(),
    jobPeople: await ctx.db.query('jobPeople').collect(),
    recurrences: await ctx.db.query('recurrences').collect(),
    notes: await ctx.db.query('notes').collect(),
    xeroOutbox: await ctx.db.query('xeroOutbox').collect(),
    auditLog: await ctx.db.query('auditLog').collect(),
    clientMatchHints: await ctx.db.query('clientMatchHints').collect(),
    scheduled: await ctx.db.system.query('_scheduled_functions').collect(),
  }))
}

function hints(s: Setup) {
  return s.t.run((ctx) => ctx.db.query('clientMatchHints').collect())
}

function clientOfJob(s: Setup, jobId: Id<'jobs'>) {
  return s.t.run(async (ctx) => {
    const found = await ctx.db.get(jobId)
    const site = found && (await ctx.db.get(found.propertyId))
    return site ? ctx.db.get(site.clientId) : null
  })
}

/** A job written as it is stored, at Jane's unless said otherwise. */
function insertJob(
  s: Setup,
  fields: Partial<Doc<'jobs'>> & { scheduledAt: number },
): Promise<Id<'jobs'>> {
  return s.t.run((ctx) =>
    ctx.db.insert('jobs', {
      businessId: s.businessId,
      propertyId: s.jane.siteId,
      assignedMembershipId: s.ownerMembershipId,
      jobType: 'General Pest Control',
      price: 20000,
      durationMinutes: 60,
      status: 'booked',
      createdAt: Date.now(),
      jobNumber: 41,
      ...fields,
    }),
  )
}

// ───────────────────────────────────────────────────────── no arguments

describe('without matchCheck or siteCheck', () => {
  test('a booking is what it was: a duplicate of a client already in the book books, and nothing more is read', async () => {
    const s = await setup()
    await insertJob(s, { scheduledAt: on(10) })
    const jobId = await s.owner.as.mutation(
      api.jobs.create,
      job(s, { newClient: typed({ name: 'Jane Nguyen' }, WATTLE) }),
    )
    expect((await clientOfJob(s, jobId))?._id).not.toBe(s.jane.clientId)
    expect(await hints(s)).toEqual([])

    const reads = await readsOf(s, s.owner, {
      newClient: typed({ name: 'Jane Nguyen' }, WATTLE),
    })
    expect(reads).toEqual([])
  })
})

// ───────────────────────────────────────────────────────── the sheet

describe('by the sheet: only a Same match not booked past refuses', () => {
  test('the same name and address is refused with the candidate, and nothing is written', async () => {
    const s = await setup()
    const before = await everything(s)
    const data = await refusalOf(
      s.owner.as.mutation(
        api.jobs.create,
        job(s, {
          newClient: typed(
            { name: 'Jane Nguyen', phone: '0499 000 123' },
            WATTLE,
          ),
          matchCheck: sheet(),
          siteCheck: nothingSeen,
        }),
      ),
    )
    expect(data).toEqual({
      code: 'MATCHED_CLIENT',
      candidates: [
        {
          clientId: s.jane.clientId,
          name: 'Jane Nguyen',
          suburb: 'Bayswater',
          propertyId: s.jane.siteId,
          evidence: ['name', 'site'],
          auto: false,
        },
      ],
    })
    // No client, no number advanced, no Xero queue entry, no audit row, no
    // hint, nothing scheduled.
    expect(await everything(s)).toEqual(before)
    // And none of what is stored about her: not her mobile, email or street.
    const said = JSON.stringify(data)
    for (const stored of ['0412', 'jane@nguyen.test', 'Wattle']) {
      expect(said).not.toContain(stored)
    }
  })

  test('booked past (dismissed), it books, and the possible duplicate is noted', async () => {
    const s = await setup()
    const jobId = await s.owner.as.mutation(
      api.jobs.create,
      job(s, {
        newClient: typed({ name: 'Jane Nguyen' }, WATTLE),
        matchCheck: sheet([s.jane.clientId]),
      }),
    )
    const made = await clientOfJob(s, jobId)
    expect(made?._id).not.toBe(s.jane.clientId)
    expect(await hints(s)).toMatchObject([
      {
        businessId: s.businessId,
        clientId: made?._id,
        otherClientId: s.jane.clientId,
        evidence: ['name', 'site'],
        madeBy: s.ownerMembershipId,
      },
    ])
  })

  test('a similar name with her own mobile is refused', async () => {
    const s = await setup()
    const data = await refusalOf(
      s.owner.as.mutation(
        api.jobs.create,
        job(s, {
          newClient: typed({ name: 'J Nguyen', phone: '0412 345 678' }, elm(3)),
          matchCheck: sheet(),
        }),
      ),
    )
    expect(data).toEqual({
      code: 'MATCHED_CLIENT',
      candidates: [
        {
          clientId: s.jane.clientId,
          name: 'Jane Nguyen',
          // Her first site's: the typed address isn't hers.
          suburb: 'Bayswater',
          evidence: ['nameNear', 'mobile'],
          auto: false,
        },
      ],
    })
  })

  // The phone's grade, here too (convex/lib/clientMatch.ts `tierOf`, M3): a
  // landline is the house's, so "T Lee" with Tom Lee's may be Tina. Likely,
  // so the sheet's booking goes ahead; his full name with it is refused.
  test('a landline whose name agrees only as an initial and surname books (Likely); the full name with it is refused', async () => {
    const s = await setup()
    const tom = await addClient(s, {
      name: 'Tom Lee',
      phone: '08 9272 5555',
      sites: [elm(8)],
    })
    const data = await refusalOf(
      s.owner.as.mutation(
        api.jobs.create,
        job(s, {
          newClient: typed({ name: 'Tom Lee', phone: '08 9272 5555' }, elm(10)),
          matchCheck: sheet(),
        }),
      ),
    )
    expect(data).toMatchObject({
      code: 'MATCHED_CLIENT',
      candidates: [{ clientId: tom.clientId, evidence: ['name', 'landline'] }],
    })
    // Refused, nothing was made: the landline is still his alone.
    const jobId = await s.owner.as.mutation(
      api.jobs.create,
      job(s, {
        newClient: typed({ name: 'T Lee', phone: '(08) 9272 5555' }, elm(9)),
        matchCheck: sheet(),
      }),
    )
    expect((await clientOfJob(s, jobId))?._id).not.toBe(tom.clientId)
  })

  test('an agency’s shared number or rentals@ books, and makes no hint', async () => {
    const s = await setup()
    await addClient(s, {
      name: 'Ray White Bayswater',
      kind: 'business',
      phone: '(08) 9272 1234',
      email: 'rentals@raywhite.test',
      sites: [elm(1)],
    })
    for (const name of ['Mark Owen', 'Lucy Owen']) {
      await addClient(s, { name, phone: '(08) 9272 1234', sites: [elm(2)] })
    }
    for (const [typedClient, at] of [
      [{ name: 'Tom Lee', phone: '08 9272 1234' }, elm(5)],
      [{ name: 'Tom Lee', email: 'Rentals@RayWhite.test' }, elm(6)],
    ] as const) {
      await s.owner.as.mutation(
        api.jobs.create,
        job(s, { newClient: typed(typedClient, at), matchCheck: sheet() }),
      )
    }
    expect(await hints(s)).toEqual([])
  })

  test('another name with her own mobile books (Likely), and is noted for the office', async () => {
    const s = await setup()
    const jobId = await s.owner.as.mutation(
      api.jobs.create,
      job(s, {
        newClient: typed({ name: 'Tom Nguyen', phone: '0412345678' }, elm(3)),
        matchCheck: sheet(),
      }),
    )
    expect(await hints(s)).toMatchObject([
      {
        clientId: (await clientOfJob(s, jobId))?._id,
        otherClientId: s.jane.clientId,
        evidence: ['mobile'],
      },
    ])
  })

  test('the address under another name books (Likely), and is no hint: a sold house, an agency’s site', async () => {
    const s = await setup()
    await s.owner.as.mutation(
      api.jobs.create,
      job(s, {
        newClient: typed({ name: 'Tom Lee' }, WATTLE),
        matchCheck: sheet(),
      }),
    )
    expect(await hints(s)).toEqual([])
  })

  test('the business’s own number on a client is nobody’s evidence, for anyone', async () => {
    const s = await setup()
    await addClient(s, {
      name: 'Sam Wu',
      phone: '(08) 9272 0000',
      sites: [elm(7)],
    })
    for (const [actor, assignee, at] of [
      [s.owner, s.ownerMembershipId, elm(9)],
      [s.kevin, s.kevinId, elm(10)],
    ] as const) {
      await actor.as.mutation(
        api.jobs.create,
        job(s, {
          assignedMembershipId: assignee,
          newClient: typed({ name: 'Sam Wu', phone: '9272 0000' }, at),
          matchCheck: sheet(),
        }),
      )
    }
  })

  test('a team member’s mobile on a client: left out for those who see the team, and for nobody else, so a refusal never says whose a number is', async () => {
    const s = await setup()
    // Dana's mobile, and a stranger's, each on one client.
    await addClient(s, {
      name: 'Kim Ho',
      phone: '0455 444 555',
      sites: [elm(7)],
    })
    await addClient(s, {
      name: 'Lou Ho',
      phone: '0466 123 456',
      sites: [elm(8)],
    })
    const booking = (
      assignee: Id<'memberships'>,
      name: string,
      phone: string,
    ) =>
      job(s, {
        assignedMembershipId: assignee,
        newClient: typed({ name, phone }, elm(20)),
        matchCheck: sheet(),
      })

    // Kevin doesn't see the roster: on his phone Dana's number on a client
    // is the client's, and the server answers him exactly as for a
    // stranger's.
    const kim = await refusalOf(
      s.kevin.as.mutation(
        api.jobs.create,
        booking(s.kevinId, 'Kim Ho', '0455 444 555'),
      ),
    )
    const lou = await refusalOf(
      s.kevin.as.mutation(
        api.jobs.create,
        booking(s.kevinId, 'Lou Ho', '0466 123 456'),
      ),
    )
    const shape = (data: Value) =>
      (
        data as { candidates: Array<{ evidence: unknown; auto: unknown }> }
      ).candidates.map(({ evidence, auto }) => ({ evidence, auto }))
    expect(shape(kim)).toEqual(shape(lou))
    expect(shape(kim)).toEqual([{ evidence: ['name', 'mobile'], auto: false }])

    // His own number is his own on his phone too.
    await addClient(s, {
      name: 'Kev Cousin',
      phone: '0433 222 333',
      sites: [elm(9)],
    })
    await s.kevin.as.mutation(
      api.jobs.create,
      booking(s.kevinId, 'Kev Cousin', '0433 222 333'),
    )

    // The owner sees the roster, and his phone leaves Dana's number out:
    // so does the server, and "Kim Ho" is only a name.
    await s.owner.as.mutation(
      api.jobs.create,
      booking(s.ownerMembershipId, 'Kim Ho', '0455 444 555'),
    )
  })

  test('a client in the Recycle bin is never matched', async () => {
    const s = await setup()
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.jane.clientId, { deletedAt: Date.now() })
      await ctx.db.patch(s.jane.siteId, { deletedAt: Date.now() })
    })
    await s.owner.as.mutation(
      api.jobs.create,
      job(s, {
        newClient: typed(
          { name: 'Jane Nguyen', phone: '0412 345 678' },
          WATTLE,
        ),
        matchCheck: sheet(),
        siteCheck: nothingSeen,
      }),
    )
  })

  test('a repeat is answered with what it made, before the check', async () => {
    const s = await setup()
    const sent = job(s, {
      newClient: typed({ name: 'Priya Shah', phone: '0477 100 200' }, elm(30)),
      matchCheck: sheet(),
      siteCheck: nothingSeen,
      clientRequestId: crypto.randomUUID(),
    })
    const jobId = await s.owner.as.mutation(api.jobs.create, sent)
    // Sent again because the answer never came: Priya is in the book now,
    // with this very job at her site, and the repeat still gets its job.
    expect(await s.owner.as.mutation(api.jobs.create, sent)).toBe(jobId)
  })

  test('a site added for a client who already has it is refused, and books once booked past', async () => {
    const s = await setup()
    const data = await refusalOf(
      s.owner.as.mutation(
        api.jobs.create,
        job(s, {
          newProperty: { clientId: s.jane.clientId, ...WATTLE },
          matchCheck: sheet(),
        }),
      ),
    )
    expect(data).toEqual({
      code: 'MATCHED_CLIENT',
      candidates: [
        {
          clientId: s.jane.clientId,
          name: 'Jane Nguyen',
          suburb: 'Bayswater',
          propertyId: s.jane.siteId,
          evidence: ['site'],
          auto: false,
        },
      ],
    })
    await s.owner.as.mutation(
      api.jobs.create,
      job(s, {
        newProperty: { clientId: s.jane.clientId, ...WATTLE },
        matchCheck: sheet([s.jane.clientId]),
      }),
    )
    // No new client, so nothing to note.
    expect(await hints(s)).toEqual([])
  })
})

// ───────────────────────────────────────────────────────── the outbox

describe('sent later by the outbox: only the automatic rule refuses', () => {
  test('the exact name and her own mobile: refused, for the phone to move it onto her', async () => {
    const s = await setup()
    const before = await everything(s)
    const data = await refusalOf(
      s.owner.as.mutation(
        api.jobs.create,
        job(s, {
          newClient: typed(
            { name: 'Jane Nguyen', phone: '0412 345 678' },
            elm(3),
          ),
          matchCheck: outbox(),
          siteCheck: nothingSeen,
        }),
      ),
    )
    expect(data).toEqual({
      code: 'MATCHED_CLIENT',
      candidates: [
        {
          clientId: s.jane.clientId,
          name: 'Jane Nguyen',
          suburb: 'Bayswater',
          evidence: ['name', 'mobile'],
          auto: true,
        },
      ],
    })
    expect(await everything(s)).toEqual(before)
  })

  test('the exact name and address: refused with her site, to book there', async () => {
    const s = await setup()
    const data = await refusalOf(
      s.owner.as.mutation(
        api.jobs.create,
        job(s, {
          newClient: typed({ name: 'Jane Nguyen' }, WATTLE),
          matchCheck: outbox(),
        }),
      ),
    )
    expect(data).toMatchObject({
      code: 'MATCHED_CLIENT',
      candidates: [{ propertyId: s.jane.siteId, auto: true }],
    })
  })

  test('a similar name with her mobile books as typed, and is noted (FW4)', async () => {
    const s = await setup()
    const jobId = await s.owner.as.mutation(
      api.jobs.create,
      job(s, {
        newClient: typed({ name: 'J Nguyen', phone: '0412 345 678' }, elm(3)),
        matchCheck: outbox(),
      }),
    )
    expect(await hints(s)).toMatchObject([
      {
        clientId: (await clientOfJob(s, jobId))?._id,
        otherClientId: s.jane.clientId,
        evidence: ['nameNear', 'mobile'],
      },
    ])
  })

  test('RK2 (a): the street in another suburb of the postcode books', async () => {
    const s = await setup()
    await s.owner.as.mutation(
      api.jobs.create,
      job(s, {
        newClient: typed(
          { name: 'Jane Nguyen' },
          { ...WATTLE, suburb: 'Morley' },
        ),
        matchCheck: outbox(),
      }),
    )
  })

  test('RK2 (b): a placeholder, one-word or shared name books, though the sheet would stop it', async () => {
    const s = await setup()
    await addClient(s, { name: 'The Owner', sites: [elm(13)] })
    await addClient(s, { name: 'Smithy', sites: [elm(11)] })
    await addClient(s, { name: 'Ann Lee', sites: [elm(15)] })
    await addClient(s, { name: 'Ann Lee', sites: [elm(16)] })
    // The same name and address, with the sheet open, is Same: not for a
    // placeholder, which is no name at all.
    for (const [name, at] of [
      ['Smithy', elm(11)],
      ['Ann Lee', elm(15)],
    ] as const) {
      expect(
        await refusalOf(
          s.owner.as.mutation(
            api.jobs.create,
            job(s, { newClient: typed({ name }, at), matchCheck: sheet() }),
          ),
        ),
      ).toMatchObject({ code: 'MATCHED_CLIENT' })
    }
    await s.owner.as.mutation(
      api.jobs.create,
      job(s, {
        newClient: typed({ name: 'The Owner' }, elm(13)),
        matchCheck: sheet(),
      }),
    )
    // Sent later, none of them is moved: not the name of one person.
    for (const [name, at] of [
      ['The Owner', elm(13)],
      ['Smithy', elm(11)],
      ['Ann Lee', elm(15)],
    ] as const) {
      await s.owner.as.mutation(
        api.jobs.create,
        job(s, { newClient: typed({ name }, at), matchCheck: outbox() }),
      )
    }
  })

  test('RK2 (c): an inactive or archived client books as typed', async () => {
    const s = await setup()
    await addClient(s, {
      name: 'Paul Green',
      status: 'inactive',
      phone: '0400 778 899',
      sites: [elm(7)],
    })
    await addClient(s, {
      name: 'Rita Brown',
      archived: true,
      phone: '0400 778 900',
      sites: [elm(9)],
    })
    // With the sheet open they are Same, and say why.
    expect(
      await refusalOf(
        s.owner.as.mutation(
          api.jobs.create,
          job(s, {
            newClient: typed({ name: 'Rita Brown' }, elm(9)),
            matchCheck: sheet(),
          }),
        ),
      ),
    ).toMatchObject({
      candidates: [{ name: 'Rita Brown', archived: true }],
    })
    expect(
      await refusalOf(
        s.owner.as.mutation(
          api.jobs.create,
          job(s, {
            newClient: typed({ name: 'Paul Green' }, elm(7)),
            matchCheck: sheet(),
          }),
        ),
      ),
    ).toMatchObject({
      candidates: [{ name: 'Paul Green', status: 'inactive' }],
    })
    // Sent later, neither is moved onto: they are booked as typed.
    for (const [name, at] of [
      ['Paul Green', elm(7)],
      ['Rita Brown', elm(9)],
    ] as const) {
      await s.owner.as.mutation(
        api.jobs.create,
        job(s, { newClient: typed({ name }, at), matchCheck: outbox() }),
      )
    }
  })

  test('RK2 (d): a mobile two clients hold books', async () => {
    const s = await setup()
    await addClient(s, {
      name: 'Lisa Tran',
      phone: '0499 111 222',
      sites: [elm(21)],
    })
    await addClient(s, {
      name: 'Tom Tran',
      phone: '0499 111 222',
      sites: [elm(22)],
    })
    await s.owner.as.mutation(
      api.jobs.create,
      job(s, {
        newClient: typed({ name: 'Lisa Tran', phone: '0499 111 222' }, elm(40)),
        matchCheck: outbox(),
      }),
    )
  })

  test('dismissed, the candidate is never moved onto', async () => {
    const s = await setup()
    await s.owner.as.mutation(
      api.jobs.create,
      job(s, {
        newClient: typed(
          { name: 'Jane Nguyen', phone: '0412 345 678' },
          elm(3),
        ),
        matchCheck: outbox([s.jane.clientId]),
      }),
    )
  })

  test('moved onto her (`applied`): books there, and the move is on the record', async () => {
    const s = await setup()
    const applied = {
      clientId: s.jane.clientId,
      evidence: ['name' as const, 'site' as const],
    }

    // Rewritten onto her site, as the phone does: on the audit log, whoever
    // sent it, though nobody was working in anyone else's account.
    const jobId = await s.owner.as.mutation(
      api.jobs.create,
      job(s, {
        propertyId: s.jane.siteId,
        notes: 'Caller: Jane Nguyen, 0499 000 123',
        matchCheck: { ...outbox(), applied },
        siteCheck: nothingSeen,
        scheduledAt: on(40),
      }),
    )
    const rows = await s.t.run((ctx) =>
      ctx.db
        .query('auditLog')
        .withIndex('by_entity', (q) =>
          q.eq('entityType', 'jobs').eq('entityId', jobId),
        )
        .collect(),
    )
    expect(rows).toMatchObject([
      {
        action: 'job.create',
        actorMembershipId: s.ownerMembershipId,
        meta: { matched: applied },
      },
    ])
    expect(rows[0].onBehalfOfMembershipId).toBeUndefined()

    // A move it didn't make isn't recorded as one.
    const elsewhere = await addClient(s, {
      name: 'Other Client',
      sites: [elm(50)],
    })
    const other = await s.owner.as.mutation(
      api.jobs.create,
      job(s, {
        propertyId: elsewhere.siteId,
        matchCheck: { ...outbox(), applied },
      }),
    )
    expect(
      await s.t.run((ctx) =>
        ctx.db
          .query('auditLog')
          .withIndex('by_entity', (q) =>
            q.eq('entityType', 'jobs').eq('entityId', other),
          )
          .collect(),
      ),
    ).toEqual([])
  })

  test('two sends of the same new client, one after the other: the second is refused onto the first', async () => {
    const s = await setup()
    const tom = typed({ name: 'Tom Ray', phone: '0477 000 111' }, elm(3))
    const first = await s.owner.as.mutation(
      api.jobs.create,
      job(s, { newClient: tom, matchCheck: outbox(), siteCheck: nothingSeen }),
    )
    const made = await s.t.run(async (ctx) => (await ctx.db.get(first))!)
    const data = await refusalOf(
      s.kevin.as.mutation(
        api.jobs.create,
        job(s, {
          assignedMembershipId: s.kevinId,
          newClient: tom,
          matchCheck: outbox(),
          siteCheck: nothingSeen,
        }),
      ),
    )
    expect(data).toMatchObject({
      code: 'MATCHED_CLIENT',
      candidates: [
        {
          name: 'Tom Ray',
          propertyId: made.propertyId,
          evidence: ['name', 'site', 'mobile'],
          auto: true,
        },
      ],
    })
    // Moved onto the first's site, the second finds the first's job there:
    // one client, one job, and a booking held for a look (FW1).
    expect(
      await refusalOf(
        s.kevin.as.mutation(
          api.jobs.create,
          job(s, {
            assignedMembershipId: s.kevinId,
            propertyId: made.propertyId,
            matchCheck: {
              ...outbox(),
              applied: {
                clientId: (await clientOfJob(s, first))!._id,
                evidence: ['name', 'site', 'mobile'],
              },
            },
            siteCheck: nothingSeen,
          }),
        ),
      ),
    ).toMatchObject({ code: 'SITE_BOOKED' })
  })

  test('two sends of one caller, the second typed a little differently: moved onto the first’s client by name and mobile, it waits for a look at the first’s job (FW1)', async () => {
    const s = await setup()
    const priya = { name: 'Priya Shah', phone: '0477 100 200' }
    const at = (addressLine: string) => ({ ...elm(0), addressLine })
    const first = await s.owner.as.mutation(
      api.jobs.create,
      job(s, {
        newClient: typed(priya, at('30 Wattle St')),
        matchCheck: outbox(),
        siteCheck: nothingSeen,
      }),
    )
    const firstSite = (await s.t.run((ctx) => ctx.db.get(first)))!.propertyId
    const madeId = (await clientOfJob(s, first))!._id
    // The second phone's, by her name and mobile: none of her sites is the
    // typed address, so there is no site of hers to move it to.
    expect(
      await refusalOf(
        s.owner.as.mutation(
          api.jobs.create,
          job(s, {
            newClient: typed(priya, at('30 Watle St')),
            matchCheck: outbox(),
            siteCheck: nothingSeen,
          }),
        ),
      ),
    ).toEqual({
      code: 'MATCHED_CLIENT',
      candidates: [
        {
          clientId: madeId,
          name: 'Priya Shah',
          suburb: 'Bayswater',
          evidence: ['name', 'mobile'],
          auto: true,
        },
      ],
    })
    // Rewritten as 2c-J does: a new site for her, as typed.
    const rewrite = (
      seen: Array<{ propertyId: Id<'properties'>; at: number }>,
    ) =>
      s.owner.as.mutation(
        api.jobs.create,
        job(s, {
          newProperty: { clientId: madeId, ...at('30 Watle St') },
          notes: 'Caller: Priya Shah, 0477 100 200',
          matchCheck: {
            ...outbox(),
            applied: { clientId: madeId, evidence: ['name', 'mobile'] },
          },
          siteCheck: { seen, seenSeries: [] },
        }),
      )
    expect(await refusalOf(rewrite([]))).toMatchObject({
      code: 'SITE_BOOKED',
      rows: [
        {
          propertyId: firstSite,
          at: on(10),
          clientName: 'Priya Shah',
          jobId: first,
        },
      ],
    })
    // Sent after a look, as seen: it books.
    await rewrite([{ propertyId: firstSite, at: on(10) }])
  })

  test('two phones moved onto her by name and mobile at one new address, their resends interleaved: the second is refused onto the site the first made, never a second site there', async () => {
    const s = await setup()
    const caller = typed(
      { name: 'Jane Nguyen', phone: '0412 345 678' },
      elm(30),
    )
    const applied = {
      clientId: s.jane.clientId,
      evidence: ['name' as const, 'mobile' as const],
    }
    // Both phones regain signal together. Each first send is refused onto
    // her, with no site of hers there to book at.
    for (const at of [on(3), on(20)]) {
      expect(
        await refusalOf(
          s.owner.as.mutation(
            api.jobs.create,
            job(s, {
              scheduledAt: at,
              newClient: caller,
              matchCheck: outbox(),
              siteCheck: nothingSeen,
            }),
          ),
        ),
      ).toEqual({
        code: 'MATCHED_CLIENT',
        candidates: [
          {
            clientId: s.jane.clientId,
            name: 'Jane Nguyen',
            suburb: 'Bayswater',
            evidence: ['name', 'mobile'],
            auto: true,
          },
        ],
      })
    }
    // Each resends as 2c-J does: a new site for her, as typed. The first
    // makes 30 Elm St.
    const resend = (at: number) =>
      s.owner.as.mutation(
        api.jobs.create,
        job(s, {
          scheduledAt: at,
          newProperty: { clientId: s.jane.clientId, ...elm(30) },
          matchCheck: { ...outbox(), applied },
          siteCheck: nothingSeen,
        }),
      )
    const first = await resend(on(3))
    const madeSite = (await s.t.run((ctx) => ctx.db.get(first)))!.propertyId
    // The second's job is two weeks later, so no work there holds it; her
    // site there does, as her own site at the typed address.
    const onto = {
      code: 'MATCHED_CLIENT',
      candidates: [
        {
          clientId: s.jane.clientId,
          name: 'Jane Nguyen',
          suburb: 'Bayswater',
          propertyId: madeSite,
          evidence: ['site'],
          auto: true,
        },
      ],
    }
    expect(await refusalOf(resend(on(20)))).toEqual(onto)
    // A day after the first's job, the same, before that job is looked at:
    // Send from a hold there would otherwise make the site again.
    expect(await refusalOf(resend(on(4)))).toEqual(onto)
    // Booked on her there after a look (2c-J's Book on Jane Nguyen): one
    // 30 Elm St, with both jobs.
    const second = await s.owner.as.mutation(
      api.jobs.create,
      job(s, {
        scheduledAt: on(20),
        propertyId: madeSite,
        matchCheck: { ...outbox(), applied },
        siteCheck: nothingSeen,
      }),
    )
    expect((await s.t.run((ctx) => ctx.db.get(second)))!.propertyId).toBe(
      madeSite,
    )
    expect(
      (
        await s.t.run((ctx) =>
          ctx.db
            .query('properties')
            .withIndex('by_client', (q) => q.eq('clientId', s.jane.clientId))
            .collect(),
        )
      )
        .map((site) => site.addressLine)
        .sort(),
    ).toEqual(['12 Wattle St', '30 Elm St'])
  })

  test('only a booking moved onto her is held by a site only like hers: the sheet’s own new site for her, or the outbox’s sent as typed, books', async () => {
    const s = await setup()
    // Her job at 12 Wattle St, the day after.
    await insertJob(s, { scheduledAt: on(11) })
    for (const [matchCheck, addressLine] of [
      [sheet(), '12 Watle St'],
      [outbox(), '12 Wattel St'],
    ] as const) {
      await s.owner.as.mutation(
        api.jobs.create,
        job(s, {
          newProperty: { clientId: s.jane.clientId, ...WATTLE, addressLine },
          matchCheck,
          siteCheck: nothingSeen,
        }),
      )
    }
  })
})

describe('a postcode saved with three digits', () => {
  test('a site stored “810” is the typed “0810”, for the match and the site check', async () => {
    const s = await setup()
    const dan = await addClient(s, {
      name: 'Dan Hall',
      sites: [
        {
          addressLine: '4 Casuarina Dr',
          suburb: 'Nightcliff',
          state: 'NT',
          postcode: '810',
        },
      ],
    })
    const at = {
      addressLine: '4 Casuarina Dr',
      suburb: 'Nightcliff',
      state: 'NT',
      postcode: '0810',
    }
    expect(
      await refusalOf(
        s.owner.as.mutation(
          api.jobs.create,
          job(s, {
            newClient: typed({ name: 'Dan Hall' }, at),
            matchCheck: sheet(),
          }),
        ),
      ),
    ).toMatchObject({
      code: 'MATCHED_CLIENT',
      candidates: [{ clientId: dan.clientId, propertyId: dan.siteId }],
    })

    await insertJob(s, { propertyId: dan.siteId, scheduledAt: on(10) })
    expect(
      await refusalOf(
        s.owner.as.mutation(
          api.jobs.create,
          job(s, {
            newClient: typed({ name: 'Dan Hall' }, at),
            matchCheck: sheet([dan.clientId]),
            siteCheck: nothingSeen,
          }),
        ),
      ),
    ).toMatchObject({ code: 'SITE_BOOKED', rows: [{ propertyId: dan.siteId }] })
  })
})

describe('a postcode with more sites than are read', () => {
  test('the newest are read, so a client added last is still found, and the cut is logged', async () => {
    const s = await setup()
    // Two thousand older sites at 6053, as a big agency's book might have.
    await s.t.run(async (ctx) => {
      const now = Date.now()
      const clientId = await ctx.db.insert('clients', {
        businessId: s.businessId,
        kind: 'business',
        name: 'Harbour Strata',
        createdAt: now,
        updatedAt: now,
      })
      for (let n = 0; n < 2000; n++) {
        await ctx.db.insert('properties', {
          businessId: s.businessId,
          clientId,
          ...elm(1000 + n),
          createdAt: now,
        })
      }
    })
    const zoe = await addClient(s, { name: 'Zoe Last', sites: [elm(7)] })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(
      await refusalOf(
        s.owner.as.mutation(
          api.jobs.create,
          job(s, {
            newClient: typed({ name: 'Zoe Last' }, elm(7)),
            matchCheck: sheet(),
          }),
        ),
      ),
    ).toMatchObject({
      code: 'MATCHED_CLIENT',
      candidates: [{ clientId: zoe.clientId, propertyId: zoe.siteId }],
    })
    expect(warn).toHaveBeenCalledWith('findSame sites cut', { limit: 2000 })
  }, 30_000)
})

describe('an address with more sites than are checked', () => {
  /** `count` more clients with a site at 12 Wattle St, each newer than
   * Jane's there: units saved without their unit numbers, say. */
  const atWattle = (s: Setup, from: number, count: number) =>
    s.t.run(async (ctx) => {
      const now = Date.now()
      for (let n = from; n < from + count; n++) {
        const clientId = await ctx.db.insert('clients', {
          businessId: s.businessId,
          kind: 'person',
          name: `Tenant ${n}`,
          createdAt: now,
          updatedAt: now,
        })
        await ctx.db.insert('properties', {
          businessId: s.businessId,
          clientId,
          ...WATTLE,
          createdAt: now,
        })
      }
    })
  const book = (s: Setup) =>
    s.owner.as.mutation(
      api.jobs.create,
      job(s, {
        newClient: typed({ name: 'Tom Lee' }, WATTLE),
        siteCheck: nothingSeen,
      }),
    )

  test('every site at it is checked up to fifty; past that the oldest are left out, and the cut is logged', async () => {
    const s = await setup()
    await insertJob(s, { scheduledAt: on(10) })
    await atWattle(s, 0, 10)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Eleven sites there, Jane's the oldest: hers is still checked.
    expect(await refusalOf(book(s))).toMatchObject({
      code: 'SITE_BOOKED',
      rows: [{ propertyId: s.jane.siteId, scheduledAt: on(10) }],
    })
    expect(warn).not.toHaveBeenCalled()

    // Fifty-one: hers is left out, so the booking goes ahead.
    await atWattle(s, 10, 40)
    await book(s)
    expect(warn).toHaveBeenCalledWith('findSame targets cut', { limit: 50 })
  })

  test('past ten sites their jobs are shared out, so a crowded address reads no more than ten sites in full would', async () => {
    const s = await setup()
    // Jane's job that week, then 250 more made there since, months out.
    await insertJob(s, { scheduledAt: on(10) })
    await s.t.run(async (ctx) => {
      for (let n = 0; n < 250; n++) {
        await ctx.db.insert('jobs', {
          businessId: s.businessId,
          propertyId: s.jane.siteId,
          assignedMembershipId: s.ownerMembershipId,
          jobType: 'General Pest Control',
          price: 20000,
          durationMinutes: 60,
          status: 'booked',
          createdAt: Date.now(),
          scheduledAt: on(100 + n),
        })
      }
    })
    // Ten sites: each has its newest 500 read, so hers is found.
    await atWattle(s, 0, 9)
    expect(await refusalOf(book(s))).toMatchObject({
      code: 'SITE_BOOKED',
      rows: [{ propertyId: s.jane.siteId, scheduledAt: on(10) }],
    })
    // Twenty: each has its newest 250, and hers that week is the 251st.
    await atWattle(s, 9, 10)
    await book(s)
  })
})

describe('a book with more clients than are read', () => {
  test('whole up to 8,000 clients; past it a new client is never Same and never moved, and is still noted against who it may be', async () => {
    const s = await setup()
    const fill = (from: number, count: number) =>
      s.t.run(async (ctx) => {
        const now = Date.now()
        for (let n = from; n < from + count; n++) {
          await ctx.db.insert('clients', {
            businessId: s.businessId,
            kind: 'person',
            name: `Client Person ${n}`,
            createdAt: now,
            updatedAt: now,
          })
        }
      })
    // Jane, 7,998 more, and Ola, newest of all: 8,000.
    await fill(0, 7998)
    const ola = await addClient(s, {
      name: 'Ola Park',
      phone: '0488 000 111',
      sites: [elm(40)],
    })
    const bySheet = job(s, {
      newClient: typed({ name: 'Ola Park' }, elm(40)),
      matchCheck: sheet(),
    })
    const byOutbox = job(s, {
      scheduledAt: on(30),
      newClient: typed({ name: 'Ola Park', phone: '0488 000 111' }, elm(41)),
      matchCheck: outbox(),
    })
    // Whole: the same name and address is Same, and the name and her own
    // mobile are under the automatic rule.
    for (const booking of [bySheet, byOutbox]) {
      expect(
        await refusalOf(s.owner.as.mutation(api.jobs.create, booking)),
      ).toMatchObject({
        code: 'MATCHED_CLIENT',
        candidates: [{ clientId: ola.clientId }],
      })
    }

    // One more client, and the check can't say who else holds a number.
    await fill(7998, 1)
    // Sent later, by name and her own mobile: booked as typed, not moved.
    const moved = await s.owner.as.mutation(api.jobs.create, byOutbox)
    const second = (await clientOfJob(s, moved))!._id
    expect(second).not.toBe(ola.clientId)
    // With the sheet open, the same name and address: Likely, so it books.
    const third = (await clientOfJob(
      s,
      await s.owner.as.mutation(api.jobs.create, bySheet),
    ))!._id
    expect(third).not.toBe(ola.clientId)
    // And each is noted against her for the office, the address as the
    // mobile.
    expect(
      (await hints(s)).map(({ clientId, otherClientId, evidence }) => ({
        clientId,
        otherClientId,
        evidence,
      })),
    ).toEqual([
      {
        clientId: second,
        otherClientId: ola.clientId,
        evidence: ['name', 'mobile'],
      },
      {
        clientId: third,
        otherClientId: ola.clientId,
        evidence: ['name', 'site'],
      },
    ])
  }, 30_000)
})

describe('a postcode typed with a space', () => {
  test('is stored as its digits from the client sheet’s Add property and edit, so the check finds the site', async () => {
    const s = await setup()
    const pat = await addClient(s, { name: 'Pat Sims', sites: [elm(1)] })
    // The client sheet sends the postcode as typed.
    const added = await s.owner.as.mutation(api.properties.createForClient, {
      businessId: s.businessId,
      clientId: pat.clientId,
      ...elm(40),
      postcode: '6053 ',
    })
    await s.owner.as.mutation(api.properties.update, {
      businessId: s.businessId,
      propertyId: pat.siteId,
      postcode: ' 6053 ',
    })
    expect(
      await s.t.run(async (ctx) =>
        Promise.all(
          [added, pat.siteId].map(
            async (id) => (await ctx.db.get(id))!.postcode,
          ),
        ),
      ),
    ).toEqual(['6053', '6053'])

    expect(
      await refusalOf(
        s.owner.as.mutation(
          api.jobs.create,
          job(s, {
            newClient: typed({ name: 'Pat Sims' }, elm(40)),
            matchCheck: sheet(),
          }),
        ),
      ),
    ).toMatchObject({
      code: 'MATCHED_CLIENT',
      candidates: [{ clientId: pat.clientId, propertyId: added }],
    })
    await insertJob(s, { propertyId: pat.siteId, scheduledAt: on(11) })
    expect(
      await refusalOf(
        s.owner.as.mutation(
          api.jobs.create,
          job(s, {
            newClient: typed({ name: 'Ola Park' }, elm(1)),
            siteCheck: nothingSeen,
          }),
        ),
      ),
    ).toMatchObject({ code: 'SITE_BOOKED', rows: [{ propertyId: pat.siteId }] })
  })

  test('sent again as typed, after its answer was lost, it is the same site: nothing is said to differ', async () => {
    const s = await setup()
    const pat = await addClient(s, { name: 'Pat Sims', sites: [elm(1)] })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const differs = () =>
      warn.mock.calls.filter(
        ([said]) => said === 'clientRequest repeat differs',
      )
    const added = {
      businessId: s.businessId,
      clientId: pat.clientId,
      ...elm(40),
      postcode: '6053 ',
      clientRequestId: crypto.randomUUID(),
    }
    const site = await s.owner.as.mutation(
      api.properties.createForClient,
      added,
    )
    expect(
      await s.owner.as.mutation(api.properties.createForClient, added),
    ).toBe(site)
    const made = {
      businessId: s.businessId,
      clientName: 'Ola Park',
      ...elm(41),
      postcode: '6053 ',
      clientRequestId: crypto.randomUUID(),
    }
    const first = await s.owner.as.mutation(api.properties.create, made)
    expect(await s.owner.as.mutation(api.properties.create, made)).toBe(first)
    expect(differs()).toEqual([])
    // Another postcode under the same id still is.
    await s.owner.as.mutation(api.properties.create, {
      ...made,
      postcode: '6054',
    })
    expect(differs()).toEqual([
      [
        'clientRequest repeat differs',
        { table: 'properties', fields: ['postcode'] },
      ],
    ])
  })
})

// ───────────────────────────────────────────────────────── the site check

describe('siteCheck: open work at the site within a week', () => {
  test('a job three days away is refused SITE_BOOKED, and books once seen by its site and slot', async () => {
    const s = await setup()
    const there = await insertJob(s, { scheduledAt: on(7, 14) })
    const before = await everything(s)
    const data = await refusalOf(
      s.owner.as.mutation(
        api.jobs.create,
        job(s, { propertyId: s.jane.siteId, siteCheck: nothingSeen }),
      ),
    )
    expect(data).toEqual({
      code: 'SITE_BOOKED',
      rows: [
        {
          propertyId: s.jane.siteId,
          at: on(7, 14),
          scheduledAt: on(7, 14),
          clientName: 'Jane Nguyen',
          jobId: there,
          jobNumber: 41,
        },
      ],
    })
    expect(await everything(s)).toEqual(before)

    await s.owner.as.mutation(
      api.jobs.create,
      job(s, {
        propertyId: s.jane.siteId,
        siteCheck: {
          seen: [{ propertyId: s.jane.siteId, at: on(7, 14) }],
          seenSeries: [],
        },
      }),
    )
  })

  test('someone else’s job, out of a subcontractor’s scope: no id or number, and seen by its pair it books (RK1)', async () => {
    const s = await setup()
    await insertJob(s, { scheduledAt: on(12) })
    const data = await refusalOf(
      s.kevin.as.mutation(
        api.jobs.create,
        job(s, {
          assignedMembershipId: s.kevinId,
          propertyId: s.jane.siteId,
          siteCheck: nothingSeen,
        }),
      ),
    )
    expect(data).toEqual({
      code: 'SITE_BOOKED',
      rows: [
        {
          propertyId: s.jane.siteId,
          at: on(12),
          scheduledAt: on(12),
          clientName: 'Jane Nguyen',
        },
      ],
    })
    await s.kevin.as.mutation(
      api.jobs.create,
      job(s, {
        assignedMembershipId: s.kevinId,
        propertyId: s.jane.siteId,
        siteCheck: {
          seen: [{ propertyId: s.jane.siteId, at: on(12) }],
          seenSeries: [],
        },
      }),
    )
  })

  test('a one-off of their own, moved by the office after it was shown, is still the job that was seen, by its id', async () => {
    const s = await setup()
    // Shown at Book: Jane's job at 8am, three days out.
    const shown = await insertJob(s, { scheduledAt: on(3, 8) })
    const seen = {
      seen: [{ propertyId: s.jane.siteId, at: on(3, 8), jobId: shown }],
      seenSeries: [],
    }
    // The office moves it to 2pm before the booking is sent.
    await s.t.run((ctx) => ctx.db.patch(shown, { scheduledAt: on(3, 14) }))
    const booking = (siteCheck: Booking['siteCheck']) =>
      job(s, {
        scheduledAt: on(4),
        propertyId: s.jane.siteId,
        matchCheck: outbox(),
        siteCheck,
      })
    // By its old slot alone it is another job now.
    expect(
      await refusalOf(
        s.owner.as.mutation(
          api.jobs.create,
          booking({
            seen: [{ propertyId: s.jane.siteId, at: on(3, 8) }],
            seenSeries: [],
          }),
        ),
      ),
    ).toMatchObject({ code: 'SITE_BOOKED', rows: [{ jobId: shown }] })
    // By its id, it is the one that was shown: it books.
    await s.owner.as.mutation(api.jobs.create, booking(seen))
  })

  test('a visit moved, or projected again with a new id, is still the slot that was seen (RK7)', async () => {
    const s = await setup()
    const recurrenceId = await s.t.run((ctx) =>
      ctx.db.insert('recurrences', {
        businessId: s.businessId,
        propertyId: s.jane.siteId,
        assignedMembershipId: s.ownerMembershipId,
        intervalCount: 3,
        intervalUnit: 'month',
        jobType: 'General Pest Control',
        price: 20000,
        anchorDate: on(12),
        active: true,
      }),
    )
    const slot = on(12)
    const seen = {
      seen: [{ propertyId: s.jane.siteId, at: slot }],
      seenSeries: [] as Array<Id<'recurrences'>>,
    }
    // Moved two hours later by the office.
    const visit = await insertJob(s, {
      recurrenceId,
      status: 'recurring',
      occurrenceAt: slot,
      scheduledAt: slot + 2 * HOUR,
    })
    await s.owner.as.mutation(
      api.jobs.create,
      job(s, { propertyId: s.jane.siteId, siteCheck: seen }),
    )
    // That booking is at the site now too, and was seen when the next one
    // is made.
    seen.seen.push({ propertyId: s.jane.siteId, at: on(10) })
    // Projected again by the engine: a new row, the same slot.
    await s.t.run(async (ctx) => {
      await ctx.db.delete(visit)
      await ctx.db.insert('jobs', {
        businessId: s.businessId,
        propertyId: s.jane.siteId,
        assignedMembershipId: s.ownerMembershipId,
        jobType: 'General Pest Control',
        price: 20000,
        durationMinutes: 60,
        status: 'recurring',
        recurrenceId,
        occurrenceAt: slot,
        scheduledAt: slot,
        createdAt: Date.now(),
      })
    })
    await s.owner.as.mutation(
      api.jobs.create,
      job(s, { propertyId: s.jane.siteId, siteCheck: seen }),
    )
  })

  test('a Recurring Job that was shown covers every visit of it', async () => {
    const s = await setup()
    const recurrenceId = await s.t.run((ctx) =>
      ctx.db.insert('recurrences', {
        businessId: s.businessId,
        propertyId: s.jane.siteId,
        assignedMembershipId: s.ownerMembershipId,
        intervalCount: 1,
        intervalUnit: 'week',
        jobType: 'General Pest Control',
        price: 20000,
        anchorDate: on(6),
        active: true,
      }),
    )
    for (const offset of [6, 13]) {
      await insertJob(s, {
        recurrenceId,
        status: 'recurring',
        occurrenceAt: on(offset),
        scheduledAt: on(offset),
      })
    }
    await refusalOf(
      s.owner.as.mutation(
        api.jobs.create,
        job(s, { propertyId: s.jane.siteId, siteCheck: nothingSeen }),
      ),
    )
    await s.owner.as.mutation(
      api.jobs.create,
      job(s, {
        propertyId: s.jane.siteId,
        siteCheck: { seen: [], seenSeries: [recurrenceId] },
      }),
    )
  })

  test('cancelled, completed and binned work books', async () => {
    const s = await setup()
    await insertJob(s, { scheduledAt: on(10), status: 'cancelled' })
    await insertJob(s, { scheduledAt: on(9), status: 'completed' })
    await insertJob(s, { scheduledAt: on(8), deletedAt: Date.now() })
    await s.owner.as.mutation(
      api.jobs.create,
      job(s, { propertyId: s.jane.siteId, siteCheck: nothingSeen }),
    )
  })

  test('a week either side, by the calendar, inclusive: seven days refuses, eight books', async () => {
    const s = await setup()
    await insertJob(s, { scheduledAt: on(3, 8) })
    await refusalOf(
      s.owner.as.mutation(
        api.jobs.create,
        job(s, {
          propertyId: s.jane.siteId,
          scheduledAt: on(10, 17),
          siteCheck: nothingSeen,
        }),
      ),
    )
    await s.owner.as.mutation(
      api.jobs.create,
      job(s, {
        propertyId: s.jane.siteId,
        scheduledAt: on(11, 7),
        siteCheck: nothingSeen,
      }),
    )
  })

  test('a new client, or a new site, typed at an address with open work is refused, whoever’s it is (FW2)', async () => {
    const s = await setup()
    await insertJob(s, { scheduledAt: on(10) })
    const agency = await addClient(s, {
      name: 'Ray White Bayswater',
      kind: 'business',
      sites: [elm(1)],
    })
    for (const where of [
      { newClient: typed({ name: 'Tom Lee' }, WATTLE), matchCheck: sheet() },
      { newClient: typed({ name: 'Tom Lee' }, WATTLE) },
      { newProperty: { clientId: agency.clientId, ...WATTLE } },
    ]) {
      expect(
        await refusalOf(
          s.owner.as.mutation(
            api.jobs.create,
            job(s, { ...where, siteCheck: nothingSeen }),
          ),
        ),
      ).toMatchObject({
        code: 'SITE_BOOKED',
        rows: [{ propertyId: s.jane.siteId, clientName: 'Jane Nguyen' }],
      })
    }
  })

  test('a one-off beside a Recurring Job with no visit that week books', async () => {
    const s = await setup()
    await s.t.run((ctx) =>
      ctx.db.insert('recurrences', {
        businessId: s.businessId,
        propertyId: s.jane.siteId,
        assignedMembershipId: s.ownerMembershipId,
        intervalCount: 3,
        intervalUnit: 'month',
        jobType: 'General Pest Control',
        price: 20000,
        anchorDate: on(40),
        active: true,
      }),
    )
    await s.owner.as.mutation(
      api.jobs.create,
      job(s, { propertyId: s.jane.siteId, siteCheck: nothingSeen }),
    )
  })
})

describe('siteCheck on a Recurring Job: a second one at the site (FW12)', () => {
  test('refused SITE_REPEATS with its interval and next visit; seen, it books', async () => {
    const s = await setup()
    const existing = await s.owner.as.mutation(
      api.recurrences.create,
      series(s, {
        propertyId: s.jane.siteId,
        anchorDate: on(30),
        jobType: 'Rodents',
      }),
    )
    const before = await everything(s)
    const data = await refusalOf(
      s.owner.as.mutation(
        api.recurrences.create,
        series(s, { propertyId: s.jane.siteId, siteCheck: nothingSeen }),
      ),
    )
    expect(data).toEqual({
      code: 'SITE_REPEATS',
      series: [
        {
          recurrenceId: existing,
          propertyId: s.jane.siteId,
          nextAt: on(30),
          intervalCount: 3,
          intervalUnit: 'month',
          jobType: 'Rodents',
        },
      ],
    })
    expect(await everything(s)).toEqual(before)

    await s.owner.as.mutation(
      api.recurrences.create,
      series(s, {
        propertyId: s.jane.siteId,
        siteCheck: { seen: [], seenSeries: [existing] },
      }),
    )
  })

  test('the running one is found however many were stopped or binned there before it', async () => {
    const s = await setup()
    const row = (fields: Partial<Doc<'recurrences'>>) => ({
      businessId: s.businessId,
      propertyId: s.jane.siteId,
      assignedMembershipId: s.ownerMembershipId,
      intervalCount: 1,
      intervalUnit: 'month' as const,
      jobType: 'General Pest Control',
      price: 20000,
      anchorDate: on(60),
      active: false,
      ...fields,
    })
    const running = await s.t.run(async (ctx) => {
      for (let i = 0; i < 60; i++) await ctx.db.insert('recurrences', row({}))
      for (let i = 0; i < 5; i++) {
        await ctx.db.insert(
          'recurrences',
          row({ active: true, deletedAt: Date.now() }),
        )
      }
      return ctx.db.insert('recurrences', row({ active: true }))
    })
    expect(
      await refusalOf(
        s.owner.as.mutation(
          api.recurrences.create,
          series(s, { propertyId: s.jane.siteId, siteCheck: nothingSeen }),
        ),
      ),
    ).toEqual({
      code: 'SITE_REPEATS',
      series: [
        {
          recurrenceId: running,
          propertyId: s.jane.siteId,
          intervalCount: 1,
          intervalUnit: 'month',
          jobType: 'General Pest Control',
        },
      ],
    })
  })

  test('someone else’s, for a subcontractor: when, and not how often or what', async () => {
    const s = await setup()
    const existing = await s.owner.as.mutation(
      api.recurrences.create,
      series(s, { propertyId: s.jane.siteId, anchorDate: on(30) }),
    )
    expect(
      await refusalOf(
        s.kevin.as.mutation(
          api.recurrences.create,
          series(s, {
            assignedMembershipId: s.kevinId,
            propertyId: s.jane.siteId,
            siteCheck: nothingSeen,
          }),
        ),
      ),
    ).toEqual({
      code: 'SITE_REPEATS',
      series: [
        { recurrenceId: existing, propertyId: s.jane.siteId, nextAt: on(30) },
      ],
    })
  })

  test('its first visit near other work is SITE_BOOKED', async () => {
    const s = await setup()
    await insertJob(s, { scheduledAt: on(11) })
    expect(
      await refusalOf(
        s.owner.as.mutation(
          api.recurrences.create,
          series(s, { propertyId: s.jane.siteId, siteCheck: nothingSeen }),
        ),
      ),
    ).toMatchObject({ code: 'SITE_BOOKED' })
  })

  test('one started in the past is checked by the first visit it books, not by its anchor', async () => {
    // Monthly from 25 days ago: no visit is invented for the anchor, and
    // the first is a month on from it, three to six days from now.
    const monthly = (s: Setup) =>
      s.owner.as.mutation(
        api.recurrences.create,
        series(s, {
          propertyId: s.jane.siteId,
          anchorDate: on(-25),
          intervalCount: 1,
          intervalUnit: 'month',
          siteCheck: nothingSeen,
        }),
      )
    // Beside its first visit, open work holds it.
    const s = await setup()
    const near = await insertJob(s, { scheduledAt: on(5) })
    expect(await refusalOf(monthly(s))).toMatchObject({
      code: 'SITE_BOOKED',
      rows: [{ jobId: near }],
    })
    // Beside where its anchor was, open work is nothing to it.
    const other = await setup()
    await insertJob(other, { scheduledAt: on(-24) })
    await monthly(other)
  })
})

// ─────────────────────────────────────────────── more than a refusal names

describe('more than three: one Book anyway clears them all', () => {
  test('SITE_BOOKED names three jobs, hands back the fourth, and books once all four are sent as seen', async () => {
    const s = await setup()
    const ids: Array<Id<'jobs'>> = []
    for (const [offset, jobNumber] of [
      [8, 41],
      [9, 42],
      [11, 43],
      [12, 44],
    ]) {
      ids.push(await insertJob(s, { scheduledAt: on(offset), jobNumber }))
    }
    const book = (seen: Seen) =>
      s.owner.as.mutation(
        api.jobs.create,
        job(s, {
          propertyId: s.jane.siteId,
          siteCheck: { seen, seenSeries: [] },
        }),
      )
    const data = (await refusalOf(book([]))) as {
      rows: Array<Seen[number] & { jobNumber?: number }>
      more?: Seen
    }
    // Nearest first: the 9th and 11th, then the 8th; the 12th handed back,
    // his own, with its id as the named rows give theirs.
    expect(data.rows.map((row) => row.at)).toEqual([on(9), on(11), on(8)])
    expect(data.more).toEqual([
      { propertyId: s.jane.siteId, at: on(12), jobId: ids[3] },
    ])
    // Only the three named sent back: refused again, for the fourth.
    const named = data.rows.map(({ propertyId, at, jobId }) => ({
      propertyId,
      at,
      jobId,
    }))
    expect(await refusalOf(book(named))).toMatchObject({
      code: 'SITE_BOOKED',
      rows: [{ at: on(12) }],
    })
    // The office moves the fourth from 9am to 11am before the resend: by its
    // old slot it would be another job, by its id it is the one handed back.
    await s.t.run((ctx) => ctx.db.patch(ids[3], { scheduledAt: on(12, 11) }))
    // All four, as one Book anyway (or Send) sends them: it books.
    await book([...named, ...(data.more ?? [])])
  })

  test('SITE_BOOKED hands back someone else’s work by site and slot alone, once a slot, and a subcontractor’s own by its id too', async () => {
    const s = await setup()
    // Near Kevin's booking: the owner's three nearest, then two of the
    // owner's in one slot, then Kevin's own.
    for (const offset of [9, 11, 8]) {
      await insertJob(s, { scheduledAt: on(offset) })
    }
    await insertJob(s, { scheduledAt: on(12), jobNumber: 44 })
    await insertJob(s, { scheduledAt: on(12), jobNumber: 45 })
    const kevins = await insertJob(s, {
      scheduledAt: on(13),
      assignedMembershipId: s.kevinId,
      jobNumber: 46,
    })
    const book = (seen: Seen) =>
      s.kevin.as.mutation(
        api.jobs.create,
        job(s, {
          assignedMembershipId: s.kevinId,
          propertyId: s.jane.siteId,
          siteCheck: { seen, seenSeries: [] },
        }),
      )
    const data = (await refusalOf(book([]))) as { rows: Seen; more?: Seen }
    expect(data.more).toEqual([
      { propertyId: s.jane.siteId, at: on(12) },
      { propertyId: s.jane.siteId, at: on(13), jobId: kevins },
    ])
    await book([
      ...data.rows.map(({ propertyId, at }) => ({ propertyId, at })),
      ...data.more!,
    ])
  })

  test('SITE_REPEATS names three Recurring Jobs and hands back the fourth', async () => {
    const s = await setup()
    const running: Array<Id<'recurrences'>> = []
    for (const months of [1, 2, 3, 6]) {
      running.push(
        await s.t.run((ctx) =>
          ctx.db.insert('recurrences', {
            businessId: s.businessId,
            propertyId: s.jane.siteId,
            assignedMembershipId: s.ownerMembershipId,
            intervalCount: months,
            intervalUnit: 'month',
            jobType: 'General Pest Control',
            price: 20000,
            anchorDate: on(60),
            active: true,
          }),
        ),
      )
    }
    const book = (seenSeries: Array<Id<'recurrences'>>) =>
      s.owner.as.mutation(
        api.recurrences.create,
        series(s, {
          propertyId: s.jane.siteId,
          siteCheck: { seen: [], seenSeries },
        }),
      )
    const data = (await refusalOf(book([]))) as {
      series: Array<{ recurrenceId: Id<'recurrences'> }>
      more?: Array<Id<'recurrences'>>
    }
    expect(data.series.map((row) => row.recurrenceId)).toEqual(
      running.slice(0, 3),
    )
    expect(data.more).toEqual([running[3]])
    await book([...data.series.map((row) => row.recurrenceId), ...data.more!])
  })

  test('MATCHED_CLIENT names three clients and hands back the fourth, for `dismissed`', async () => {
    const s = await setup()
    // Four clients at Jane's address whose names are like the typed one.
    const others = []
    for (const name of ['Jill Nguyen', 'Joy Nguyen', 'Jim Nguyen']) {
      others.push((await addClient(s, { name, sites: [WATTLE] })).clientId)
    }
    const all = [s.jane.clientId, ...others]
    const book = (dismissed: Array<Id<'clients'>>) =>
      s.owner.as.mutation(
        api.jobs.create,
        job(s, {
          newClient: typed({ name: 'J Nguyen' }, WATTLE),
          matchCheck: sheet(dismissed),
        }),
      )
    const data = (await refusalOf(book([]))) as {
      candidates: Array<{ clientId: Id<'clients'> }>
      more?: Array<Id<'clients'>>
    }
    expect(data.candidates).toHaveLength(3)
    expect(data.more).toHaveLength(1)
    const handed = [
      ...data.candidates.map((candidate) => candidate.clientId),
      ...data.more!,
    ]
    expect([...handed].sort()).toEqual([...all].sort())
    await book(handed)
  })
})

// ───────────────────────────────────────────────── every mode, every call

describe('the checks never reach what is stored', () => {
  test('every mode of both bookings books with both checks sent, and stores neither', async () => {
    const s = await setup()
    const checks = { matchCheck: sheet(), siteCheck: nothingSeen }
    const where = [
      { propertyId: s.jane.siteId },
      { newProperty: { clientId: s.jane.clientId, ...elm(60) } },
      { newClient: typed({ name: 'Mia Chen' }, elm(61)) },
    ]
    for (const [i, at] of where.entries()) {
      await s.owner.as.mutation(
        api.jobs.create,
        job(s, { ...at, ...checks, scheduledAt: on(40 + i * 20) }),
      )
    }
    const seriesWhere = [
      {
        propertyId: (await addClient(s, { name: 'Ann Bell', sites: [elm(62)] }))
          .siteId,
      },
      { newProperty: { clientId: s.jane.clientId, ...elm(63) } },
      { newClient: typed({ name: 'Ian Park' }, elm(64)) },
    ]
    for (const at of seriesWhere) {
      await s.owner.as.mutation(
        api.recurrences.create,
        series(s, { ...at, ...checks }),
      )
    }
    const stored = await everything(s)
    const said = JSON.stringify([
      stored.jobs,
      stored.recurrences,
      stored.properties,
    ])
    expect(said).not.toContain('dismissed')
    expect(said).not.toContain('seenSeries')
  })

  test('Clients → New client, and Add property: refused before anything is made, and made once booked past', async () => {
    const s = await setup()
    const before = await everything(s)
    const newClient = {
      businessId: s.businessId,
      clientName: 'Jane Nguyen',
      ...WATTLE,
    }
    expect(
      await refusalOf(
        s.owner.as.mutation(api.properties.create, {
          ...newClient,
          matchCheck: sheet(),
        }),
      ),
    ).toMatchObject({
      code: 'MATCHED_CLIENT',
      candidates: [{ clientId: s.jane.clientId, propertyId: s.jane.siteId }],
    })
    expect(
      await refusalOf(
        s.owner.as.mutation(api.properties.createForClient, {
          businessId: s.businessId,
          clientId: s.jane.clientId,
          ...WATTLE,
          matchCheck: sheet(),
        }),
      ),
    ).toMatchObject({
      code: 'MATCHED_CLIENT',
      candidates: [{ clientId: s.jane.clientId, propertyId: s.jane.siteId }],
    })
    expect(await everything(s)).toEqual(before)

    const siteId = await s.owner.as.mutation(api.properties.create, {
      ...newClient,
      matchCheck: sheet([s.jane.clientId]),
    })
    const made = await s.t.run(async (ctx) => (await ctx.db.get(siteId))!)
    expect(await hints(s)).toMatchObject([
      { clientId: made.clientId, otherClientId: s.jane.clientId },
    ])
    await s.owner.as.mutation(api.properties.createForClient, {
      businessId: s.businessId,
      clientId: s.jane.clientId,
      ...WATTLE,
      matchCheck: sheet([s.jane.clientId]),
    })
  })
})

describe('what the booking itself is refused for comes before the check', () => {
  test('so a check that finds nothing books, and its answer is never had for nothing: no number of "12" to learn when another member is booked at an address', async () => {
    const s = await setup()
    // The owner's job at Jane's, 200 days out: past what jobs.openWork sends
    // Kevin, though not past the server's check.
    await insertJob(s, { scheduledAt: on(200) })
    const gone = await addClient(s, {
      name: 'Gone Away',
      binned: true,
      sites: [elm(70)],
    })
    const before = await everything(s)
    const asKevin = (offset: number, fields: Partial<Booking>) =>
      s.kevin.as.mutation(
        api.jobs.create,
        job(s, {
          assignedMembershipId: s.kevinId,
          scheduledAt: on(offset),
          matchCheck: sheet(),
          siteCheck: nothingSeen,
          ...fields,
        }),
      )
    const business = (fields: Partial<NewClient>): NewClient => ({
      ...typed({ name: 'Lee Holdings' }, WATTLE),
      kind: 'business',
      ...fields,
    })
    const refused: Array<[string, Partial<Booking>]> = [
      [
        'INVALID_PHONE',
        { newClient: typed({ name: 'Tom Lee', phone: '12' }, WATTLE) },
      ],
      [
        'INVALID_EMAIL',
        { newClient: typed({ name: 'Tom Lee', email: 'tom@' }, WATTLE) },
      ],
      ['INVALID_ABN', { newClient: business({ abn: '12 345' }) }],
      ['INVALID_PHONE', { newClient: business({ siteContactPhone: '12' }) }],
      [
        'TOO_MANY_TAGS',
        {
          newClient: {
            ...typed({ name: 'Tom Lee' }, WATTLE),
            tags: Array.from({ length: 21 }, (_, n) => `Tag ${n}`),
          },
        },
      ],
      // A new site for a client in the Recycle bin, at Jane's address.
      ['NOT_FOUND', { newProperty: { clientId: gone.clientId, ...WATTLE } }],
      // Jane's own address, which would be MATCHED_CLIENT.
      [
        'INVALID_PHONE',
        {
          newProperty: {
            clientId: s.jane.clientId,
            ...WATTLE,
            siteContactPhone: '12',
          },
        },
      ],
    ]
    for (const [code, fields] of refused) {
      // Within a week of the owner's job, and three weeks past it: the same
      // answer either way, so it says nothing about the work there.
      expect(await refusalOf(asKevin(203, fields))).toBe(code)
      expect(await refusalOf(asKevin(230, fields))).toBe(code)
    }
    expect(
      await refusalOf(
        s.kevin.as.mutation(
          api.recurrences.create,
          series(s, {
            assignedMembershipId: s.kevinId,
            anchorDate: on(203),
            newClient: typed({ name: 'Tom Lee', phone: '12' }, WATTLE),
            matchCheck: sheet(),
            siteCheck: nothingSeen,
          }),
        ),
      ),
    ).toBe('INVALID_PHONE')
    // Nor is it had from Clients → New client, or Add property: Jane's name
    // and address, or her address again, with a number that can't be.
    expect(
      await refusalOf(
        s.kevin.as.mutation(api.properties.create, {
          businessId: s.businessId,
          clientName: 'Jane Nguyen',
          phone: '12',
          ...WATTLE,
          matchCheck: sheet(),
        }),
      ),
    ).toBe('INVALID_PHONE')
    expect(
      await refusalOf(
        s.kevin.as.mutation(api.properties.createForClient, {
          businessId: s.businessId,
          clientId: s.jane.clientId,
          ...WATTLE,
          siteContactPhone: '12',
          matchCheck: sheet(),
        }),
      ),
    ).toBe('INVALID_PHONE')
    expect(await everything(s)).toEqual(before)

    // A booking that can be made: near the owner's job it is refused; three
    // weeks past it, it books, and the office sees it.
    const tom = typed({ name: 'Tom Lee', phone: '0499 111 222' }, WATTLE)
    expect(await refusalOf(asKevin(203, { newClient: tom }))).toMatchObject({
      code: 'SITE_BOOKED',
      rows: [{ propertyId: s.jane.siteId, scheduledAt: on(200) }],
    })
    const jobId = await asKevin(230, { newClient: tom })
    expect((await clientOfJob(s, jobId))?.name).toBe('Tom Lee')
  })
})

// ───────────────────────────────────────────────────────── scope

describe('only clients the caller may see', () => {
  test('on a narrowed book an out-of-scope client is never a candidate nor a second holder, and nothing is Same', async () => {
    // Nobody takes the narrow branch today (lib/clientScope.ts): every role
    // has `clients.directory`. Asked here of the backstop itself, with an
    // envelope that lacks it, as Kevin: his book is the clients at his own
    // jobs.
    const s = await setup()
    await insertJob(s, {
      assignedMembershipId: s.kevinId,
      scheduledAt: on(-20),
    })
    // Tom shares Jane's mobile, and holds his own; neither is Kevin's.
    const tom = await addClient(s, {
      name: 'Tom Ray',
      phone: '0412 345 678',
      sites: [elm(3)],
    })
    await addClient(s, {
      name: 'Lou Ray',
      phone: '0466 987 654',
      sites: [elm(4)],
    })

    const narrowed = (env: ActorEnvelope): ActorEnvelope => ({
      ...env,
      caps: { ...env.caps, 'clients.directory': false },
    })
    const run = (by: 'sheet' | 'outbox', client: NewClient) =>
      s.kevin.as.run(async (ctx) => {
        const env = narrowed(await requireActor(ctx, s.businessId))
        return backstop(
          ctx,
          env,
          s.businessId,
          proposedOf({ newClient: client }),
          {
            matchCheck: { by, dismissed: [] },
            now: Date.now(),
          },
        )
      })

    // Out of his book: Lou is nobody to him, sheet or outbox.
    for (const by of ['sheet', 'outbox'] as const) {
      expect(
        await run(
          by,
          typed({ name: 'Lou Ray', phone: '0466 987 654' }, elm(4)),
        ),
      ).toEqual({ hints: [] })
    }
    // In it, Jane, by a mobile only she holds in his book though Tom holds
    // it too: as his phone sees it, Likely at most, so never refused.
    for (const by of ['sheet', 'outbox'] as const) {
      expect(
        await run(
          by,
          typed({ name: 'Jane Nguyen', phone: '0412 345 678' }, WATTLE),
        ),
      ).toEqual({
        hints: [
          {
            otherClientId: s.jane.clientId,
            evidence: ['name', 'site', 'mobile'],
          },
        ],
      })
    }
    expect(tom.clientId).toBeDefined()
  })

  test('the site check names a client only for someone who may see them', async () => {
    const s = await setup()
    await insertJob(s, { scheduledAt: on(10) })
    const data = await s.kevin.as.run(async (ctx) => {
      const real = await requireActor(ctx, s.businessId)
      const env = {
        ...real,
        caps: { ...real.caps, 'clients.directory': false },
      }
      return backstop(
        ctx,
        env,
        s.businessId,
        proposedOf({ propertyId: s.jane.siteId }),
        {
          siteCheck: nothingSeen,
          at: on(10),
          now: Date.now(),
        },
      ).then(
        () => null,
        (e: unknown) => (e as ConvexError<Value>).data,
      )
    })
    expect(data).toEqual({
      code: 'SITE_BOOKED',
      rows: [{ propertyId: s.jane.siteId, at: on(10), scheduledAt: on(10) }],
    })
  })
})

describe('a typed address on a narrowed book', () => {
  test('is checked for work only at the sites of clients in the book: none outside it says who is there, or when', async () => {
    // As above: nobody takes the narrow branch today, so asked of the
    // backstop itself, as Kevin, whose book is the clients at his own jobs.
    const s = await setup()
    await insertJob(s, {
      assignedMembershipId: s.kevinId,
      scheduledAt: on(-20),
    })
    await insertJob(s, { scheduledAt: on(10) })
    // Lou is outside his book, with a site at 4 Elm St booked that week.
    const lou = await addClient(s, { name: 'Lou Ray', sites: [elm(4)] })
    await insertJob(s, { propertyId: lou.siteId, scheduledAt: on(10) })

    const run = (input: Parameters<typeof proposedOf>[0]) =>
      s.kevin.as.run(async (ctx) => {
        const real = await requireActor(ctx, s.businessId)
        const env = {
          ...real,
          caps: { ...real.caps, 'clients.directory': false },
        }
        return backstop(ctx, env, s.businessId, proposedOf(input), {
          siteCheck: nothingSeen,
          at: on(10),
          now: Date.now(),
        }).then(
          (out) => out,
          (e: unknown) => (e as ConvexError<Value>).data,
        )
      })

    // At Lou's address, as a new client or a new site for Jane: books, as at
    // an address with no site at all.
    for (const input of [
      { newClient: typed({ name: 'Anyone At All' }, elm(4)) },
      { newProperty: { clientId: s.jane.clientId, ...elm(4) } },
      { newClient: typed({ name: 'Anyone At All' }, elm(5)) },
    ]) {
      expect(await run(input)).toEqual({ hints: [] })
    }
    // At Jane's, who is in his book, the work there still stops it.
    expect(
      await run({ newClient: typed({ name: 'Anyone At All' }, WATTLE) }),
    ).toMatchObject({
      code: 'SITE_BOOKED',
      rows: [{ propertyId: s.jane.siteId, clientName: 'Jane Nguyen' }],
    })
    // And at Lou's site chosen by its id, its work stops it: the site and
    // its dates are what his phone's jobs.openWork already holds.
    expect(await run({ propertyId: lou.siteId })).toEqual({
      code: 'SITE_BOOKED',
      rows: [{ propertyId: lou.siteId, at: on(10), scheduledAt: on(10) }],
    })
  })
})

// ───────────────────────────────────────────────────────── hints

/** A booking past Jane, which notes her against the client it makes. */
async function hintedClient(s: Setup) {
  const jobId = await s.owner.as.mutation(
    api.jobs.create,
    job(s, {
      newClient: typed({ name: 'Tom Nguyen', phone: '0412 345 678' }, elm(3)),
      matchCheck: sheet(),
    }),
  )
  const made = (await clientOfJob(s, jobId))!
  return { jobId, clientId: made._id }
}

describe('possible duplicates (clientMatchHints)', () => {
  test('shown on both clients’ sheets, scope-filtered, and not once the other is in the Recycle bin', async () => {
    const s = await setup()
    const tom = await hintedClient(s)
    const forTom = await s.dana.as.query(api.clientMatchHints.forClient, {
      businessId: s.businessId,
      clientId: tom.clientId,
    })
    expect(forTom).toMatchObject([
      {
        otherClientId: s.jane.clientId,
        otherName: 'Jane Nguyen',
        evidence: ['mobile'],
      },
    ])
    expect(
      await s.owner.as.query(api.clientMatchHints.forClient, {
        businessId: s.businessId,
        clientId: s.jane.clientId,
      }),
    ).toMatchObject([{ otherClientId: tom.clientId, otherName: 'Tom Nguyen' }])

    await s.owner.as.mutation(api.bin.deleteClient, {
      businessId: s.businessId,
      clientId: s.jane.clientId,
    })
    expect(
      await s.owner.as.query(api.clientMatchHints.forClient, {
        businessId: s.businessId,
        clientId: tom.clientId,
      }),
    ).toEqual([])
    // Still there, for a restore to bring back.
    expect(await hints(s)).toHaveLength(1)
  })

  test('only for whoever manages the team: a subcontractor sees none, so a pair with a hint beside a pair without never says whose a number is', async () => {
    const s = await setup()
    // Dana's mobile, the owner's own, and a stranger's, each on one client.
    const old = {
      kim: await addClient(s, {
        name: 'Kim Ho',
        phone: '0455 444 555',
        sites: [elm(7)],
      }),
      pat: await addClient(s, {
        name: 'Pat Lee',
        phone: '0412 000 111',
        sites: [elm(8)],
      }),
      lou: await addClient(s, {
        name: 'Lou Ho',
        phone: '0466 123 456',
        sites: [elm(9)],
      }),
    }
    // The owner books each name again as a new client with the same
    // number, past whatever his phone showed.
    const made = {} as Record<keyof typeof old, Id<'clients'>>
    for (const [key, name, phone, at] of [
      ['kim', 'Kim Ho', '0455 444 555', elm(20)],
      ['pat', 'Pat Lee', '0412 000 111', elm(21)],
      ['lou', 'Lou Ho', '0466 123 456', elm(22)],
    ] as const) {
      const jobId = await s.owner.as.mutation(
        api.jobs.create,
        job(s, {
          newClient: typed({ name, phone }, at),
          matchCheck: sheet([old[key].clientId]),
        }),
      )
      made[key] = (await clientOfJob(s, jobId))!._id
    }
    // His phone leaves his own number and the team's out, and so does the
    // server for him: only Lou's pair is a possible duplicate.
    expect(await hints(s)).toMatchObject([
      { clientId: made.lou, otherClientId: old.lou.clientId },
    ])
    const sheetOf = (actor: TestActor, clientId: Id<'clients'>) =>
      actor.as.query(api.clientMatchHints.forClient, {
        businessId: s.businessId,
        clientId,
      })
    // Dana manages the team, knows every member's number, and sees it.
    expect(await sheetOf(s.dana, made.lou)).toMatchObject([
      { otherClientId: old.lou.clientId, evidence: ['name', 'mobile'] },
    ])
    // Kevin sees the same names and numbers in his client book, and no hint
    // on any of them, on either side: not Lou's, so the missing ones say
    // nothing about Kim's and Pat's numbers.
    for (const key of ['kim', 'pat', 'lou'] as const) {
      for (const clientId of [made[key], old[key].clientId]) {
        expect(await sheetOf(s.kevin, clientId)).toEqual([])
      }
    }
  })

  test('worked out with the team’s numbers left out, whoever booked: a subcontractor’s new client with a team member’s number on a client is noted against nobody', async () => {
    const s = await setup()
    // The office put Dana's mobile on Tom Lee, as offices do. Lou's is his.
    const tom = await addClient(s, {
      name: 'Tom Lee',
      phone: '0455 444 555',
      sites: [elm(7)],
    })
    const lou = await addClient(s, {
      name: 'Lou Ho',
      phone: '0466 123 456',
      sites: [elm(8)],
    })
    // Kevin doesn't see the roster, so on his phone and on the server both
    // numbers are the clients' own: each new caller books as typed (Likely).
    const booked = []
    for (const [name, phone, at] of [
      ['Sam Wu', '0455 444 555', elm(20)],
      ['Ann Wu', '0466 123 456', elm(21)],
    ] as const) {
      const jobId = await s.kevin.as.mutation(
        api.jobs.create,
        job(s, {
          assignedMembershipId: s.kevinId,
          newClient: typed({ name, phone }, at),
          matchCheck: sheet(),
        }),
      )
      booked.push((await clientOfJob(s, jobId))!._id)
    }
    const [sam, ann] = booked
    // Only the stranger's number is noted for the office, as the owner's own
    // booking would note it: Dana's says nothing about who Sam Wu is.
    expect(await hints(s)).toMatchObject([
      {
        clientId: ann,
        otherClientId: lou.clientId,
        evidence: ['mobile'],
        madeBy: s.kevinId,
      },
    ])
    for (const clientId of [sam, tom.clientId]) {
      expect(
        await s.owner.as.query(api.clientMatchHints.forClient, {
          businessId: s.businessId,
          clientId,
        }),
      ).toEqual([])
    }
  })

  test('worked out with the team’s numbers left out, whoever booked: a subcontractor’s booking notes what the owner’s would, where leaving them out makes a shared number one client’s', async () => {
    // Jo's field holds her mobile and Dana's, the office's doing; Bob holds
    // the same mobile alone.
    const book = async (actor: 'owner' | 'kevin') => {
      const s = await setup()
      const jo = await addClient(s, {
        name: 'Jo Bloggs',
        phone: '0412 111 222, 0455 444 555',
        sites: [elm(7)],
      })
      const bob = await addClient(s, {
        name: 'Bob Ray',
        phone: '0412 111 222',
        sites: [elm(8)],
      })
      const jobId = await s[actor].as.mutation(
        api.jobs.create,
        job(s, {
          assignedMembershipId:
            actor === 'owner' ? s.ownerMembershipId : s.kevinId,
          newClient: typed(
            { name: 'Jo Bloggs', phone: '0412 111 222' },
            elm(30),
          ),
          matchCheck: sheet(),
        }),
      )
      return { s, jo, bob, made: (await clientOfJob(s, jobId))!._id }
    }
    // The owner's own check, and his phone, leave Dana's field out whole:
    // the mobile is Bob's alone, under another name (Likely), noted.
    const byOwner = await book('owner')
    expect(await hints(byOwner.s)).toMatchObject([
      {
        clientId: byOwner.made,
        otherClientId: byOwner.bob.clientId,
        evidence: ['mobile'],
      },
    ])
    // Kevin's own check sees the mobile on Jo and Bob both, and finds no
    // possible duplicate; the office is told what the owner's booking tells
    // it all the same.
    const byKevin = await book('kevin')
    expect(await hints(byKevin.s)).toMatchObject([
      {
        clientId: byKevin.made,
        otherClientId: byKevin.bob.clientId,
        evidence: ['mobile'],
        madeBy: byKevin.s.kevinId,
      },
    ])
  })

  test('a new client with the name and address of one on a book the check can’t see whole is noted, as on a whole book', async () => {
    // Asked of the backstop itself, as Kevin with an envelope that narrows
    // his book (as in "only clients the caller may see"): the clients at
    // his own jobs, which are Jane's.
    const s = await setup()
    await insertJob(s, {
      assignedMembershipId: s.kevinId,
      scheduledAt: on(-20),
    })
    const checked = await s.kevin.as.run(async (ctx) => {
      const real = await requireActor(ctx, s.businessId)
      const env = {
        ...real,
        caps: { ...real.caps, 'clients.directory': false },
      }
      return backstop(
        ctx,
        env,
        s.businessId,
        proposedOf({ newClient: typed({ name: 'Jane Nguyen' }, WATTLE) }),
        { matchCheck: sheet(), now: Date.now() },
      )
    })
    // Likely, not Same, so it books; the strongest sign there is, noted.
    expect(checked).toEqual({
      hints: [{ otherClientId: s.jane.clientId, evidence: ['name', 'site'] }],
    })
  })

  test('Not the same: only for whoever may merge clients, and then off both sheets', async () => {
    const s = await setup()
    const tom = await hintedClient(s)
    const [hint] = await hints(s)
    const answer = {
      businessId: s.businessId,
      hintId: hint._id,
      answer: 'different' as const,
    }
    expect(
      await refusalOf(s.kevin.as.mutation(api.clientMatchHints.answer, answer)),
    ).toBe('NO_ACCESS')
    await s.owner.as.mutation(api.clientMatchHints.answer, answer)
    expect(await hints(s)).toMatchObject([
      { answer: 'different', answeredBy: s.ownerMembershipId },
    ])
    for (const clientId of [tom.clientId, s.jane.clientId]) {
      expect(
        await s.owner.as.query(api.clientMatchHints.forClient, {
          businessId: s.businessId,
          clientId,
        }),
      ).toEqual([])
    }
  })

  test('wiped from the Recycle bin with either client, however many name it', async () => {
    vi.useFakeTimers()
    const s = await setup()
    const tom = await hintedClient(s)
    // More than one read's worth, on both sides.
    await s.t.run(async (ctx) => {
      for (let i = 0; i < 250; i++) {
        const [clientId, otherClientId] =
          i % 2 === 0
            ? [tom.clientId, s.jane.clientId]
            : [s.jane.clientId, tom.clientId]
        await ctx.db.insert('clientMatchHints', {
          businessId: s.businessId,
          clientId,
          otherClientId,
          evidence: ['mobile'],
          madeAt: Date.now(),
          madeBy: s.ownerMembershipId,
        })
      }
    })
    const entryId = await s.owner.as.mutation(api.bin.deleteClient, {
      businessId: s.businessId,
      clientId: s.jane.clientId,
    })
    await s.owner.as.mutation(api.bin.wipe, {
      businessId: s.businessId,
      entryId,
    })
    await s.t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(await hints(s)).toEqual([])
  })

  test('taken back with a client by an import’s Undo', async () => {
    vi.useFakeTimers()
    const s = await setup()
    const importId = await s.t.run((ctx) =>
      ctx.db.insert('clientImports', {
        businessId: s.businessId,
        createdByMembershipId: s.ownerMembershipId,
        fileName: 'clients.csv',
        createdAt: Date.now(),
        clients: 1,
        sites: 0,
        notes: 0,
        skipped: 0,
        failed: 0,
      }),
    )
    // Imported with her mobile, and no site yet.
    const imported = await s.t.run(async (ctx) => {
      const now = Date.now()
      return ctx.db.insert('clients', {
        businessId: s.businessId,
        kind: 'person',
        name: 'Ola Imported',
        phone: '0488 123 987',
        importId,
        importedFrom: importId,
        createdAt: now,
        updatedAt: now,
      })
    })
    await s.owner.as.mutation(
      api.jobs.create,
      job(s, {
        newClient: typed(
          { name: 'Ola Booked', phone: '0488 123 987' },
          elm(70),
        ),
        matchCheck: sheet(),
      }),
    )
    expect(await hints(s)).toMatchObject([{ otherClientId: imported }])
    await s.owner.as.mutation(api.clientImports.undo, {
      businessId: s.businessId,
      importId,
    })
    await s.t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(await s.t.run((ctx) => ctx.db.get(imported))).toBeNull()
    expect(await hints(s)).toEqual([])
  })

  test('a merge answers the pair as merged, and hands the merged-away client’s others to the client it was merged into', async () => {
    const s = await setup()
    const tom = await hintedClient(s)
    // Tom is noted against others too, made by him and naming him; and one
    // of them, Ula, is noted against Jane already.
    const tess = await addClient(s, { name: 'Tess Nguyen', sites: [elm(80)] })
    const tia = await addClient(s, { name: 'Tia Nguyen', sites: [elm(81)] })
    const ula = await addClient(s, { name: 'Ula Nguyen', sites: [elm(82)] })
    const note = (
      clientId: Id<'clients'>,
      otherClientId: Id<'clients'>,
      madeAt: number,
    ) =>
      s.t.run((ctx) =>
        ctx.db.insert('clientMatchHints', {
          businessId: s.businessId,
          clientId,
          otherClientId,
          evidence: ['email'],
          madeAt,
          madeBy: s.ownerMembershipId,
        }),
      )
    const toTess = await note(tom.clientId, tess.clientId, 3)
    const fromTia = await note(tia.clientId, tom.clientId, 2)
    const janeUla = await note(s.jane.clientId, ula.clientId, 1)
    await note(tom.clientId, ula.clientId, 4)
    await s.owner.as.mutation(api.clientMerge.merge, {
      businessId: s.businessId,
      fromClientId: tom.clientId,
      intoClientId: s.jane.clientId,
    })
    const byId = new Map((await hints(s)).map((row) => [row._id, row]))
    expect([...byId.values()]).toHaveLength(4)
    expect([...byId.values()]).toContainEqual(
      expect.objectContaining({
        clientId: tom.clientId,
        otherClientId: s.jane.clientId,
        answer: 'merged',
        answeredBy: s.ownerMembershipId,
      }),
    )
    expect(byId.get(toTess)).toMatchObject({
      clientId: s.jane.clientId,
      otherClientId: tess.clientId,
    })
    expect(byId.get(fromTia)).toMatchObject({
      clientId: tia.clientId,
      otherClientId: s.jane.clientId,
    })
    // Tom's with Ula would only repeat Jane's.
    expect(byId.get(janeUla)).toMatchObject({ otherClientId: ula.clientId })
    expect(
      (
        await s.owner.as.query(api.clientMatchHints.forClient, {
          businessId: s.businessId,
          clientId: s.jane.clientId,
        })
      ).map((row) => row.otherName),
    ).toEqual(['Tess Nguyen', 'Tia Nguyen', 'Ula Nguyen'])
    expect(
      await s.owner.as.query(api.clientMatchHints.forClient, {
        businessId: s.businessId,
        clientId: tess.clientId,
      }),
    ).toMatchObject([{ otherClientId: s.jane.clientId }])
  })

  test('a merge never asks again what the office already answered: a pair set aside on the kept client stays set aside', async () => {
    const s = await setup()
    const tom = await hintedClient(s)
    const cal = await addClient(s, { name: 'Cal Nguyen', sites: [elm(83)] })
    const note = (clientId: Id<'clients'>, otherClientId: Id<'clients'>) =>
      s.t.run((ctx) =>
        ctx.db.insert('clientMatchHints', {
          businessId: s.businessId,
          clientId,
          otherClientId,
          evidence: ['email'],
          madeAt: Date.now(),
          madeBy: s.ownerMembershipId,
        }),
      )
    // Jane and Cal: Not the same, answered by the office.
    const janeCal = await note(s.jane.clientId, cal.clientId)
    await s.owner.as.mutation(api.clientMatchHints.answer, {
      businessId: s.businessId,
      hintId: janeCal,
      answer: 'different',
    })
    // Tom and Cal: still open, on Tom's sheet.
    const tomCal = await note(cal.clientId, tom.clientId)
    await s.owner.as.mutation(api.clientMerge.merge, {
      businessId: s.businessId,
      fromClientId: tom.clientId,
      intoClientId: s.jane.clientId,
    })
    for (const clientId of [s.jane.clientId, cal.clientId]) {
      expect(
        await s.owner.as.query(api.clientMatchHints.forClient, {
          businessId: s.businessId,
          clientId,
        }),
      ).toEqual([])
    }
    const left = new Map((await hints(s)).map((row) => [row._id, row]))
    expect(left.has(tomCal)).toBe(false)
    expect(left.get(janeCal)).toMatchObject({ answer: 'different' })
  })
})

// ───────────────────────────────────────────────── the record of a move

/** A booking the outbox moved onto Jane by the automatic rule, at one of
 * her own sites (`propertyId`) or at a new site for her (`newProperty`). */
function movedOntoJane(
  s: Setup,
  where: Pick<Booking, 'propertyId' | 'newProperty'>,
  evidence: Array<'name' | 'site' | 'mobile'>,
) {
  return s.owner.as.mutation(
    api.jobs.create,
    job(s, {
      ...where,
      notes: 'Caller: Tom Nguyen, 0499 888 777',
      matchCheck: {
        ...outbox(),
        applied: { clientId: s.jane.clientId, evidence },
      },
      siteCheck: nothingSeen,
    }),
  )
}

function janeNow(s: Setup) {
  return s.t.run(async (ctx) => (await ctx.db.get(s.jane.clientId))!)
}

function auditOfJob(s: Setup, jobId: Id<'jobs'>) {
  return s.t.run((ctx) =>
    ctx.db
      .query('auditLog')
      .withIndex('by_entity', (q) =>
        q.eq('entityType', 'jobs').eq('entityId', jobId),
      )
      .collect(),
  )
}

/** 2c-I's dependant, two weeks after its parent: `{ local }` resolved to
 * the parent's site, sent with the parent's `applied`. Or a second phone's
 * booking of the same caller, moved there. */
function followUpAt(s: Setup, propertyId: Id<'properties'>) {
  return s.owner.as.mutation(
    api.jobs.create,
    job(s, {
      propertyId,
      scheduledAt: on(24),
      matchCheck: {
        ...outbox(),
        applied: { clientId: s.jane.clientId, evidence: ['name', 'mobile'] },
      },
    }),
  )
}

/** A Recurring Job the outbox moved onto Jane by the automatic rule: 2c-I's
 * series parent (at a new site for her, or one of hers) or dependant (at
 * its parent's site, with the parent's `applied`), or a second phone's. */
function seriesMovedOntoJane(
  s: Setup,
  where: Pick<Series, 'propertyId' | 'newProperty'>,
  fields: Partial<Series> = {},
) {
  return s.owner.as.mutation(
    api.recurrences.create,
    series(s, {
      ...where,
      matchCheck: {
        ...outbox(),
        applied: { clientId: s.jane.clientId, evidence: ['name', 'mobile'] },
      },
      ...fields,
    }),
  )
}

/**
 * What "Book as a new client instead" (2c-J) will be built on: the audit
 * row of a booking the outbox moved onto a client (`meta.matched`), written
 * whoever sent it, and read back by `automaticMoveOf` and
 * `automaticSeriesMoveOf`.
 */
describe('the record of a move (`meta.matched`), for 2c-J', () => {
  test('as it landed: the client, the evidence, the site, whether the booking made the site, and whether she was a lead it made active', async () => {
    const s = await setup()
    await s.t.run((ctx) => ctx.db.patch(s.jane.clientId, { status: 'lead' }))
    const jobId = await movedOntoJane(
      s,
      { newProperty: { clientId: s.jane.clientId, ...elm(3) } },
      ['name', 'mobile'],
    )
    const madeSite = (await s.t.run((ctx) => ctx.db.get(jobId)))!.propertyId
    // Read before the booking made her active, so it says that it did.
    expect((await janeNow(s)).status).toBe('active')
    const move = {
      clientId: s.jane.clientId,
      evidence: ['name', 'mobile'],
      propertyId: madeSite,
      madeSite: true,
      wasLead: true,
    }
    const rows = await auditOfJob(s, jobId)
    expect(rows).toMatchObject([
      {
        action: 'job.create',
        actorMembershipId: s.ownerMembershipId,
        meta: { matched: move },
      },
    ])
    expect(rows[0].onBehalfOfMembershipId).toBeUndefined()
    expect(await s.t.run((ctx) => automaticMoveOf(ctx, jobId))).toEqual(move)

    // At one of her own sites, now she is a client: it made no site, and
    // made nobody active.
    const atHers = await movedOntoJane(s, { propertyId: s.jane.siteId }, [
      'name',
      'site',
    ])
    expect(await s.t.run((ctx) => automaticMoveOf(ctx, atHers))).toEqual({
      clientId: s.jane.clientId,
      evidence: ['name', 'site'],
      propertyId: s.jane.siteId,
    })
  })

  test('a dependant sent with its parent’s `applied`, at the site its parent made, is a move too, there, and made no site', async () => {
    const s = await setup()
    const parent = await movedOntoJane(
      s,
      { newProperty: { clientId: s.jane.clientId, ...elm(3) } },
      ['name', 'mobile'],
    )
    const madeSite = (await s.t.run((ctx) => ctx.db.get(parent)))!.propertyId
    const followUp = await followUpAt(s, madeSite)
    expect(await auditOfJob(s, followUp)).toMatchObject([
      {
        action: 'job.create',
        meta: { matched: { clientId: s.jane.clientId, propertyId: madeSite } },
      },
    ])
    expect(await s.t.run((ctx) => automaticMoveOf(ctx, followUp))).toEqual({
      clientId: s.jane.clientId,
      evidence: ['name', 'mobile'],
      propertyId: madeSite,
    })
  })

  test('a Recurring Job moved onto her is on its own record, and its visits carry none', async () => {
    const s = await setup()
    await s.t.run((ctx) => ctx.db.patch(s.jane.clientId, { status: 'lead' }))
    const recurrenceId = await seriesMovedOntoJane(s, {
      newProperty: { clientId: s.jane.clientId, ...elm(3) },
    })
    const madeSite = (await s.t.run((ctx) => ctx.db.get(recurrenceId)))!
      .propertyId
    // Read before the series made her active, so it says that it did.
    expect((await janeNow(s)).status).toBe('active')
    const move = {
      clientId: s.jane.clientId,
      evidence: ['name', 'mobile'],
      propertyId: madeSite,
      madeSite: true,
      wasLead: true,
    }
    const rows = await s.t.run((ctx) =>
      ctx.db
        .query('auditLog')
        .withIndex('by_entity', (q) =>
          q.eq('entityType', 'recurrences').eq('entityId', recurrenceId),
        )
        .collect(),
    )
    expect(rows).toMatchObject([
      {
        action: 'recurrence.create',
        actorMembershipId: s.ownerMembershipId,
        meta: { matched: move },
      },
    ])
    expect(rows[0].onBehalfOfMembershipId).toBeUndefined()
    expect(
      await s.t.run((ctx) => automaticSeriesMoveOf(ctx, recurrenceId)),
    ).toEqual(move)
    const visits = await s.t.run(async (ctx) =>
      (await ctx.db.query('jobs').collect()).filter(
        (visit) => visit.recurrenceId === recurrenceId,
      ),
    )
    expect(visits.length).toBeGreaterThan(0)
    for (const visit of visits) {
      expect(await s.t.run((ctx) => automaticMoveOf(ctx, visit._id))).toBeNull()
    }
  })

  test('a person’s own choice with the sheet open is no move: never recorded as one, and it spares no refusal', async () => {
    const s = await setup()
    const applied = {
      clientId: s.jane.clientId,
      evidence: ['email' as const],
    }
    expect(
      await refusalOf(
        s.kevin.as.mutation(
          api.jobs.create,
          job(s, {
            assignedMembershipId: s.kevinId,
            newProperty: { clientId: s.jane.clientId, ...WATTLE },
            matchCheck: { ...sheet(), applied },
          }),
        ),
      ),
    ).toMatchObject({ code: 'MATCHED_CLIENT' })
    const jobId = await s.kevin.as.mutation(
      api.jobs.create,
      job(s, {
        assignedMembershipId: s.kevinId,
        propertyId: s.jane.siteId,
        matchCheck: { ...sheet(), applied },
      }),
    )
    expect(await auditOfJob(s, jobId)).toEqual([])
    expect(await s.t.run((ctx) => automaticMoveOf(ctx, jobId))).toBeNull()
  })

  test('New site for her at an address she has, sent to her own site there, is no move: she is the client the person chose', async () => {
    const s = await setup()
    expect(
      await refusalOf(
        s.owner.as.mutation(
          api.jobs.create,
          job(s, {
            newProperty: { clientId: s.jane.clientId, ...WATTLE },
            matchCheck: outbox(),
          }),
        ),
      ),
    ).toEqual({
      code: 'MATCHED_CLIENT',
      candidates: [
        {
          clientId: s.jane.clientId,
          name: 'Jane Nguyen',
          suburb: 'Bayswater',
          propertyId: s.jane.siteId,
          evidence: ['site'],
          auto: true,
        },
      ],
    })
    // Even sent with the candidate as `applied`, as a phone might.
    const jobId = await s.owner.as.mutation(
      api.jobs.create,
      job(s, {
        propertyId: s.jane.siteId,
        matchCheck: {
          ...outbox(),
          applied: { clientId: s.jane.clientId, evidence: ['site'] },
        },
      }),
    )
    expect(await auditOfJob(s, jobId)).toEqual([])
    expect(await s.t.run((ctx) => automaticMoveOf(ctx, jobId))).toBeNull()
  })

  test('the evidence is recorded once each, in order, however often the phone repeats it', async () => {
    const s = await setup()
    const jobId = await s.kevin.as.mutation(
      api.jobs.create,
      job(s, {
        assignedMembershipId: s.kevinId,
        propertyId: s.jane.siteId,
        matchCheck: {
          ...outbox(),
          applied: {
            clientId: s.jane.clientId,
            evidence: [
              ...Array.from({ length: 4000 }, () => 'mobile' as const),
              'site',
              'name',
              'name',
            ],
          },
        },
      }),
    )
    const rows = await auditOfJob(s, jobId)
    expect(rows).toMatchObject([
      {
        action: 'job.create',
        meta: { matched: { evidence: ['name', 'site', 'mobile'] } },
      },
    ])
    expect(JSON.stringify(rows[0].meta).length).toBeLessThan(500)
  })
})

// ───────────────────────────────────────────────────────── what it reads

/**
 * Every read the backstop makes for one booking, as `table.index` for a
 * range, `table (get)` for one document, `betterAuth.user` for a sign-in
 * email: what it costs per booking, and that it never reads a whole table.
 */
async function readsOf(
  s: Setup,
  actor: TestActor,
  input: Parameters<typeof proposedOf>[0],
  checks: Partial<Parameters<typeof backstop>[4]> = {},
) {
  return actor.as.run(async (ctx) => {
    const env = await requireActor(ctx, s.businessId)
    const reads = new Set<string>()
    const tables = Object.keys(schema.tables) as Array<TableNames>
    const db = ctx.db
    const tableOf = (id: string) =>
      tables.find((table) => db.normalizeId(table, id) !== null) ?? 'unknown'
    const reader = {
      query: (table: TableNames) =>
        new Proxy(db.query(table), {
          get(target, prop, receiver) {
            if (prop !== 'withIndex') reads.add(`${table} (whole table)`)
            const value: unknown = Reflect.get(target, prop, receiver)
            if (prop === 'withIndex' && typeof value === 'function') {
              return (name: string, range?: unknown) => {
                reads.add(`${table}.${name}`)
                return Reflect.apply(value, target, [name, range]) as unknown
              }
            }
            return typeof value === 'function' ? value.bind(target) : value
          },
        }),
      get: (...args: Array<string>) => {
        reads.add(`${args.length === 2 ? args[0] : tableOf(args[0])} (get)`)
        return Reflect.apply(db.get, db, args) as Promise<unknown>
      },
      normalizeId: db.normalizeId.bind(db),
    }
    const runQuery = (ref: unknown, args: unknown) => {
      const model = (args as { model?: unknown }).model
      reads.add(typeof model === 'string' ? `betterAuth.${model}` : 'runQuery')
      return Reflect.apply(ctx.runQuery, ctx, [ref, args]) as Promise<unknown>
    }
    const proxied = { ...ctx, db: reader, runQuery } as unknown as QueryCtx
    await backstop(proxied, env, s.businessId, proposedOf(input), {
      now: Date.now(),
      ...checks,
    }).catch(() => null)
    return [...reads].sort()
  })
}

describe('what the backstop reads, per booking', () => {
  test('a new client: the client book, its contact people, the postcode’s sites, who is asking, and the jobs at the address', async () => {
    const s = await setup()
    await insertJob(s, { scheduledAt: on(40) })
    expect(
      await readsOf(
        s,
        s.owner,
        {
          newClient: typed({ name: 'Ola Park', phone: '0488 000 111' }, WATTLE),
        },
        { matchCheck: sheet(), siteCheck: nothingSeen, at: on(10) },
      ),
    ).toEqual([
      'betterAuth.user',
      'businesses (get)',
      'clientContacts.by_business',
      'clients.by_business',
      'jobs.by_property',
      'memberships (get)',
      // The owner sees the team, so the roster is read for its numbers.
      'memberships.by_business',
      'properties.by_business_and_postcode',
    ])
    // A subcontractor's book is matched without the team's numbers, so the
    // roster isn't read for them.
    expect(
      await readsOf(
        s,
        s.kevin,
        { newClient: typed({ name: 'Ola Park' }, elm(90)) },
        { matchCheck: sheet() },
      ),
    ).not.toContain('memberships.by_business')
    // Only for a possible duplicate to note, which is worked out without
    // the team's numbers whoever booked.
    expect(
      await readsOf(
        s,
        s.kevin,
        {
          newClient: typed(
            { name: 'Ola Park', phone: '0412 345 678' },
            elm(90),
          ),
        },
        { matchCheck: sheet() },
      ),
    ).toContain('memberships.by_business')
  })

  test('a new site for a client: the client and the postcode’s sites; an existing site: the site and its jobs', async () => {
    const s = await setup()
    // Add property's (`createForClient`), which books nothing: never the
    // business row, which every booking patches meanwhile.
    expect(
      await readsOf(
        s,
        s.owner,
        { newProperty: { clientId: s.jane.clientId, ...elm(90) } },
        { matchCheck: sheet() },
      ),
    ).toEqual(['clients (get)', 'properties.by_business_and_postcode'])
    // A booking's, whose time zone the site check needs.
    expect(
      await readsOf(
        s,
        s.owner,
        { newProperty: { clientId: s.jane.clientId, ...elm(90) } },
        { matchCheck: sheet(), siteCheck: nothingSeen, at: on(10) },
      ),
    ).toEqual([
      'businesses (get)',
      'clients (get)',
      'properties.by_business_and_postcode',
    ])
    expect(
      await readsOf(
        s,
        s.owner,
        { propertyId: s.jane.siteId },
        {
          matchCheck: sheet(),
          siteCheck: nothingSeen,
          at: on(10),
          series: true,
        },
      ),
    ).toEqual([
      'businesses (get)',
      'jobs.by_property',
      'properties (get)',
      'recurrences.by_property',
    ])
  })
})

/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import {
  addSession,
  createActor,
  createBusiness,
  joinBusiness,
  testApp,
} from '../test/harness'
import { SWITCH_TTL_MS } from './lib/capabilities'
import { ConvexError } from 'convex/values'
import type { FunctionArgs } from 'convex/server'
import type { Id } from './_generated/dataModel'
import type { TestActor } from '../test/harness'

/**
 * Request ids made on the phone (lib/clientRequest.ts). On one bar a booking
 * can land and its answer never come back, so the phone sends it again under
 * the id it made for the draft. The second send must get the first one's
 * record back and do nothing else: no second job number, client number, note,
 * person going, Xero queue entry or visit.
 *
 * And it must get it back whatever has changed since the first was checked —
 * the assignee removed, the site binned, the switch run out. Refusing then
 * would leave a booking the server holds looking unsent on the phone, and the
 * person would book it again by hand.
 */

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

beforeEach(() => {
  // The business syncs to Xero, so a repeat that queued its client again
  // would show. Paused, so nothing is sent and what was queued stays to read.
  vi.stubEnv('XERO_CLIENT_ID', 'test-client-id')
  vi.stubEnv('XERO_CLIENT_SECRET', 'test-client-secret')
  vi.stubEnv('XERO_TOKEN_KEYS', '1:test-key')
  vi.stubEnv('XERO_SYNC_PAUSED', 'on')
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

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
  const kevinMembershipId = await joinBusiness(
    t,
    owner,
    kevin,
    businessId,
    'subcontractor',
  )
  const jane = await t.run(async (ctx) => {
    const now = Date.now()
    const clientId = await ctx.db.insert('clients', {
      businessId,
      kind: 'person',
      name: 'Jane Smith',
      createdAt: now,
      updatedAt: now,
    })
    const propertyId = await ctx.db.insert('properties', {
      businessId,
      clientId,
      addressLine: '14 Rosewood Ave',
      suburb: 'Morley',
      state: 'WA',
      postcode: '6062',
      createdAt: now,
    })
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
    return { clientId, propertyId }
  })
  return {
    t,
    owner,
    kevin,
    businessId,
    ownerMembershipId,
    kevinMembershipId,
    clientId: jane.clientId,
    propertyId: jane.propertyId,
  }
}

type Setup = Awaited<ReturnType<typeof setup>>

/** An id as the phone makes one. */
const newKey = () => crypto.randomUUID()

type Booking = FunctionArgs<typeof api.jobs.create>
type Series = FunctionArgs<typeof api.recurrences.create>

/** A job for Kevin at Jane's, booked by whoever sends it. */
function booking(s: Setup, fields: Partial<Booking> = {}): Booking {
  return {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: s.kevinMembershipId,
    jobType: 'General Pest Control',
    price: 20000,
    scheduledAt: Date.now() + DAY,
    durationMinutes: 60,
    ...fields,
  }
}

/** A monthly series for Kevin at Jane's. */
function series(s: Setup, fields: Partial<Series> = {}): Series {
  return {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: s.kevinMembershipId,
    intervalCount: 1,
    intervalUnit: 'month',
    jobType: 'Rodents',
    price: 18000,
    anchorDate: Date.now() + DAY,
    durationMinutes: 45,
    ...fields,
  }
}

const priya = {
  clientName: 'Priya Shah',
  phone: '0412 345 678',
  email: 'priya@shah.test',
  addressLine: '88 Marine Parade',
  suburb: 'Cottesloe',
  state: 'WA',
  postcode: '6011',
}

const secondSite = {
  addressLine: '5 Banksia Road',
  suburb: 'Bayswater',
  state: 'WA',
  postcode: '6053',
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
    wipedClientRequests: await ctx.db.query('wipedClientRequests').collect(),
    scheduled: await ctx.db.system.query('_scheduled_functions').collect(),
  }))
}

function row<T extends 'jobs' | 'recurrences' | 'properties' | 'clients'>(
  s: Setup,
  id: Id<T>,
) {
  return s.t.run(async (ctx) => (await ctx.db.get(id))!)
}

function visitsOf(s: Setup, recurrenceId: Id<'recurrences'>) {
  return s.t.run((ctx) =>
    ctx.db
      .query('jobs')
      .withIndex('by_recurrence', (q) => q.eq('recurrenceId', recurrenceId))
      .collect(),
  )
}

/** The visit booked by hand with a series: the one at its start. */
async function visitAtStart(s: Setup, recurrenceId: Id<'recurrences'>) {
  const { anchorDate } = await row(s, recurrenceId)
  const visit = (await visitsOf(s, recurrenceId)).find(
    (each) => each.scheduledAt === anchorDate,
  )
  return visit!._id
}

/** The job's own visit to the Recycle bin. */
function binJob(s: Setup, jobId: Id<'jobs'>) {
  return s.owner.as.mutation(api.bin.deleteJob, {
    businessId: s.businessId,
    jobId,
  })
}

/** Gone from the database, not only from the lists. */
function isGone(s: Setup, id: Id<'jobs' | 'recurrences' | 'properties'>) {
  return s.t.run(async (ctx) => (await ctx.db.get(id)) === null)
}

/** Runs every step a wipe scheduled, to the end (needs fake timers). */
async function settle(s: Setup) {
  await s.t.finishAllScheduledFunctions(vi.runAllTimers)
}

/** What a phone holding an unanswered send asks (clientRequests.find). */
function findAs(
  who: TestActor,
  businessId: Id<'businesses'>,
  kind: 'job' | 'series' | 'site',
  clientRequestId: string,
) {
  return who.as.query(api.clientRequests.find, {
    businessId,
    clientRequestId,
    kind,
  })
}

/** Someone with a business of their own, and no place in Coastal's. */
async function rival(s: Setup) {
  const other = await createActor(s.t, { email: 'rival@other.test' })
  const { businessId, ownerMembershipId } = await createBusiness(
    s.t,
    other,
    'Other Pest',
  )
  return { ...other, businessId, ownerMembershipId }
}

/** Terence working inside Kevin's account on this session, until `expiresAt`. */
async function switchIntoKevin(s: Setup, owner: TestActor) {
  const now = Date.now()
  return s.t.run((ctx) =>
    ctx.db.insert('accountSwitches', {
      sessionId: owner.sessionId,
      businessId: s.businessId,
      realMembershipId: s.ownerMembershipId,
      targetMembershipId: s.kevinMembershipId,
      startedAt: now,
      expiresAt: now + SWITCH_TTL_MS,
    }),
  )
}

describe('a save sent twice under one id is made once', () => {
  test('a job: its id back, and no second number, client, note, person going or Xero entry', async () => {
    const s = await setup()
    const args = {
      ...booking(s, { propertyId: undefined }),
      newClient: priya,
      notes: 'Side gate code 4411.',
      alsoGoing: [s.ownerMembershipId],
      clientRequestId: newKey(),
    }

    const jobId = await s.owner.as.mutation(api.jobs.create, args)
    const after = await everything(s)
    expect(await s.owner.as.mutation(api.jobs.create, args)).toBe(jobId)
    expect(await everything(s)).toEqual(after)

    // What the first send made, once.
    const job = await row(s, jobId)
    expect(after.jobs).toHaveLength(1)
    expect(after.clients.map((c) => c.name).sort()).toEqual([
      'Jane Smith',
      'Priya Shah',
    ])
    expect(job.jobNumber).toBe(1)
    expect(after.businesses[0].nextJobNumber).toBe(2)
    expect(after.businesses[0].nextClientNumber).toBe(2)
    expect(after.notes).toHaveLength(1)
    expect(after.jobPeople).toHaveLength(1)
    const property = await row(s, job.propertyId)
    expect(after.xeroOutbox.map((r) => r.clientId)).toEqual([property.clientId])
  })

  test('a Recurring Job: no second series, and not one visit more', async () => {
    const s = await setup()
    const args = {
      ...series(s, { propertyId: undefined }),
      newProperty: { clientId: s.clientId, ...secondSite },
      notes: 'Bait stations behind the shed.',
      clientRequestId: newKey(),
    }

    const recurrenceId = await s.owner.as.mutation(api.recurrences.create, args)
    const after = await everything(s)
    const visits = await visitsOf(s, recurrenceId)
    expect(await s.owner.as.mutation(api.recurrences.create, args)).toBe(
      recurrenceId,
    )
    expect(await everything(s)).toEqual(after)

    expect(after.recurrences).toHaveLength(1)
    expect(visits.length).toBeGreaterThan(1)
    expect(await visitsOf(s, recurrenceId)).toHaveLength(visits.length)
    expect(after.notes).toHaveLength(1)
    expect(after.properties).toHaveLength(2)
  })

  test('a new client: no second client, and its number given out once', async () => {
    const s = await setup()
    const args = {
      businessId: s.businessId,
      ...priya,
      contactPerson: 'Dev Shah',
      kind: 'business' as const,
      clientRequestId: newKey(),
    }

    const propertyId = await s.owner.as.mutation(api.properties.create, args)
    const after = await everything(s)
    expect(await s.owner.as.mutation(api.properties.create, args)).toBe(
      propertyId,
    )
    expect(await everything(s)).toEqual(after)

    expect(after.clients).toHaveLength(2)
    expect(after.clientContacts).toHaveLength(1)
    expect(after.properties).toHaveLength(2)
    expect(after.businesses[0].nextClientNumber).toBe(2)
    expect(after.xeroOutbox).toHaveLength(1)
  })

  test('a site for a client: no second site', async () => {
    const s = await setup()
    const args = {
      businessId: s.businessId,
      clientId: s.clientId,
      ...secondSite,
      clientRequestId: newKey(),
    }

    const propertyId = await s.owner.as.mutation(
      api.properties.createForClient,
      args,
    )
    const after = await everything(s)
    expect(
      await s.owner.as.mutation(api.properties.createForClient, args),
    ).toBe(propertyId)
    expect(await everything(s)).toEqual(after)

    expect(after.properties).toHaveLength(2)
    expect(after.xeroOutbox).toHaveLength(1)
  })

  test('without an id, the same booking sent twice is two, as before', async () => {
    const s = await setup()
    const args = booking(s)
    const first = await s.owner.as.mutation(api.jobs.create, args)
    const second = await s.owner.as.mutation(api.jobs.create, args)
    expect(second).not.toBe(first)
    expect((await everything(s)).jobs).toHaveLength(2)
  })
})

describe('a repeat gets its record back, whatever changed since', () => {
  test('the assignee was removed: not INVALID_ASSIGNEE', async () => {
    const s = await setup()
    const job = booking(s, { clientRequestId: newKey() })
    const arrangement = series(s, { clientRequestId: newKey() })
    const jobId = await s.owner.as.mutation(api.jobs.create, job)
    const recurrenceId = await s.owner.as.mutation(
      api.recurrences.create,
      arrangement,
    )

    await s.owner.as.mutation(api.team.remove, {
      businessId: s.businessId,
      membershipId: s.kevinMembershipId,
      reassignTo: s.ownerMembershipId,
    })

    expect(await s.owner.as.mutation(api.jobs.create, job)).toBe(jobId)
    expect(await s.owner.as.mutation(api.recurrences.create, arrangement)).toBe(
      recurrenceId,
    )
    // Which is what the same booking gets as a new one.
    await expect(
      s.owner.as.mutation(api.jobs.create, booking(s)),
    ).rejects.toThrow(/INVALID_ASSIGNEE/)
  })

  test('the site or the client went to the Recycle bin: not NOT_FOUND', async () => {
    const s = await setup()
    const job = booking(s, { clientRequestId: newKey() })
    const arrangement = series(s, { clientRequestId: newKey() })
    const jobId = await s.owner.as.mutation(api.jobs.create, job)
    const recurrenceId = await s.owner.as.mutation(
      api.recurrences.create,
      arrangement,
    )
    await s.owner.as.mutation(api.bin.deleteProperty, {
      businessId: s.businessId,
      propertyId: s.propertyId,
    })

    expect(await s.owner.as.mutation(api.jobs.create, job)).toBe(jobId)
    expect(await s.owner.as.mutation(api.recurrences.create, arrangement)).toBe(
      recurrenceId,
    )
    await expect(
      s.owner.as.mutation(api.jobs.create, booking(s)),
    ).rejects.toThrow(/NOT_FOUND/)

    const site = {
      businessId: s.businessId,
      clientId: s.clientId,
      ...secondSite,
      clientRequestId: newKey(),
    }
    const siteId = await s.owner.as.mutation(
      api.properties.createForClient,
      site,
    )
    await s.owner.as.mutation(api.bin.deleteClient, {
      businessId: s.businessId,
      clientId: s.clientId,
    })
    expect(
      await s.owner.as.mutation(api.properties.createForClient, site),
    ).toBe(siteId)
    await expect(
      s.owner.as.mutation(api.properties.createForClient, {
        ...site,
        clientRequestId: undefined,
      }),
    ).rejects.toThrow(/NOT_FOUND/)
  })

  test('the record itself went to the Recycle bin: still made, not made again', async () => {
    const s = await setup()
    const job = booking(s, { clientRequestId: newKey() })
    const arrangement = series(s, { clientRequestId: newKey() })
    const client = {
      businessId: s.businessId,
      ...priya,
      clientRequestId: newKey(),
    }
    const jobId = await s.owner.as.mutation(api.jobs.create, job)
    const recurrenceId = await s.owner.as.mutation(
      api.recurrences.create,
      arrangement,
    )
    const propertyId = await s.owner.as.mutation(api.properties.create, client)

    await binJob(s, jobId)
    const [visit] = await visitsOf(s, recurrenceId)
    await s.owner.as.mutation(api.bin.deleteSeries, {
      businessId: s.businessId,
      jobId: visit._id,
    })
    await s.owner.as.mutation(api.bin.deleteProperty, {
      businessId: s.businessId,
      propertyId,
    })
    const binned = await everything(s)

    expect(await s.owner.as.mutation(api.jobs.create, job)).toBe(jobId)
    expect(await s.owner.as.mutation(api.recurrences.create, arrangement)).toBe(
      recurrenceId,
    )
    expect(await s.owner.as.mutation(api.properties.create, client)).toBe(
      propertyId,
    )
    expect(await everything(s)).toEqual(binned)
  })

  test('the record was then wiped for good: still made, and not made again', async () => {
    vi.useFakeTimers()
    const s = await setup()
    // Booked with a new client, so a second job would number a second
    // client and queue it for Xero too.
    const job = {
      ...booking(s, { propertyId: undefined }),
      newClient: priya,
      clientRequestId: newKey(),
    }
    const seriesKey = newKey()
    const arrangement = series(s, { clientRequestId: seriesKey })
    const site = {
      businessId: s.businessId,
      clientId: s.clientId,
      ...secondSite,
      clientRequestId: newKey(),
    }
    const client = {
      businessId: s.businessId,
      clientName: 'Dev Shah',
      phone: '0413 222 333',
      addressLine: '9 Ocean Street',
      suburb: 'Scarborough',
      state: 'WA',
      postcode: '6019',
      clientRequestId: newKey(),
    }
    const jobId = await s.owner.as.mutation(api.jobs.create, job)
    const recurrenceId = await s.owner.as.mutation(
      api.recurrences.create,
      arrangement,
    )
    const siteId = await s.owner.as.mutation(
      api.properties.createForClient,
      site,
    )
    const clientSiteId = await s.owner.as.mutation(
      api.properties.create,
      client,
    )
    await settle(s)

    // Each way a wipe starts. Delete now, for the job:
    await s.owner.as.mutation(api.bin.wipe, {
      businessId: s.businessId,
      entryId: await binJob(s, jobId),
    })
    await settle(s)
    // Empty bin, for the series and the site:
    const [visit] = await visitsOf(s, recurrenceId)
    await s.owner.as.mutation(api.bin.deleteSeries, {
      businessId: s.businessId,
      jobId: visit._id,
    })
    await s.owner.as.mutation(api.bin.deleteProperty, {
      businessId: s.businessId,
      propertyId: siteId,
    })
    await s.owner.as.mutation(api.bin.empty, { businessId: s.businessId })
    await settle(s)
    // And thirty days on, for the client and its site:
    const { clientId: devId } = await row(s, clientSiteId)
    const old = await s.owner.as.mutation(api.bin.deleteClient, {
      businessId: s.businessId,
      clientId: devId,
    })
    await s.t.run((ctx) =>
      ctx.db.patch(old, { deletedAt: Date.now() - 31 * DAY }),
    )
    await s.t.mutation(internal.bin.purgeExpired, {})
    await settle(s)

    for (const id of [jobId, recurrenceId, siteId, clientSiteId]) {
      expect(await isGone(s, id)).toBe(true)
    }
    const wiped = await everything(s)
    // What is kept of each: the phone's id and the gone record's, nothing
    // of the client.
    const kept = (kind: string, id: string, clientRequestId: string) => ({
      kind,
      id,
      clientRequestId,
      businessId: s.businessId,
    })
    expect(wiped.wipedClientRequests).toHaveLength(4)
    expect(wiped.wipedClientRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining(kept('job', jobId, job.clientRequestId)),
        expect.objectContaining(kept('series', recurrenceId, seriesKey)),
        expect.objectContaining(kept('site', siteId, site.clientRequestId)),
        expect.objectContaining(
          kept('site', clientSiteId, client.clientRequestId),
        ),
      ]),
    )
    for (const entry of wiped.wipedClientRequests) {
      expect(Object.keys(entry).sort()).toEqual([
        '_creationTime',
        '_id',
        'businessId',
        'clientRequestId',
        'id',
        'kind',
        'wipedAt',
      ])
    }

    // Sent again, each is told what it made, and nothing comes back.
    expect(await s.owner.as.mutation(api.jobs.create, job)).toBe(jobId)
    expect(await s.owner.as.mutation(api.recurrences.create, arrangement)).toBe(
      recurrenceId,
    )
    expect(
      await s.owner.as.mutation(api.properties.createForClient, site),
    ).toBe(siteId)
    expect(await s.owner.as.mutation(api.properties.create, client)).toBe(
      clientSiteId,
    )
    expect(await everything(s)).toEqual(wiped)

    // And asked, each was made: never "nothing was", which would free the
    // phone to send it as new.
    const find = (kind: 'job' | 'series' | 'site', key: string) =>
      findAs(s.owner, s.businessId, kind, key)
    expect(await find('job', job.clientRequestId)).toEqual({
      kind: 'job',
      id: jobId,
    })
    expect(await find('series', seriesKey)).toEqual({
      kind: 'series',
      id: recurrenceId,
    })
    expect(await find('site', site.clientRequestId)).toEqual({
      kind: 'site',
      id: siteId,
    })
    expect(await find('site', client.clientRequestId)).toEqual({
      kind: 'site',
      id: clientSiteId,
    })
  })

  test('a repeat the arguments no longer allow is refused before its lookup', async () => {
    // Convex checks the arguments before the handler runs, so a save a phone
    // still holds can only be answered while every field it carries is
    // still allowed (lib/clientRequest.ts). The refusal is no ConvexError,
    // and says nothing about the first send: `find` still knows.
    const s = await setup()
    const job = booking(s, { clientRequestId: newKey() })
    const jobId = await s.owner.as.mutation(api.jobs.create, job)
    const before = await everything(s)

    const refused = await s.owner.as
      .mutation(api.jobs.create, {
        ...job,
        retiredField: 'kept by an older phone',
      } as Booking)
      .catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(Error)
    expect(refused).not.toBeInstanceOf(ConvexError)
    expect(String(refused)).toMatch(/retiredField/)
    expect(await everything(s)).toEqual(before)
    expect(
      await findAs(s.owner, s.businessId, 'job', job.clientRequestId!),
    ).toEqual({ kind: 'job', id: jobId, propertyId: s.propertyId })
  })

  test('the switch it was booked under ran out: not SWITCH_EXPIRED', async () => {
    const s = await setup()
    const switchId = await switchIntoKevin(s, s.owner)
    const job = booking(s, { clientRequestId: newKey() })
    const arrangement = series(s, { clientRequestId: newKey() })
    const jobId = await s.owner.as.mutation(api.jobs.create, job)
    const recurrenceId = await s.owner.as.mutation(
      api.recurrences.create,
      arrangement,
    )

    await s.t.run((ctx) =>
      ctx.db.patch(switchId, { expiresAt: Date.now() - 1 }),
    )

    expect(await s.owner.as.mutation(api.jobs.create, job)).toBe(jobId)
    expect(await s.owner.as.mutation(api.recurrences.create, arrangement)).toBe(
      recurrenceId,
    )
    await expect(
      s.owner.as.mutation(api.jobs.create, booking(s)),
    ).rejects.toThrow(/SWITCH_EXPIRED/)
  })
})

describe('an id is the business’s, behind its membership', () => {
  test('someone not on the team is refused, whatever it made', async () => {
    const s = await setup()
    const other = await rival(s)
    const job = booking(s, { clientRequestId: newKey() })
    const arrangement = series(s, { clientRequestId: newKey() })
    const client = {
      businessId: s.businessId,
      ...priya,
      clientRequestId: newKey(),
    }
    const site = {
      businessId: s.businessId,
      clientId: s.clientId,
      ...secondSite,
      clientRequestId: newKey(),
    }
    await s.owner.as.mutation(api.jobs.create, job)
    await s.owner.as.mutation(api.recurrences.create, arrangement)
    await s.owner.as.mutation(api.properties.create, client)
    await s.owner.as.mutation(api.properties.createForClient, site)
    const before = await everything(s)

    for (const send of [
      () => other.as.mutation(api.jobs.create, job),
      () => other.as.mutation(api.recurrences.create, arrangement),
      () => other.as.mutation(api.properties.create, client),
      () => other.as.mutation(api.properties.createForClient, site),
    ]) {
      await expect(send()).rejects.toThrow(/NO_ACCESS/)
    }
    expect(await everything(s)).toEqual(before)
  })

  test('so is a member removed since, sending their own booking again', async () => {
    const s = await setup()
    const job = booking(s, { clientRequestId: newKey() })
    await s.kevin.as.mutation(api.jobs.create, job)
    await s.owner.as.mutation(api.team.remove, {
      businessId: s.businessId,
      membershipId: s.kevinMembershipId,
      reassignTo: s.ownerMembershipId,
    })
    // Removal ends every session they had; signed in again, they are no
    // longer a member.
    await expect(s.kevin.as.mutation(api.jobs.create, job)).rejects.toThrow(
      /Unauthenticated/,
    )
    const again = await addSession(s.t, s.kevin)
    await expect(again.as.mutation(api.jobs.create, job)).rejects.toThrow(
      /NO_ACCESS/,
    )
  })

  test('the same id in another business makes that business its own record', async () => {
    const s = await setup()
    const other = await rival(s)
    const keys = {
      client: newKey(),
      site: newKey(),
      job: newKey(),
      series: newKey(),
    }

    /** Each kind of save, sent in one business by its owner. */
    async function sendAll(
      who: TestActor,
      businessId: Id<'businesses'>,
      assignee: Id<'memberships'>,
    ) {
      const clientSite = await who.as.mutation(api.properties.create, {
        businessId,
        ...priya,
        clientRequestId: keys.client,
      })
      const { clientId } = await row(s, clientSite)
      const site = await who.as.mutation(api.properties.createForClient, {
        businessId,
        clientId,
        ...secondSite,
        clientRequestId: keys.site,
      })
      const at = {
        businessId,
        propertyId: site,
        assignedMembershipId: assignee,
      }
      const job = await who.as.mutation(
        api.jobs.create,
        booking(s, { ...at, clientRequestId: keys.job }),
      )
      const arrangement = await who.as.mutation(
        api.recurrences.create,
        series(s, { ...at, clientRequestId: keys.series }),
      )
      return { clientSite, site, job, arrangement }
    }

    const ours = await sendAll(s.owner, s.businessId, s.ownerMembershipId)
    const theirs = await sendAll(
      other,
      other.businessId,
      other.ownerMembershipId,
    )
    for (const made of ['clientSite', 'site', 'job', 'arrangement'] as const) {
      expect(theirs[made], made).not.toBe(ours[made])
      expect((await row(s, ours[made])).businessId, made).toBe(s.businessId)
      expect((await row(s, theirs[made])).businessId, made).toBe(
        other.businessId,
      )
    }
    expect((await row(s, theirs.job)).clientRequestId).toBe(keys.job)

    // And each business is answered with its own.
    for (const [who, businessId, made] of [
      [s.owner, s.businessId, ours],
      [other, other.businessId, theirs],
    ] as const) {
      expect(await findAs(who, businessId, 'job', keys.job)).toEqual({
        kind: 'job',
        id: made.job,
        propertyId: made.site,
      })
      expect(await findAs(who, businessId, 'series', keys.series)).toEqual({
        kind: 'series',
        id: made.arrangement,
        propertyId: made.site,
        firstJobId: await visitAtStart(s, made.arrangement),
      })
      expect(await findAs(who, businessId, 'site', keys.site)).toEqual({
        kind: 'site',
        id: made.site,
        propertyId: made.site,
      })
      expect(await findAs(who, businessId, 'site', keys.client)).toEqual({
        kind: 'site',
        id: made.clientSite,
        propertyId: made.clientSite,
      })
    }
  })

  test('a key read off one kind of record, sent with another, answers only for that one', async () => {
    // Every member can read a record's key. Kevin sends the owner's site key
    // with a job of his own: that makes his job, under his own rights, and
    // the owner's phone asking after its site is still told the site.
    const s = await setup()
    const key = newKey()
    const site = {
      businessId: s.businessId,
      clientId: s.clientId,
      ...secondSite,
      clientRequestId: key,
    }
    const siteId = await s.owner.as.mutation(
      api.properties.createForClient,
      site,
    )

    const kevinsJob = await s.kevin.as.mutation(
      api.jobs.create,
      booking(s, { propertyId: siteId, clientRequestId: key }),
    )

    expect(await findAs(s.owner, s.businessId, 'site', key)).toEqual({
      kind: 'site',
      id: siteId,
      propertyId: siteId,
    })
    expect(
      await s.owner.as.mutation(api.properties.createForClient, site),
    ).toBe(siteId)
    expect(await findAs(s.owner, s.businessId, 'job', key)).toEqual({
      kind: 'job',
      id: kevinsJob,
      propertyId: siteId,
    })
    expect(await findAs(s.owner, s.businessId, 'series', key)).toBeNull()
  })
})

describe('only an id as the phone makes one', () => {
  test('anything else is INVALID_REQUEST_ID, with nothing written', async () => {
    const s = await setup()
    const good = newKey()
    const before = await everything(s)
    for (const clientRequestId of [
      '',
      'job-1',
      good.toUpperCase(),
      ` ${good}`,
      `{${good}}`,
      good.replace(/-/g, ''),
      // A version 1 id (time-based), and one of the wrong variant.
      `${good.slice(0, 14)}1${good.slice(15)}`,
      `${good.slice(0, 19)}c${good.slice(20)}`,
    ]) {
      for (const send of [
        () =>
          s.owner.as.mutation(api.jobs.create, booking(s, { clientRequestId })),
        () =>
          s.owner.as.mutation(
            api.recurrences.create,
            series(s, { clientRequestId }),
          ),
        () =>
          s.owner.as.mutation(api.properties.create, {
            businessId: s.businessId,
            ...priya,
            clientRequestId,
          }),
        () =>
          s.owner.as.mutation(api.properties.createForClient, {
            businessId: s.businessId,
            clientId: s.clientId,
            ...secondSite,
            clientRequestId,
          }),
      ]) {
        await expect(send(), clientRequestId).rejects.toThrow(
          /INVALID_REQUEST_ID/,
        )
      }
    }
    expect(await everything(s)).toEqual(before)
  })
})

describe('where the id is kept', () => {
  test('on the job, never on the client or site made with it', async () => {
    const s = await setup()
    const withClient = newKey()
    const withSite = newKey()
    const a = await row(
      s,
      await s.owner.as.mutation(api.jobs.create, {
        ...booking(s, { propertyId: undefined }),
        newClient: priya,
        clientRequestId: withClient,
      }),
    )
    const b = await row(
      s,
      await s.owner.as.mutation(api.jobs.create, {
        ...booking(s, { propertyId: undefined }),
        newProperty: { clientId: s.clientId, ...secondSite },
        clientRequestId: withSite,
      }),
    )
    expect(a.clientRequestId).toBe(withClient)
    expect(b.clientRequestId).toBe(withSite)
    const madeWith = await row(s, a.propertyId)
    expect(madeWith).not.toHaveProperty('clientRequestId')
    expect(await row(s, madeWith.clientId)).not.toHaveProperty(
      'clientRequestId',
    )
    expect(await row(s, b.propertyId)).not.toHaveProperty('clientRequestId')
  })

  test('on the series, never on its visits or the site made with it', async () => {
    const s = await setup()
    const clientRequestId = newKey()
    const recurrenceId = await s.owner.as.mutation(api.recurrences.create, {
      ...series(s, { propertyId: undefined }),
      newClient: priya,
      clientRequestId,
    })
    const arrangement = await row(s, recurrenceId)
    expect(arrangement.clientRequestId).toBe(clientRequestId)
    const visits = await visitsOf(s, recurrenceId)
    expect(visits.length).toBeGreaterThan(1)
    for (const visit of visits) {
      expect(visit).not.toHaveProperty('clientRequestId')
    }
    expect(await row(s, arrangement.propertyId)).not.toHaveProperty(
      'clientRequestId',
    )
  })

  test('on the site a new client or a new site makes', async () => {
    const s = await setup()
    const forClient = newKey()
    const forSite = newKey()
    const first = await row(
      s,
      await s.owner.as.mutation(api.properties.create, {
        businessId: s.businessId,
        ...priya,
        clientRequestId: forClient,
      }),
    )
    const second = await row(
      s,
      await s.owner.as.mutation(api.properties.createForClient, {
        businessId: s.businessId,
        clientId: s.clientId,
        ...secondSite,
        clientRequestId: forSite,
      }),
    )
    expect(first.clientRequestId).toBe(forClient)
    expect(await row(s, first.clientId)).not.toHaveProperty('clientRequestId')
    expect(second.clientRequestId).toBe(forSite)
  })

  test('and nowhere when none is sent', async () => {
    const s = await setup()
    const job = await row(
      s,
      await s.owner.as.mutation(api.jobs.create, booking(s)),
    )
    expect(job).not.toHaveProperty('clientRequestId')
  })
})

describe('a repeat that differs', () => {
  test('is answered with the first, and logged by field name, never value', async () => {
    const s = await setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const job = booking(s, { clientRequestId: newKey() })
    const jobId = await s.owner.as.mutation(api.jobs.create, job)
    const client = {
      businessId: s.businessId,
      ...priya,
      clientRequestId: newKey(),
    }
    const propertyId = await s.owner.as.mutation(api.properties.create, client)
    const arrangement = series(s, { clientRequestId: newKey() })
    const recurrenceId = await s.owner.as.mutation(
      api.recurrences.create,
      arrangement,
    )
    const site = {
      businessId: s.businessId,
      clientId: s.clientId,
      ...secondSite,
      clientRequestId: newKey(),
    }
    const siteId = await s.owner.as.mutation(
      api.properties.createForClient,
      site,
    )

    // The same again logs nothing.
    await s.owner.as.mutation(api.jobs.create, job)
    await s.owner.as.mutation(api.properties.create, client)
    await s.owner.as.mutation(api.recurrences.create, arrangement)
    await s.owner.as.mutation(api.properties.createForClient, site)
    expect(warn).not.toHaveBeenCalled()

    const later = job.scheduledAt + 2 * HOUR
    expect(
      await s.owner.as.mutation(api.jobs.create, {
        ...job,
        scheduledAt: later,
      }),
    ).toBe(jobId)
    expect(
      await s.owner.as.mutation(api.properties.create, {
        ...client,
        addressLine: '1 Quiet Lane',
      }),
    ).toBe(propertyId)

    const laterStart = arrangement.anchorDate + 7 * DAY
    expect(
      await s.owner.as.mutation(api.recurrences.create, {
        ...arrangement,
        anchorDate: laterStart,
      }),
    ).toBe(recurrenceId)
    expect(
      await s.owner.as.mutation(api.properties.createForClient, {
        ...site,
        suburb: 'Maylands',
      }),
    ).toBe(siteId)

    expect((await row(s, jobId)).scheduledAt).toBe(job.scheduledAt)
    expect((await row(s, propertyId)).addressLine).toBe(priya.addressLine)
    expect((await row(s, recurrenceId)).anchorDate).toBe(arrangement.anchorDate)
    expect((await row(s, siteId)).suburb).toBe(secondSite.suburb)
    expect(warn.mock.calls).toEqual([
      [
        'clientRequest repeat differs',
        { table: 'jobs', fields: ['scheduledAt'] },
      ],
      [
        'clientRequest repeat differs',
        { table: 'properties', fields: ['addressLine'] },
      ],
      [
        'clientRequest repeat differs',
        { table: 'recurrences', fields: ['anchorDate'] },
      ],
      [
        'clientRequest repeat differs',
        { table: 'properties', fields: ['suburb'] },
      ],
    ])
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).not.toContain(String(later))
    expect(logged).not.toContain('Quiet Lane')
    expect(logged).not.toContain(String(laterStart))
    expect(logged).not.toContain('Maylands')
  })

  test('so is an edit made since: the record as it is now, not as first sent', async () => {
    // The phone sent exactly what it sent the first time. The office moved
    // the job in between, and the line can't tell that from a phone bug:
    // a lead, not proof (lib/clientRequest.ts `noteRepeat`).
    const s = await setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const job = booking(s, { clientRequestId: newKey() })
    const jobId = await s.owner.as.mutation(api.jobs.create, job)
    const moved = job.scheduledAt + 3 * HOUR
    await s.owner.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      scheduledAt: moved,
    })

    expect(await s.owner.as.mutation(api.jobs.create, job)).toBe(jobId)
    // The edit stands.
    expect((await row(s, jobId)).scheduledAt).toBe(moved)
    expect(warn.mock.calls).toEqual([
      [
        'clientRequest repeat differs',
        { table: 'jobs', fields: ['scheduledAt'] },
      ],
    ])
  })
})

describe('clientRequests.find', () => {
  test('null before, and what the id made after, in the bin or not', async () => {
    const s = await setup()
    const find = (kind: 'job' | 'series' | 'site', clientRequestId: string) =>
      findAs(s.owner, s.businessId, kind, clientRequestId)
    const [job, arrangement, client, site] = [
      newKey(),
      newKey(),
      newKey(),
      newKey(),
    ]
    const asked = [
      ['job', job],
      ['series', arrangement],
      ['site', client],
      ['site', site],
    ] as const
    for (const [kind, key] of asked) {
      expect(await find(kind, key)).toBeNull()
    }

    const jobId = await s.owner.as.mutation(
      api.jobs.create,
      booking(s, { clientRequestId: job }),
    )
    const recurrenceId = await s.owner.as.mutation(
      api.recurrences.create,
      series(s, { clientRequestId: arrangement }),
    )
    const clientSite = await s.owner.as.mutation(api.properties.create, {
      businessId: s.businessId,
      ...priya,
      clientRequestId: client,
    })
    const extraSite = await s.owner.as.mutation(
      api.properties.createForClient,
      {
        businessId: s.businessId,
        clientId: s.clientId,
        ...secondSite,
        clientRequestId: site,
      },
    )

    expect(await find('job', job)).toEqual({
      kind: 'job',
      id: jobId,
      propertyId: s.propertyId,
    })
    expect(await find('series', arrangement)).toEqual({
      kind: 'series',
      id: recurrenceId,
      propertyId: s.propertyId,
      firstJobId: await visitAtStart(s, recurrenceId),
    })
    expect(await find('site', client)).toEqual({
      kind: 'site',
      id: clientSite,
      propertyId: clientSite,
    })
    expect(await find('site', site)).toEqual({
      kind: 'site',
      id: extraSite,
      propertyId: extraSite,
    })
    // Only the kind asked about: the job's id made no site.
    expect(await find('site', job)).toBeNull()
    expect(await find('job', arrangement)).toBeNull()

    // In the bin it is still there, and so is where it was.
    await binJob(s, jobId)
    expect(await find('job', job)).toEqual({
      kind: 'job',
      id: jobId,
      propertyId: s.propertyId,
    })
  })

  test('refuses someone not on the team, and an id the phone would not make', async () => {
    const s = await setup()
    const other = await rival(s)
    const clientRequestId = newKey()
    await s.owner.as.mutation(api.jobs.create, booking(s, { clientRequestId }))
    await expect(
      findAs(other, s.businessId, 'job', clientRequestId),
    ).rejects.toThrow(/NO_ACCESS/)
    // Membership first: a stranger learns nothing, not even that the id was
    // malformed.
    await expect(findAs(other, s.businessId, 'job', 'job-1')).rejects.toThrow(
      /NO_ACCESS/,
    )
    await expect(findAs(s.owner, s.businessId, 'job', 'job-1')).rejects.toThrow(
      /INVALID_REQUEST_ID/,
    )
    // In another business it made nothing.
    expect(
      await findAs(other, other.businessId, 'job', clientRequestId),
    ).toBeNull()
  })
})

describe('clientRequests.find: where it went', () => {
  // For the phone's next step once it knows a booking was made: the site it
  // is at, for a booking kept for the same new client, and the first visit
  // the card for a Recurring Job becomes.

  test('a booking: the site it is at, however the site came', async () => {
    const s = await setup()
    const keys = {
      atSite: newKey(),
      withClient: newKey(),
      withSite: newKey(),
      series: newKey(),
    }
    const atSite = await s.owner.as.mutation(
      api.jobs.create,
      booking(s, { clientRequestId: keys.atSite }),
    )
    const withClient = await s.owner.as.mutation(api.jobs.create, {
      ...booking(s, { propertyId: undefined }),
      newClient: priya,
      clientRequestId: keys.withClient,
    })
    const withSite = await s.owner.as.mutation(api.jobs.create, {
      ...booking(s, { propertyId: undefined }),
      newProperty: { clientId: s.clientId, ...secondSite },
      clientRequestId: keys.withSite,
    })
    const recurrenceId = await s.owner.as.mutation(api.recurrences.create, {
      ...series(s, { propertyId: undefined }),
      newClient: { ...priya, clientName: 'Dev Shah' },
      clientRequestId: keys.series,
    })

    const find = (kind: 'job' | 'series', key: string) =>
      findAs(s.owner, s.businessId, kind, key)
    expect(await find('job', keys.atSite)).toEqual({
      kind: 'job',
      id: atSite,
      propertyId: s.propertyId,
    })
    // The site made with it, which is the job's own.
    const clientSite = (await row(s, withClient)).propertyId
    expect(clientSite).not.toBe(s.propertyId)
    expect(await find('job', keys.withClient)).toEqual({
      kind: 'job',
      id: withClient,
      propertyId: clientSite,
    })
    const newSite = (await row(s, withSite)).propertyId
    expect(newSite).not.toBe(s.propertyId)
    expect((await row(s, newSite)).clientId).toBe(s.clientId)
    expect(await find('job', keys.withSite)).toEqual({
      kind: 'job',
      id: withSite,
      propertyId: newSite,
    })
    const seriesSite = (await row(s, recurrenceId)).propertyId
    expect(await find('series', keys.series)).toEqual({
      kind: 'series',
      id: recurrenceId,
      propertyId: seriesSite,
      firstJobId: await visitAtStart(s, recurrenceId),
    })
  })

  test('moved since: the site it is at now, not the one it made', async () => {
    // Booked for a new client, so it made that client's site, then moved by
    // the office to Jane's before the phone asked. The answer names Jane's:
    // the phone can't take it as the site the booking made.
    const s = await setup()
    const key = newKey()
    const jobId = await s.owner.as.mutation(api.jobs.create, {
      ...booking(s, { propertyId: undefined }),
      newClient: priya,
      clientRequestId: key,
    })
    const priyasSite = (await row(s, jobId)).propertyId
    expect(priyasSite).not.toBe(s.propertyId)
    await s.owner.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      propertyId: s.propertyId,
    })

    expect(await findAs(s.owner, s.businessId, 'job', key)).toEqual({
      kind: 'job',
      id: jobId,
      propertyId: s.propertyId,
    })
  })

  test('a Recurring Job: its first visit, or none while it has none', async () => {
    const s = await setup()
    // Started more than a day ago, so its first visit is the engine's next.
    const [late, yearly] = [newKey(), newKey()]
    const lateId = await s.owner.as.mutation(
      api.recurrences.create,
      series(s, { anchorDate: Date.now() - 3 * DAY, clientRequestId: late }),
    )
    // And a yearly one started the same way, whose next visit is further
    // ahead than the engine books: no visit yet.
    const yearlyId = await s.owner.as.mutation(
      api.recurrences.create,
      series(s, {
        anchorDate: Date.now() - 3 * DAY,
        intervalUnit: 'year',
        clientRequestId: yearly,
      }),
    )

    const visits = await visitsOf(s, lateId)
    expect(visits.length).toBeGreaterThan(0)
    const earliest = visits.reduce((a, b) =>
      b.scheduledAt < a.scheduledAt ? b : a,
    )
    expect(earliest.scheduledAt).toBeGreaterThan(Date.now())
    expect(await findAs(s.owner, s.businessId, 'series', late)).toEqual({
      kind: 'series',
      id: lateId,
      propertyId: s.propertyId,
      firstJobId: earliest._id,
    })

    expect(await visitsOf(s, yearlyId)).toHaveLength(0)
    expect(await findAs(s.owner, s.businessId, 'series', yearly)).toEqual({
      kind: 'series',
      id: yearlyId,
      propertyId: s.propertyId,
    })
  })

  test('a site: itself', async () => {
    const s = await setup()
    const [client, site] = [newKey(), newKey()]
    const clientSite = await s.owner.as.mutation(api.properties.create, {
      businessId: s.businessId,
      ...priya,
      clientRequestId: client,
    })
    const extraSite = await s.owner.as.mutation(
      api.properties.createForClient,
      {
        businessId: s.businessId,
        clientId: s.clientId,
        ...secondSite,
        clientRequestId: site,
      },
    )
    expect(await findAs(s.owner, s.businessId, 'site', client)).toEqual({
      kind: 'site',
      id: clientSite,
      propertyId: clientSite,
    })
    expect(await findAs(s.owner, s.businessId, 'site', site)).toEqual({
      kind: 'site',
      id: extraSite,
      propertyId: extraSite,
    })
  })

  test('neither once the record is wiped for good: only that it was made', async () => {
    vi.useFakeTimers()
    const s = await setup()
    const keys = { job: newKey(), series: newKey(), site: newKey() }
    const jobId = await s.owner.as.mutation(
      api.jobs.create,
      booking(s, { clientRequestId: keys.job }),
    )
    const recurrenceId = await s.owner.as.mutation(
      api.recurrences.create,
      series(s, { clientRequestId: keys.series }),
    )
    const siteId = await s.owner.as.mutation(api.properties.createForClient, {
      businessId: s.businessId,
      clientId: s.clientId,
      ...secondSite,
      clientRequestId: keys.site,
    })
    await settle(s)

    await s.owner.as.mutation(api.bin.wipe, {
      businessId: s.businessId,
      entryId: await binJob(s, jobId),
    })
    await settle(s)
    const [visit] = await visitsOf(s, recurrenceId)
    await s.owner.as.mutation(api.bin.deleteSeries, {
      businessId: s.businessId,
      jobId: visit._id,
    })
    await s.owner.as.mutation(api.bin.deleteProperty, {
      businessId: s.businessId,
      propertyId: siteId,
    })
    await s.owner.as.mutation(api.bin.empty, { businessId: s.businessId })
    await settle(s)
    for (const id of [jobId, recurrenceId, siteId]) {
      expect(await isGone(s, id)).toBe(true)
    }

    for (const [kind, key, id] of [
      ['job', keys.job, jobId],
      ['series', keys.series, recurrenceId],
      ['site', keys.site, siteId],
    ] as const) {
      const found = await findAs(s.owner, s.businessId, kind, key)
      expect(found, kind).toEqual({ kind, id })
      expect(Object.keys(found!).sort(), kind).toEqual(['id', 'kind'])
    }
  })
})

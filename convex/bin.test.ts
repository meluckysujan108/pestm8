/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api, internal } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import { dayKeyOf } from './lib/dates'
import type { Id } from './_generated/dataModel'
import type { TestApp } from '../test/harness'

/**
 * The Recycle bin's groundwork (lib/bin.ts): a client, property, job or
 * Recurring Job carrying `deletedAt` is left out of every list, search and
 * count, reads as missing by id, refuses writes — and the nightly engine books
 * nothing for it. Nothing in the app can bin a row yet, so these tests set the
 * marker directly, exactly as the delete will.
 */

const DAY = 24 * 60 * 60 * 1000
const TZ = 'Australia/Perth'

async function setup() {
  const t = testApp()
  const owner = await createActor(t, { email: 'terence@coastal.test' })
  const { businessId, ownerMembershipId } = await createBusiness(t, owner)
  const kept = await seedClient(t, businessId, 'J. Nguyen', '12 Wattle Street')
  const binned = await seedClient(t, businessId, 'R. Patel', '3 Banksia Road')
  return { t, owner, businessId, ownerMembershipId, kept, binned }
}

type Setup = Awaited<ReturnType<typeof setup>>

async function seedClient(
  t: TestApp,
  businessId: Id<'businesses'>,
  name: string,
  addressLine: string,
) {
  return t.run(async (ctx) => {
    const now = Date.now()
    const clientId = await ctx.db.insert('clients', {
      businessId,
      kind: 'person',
      name,
      createdAt: now,
      updatedAt: now,
    })
    const propertyId = await ctx.db.insert('properties', {
      businessId,
      clientId,
      addressLine,
      suburb: 'Bayswater',
      state: 'WA',
      postcode: '6053',
      createdAt: now,
    })
    return { clientId, propertyId }
  })
}

/** Puts rows in the bin the way the delete will: the marker on each. */
async function bin(
  t: TestApp,
  ...ids: Array<
    Id<'clients'> | Id<'properties'> | Id<'jobs'> | Id<'recurrences'>
  >
) {
  await t.run(async (ctx) => {
    for (const id of ids) await ctx.db.patch(id, { deletedAt: Date.now() })
  })
}

async function book(
  s: Setup,
  propertyId: Id<'properties'>,
  scheduledAt: number,
) {
  return s.owner.as.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId,
    assignedMembershipId: s.ownerMembershipId,
    jobType: 'General Pest',
    price: 18000,
    scheduledAt,
    durationMinutes: 60,
  })
}

describe('a client in the bin', () => {
  test('is left out of the client list and reads as missing', async () => {
    const s = await setup()
    await bin(s.t, s.binned.clientId, s.binned.propertyId)

    const clients = await s.owner.as.query(api.clients.list, {
      businessId: s.businessId,
    })
    expect(clients.map((c) => c._id)).toEqual([s.kept.clientId])

    expect(
      await s.owner.as.query(api.clients.get, {
        businessId: s.businessId,
        clientId: s.binned.clientId,
      }),
    ).toBeNull()
    expect(
      await s.owner.as.query(api.properties.listByClient, {
        businessId: s.businessId,
        clientId: s.binned.clientId,
      }),
    ).toEqual([])
    await expect(
      s.owner.as.query(api.clients.jobHistory, {
        businessId: s.businessId,
        clientId: s.binned.clientId,
      }),
    ).rejects.toThrow(/NOT_FOUND/)
  })

  test('cannot be given a new site', async () => {
    const s = await setup()
    await bin(s.t, s.binned.clientId, s.binned.propertyId)

    await expect(
      s.owner.as.mutation(api.properties.createForClient, {
        businessId: s.businessId,
        clientId: s.binned.clientId,
        addressLine: '9 Jarrah Way',
        suburb: 'Bayswater',
        state: 'WA',
        postcode: '6053',
      }),
    ).rejects.toThrow(/NOT_FOUND/)
  })
})

describe('a property in the bin', () => {
  test('is left out of lists and search, and reads as missing', async () => {
    const s = await setup()
    await bin(s.t, s.binned.propertyId)

    const listed = await s.owner.as.query(api.properties.list, {
      businessId: s.businessId,
    })
    expect(listed.map((p) => p._id)).toEqual([s.kept.propertyId])

    const browsed = await s.owner.as.query(api.properties.search, {
      businessId: s.businessId,
      q: '',
    })
    expect(browsed.map((p) => p._id)).toEqual([s.kept.propertyId])

    const searched = await s.owner.as.query(api.properties.search, {
      businessId: s.businessId,
      q: 'Banksia',
    })
    expect(searched).toEqual([])

    expect(
      await s.owner.as.query(api.properties.get, {
        businessId: s.businessId,
        propertyId: s.binned.propertyId,
      }),
    ).toBeNull()
  })

  test('takes no new booking', async () => {
    const s = await setup()
    await bin(s.t, s.binned.propertyId)

    await expect(
      book(s, s.binned.propertyId, Date.now() + DAY),
    ).rejects.toThrow(/NOT_FOUND/)
  })
})

describe('a job in the bin', () => {
  test('is left out of every list and reads as missing', async () => {
    const s = await setup()
    const when = Date.now() + DAY
    const keptJob = await book(s, s.kept.propertyId, when)
    const binnedJob = await book(s, s.kept.propertyId, when + 60 * 60 * 1000)
    await bin(s.t, binnedJob)

    const { jobs } = await s.owner.as.query(api.jobs.list, {
      businessId: s.businessId,
    })
    expect(jobs.map((j) => j._id)).toEqual([keptJob])

    const day = await s.owner.as.query(api.jobs.listDay, {
      businessId: s.businessId,
      dayKey: dayKeyOf(when, TZ),
    })
    expect(day.map((j) => j._id)).toEqual([keptJob])

    const history = await s.owner.as.query(api.properties.jobHistory, {
      businessId: s.businessId,
      propertyId: s.kept.propertyId,
    })
    expect(history.map((j) => j._id)).toEqual([keptJob])

    const clientHistory = await s.owner.as.query(api.clients.jobHistory, {
      businessId: s.businessId,
      clientId: s.kept.clientId,
    })
    expect(clientHistory.map((j) => j._id)).toEqual([keptJob])

    expect(
      await s.owner.as.query(api.jobs.get, {
        businessId: s.businessId,
        jobId: binnedJob,
      }),
    ).toBeNull()
  })

  test('is not edited until it is restored', async () => {
    const s = await setup()
    const jobId = await book(s, s.kept.propertyId, Date.now() + DAY)
    await bin(s.t, jobId)

    await expect(
      s.owner.as.mutation(api.jobs.cancel, {
        businessId: s.businessId,
        jobId,
      }),
    ).rejects.toThrow(/NOT_FOUND/)
  })

  test('cannot be moved onto a property in the bin', async () => {
    const s = await setup()
    const jobId = await book(s, s.kept.propertyId, Date.now() + DAY)
    await bin(s.t, s.binned.propertyId)

    await expect(
      s.owner.as.mutation(api.jobs.update, {
        businessId: s.businessId,
        jobId,
        propertyId: s.binned.propertyId,
      }),
    ).rejects.toThrow(/NOT_FOUND/)
  })
})

describe('a Recurring Job and the nightly engine', () => {
  async function weekly(s: Setup, propertyId: Id<'properties'>) {
    await s.owner.as.mutation(api.recurrences.create, {
      businessId: s.businessId,
      propertyId,
      assignedMembershipId: s.ownerMembershipId,
      intervalCount: 1,
      intervalUnit: 'week',
      jobType: 'Rodents',
      price: 18000,
      anchorDate: Date.now() + DAY,
      durationMinutes: 45,
    })
    return s.t.run(async (ctx) => {
      const series = await ctx.db
        .query('recurrences')
        .withIndex('by_property', (q) => q.eq('propertyId', propertyId))
        .unique()
      const visits = await ctx.db
        .query('jobs')
        .withIndex('by_recurrence', (q) => q.eq('recurrenceId', series!._id))
        .collect()
      return { seriesId: series!._id, visits }
    })
  }

  async function visitsOf(s: Setup, seriesId: Id<'recurrences'>) {
    return s.t.run((ctx) =>
      ctx.db
        .query('jobs')
        .withIndex('by_recurrence', (q) => q.eq('recurrenceId', seriesId))
        .collect(),
    )
  }

  test('a binned series is not listed or counted', async () => {
    const s = await setup()
    await weekly(s, s.kept.propertyId)
    const { seriesId } = await weekly(s, s.binned.propertyId)
    await bin(s.t, seriesId)

    const listed = await s.owner.as.query(api.recurrences.listForBusiness, {
      businessId: s.businessId,
    })
    expect(listed.map((r) => r._id)).not.toContain(seriesId)
    expect(listed).toHaveLength(1)

    const view = await s.owner.as.query(api.jobs.listRecurring, {
      businessId: s.businessId,
    })
    expect(view.seriesCount).toBe(1)
  })

  test('books nothing for a binned series', async () => {
    const s = await setup()
    const { seriesId, visits } = await weekly(s, s.kept.propertyId)
    // Take the projections away, as if the horizon had moved on.
    await s.t.run(async (ctx) => {
      for (const v of visits.filter((j) => j.status === 'recurring')) {
        await ctx.db.delete(v._id)
      }
    })
    const before = (await visitsOf(s, seriesId)).length
    await bin(s.t, seriesId)

    await s.t.mutation(internal.recurrences.materialiseAll, {})
    expect(await visitsOf(s, seriesId)).toHaveLength(before)
  })

  test('books nothing at a binned property, even for a series left live', async () => {
    const s = await setup()
    const { seriesId, visits } = await weekly(s, s.binned.propertyId)
    await s.t.run(async (ctx) => {
      for (const v of visits.filter((j) => j.status === 'recurring')) {
        await ctx.db.delete(v._id)
      }
    })
    const before = (await visitsOf(s, seriesId)).length
    await bin(s.t, s.binned.propertyId)

    await s.t.mutation(internal.recurrences.materialiseAll, {})
    expect(await visitsOf(s, seriesId)).toHaveLength(before)
  })

  test('a binned visit still holds its place, so it is not booked again', async () => {
    const s = await setup()
    const { seriesId, visits } = await weekly(s, s.kept.propertyId)
    const projected = visits.find((j) => j.status === 'recurring')!
    await bin(s.t, projected._id)

    await s.t.mutation(internal.recurrences.materialiseAll, {})
    const after = await visitsOf(s, seriesId)
    expect(after).toHaveLength(visits.length)
    expect(
      after.filter(
        (j) =>
          (j.occurrenceAt ?? j.scheduledAt) ===
          (projected.occurrenceAt ?? projected.scheduledAt),
      ),
    ).toHaveLength(1)
  })
})

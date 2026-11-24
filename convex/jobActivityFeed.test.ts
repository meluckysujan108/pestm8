/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api } from './_generated/api'
import {
  createActor,
  createBusiness,
  joinBusiness,
  testApp,
} from '../test/harness'
import type { Id } from './_generated/dataModel'
import type { FeedEntry } from './jobActivity'
import type { TestActor } from '../test/harness'

/**
 * The owner's Settings → Activity (convex/jobActivity.ts `feed`): every
 * change to every job in the business, newest first, a page at a time, read
 * line by line exactly as a job's own Activity reads it.
 *
 * Terence owns the business. Kevin is a subcontractor who leads some work
 * and cannot see prices. Ali is a contractor, who manages a team but not the
 * business.
 */

const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE

beforeEach(() => {
  // Only the clock: each change a minute after the last, so "newest first"
  // never rests on two lines written in the same millisecond.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-24T01:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

function tick() {
  vi.setSystemTime(Date.now() + MINUTE)
}

async function setup() {
  const t = testApp()
  const terence = await createActor(t, {
    email: 'terence@pestm8.test',
    name: 'Terence',
  })
  const { businessId, ownerMembershipId } = await createBusiness(t, terence)
  const kevin = await createActor(t, {
    email: 'kevin@pestm8.test',
    name: 'Kevin',
  })
  const kevinId = await joinBusiness(
    t,
    terence,
    kevin,
    businessId,
    'subcontractor',
  )
  const ali = await createActor(t, { email: 'ali@pestm8.test', name: 'Ali' })
  const aliId = await joinBusiness(t, terence, ali, businessId, 'contractor')
  const { clientId, propertyId, otherPropertyId } = await t.run(async (ctx) => {
    const now = Date.now()
    const client = await ctx.db.insert('clients', {
      businessId,
      kind: 'person',
      name: 'J. Nguyen',
      createdAt: now,
      updatedAt: now,
    })
    const site = (addressLine: string) =>
      ctx.db.insert('properties', {
        businessId,
        clientId: client,
        addressLine,
        suburb: 'Bayswater',
        state: 'WA',
        postcode: '6053',
        createdAt: now,
      })
    return {
      clientId: client,
      propertyId: await site('12 Wattle Street'),
      otherPropertyId: await site('14 Acacia Avenue'),
    }
  })
  return {
    t,
    terence,
    kevin,
    ali,
    businessId,
    ownerId: ownerMembershipId,
    kevinId,
    aliId,
    clientId,
    propertyId,
    otherPropertyId,
  }
}

type Setup = Awaited<ReturnType<typeof setup>>

async function book(
  s: Setup,
  opts: { lead?: Id<'memberships'>; jobType?: string } = {},
) {
  tick()
  return s.terence.as.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: opts.lead ?? s.ownerId,
    jobType: opts.jobType ?? 'General Pest Control',
    price: 19500,
    scheduledAt: Date.now() + 2 * DAY,
    durationMinutes: 60,
  })
}

async function lengthen(
  s: Setup,
  who: TestActor,
  jobId: Id<'jobs'>,
  durationMinutes: number,
) {
  tick()
  await who.as.mutation(api.jobs.update, {
    businessId: s.businessId,
    jobId,
    durationMinutes,
  })
}

function feed(
  s: Setup,
  who: TestActor = s.terence,
  opts: { staffId?: string; numItems?: number; cursor?: string | null } = {},
) {
  return who.as.query(api.jobActivity.feed, {
    businessId: s.businessId,
    ...(opts.staffId !== undefined && { staffId: opts.staffId }),
    paginationOpts: {
      numItems: opts.numItems ?? 30,
      cursor: opts.cursor ?? null,
    },
  })
}

/** Every page, followed to the end. */
async function wholeFeed(s: Setup, numItems: number) {
  const lines: Array<FeedEntry> = []
  let cursor: string | null = null
  for (let pages = 0; pages < 20; pages++) {
    const read = await feed(s, s.terence, { numItems, cursor })
    lines.push(...read.page)
    if (read.isDone) return { lines, pages: pages + 1 }
    cursor = read.continueCursor
  }
  throw new Error('the feed never ended')
}

describe('who reads it', () => {
  test('the owner, whichever of their views the device is in', async () => {
    const s = await setup()
    // Kevin's job, and the owner's device in My jobs (every device opens
    // there): the business's log is still every job's.
    const jobId = await book(s, { lead: s.kevinId })
    await lengthen(s, s.kevin, jobId, 90)

    const read = await feed(s)
    expect(read.page.map((line) => [line.action, line.by.name])).toEqual([
      ['job.update', 'Kevin'],
      ['job.create', 'Terence'],
    ])
  })

  test('nobody but the owner', async () => {
    const s = await setup()
    await book(s, { lead: s.kevinId })

    // Kevin leads the job, and still may not read the business's log.
    await expect(feed(s, s.kevin)).rejects.toThrow(/NO_ACCESS/)
    // A contractor manages a team, not the business.
    await expect(feed(s, s.ali)).rejects.toThrow(/NO_ACCESS/)
  })

  test('not while the owner is working in someone else’s account', async () => {
    const s = await setup()
    await book(s, { lead: s.kevinId })
    await s.terence.as.mutation(api.views.set, {
      businessId: s.businessId,
      view: { kind: 'account', membershipId: s.kevinId },
    })

    await expect(feed(s)).rejects.toThrow(/NO_ACCESS/)
  })
})

describe('a page at a time', () => {
  test('newest first, every line once, across pages', async () => {
    const s = await setup()
    const first = await book(s)
    const second = await book(s, { jobType: 'Termite Inspection' })
    await lengthen(s, s.terence, first, 90)
    await lengthen(s, s.terence, second, 120)
    await lengthen(s, s.terence, first, 30)

    const { lines, pages } = await wholeFeed(s, 2)
    expect(pages).toBe(3)
    expect(lines).toHaveLength(5)
    expect(new Set(lines.map((line) => line._id)).size).toBe(5)
    const at = lines.map((line) => line.at)
    expect(at).toEqual([...at].sort((a, b) => b - a))
    expect(
      lines.map((line) => [line.jobId, line.action, line.changes]),
    ).toEqual([
      [first, 'job.update', [{ field: 'durationMinutes', from: 90, to: 30 }]],
      [second, 'job.update', [{ field: 'durationMinutes', from: 60, to: 120 }]],
      [first, 'job.update', [{ field: 'durationMinutes', from: 60, to: 90 }]],
      [second, 'job.create', []],
      [first, 'job.create', []],
    ])
  })

  test('only this business’s lines', async () => {
    const s = await setup()
    await book(s)
    // Another business, with history of its own.
    const other = await createActor(s.t, {
      email: 'other@pestm8.test',
      name: 'Other',
    })
    const { businessId: elsewhere, ownerMembershipId } = await createBusiness(
      s.t,
      other,
      'Elsewhere Pest',
    )
    await s.t.run(async (ctx) => {
      const now = Date.now()
      const clientId = await ctx.db.insert('clients', {
        businessId: elsewhere,
        kind: 'person',
        name: 'Someone Else',
        createdAt: now,
        updatedAt: now,
      })
      await ctx.db.insert('properties', {
        businessId: elsewhere,
        clientId,
        addressLine: '1 Other Road',
        suburb: 'Midland',
        state: 'WA',
        postcode: '6056',
        createdAt: now,
      })
    })
    const siteId = await s.t.run(
      async (ctx) =>
        (await ctx.db
          .query('properties')
          .withIndex('by_business', (q) => q.eq('businessId', elsewhere))
          .first())!._id,
    )
    await other.as.mutation(api.jobs.create, {
      businessId: elsewhere,
      propertyId: siteId,
      assignedMembershipId: ownerMembershipId,
      jobType: 'General Pest Control',
      price: 19500,
      scheduledAt: Date.now() + DAY,
      durationMinutes: 60,
    })

    const read = await feed(s)
    expect(read.page).toHaveLength(1)
    expect(read.page[0].job).toMatchObject({ client: 'J. Nguyen' })
  })
})

describe('what a line says', () => {
  test('which job: what it is, for whom and when', async () => {
    const s = await setup()
    const jobId = await book(s)
    const job = await s.t.run((ctx) => ctx.db.get(jobId))

    const [line] = (await feed(s)).page
    expect(line.jobId).toBe(jobId)
    expect(line.job).toEqual({
      state: 'open',
      jobType: 'General Pest Control',
      client: 'J. Nguyen',
      suburb: 'Bayswater',
      scheduledAt: job!.scheduledAt,
    })
  })

  test('word for word what the job’s own Activity says', async () => {
    const s = await setup()
    const jobId = await book(s, { lead: s.kevinId })
    tick()
    await s.terence.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      price: 22000,
      propertyId: s.otherPropertyId,
      assignedMembershipId: s.ownerId,
    })
    tick()
    await s.terence.as.mutation(api.payments.record, {
      businessId: s.businessId,
      jobId,
      method: 'cash',
      amount: 5000,
      clientRequestId: crypto.randomUUID(),
    })

    const own = await s.terence.as.query(api.jobActivity.list, {
      businessId: s.businessId,
      jobId,
    })
    const page = (await feed(s)).page
    expect(page.map(({ job: _job, jobId: _jobId, ...line }) => line)).toEqual(
      own!.entries,
    )
    // The owner sees every figure, as on the job.
    expect(page[0].payment).toEqual({
      method: 'cash',
      amount: 5000,
      deposit: true,
    })
    expect(page[1].changes).toContainEqual({
      field: 'price',
      from: 19500,
      to: 22000,
    })
  })

  test('an address since put in the Recycle bin is another address', async () => {
    const s = await setup()
    const jobId = await book(s)
    tick()
    await s.terence.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      propertyId: s.otherPropertyId,
    })
    tick()
    await s.terence.as.mutation(api.bin.deleteProperty, {
      businessId: s.businessId,
      propertyId: s.propertyId,
    })

    const moved = (await feed(s)).page.find(
      (line) => line.action === 'job.update',
    )
    expect(moved?.changes).toEqual([
      { field: 'property', from: null, to: '14 Acacia Avenue, Bayswater' },
    ])
  })
})

describe('a job that isn’t there to open', () => {
  test('in the Recycle bin: named, and said to be there', async () => {
    const s = await setup()
    const jobId = await book(s)
    tick()
    await s.terence.as.mutation(api.bin.deleteClient, {
      businessId: s.businessId,
      clientId: s.clientId,
    })

    const page = (await feed(s)).page
    expect(page.map((line) => [line.action, line.binRoot])).toEqual([
      ['bin.delete', 'client'],
      ['job.create', null],
    ])
    // Every line of it says so, not only the one that deleted it.
    for (const line of page) {
      expect(line.jobId).toBe(jobId)
      expect(line.job).toMatchObject({
        state: 'binned',
        jobType: 'General Pest Control',
        client: 'J. Nguyen',
        suburb: 'Bayswater',
      })
    }
  })

  test('restored from the Recycle bin, it opens again', async () => {
    const s = await setup()
    const jobId = await book(s)
    tick()
    const entryId = await s.terence.as.mutation(api.bin.deleteJob, {
      businessId: s.businessId,
      jobId,
    })
    tick()
    await s.terence.as.mutation(api.bin.restore, {
      businessId: s.businessId,
      entryId,
    })

    const page = (await feed(s)).page
    expect(page.map((line) => line.action)).toEqual([
      'bin.restore',
      'bin.delete',
      'job.create',
    ])
    expect(page.every((line) => line.job.state === 'open')).toBe(true)
  })

  test('gone for good: said to be gone, and nothing else about it', async () => {
    const s = await setup()
    const jobId = await book(s)
    // A wipe still under way: the job is gone, a line of its history not
    // yet (bin.ts drops the history first, a step at a time).
    await s.t.run((ctx) => ctx.db.delete('jobs', jobId))

    const [line] = (await feed(s)).page
    expect(line.jobId).toBe(jobId)
    expect(line.job).toEqual({ state: 'gone' })
    expect(line.by).toEqual({ name: 'Terence', you: true })
  })
})

describe('one person’s changes', () => {
  test('only what they changed themselves', async () => {
    const s = await setup()
    const jobId = await book(s, { lead: s.kevinId })
    await lengthen(s, s.kevin, jobId, 90)
    await lengthen(s, s.terence, jobId, 120)
    await lengthen(s, s.kevin, jobId, 45)

    const kevins = (await feed(s, s.terence, { staffId: s.kevinId })).page
    expect(kevins.map((line) => line.changes)).toEqual([
      [{ field: 'durationMinutes', from: 120, to: 45 }],
      [{ field: 'durationMinutes', from: 60, to: 90 }],
    ])
    expect(kevins.every((line) => line.by.name === 'Kevin')).toBe(true)

    const terences = (await feed(s, s.terence, { staffId: s.ownerId })).page
    expect(terences.map((line) => line.action)).toEqual([
      'job.update',
      'job.create',
    ])
  })

  test('a change made in their account is the person’s who made it', async () => {
    const s = await setup()
    const jobId = await book(s, { lead: s.kevinId })
    await s.terence.as.mutation(api.views.set, {
      businessId: s.businessId,
      view: { kind: 'account', membershipId: s.kevinId },
    })
    await lengthen(s, s.terence, jobId, 120)
    await s.terence.as.mutation(api.views.set, {
      businessId: s.businessId,
      view: { kind: 'everyone' },
    })

    expect((await feed(s, s.terence, { staffId: s.kevinId })).page).toEqual([])
    const [mine] = (await feed(s, s.terence, { staffId: s.ownerId })).page
    expect(mine).toMatchObject({
      action: 'job.update',
      by: { name: 'Terence', you: true },
      inAccountOf: { name: 'Kevin', you: false },
    })
  })

  test('a page at a time, as the whole log is', async () => {
    const s = await setup()
    const jobId = await book(s, { lead: s.kevinId })
    for (const minutes of [70, 80, 90]) {
      await lengthen(s, s.kevin, jobId, minutes)
      await lengthen(s, s.terence, jobId, minutes + 5)
    }

    const first = await feed(s, s.terence, { staffId: s.kevinId, numItems: 2 })
    expect(first.page).toHaveLength(2)
    expect(first.isDone).toBe(false)
    const rest = await feed(s, s.terence, {
      staffId: s.kevinId,
      numItems: 2,
      cursor: first.continueCursor,
    })
    expect(
      [...first.page, ...rest.page].map((line) => line.changes[0]),
    ).toEqual([
      { field: 'durationMinutes', from: 85, to: 90 },
      { field: 'durationMinutes', from: 75, to: 80 },
      { field: 'durationMinutes', from: 60, to: 70 },
    ])
  })

  test('someone a link names who isn’t anyone here: nothing, not a refusal', async () => {
    const s = await setup()
    await book(s)

    expect(
      await feed(s, s.terence, { staffId: 'not-a-membership-id' }),
    ).toEqual({ page: [], isDone: true, continueCursor: '' })
  })
})

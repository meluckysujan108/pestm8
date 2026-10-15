/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import { startOfDayInZone, todayKeyInZone } from './lib/dates'
import type { Id } from './_generated/dataModel'
import type { TestActor } from '../test/harness'

/**
 * The paged Job tab (`jobs.listPage`), its caption (`jobs.listCounts`), the
 * status filter on the bounded list (`jobs.list`), and the flag that tells
 * the app which of the two to read (`access.me.listsEverything`).
 *
 * What convex-test cannot show: Convex ties a real cursor to the exact query
 * that made it, and convex-test's cursors are positions. That is why
 * `listPage` filters on nothing that depends on who is asking — and why the
 * scope tests below are about which list answers, not about cursors.
 */

const DAY = 24 * 60 * 60 * 1000

async function setup() {
  const t = testApp()
  const owner = await createActor(t, { email: 'terence@coastal.test' })
  const { businessId, ownerMembershipId } = await createBusiness(t, owner)
  const propertyId = await t.run(async (ctx) => {
    const now = Date.now()
    const clientId = await ctx.db.insert('clients', {
      businessId,
      kind: 'person',
      name: 'J. Nguyen',
      createdAt: now,
      updatedAt: now,
    })
    return ctx.db.insert('properties', {
      businessId,
      clientId,
      addressLine: '12 Wattle Street',
      suburb: 'Bayswater',
      state: 'WA',
      postcode: '6053',
      createdAt: now,
    })
  })
  return { t, owner, businessId, ownerMembershipId, propertyId }
}

type Setup = Awaited<ReturnType<typeof setup>>

async function join(s: Setup, invitee: TestActor) {
  const { url } = await s.owner.as.action(api.invitations.create, {
    businessId: s.businessId,
    email: invitee.email,
    role: 'subcontractor',
  })
  await invitee.as.action(api.invitations.redeem, {
    token: url.split('/join/')[1],
  })
  const membership = await s.t.run(async (ctx) =>
    ctx.db
      .query('memberships')
      .withIndex('by_user_business', (q) =>
        q.eq('userId', invitee.userId).eq('businessId', s.businessId),
      )
      .unique(),
  )
  return membership!._id
}

function book(s: Setup, scheduledAt: number, assignedMembershipId?: string) {
  return s.owner.as.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: (assignedMembershipId ??
      s.ownerMembershipId) as Id<'memberships'>,
    jobType: 'General Pest Control',
    price: 20000,
    scheduledAt,
    durationMinutes: 60,
  })
}

/** A projected visit, as the engine inserts them: newest of all. */
function project(s: Setup, scheduledAt: number) {
  return s.t.run(async (ctx) =>
    ctx.db.insert('jobs', {
      businessId: s.businessId,
      propertyId: s.propertyId,
      assignedMembershipId: s.ownerMembershipId,
      jobType: 'General Pest Control',
      price: 20000,
      scheduledAt,
      durationMinutes: 60,
      status: 'recurring',
      createdAt: Date.now(),
    }),
  )
}

function page(
  actor: TestActor,
  businessId: Id<'businesses'>,
  opts: {
    numItems: number
    cursor?: string | null
    status?: 'pending' | 'booked' | 'completed' | 'invoiced' | 'cancelled'
  },
) {
  return actor.as.query(api.jobs.listPage, {
    businessId,
    ...(opts.status ? { status: opts.status } : {}),
    paginationOpts: { numItems: opts.numItems, cursor: opts.cursor ?? null },
  })
}

/** Every page, followed to the end. */
async function everyPage(
  actor: TestActor,
  businessId: Id<'businesses'>,
  numItems: number,
  status?: 'pending' | 'booked' | 'completed' | 'invoiced' | 'cancelled',
) {
  const ids: Array<Id<'jobs'>> = []
  let cursor: string | null = null
  for (let i = 0; i < 50; i++) {
    const p = await page(actor, businessId, { numItems, cursor, status })
    ids.push(...p.page.map((job) => job._id))
    if (p.isDone) return ids
    cursor = p.continueCursor
  }
  throw new Error('never finished')
}

describe('the paged Job tab', () => {
  test('pages newest booked first, joining each page onto the last', async () => {
    const s = await setup()
    // Booked in this order, for days in the opposite order: pages follow
    // when each was booked, and stay in that order within a page — the
    // card list decorates them without re-sorting by date.
    const booked = []
    for (let i = 0; i < 5; i++)
      booked.push(await book(s, Date.now() + (30 - i) * DAY))

    const ids = await everyPage(s.owner, s.businessId, 2)
    expect(ids).toEqual([...booked].reverse())
  })

  test('steps over projections and the Recycle bin without coming back short', async () => {
    const s = await setup()
    const older = await book(s, Date.now() + DAY)
    const binned = await book(s, Date.now() + 2 * DAY)
    await s.t.run(async (ctx) =>
      ctx.db.patch(binned, { deletedAt: Date.now() }),
    )
    // Six months of projections inserted after every booking: the newest
    // rows of the table, all of them stepped over.
    for (let i = 0; i < 30; i++) await project(s, Date.now() + i * DAY)
    const newer = await book(s, Date.now() + 3 * DAY)

    const first = await page(s.owner, s.businessId, { numItems: 2 })
    expect(first.page.map((job) => job._id)).toEqual([newer, older])
    expect(first.page.every((job) => job.status !== 'recurring')).toBe(true)
  })

  test('filters by status on the server, and leaves the Recycle bin out there too', async () => {
    const s = await setup()
    const kept = await book(s, Date.now() + DAY)
    const binned = await book(s, Date.now() + 2 * DAY)
    await book(s, Date.now() + 3 * DAY)
    for (const jobId of [kept, binned]) {
      await s.owner.as.mutation(api.jobs.cancel, {
        businessId: s.businessId,
        jobId,
      })
    }
    await s.t.run(async (ctx) =>
      ctx.db.patch(binned, { deletedAt: Date.now() }),
    )

    const ids = await everyPage(s.owner, s.businessId, 1, 'cancelled')
    expect(ids).toEqual([kept])
  })

  test('cuts a page down to a sane size whatever is asked', async () => {
    const s = await setup()
    await s.t.run(async (ctx) => {
      for (let i = 0; i < 70; i++) {
        await ctx.db.insert('jobs', {
          businessId: s.businessId,
          propertyId: s.propertyId,
          assignedMembershipId: s.ownerMembershipId,
          jobType: 'General Pest Control',
          price: 20000,
          scheduledAt: Date.now() + i * DAY,
          durationMinutes: 60,
          status: 'booked',
          createdAt: Date.now(),
        })
      }
    })
    const p = await page(s.owner, s.businessId, { numItems: 10_000 })
    expect(p.page.length).toBeLessThanOrEqual(60)
    expect(p.isDone).toBe(false)
  })

  test('carries the people also going, read per job', async () => {
    const s = await setup()
    const kevin = await createActor(s.t, { email: 'kevin@coastal.test' })
    const kevinId = await join(s, kevin)
    const jobId = await book(s, Date.now() + 400 * DAY)
    await book(s, Date.now() - 400 * DAY)
    await s.owner.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      alsoGoing: [kevinId],
    })

    const p = await page(s.owner, s.businessId, { numItems: 10 })
    const shared = p.page.find((job) => job._id === jobId)
    expect(shared?.alsoGoing.map((person) => person._id)).toEqual([kevinId])
  })
})

describe('which list answers', () => {
  test('a subcontractor gets an empty, finished page and reads the bounded list', async () => {
    const s = await setup()
    const kevin = await createActor(s.t, { email: 'kevin@coastal.test' })
    const kevinId = await join(s, kevin)
    const his = await book(s, Date.now() + DAY, kevinId)
    await book(s, Date.now() + 2 * DAY)

    const me = await kevin.as.query(api.access.me, { businessId: s.businessId })
    expect(me.listsEverything).toBe(false)
    expect(await page(kevin, s.businessId, { numItems: 24 })).toEqual({
      page: [],
      isDone: true,
      continueCursor: '',
    })
    expect(
      await kevin.as.query(api.jobs.listCounts, { businessId: s.businessId }),
    ).toBeNull()

    const { jobs } = await kevin.as.query(api.jobs.list, {
      businessId: s.businessId,
    })
    expect(jobs.map((job) => job._id)).toEqual([his])
  })

  test('the owner in "Just my jobs" moves to the bounded list, and back', async () => {
    const s = await setup()
    await book(s, Date.now() + DAY)
    const me = () =>
      s.owner.as.query(api.access.me, { businessId: s.businessId })

    expect((await me()).listsEverything).toBe(true)
    expect(
      (await page(s.owner, s.businessId, { numItems: 24 })).page,
    ).toHaveLength(1)

    await s.owner.as.mutation(api.views.set, {
      businessId: s.businessId,
      view: { kind: 'mine' },
    })
    expect((await me()).listsEverything).toBe(false)
    expect((await page(s.owner, s.businessId, { numItems: 24 })).page).toEqual(
      [],
    )

    await s.owner.as.mutation(api.views.set, {
      businessId: s.businessId,
      view: { kind: 'everyone' },
    })
    expect((await me()).listsEverything).toBe(true)
  })

  test('a subcontractor who may see every schedule pages the whole business', async () => {
    const s = await setup()
    const kevin = await createActor(s.t, { email: 'kevin@coastal.test' })
    const kevinId = await join(s, kevin)
    await s.owner.as.mutation(api.memberships.setGrants, {
      businessId: s.businessId,
      membershipId: kevinId,
      grants: {
        switchInto: null,
        clientDirectory: true,
        prices: false,
        otherSchedules: true,
      },
    })
    await book(s, Date.now() + DAY, kevinId)
    await book(s, Date.now() + 2 * DAY)

    const me = await kevin.as.query(api.access.me, { businessId: s.businessId })
    expect(me.listsEverything).toBe(true)
    const p = await page(kevin, s.businessId, { numItems: 24 })
    expect(p.page).toHaveLength(2)
    // Prices stay hidden from someone not granted them, on every list.
    expect(p.page.every((job) => job.price === 0)).toBe(true)
  })
})

describe('the bounded list, filtered by status', () => {
  test('finds the newest of one status, not that status among the newest', async () => {
    const s = await setup()
    const old = await book(s, Date.now() + DAY)
    await s.owner.as.mutation(api.jobs.cancel, {
      businessId: s.businessId,
      jobId: old,
    })
    for (let i = 0; i < 3; i++) await book(s, Date.now() + (i + 2) * DAY)

    const { jobs } = await s.owner.as.query(api.jobs.list, {
      businessId: s.businessId,
      status: 'cancelled',
    })
    expect(jobs.map((job) => job._id)).toEqual([old])
  })

  test('keeps a job someone is also going on in their filtered list', async () => {
    const s = await setup()
    const kevin = await createActor(s.t, { email: 'kevin@coastal.test' })
    const kevinId = await join(s, kevin)
    const jobId = await book(s, Date.now() + DAY)
    await s.owner.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      alsoGoing: [kevinId],
    })

    const { jobs } = await kevin.as.query(api.jobs.list, {
      businessId: s.businessId,
      status: 'pending',
    })
    expect(jobs.map((job) => job._id)).toEqual([jobId])
    expect(jobs[0].alsoGoing.map((person) => person._id)).toEqual([kevinId])
  })
})

describe('the caption’s counts', () => {
  test('count each status on its own, leaving out projections and the bin', async () => {
    const s = await setup()
    const a = await book(s, Date.now() + DAY)
    await book(s, Date.now() + 2 * DAY)
    const binned = await book(s, Date.now() + 3 * DAY)
    await s.owner.as.mutation(api.jobs.cancel, {
      businessId: s.businessId,
      jobId: a,
    })
    await s.t.run(async (ctx) =>
      ctx.db.patch(binned, { deletedAt: Date.now() }),
    )
    await project(s, Date.now() + 4 * DAY)

    const count = (status?: 'pending' | 'cancelled') =>
      s.owner.as.query(api.jobs.listCounts, {
        businessId: s.businessId,
        ...(status ? { status } : {}),
      })
    expect(await count()).toEqual({ count: 2, capped: false })
    expect(await count('pending')).toEqual({ count: 1, capped: false })
    expect(await count('cancelled')).toEqual({ count: 1, capped: false })
  })

  test('say "1,000+" past the limit, and stay exact for the other statuses', async () => {
    const s = await setup()
    await s.t.run(async (ctx) => {
      for (let i = 0; i < 1001; i++) {
        await ctx.db.insert('jobs', {
          businessId: s.businessId,
          propertyId: s.propertyId,
          assignedMembershipId: s.ownerMembershipId,
          jobType: 'General Pest Control',
          price: 20000,
          scheduledAt: Date.now() - i * DAY,
          durationMinutes: 60,
          status: 'completed',
          createdAt: Date.now(),
        })
      }
    })
    await book(s, Date.now() + DAY)

    expect(
      await s.owner.as.query(api.jobs.listCounts, {
        businessId: s.businessId,
        status: 'completed',
      }),
    ).toEqual({ count: 1000, capped: true })
    expect(
      await s.owner.as.query(api.jobs.listCounts, {
        businessId: s.businessId,
        status: 'pending',
      }),
    ).toEqual({ count: 1, capped: false })
  })
})

describe('the Recurring Job header', () => {
  test('counts what the visits list holds, without decorating it', async () => {
    const s = await setup()
    await s.owner.as.mutation(api.recurrences.create, {
      businessId: s.businessId,
      propertyId: s.propertyId,
      assignedMembershipId: s.ownerMembershipId,
      intervalCount: 2,
      intervalUnit: 'week',
      jobType: 'General Pest Control',
      price: 20000,
      anchorDate: Date.now() + DAY,
      durationMinutes: 60,
    })
    // A booked job in the window, which neither number counts.
    await book(s, Date.now() + 3 * DAY)

    const full = await s.owner.as.query(api.jobs.listRecurring, {
      businessId: s.businessId,
    })
    const startOfToday = startOfDayInZone(
      todayKeyInZone('Australia/Perth'),
      'Australia/Perth',
    )
    const summary = await s.owner.as.query(api.jobs.recurringSummary, {
      businessId: s.businessId,
      startOfToday,
    })
    expect(summary.seriesCount).toBe(full.seriesCount)
    expect(summary.visitCount).toBe(full.jobs.length)
    expect(summary.visitCount).toBeGreaterThan(0)
  })
})

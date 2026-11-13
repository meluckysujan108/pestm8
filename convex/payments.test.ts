/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api, internal } from './_generated/api'
import {
  createActor,
  createBusiness,
  joinBusiness,
  testApp,
} from '../test/harness'
import {
  assertStatusChange,
  finishedStatus,
  isSettled,
  moneyOf,
  orderForDay,
  owingOn,
  sinksOnDay,
  statusFromMoney,
} from './lib/jobStatus'
import { addDaysToKey, dayKeyOf, startOfDayInZone } from './lib/dates'
import type { Id } from './_generated/dataModel'
import type { JobStatus } from './lib/jobStatus'
import type { TestActor } from '../test/harness'

/**
 * What a payment does to a job (lib/jobStatus.ts), who may record one and take
 * one back (convex/payments.ts), and what the money adds up to.
 */

const DAY = 24 * 60 * 60 * 1000
const PRICE = 22000

async function setup() {
  const t = testApp()
  const owner = await createActor(t, { email: 'terence@coastal.test' })
  const { businessId, ownerMembershipId } = await createBusiness(t, owner)
  const propertyId = await t.run(async (ctx) => {
    const clientId = await ctx.db.insert('clients', {
      businessId,
      kind: 'person',
      name: 'J. Nguyen',
      createdAt: 0,
      updatedAt: 0,
    })
    return ctx.db.insert('properties', {
      businessId,
      clientId,
      addressLine: '12 Wattle Street',
      suburb: 'Bayswater',
      state: 'WA',
      postcode: '6053',
      createdAt: 0,
    })
  })
  return { t, owner, businessId, ownerMembershipId, propertyId }
}

type Setup = Awaited<ReturnType<typeof setup>>

/** A job in a given state, without going through the screens that get it there. */
function insertJob(
  s: Setup,
  fields: {
    status?: JobStatus
    price?: number
    assignedMembershipId?: Id<'memberships'>
    invoicedAt?: number
    completedAt?: number
    scheduledAt?: number
  } = {},
) {
  return s.t.run((ctx) =>
    ctx.db.insert('jobs', {
      businessId: s.businessId,
      propertyId: s.propertyId,
      assignedMembershipId: s.ownerMembershipId,
      jobType: 'General Pest Control',
      price: PRICE,
      scheduledAt: Date.now() + DAY,
      durationMinutes: 60,
      status: 'booked',
      createdAt: 0,
      ...fields,
    }),
  )
}

const jobOf = (s: Setup, jobId: Id<'jobs'>) =>
  s.t.run((ctx) => ctx.db.get(jobId))

const statusOf = async (s: Setup, jobId: Id<'jobs'>) =>
  (await jobOf(s, jobId))?.status

function pay(
  s: Setup,
  jobId: Id<'jobs'>,
  extra: {
    method?: 'cash' | 'card' | 'bankTransfer' | 'cheque' | 'other' | 'noCharge'
    amount?: number
    complete?: boolean
    reference?: string
    receivedAt?: number
    clientRequestId?: string
    handOver?: {
      from?: Id<'memberships'>
      to: Id<'memberships'>
      note?: string
    }
    as?: TestActor
  } = {},
) {
  const { as = s.owner, method = 'cash', ...rest } = extra
  return as.as.mutation(api.payments.record, {
    businessId: s.businessId,
    jobId,
    method,
    clientRequestId: crypto.randomUUID(),
    ...rest,
  })
}

function takeBack(
  s: Setup,
  jobId: Id<'jobs'>,
  paymentId: Id<'payments'>,
  as: TestActor = s.owner,
) {
  return as.as.mutation(api.payments.remove, {
    businessId: s.businessId,
    jobId,
    paymentId,
  })
}

const moneyOn = (s: Setup, jobId: Id<'jobs'>, as: TestActor = s.owner) =>
  as.as.query(api.payments.forJob, { businessId: s.businessId, jobId })

const figures = (s: Setup, as: TestActor = s.owner) =>
  as.as.query(api.payments.summary, { businessId: s.businessId })

/** A subcontractor with a job of their own. New joiners see no prices. */
async function withSubcontractor(s: Setup, opts: { prices?: boolean } = {}) {
  const sam = await createActor(s.t, { email: 'sam@coastal.test', name: 'Sam' })
  const samId = await joinBusiness(
    s.t,
    s.owner,
    sam,
    s.businessId,
    'subcontractor',
  )
  if (opts.prices) {
    await s.t.run(async (ctx) => {
      await ctx.db.patch(samId, {
        grants: {
          switchInto: null,
          clientDirectory: true,
          prices: true,
          otherSchedules: false,
        },
      })
    })
  }
  const jobId = await insertJob(s, { assignedMembershipId: samId })
  return { sam, samId, jobId }
}

describe('what the money makes a job', () => {
  test('cash in full at the door: Paid and finished, for what was owing', async () => {
    const s = await setup()
    const jobId = await insertJob(s)

    await pay(s, jobId, { complete: true })

    const job = await jobOf(s, jobId)
    expect(job?.status).toBe('paid')
    expect(job?.completedAt).toBeTypeOf('number')
    const money = await moneyOn(s, jobId)
    expect(money?.paid).toBe(PRICE)
    expect(money?.owing).toBe(0)
    expect(money?.settled).toBe(true)
  })

  test('invoiced, then paid when the transfer lands', async () => {
    const s = await setup()
    const jobId = await insertJob(s)

    await s.owner.as.mutation(api.payments.markInvoiced, {
      businessId: s.businessId,
      jobId,
    })
    const billed = await jobOf(s, jobId)
    expect(billed?.status).toBe('invoiced')
    expect(billed?.invoicedAt).toBeTypeOf('number')
    expect(billed?.completedAt).toBeTypeOf('number')

    await pay(s, jobId, { method: 'bankTransfer' })
    expect(await statusOf(s, jobId)).toBe('paid')
  })

  test('part now, the rest later: Invoiced, with the rest owing', async () => {
    const s = await setup()
    const jobId = await insertJob(s)

    await pay(s, jobId, { complete: true, amount: 10000 })
    expect(await statusOf(s, jobId)).toBe('invoiced')
    expect((await moneyOn(s, jobId))?.owing).toBe(12000)

    await pay(s, jobId, { method: 'card' })
    expect(await statusOf(s, jobId)).toBe('paid')
    expect((await moneyOn(s, jobId))?.paid).toBe(PRICE)
  })

  test('no charge settles it at $0, priced or not', async () => {
    const s = await setup()
    const priced = await insertJob(s)
    const free = await insertJob(s, { price: 0 })

    await pay(s, priced, { method: 'noCharge', complete: true })
    await pay(s, free, { method: 'noCharge', complete: true })

    expect(await statusOf(s, priced)).toBe('paid')
    expect(await statusOf(s, free)).toBe('paid')
    expect((await moneyOn(s, priced))?.paid).toBe(0)
    expect((await moneyOn(s, priced))?.owing).toBe(0)
  })

  test('nothing recorded stays Completed, a $0 job included', async () => {
    const s = await setup()
    const priced = await insertJob(s)
    const free = await insertJob(s, { price: 0 })
    for (const jobId of [priced, free]) {
      await s.owner.as.mutation(api.jobs.complete, {
        businessId: s.businessId,
        jobId,
      })
      expect(await statusOf(s, jobId)).toBe('completed')
    }
  })

  test('a deposit leaves the job as it was', async () => {
    const s = await setup()
    const jobId = await insertJob(s)
    await pay(s, jobId, { method: 'bankTransfer', amount: 5000 })
    expect(await statusOf(s, jobId)).toBe('booked')
    expect((await moneyOn(s, jobId))?.payments[0].deposit).toBe(true)
  })

  test('a deposit covering the price turns Paid as the work is done', async () => {
    const s = await setup()
    const jobId = await insertJob(s)
    await pay(s, jobId, { method: 'bankTransfer' })
    expect(await statusOf(s, jobId)).toBe('booked')

    await s.owner.as.mutation(api.jobs.complete, {
      businessId: s.businessId,
      jobId,
    })
    const job = await jobOf(s, jobId)
    expect(job?.status).toBe('paid')
    expect(job?.completedAt).toBeTypeOf('number')
  })

  test('a smaller deposit leaves the rest to bill, not billed', async () => {
    const s = await setup()
    const jobId = await insertJob(s)
    await pay(s, jobId, { method: 'bankTransfer', amount: 5000 })
    await s.owner.as.mutation(api.jobs.complete, {
      businessId: s.businessId,
      jobId,
    })
    expect(await statusOf(s, jobId)).toBe('completed')
    expect((await figures(s))?.toBillValue).toBe(17000)
  })

  test('the status menu honours money already in', async () => {
    const s = await setup()
    const jobId = await insertJob(s)
    await pay(s, jobId, { method: 'bankTransfer' })

    await s.owner.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      status: 'completed',
    })
    expect(await statusOf(s, jobId)).toBe('paid')
  })

  test('a price corrected down to what was paid closes the job', async () => {
    const s = await setup()
    const jobId = await insertJob(s, { status: 'completed' })
    await s.t.run((ctx) =>
      ctx.db.insert('payments', {
        businessId: s.businessId,
        jobId,
        method: 'cash',
        amount: 5000,
        receivedAt: 1,
        recordedBy: s.ownerMembershipId,
        recordedAt: 1,
        deposit: true,
      }),
    )
    await s.owner.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      price: 5000,
    })
    expect(await statusOf(s, jobId)).toBe('paid')
  })

  test('finishing through a payment asks for the report like Completed does', async () => {
    const s = await setup()
    const jobId = await insertJob(s)
    await s.t.run((ctx) =>
      ctx.db.patch(s.businessId, { requireReportToComplete: true }),
    )

    await expect(pay(s, jobId, { complete: true })).rejects.toThrow(
      /REPORT_REQUIRED/,
    )
    await expect(
      s.owner.as.mutation(api.payments.markInvoiced, {
        businessId: s.businessId,
        jobId,
      }),
    ).rejects.toThrow(/REPORT_REQUIRED/)
    expect((await moneyOn(s, jobId))?.payments).toEqual([])
    // A deposit is not finishing it.
    await pay(s, jobId, { amount: 5000 })
    expect(await statusOf(s, jobId)).toBe('booked')
  })

  test('marking a part-paid job invoiced says it was billed', async () => {
    const s = await setup()
    const jobId = await insertJob(s)
    const { paymentId } = await pay(s, jobId, { complete: true, amount: 5000 })
    expect((await jobOf(s, jobId))?.invoicedAt).toBeUndefined()

    await s.owner.as.mutation(api.payments.markInvoiced, {
      businessId: s.businessId,
      jobId,
    })
    await takeBack(s, jobId, paymentId)
    expect(await statusOf(s, jobId)).toBe('invoiced')
  })

  test('a save sent twice is one payment', async () => {
    const s = await setup()
    const jobId = await insertJob(s)
    const clientRequestId = crypto.randomUUID()
    const first = await pay(s, jobId, { amount: 5000, clientRequestId })
    const second = await pay(s, jobId, { amount: 5000, clientRequestId })
    expect(second.paymentId).toBe(first.paymentId)
    expect((await moneyOn(s, jobId))?.payments).toHaveLength(1)
  })
})

describe('what cannot be recorded', () => {
  test('more than is owing', async () => {
    const s = await setup()
    const jobId = await insertJob(s, { status: 'completed' })
    await expect(pay(s, jobId, { amount: PRICE + 1 })).rejects.toThrow(
      /PAYMENT_OVER_OWING/,
    )
  })

  test.each([0, -100, 10.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'an amount of %s',
    async (amount) => {
      const s = await setup()
      const jobId = await insertJob(s, { status: 'completed' })
      await expect(pay(s, jobId, { amount })).rejects.toThrow(/INVALID_PAYMENT/)
    },
  )

  test('anything on a job already paid', async () => {
    const s = await setup()
    const jobId = await insertJob(s, { status: 'completed' })
    await pay(s, jobId)
    await expect(pay(s, jobId, { amount: 100 })).rejects.toThrow(
      /NOTHING_OWING/,
    )
    await expect(pay(s, jobId, { method: 'noCharge' })).rejects.toThrow(
      /NOTHING_OWING/,
    )
  })

  test('a request id that is not one the phone makes', async () => {
    const s = await setup()
    const jobId = await insertJob(s, { status: 'completed' })
    await expect(pay(s, jobId, { clientRequestId: 'phone-1' })).rejects.toThrow(
      /INVALID_REQUEST_ID/,
    )
  })

  test('money on a job nobody has priced', async () => {
    const s = await setup()
    const jobId = await insertJob(s, { status: 'completed', price: 0 })
    await expect(pay(s, jobId)).rejects.toThrow(/NOTHING_OWING/)
  })

  test('a cancelled job, or a deposit on a projected visit', async () => {
    const s = await setup()
    const cancelled = await insertJob(s, { status: 'cancelled' })
    const projected = await insertJob(s, { status: 'recurring' })
    await expect(pay(s, cancelled)).rejects.toThrow(/PAYMENT_NOT_ALLOWED/)
    await expect(pay(s, projected)).rejects.toThrow(/PAYMENT_NOT_ALLOWED/)
    // Finished at the door, a projected visit can be paid for.
    await pay(s, projected, { complete: true })
    expect(await statusOf(s, projected)).toBe('paid')
  })

  test('a reference that is really a paragraph', async () => {
    const s = await setup()
    const jobId = await insertJob(s, { status: 'completed' })
    await expect(pay(s, jobId, { reference: 'x'.repeat(65) })).rejects.toThrow(
      /INVALID_PAYMENT/,
    )
  })

  test.each([0, -1, Number.NaN])(
    'a received date of %s',
    async (receivedAt) => {
      const s = await setup()
      const jobId = await insertJob(s, { status: 'completed' })
      await expect(pay(s, jobId, { receivedAt })).rejects.toThrow(
        /INVALID_PAYMENT/,
      )
    },
  )

  test('money arriving tomorrow is money arriving today', async () => {
    const s = await setup()
    const jobId = await insertJob(s, { status: 'completed' })
    await pay(s, jobId, { receivedAt: Date.now() + 30 * DAY })
    const received = (await moneyOn(s, jobId))?.payments[0].receivedAt
    expect(received).toBeLessThanOrEqual(Date.now())
  })
})

describe('a paid job', () => {
  async function paid() {
    const s = await setup()
    const jobId = await insertJob(s)
    const { paymentId } = await pay(s, jobId, { complete: true })
    return { s, jobId, paymentId }
  }

  test('locks its details and cannot be moved by hand', async () => {
    const { s, jobId } = await paid()
    const { businessId } = s
    await expect(
      s.owner.as.mutation(api.jobs.update, { businessId, jobId, price: 1 }),
    ).rejects.toThrow(/JOB_PAID/)
    await expect(
      s.owner.as.mutation(api.jobs.update, {
        businessId,
        jobId,
        status: 'invoiced',
      }),
    ).rejects.toThrow(/JOB_PAID/)
    await expect(
      s.owner.as.mutation(api.jobs.cancel, { businessId, jobId }),
    ).rejects.toThrow(/JOB_PAID/)
    expect(await statusOf(s, jobId)).toBe('paid')
  })

  test('cannot be asked for by hand', async () => {
    const { s, jobId } = await paid()
    const other = await insertJob(s)
    await expect(
      s.owner.as.mutation(api.jobs.update, {
        businessId: s.businessId,
        jobId: other,
        // @ts-expect-error `paid` is deliberately not a status anyone can set
        status: 'paid',
      }),
    ).rejects.toThrow()
    expect(jobId).toBeDefined()
  })

  test('completing it again changes nothing', async () => {
    const { s, jobId } = await paid()
    const before = await jobOf(s, jobId)
    await s.owner.as.mutation(api.jobs.complete, {
      businessId: s.businessId,
      jobId,
    })
    const after = await jobOf(s, jobId)
    expect(after?.status).toBe('paid')
    expect(after?.completedAt).toBe(before?.completedAt)
  })

  test('is on the Job tab, filtered and counted', async () => {
    const { s, jobId } = await paid()
    const { businessId } = s
    const list = await s.owner.as.query(api.jobs.list, { businessId })
    expect(list.jobs.map((j) => j._id)).toContain(jobId)
    const filtered = await s.owner.as.query(api.jobs.list, {
      businessId,
      status: 'paid',
    })
    expect(filtered.jobs.map((j) => j._id)).toEqual([jobId])
    const counts = await s.owner.as.query(api.jobs.listCounts, { businessId })
    expect(counts?.count).toBe(1)
  })

  test('sinks to the bottom of the day with completed work', () => {
    const job = (id: string, scheduledAt: number, status: JobStatus) => ({
      id,
      scheduledAt,
      status,
    })
    const ordered = orderForDay([
      job('done', 1, 'completed'),
      { ...job('settled', 2, 'paid'), completedAt: 5 },
      job('ahead', 3, 'booked'),
    ])
    expect(ordered.map((j) => j.id)).toEqual(['ahead', 'done', 'settled'])
  })
})

describe('taking a payment back', () => {
  test('one invoiced before invoices were dated stays Invoiced when a part comes off', async () => {
    const s = await setup()
    const jobId = await insertJob(s, { status: 'invoiced' })
    const first = await pay(s, jobId, { method: 'card', amount: 5000 })
    const second = await pay(s, jobId, { method: 'card', amount: 5000 })

    await takeBack(s, jobId, second.paymentId)
    await takeBack(s, jobId, first.paymentId)

    expect(await statusOf(s, jobId)).toBe('invoiced')
    expect((await figures(s))?.owingValue).toBe(PRICE)
    expect((await figures(s))?.toBillValue).toBe(0)
  })

  test('a job paid at the door goes back to Completed', async () => {
    const s = await setup()
    const jobId = await insertJob(s)
    const { paymentId } = await pay(s, jobId, { complete: true })

    expect((await takeBack(s, jobId, paymentId)).status).toBe('completed')

    expect(await statusOf(s, jobId)).toBe('completed')
    const money = await moneyOn(s, jobId)
    expect(money?.payments).toEqual([])
    expect(money?.removed).toHaveLength(1)
    expect(money?.owing).toBe(PRICE)
  })

  test('a job that was billed goes back to Invoiced', async () => {
    const s = await setup()
    const jobId = await insertJob(s, { status: 'completed' })
    await s.owner.as.mutation(api.payments.markInvoiced, {
      businessId: s.businessId,
      jobId,
    })
    const { paymentId } = await pay(s, jobId, { method: 'bankTransfer' })
    await takeBack(s, jobId, paymentId)
    expect(await statusOf(s, jobId)).toBe('invoiced')
  })

  test('so does one invoiced before invoices were dated', async () => {
    const s = await setup()
    const jobId = await insertJob(s, { status: 'invoiced' })
    const { paymentId } = await pay(s, jobId, { method: 'bankTransfer' })
    expect(await statusOf(s, jobId)).toBe('paid')
    await takeBack(s, jobId, paymentId)
    expect(await statusOf(s, jobId)).toBe('invoiced')
  })

  test('part payments unwind in either order', async () => {
    const s = await setup()
    const jobId = await insertJob(s)
    const first = await pay(s, jobId, { complete: true, amount: 10000 })
    const second = await pay(s, jobId, { method: 'card' })
    expect(await statusOf(s, jobId)).toBe('paid')

    await takeBack(s, jobId, second.paymentId)
    expect(await statusOf(s, jobId)).toBe('invoiced')
    await takeBack(s, jobId, first.paymentId)
    expect(await statusOf(s, jobId)).toBe('completed')
  })

  test('a deposit coming off leaves the job as it was', async () => {
    const s = await setup()
    const jobId = await insertJob(s)
    const { paymentId } = await pay(s, jobId, { amount: 5000 })
    expect((await takeBack(s, jobId, paymentId)).status).toBe('booked')
  })

  test('the deposit left after the balance comes off is to bill, as before', async () => {
    const s = await setup()
    const jobId = await insertJob(s)
    await pay(s, jobId, { amount: 5000 })
    await s.owner.as.mutation(api.jobs.complete, {
      businessId: s.businessId,
      jobId,
    })
    const { paymentId } = await pay(s, jobId, { method: 'card' })
    expect(await statusOf(s, jobId)).toBe('paid')
    await takeBack(s, jobId, paymentId)
    expect(await statusOf(s, jobId)).toBe('completed')
  })

  test('no charge can be taken back', async () => {
    const s = await setup()
    const jobId = await insertJob(s)
    const { paymentId } = await pay(s, jobId, {
      method: 'noCharge',
      complete: true,
    })
    await takeBack(s, jobId, paymentId)
    expect(await statusOf(s, jobId)).toBe('completed')
  })

  test('twice is once, and it can be recorded again', async () => {
    const s = await setup()
    const jobId = await insertJob(s, { status: 'completed' })
    const { paymentId } = await pay(s, jobId)
    await takeBack(s, jobId, paymentId)
    await takeBack(s, jobId, paymentId)
    expect((await moneyOn(s, jobId))?.removed).toHaveLength(1)
    await pay(s, jobId)
    expect(await statusOf(s, jobId)).toBe('paid')
  })

  test('a payment from another job is not found', async () => {
    const s = await setup()
    const jobId = await insertJob(s, { status: 'completed' })
    const other = await insertJob(s, { status: 'completed' })
    const { paymentId } = await pay(s, jobId)
    await expect(takeBack(s, other, paymentId)).rejects.toThrow(/NOT_FOUND/)
  })
})

describe('moved by hand', () => {
  test('leaving Invoiced forgets it was billed', async () => {
    const s = await setup()
    const jobId = await insertJob(s, { status: 'completed' })
    await s.owner.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      status: 'invoiced',
    })
    expect((await jobOf(s, jobId))?.invoicedAt).toBeTypeOf('number')

    await s.owner.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      status: 'completed',
    })
    expect((await jobOf(s, jobId))?.invoicedAt).toBeUndefined()
  })

  test('completing an invoiced job forgets it too', async () => {
    const s = await setup()
    const jobId = await insertJob(s, {
      status: 'invoiced',
      invoicedAt: 1,
    })
    await s.owner.as.mutation(api.jobs.complete, {
      businessId: s.businessId,
      jobId,
    })
    expect((await jobOf(s, jobId))?.invoicedAt).toBeUndefined()
  })

  test('someone’s own choice of Completed survives a payment leaving', async () => {
    const s = await setup()
    const jobId = await insertJob(s)
    await pay(s, jobId, { complete: true, amount: 5000 })
    const { paymentId } = await pay(s, jobId, { amount: 5000 })
    await s.owner.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      status: 'completed',
    })
    await takeBack(s, jobId, paymentId)
    expect(await statusOf(s, jobId)).toBe('completed')
  })
})

describe('someone who cannot see prices', () => {
  test('records in full, and never sees the figure', async () => {
    const s = await setup()
    const { sam, jobId } = await withSubcontractor(s)

    const result = await pay(s, jobId, { as: sam, complete: true })
    expect(result).toEqual({ paymentId: result.paymentId, status: 'paid' })

    const seen = await moneyOn(s, jobId, sam)
    expect(seen?.pricesHidden).toBe(true)
    expect(seen?.paid).toBe(0)
    expect(seen?.owing).toBe(0)
    expect(seen?.payments[0]).toMatchObject({ amount: 0, method: 'cash' })
    // The owner's figure is the real one.
    expect((await moneyOn(s, jobId))?.paid).toBe(PRICE)
  })

  test('cannot name an amount, which would find the price by asking', async () => {
    const s = await setup()
    const { sam, jobId } = await withSubcontractor(s)
    await expect(
      pay(s, jobId, { as: sam, amount: 1, complete: true }),
    ).rejects.toThrow(/NO_ACCESS/)
    await expect(
      pay(s, jobId, { as: sam, amount: PRICE * 10, complete: true }),
    ).rejects.toThrow(/NO_ACCESS/)
  })

  test('gets no figures, and no count beside them', async () => {
    const s = await setup()
    const { sam, jobId } = await withSubcontractor(s)
    await pay(s, jobId, { as: sam, complete: true })
    const summary = await figures(s, sam)
    expect(summary).toMatchObject({
      toBill: null,
      toBillValue: null,
      owing: null,
      owingValue: null,
      paidThisMonth: null,
      paidThisMonthByMethod: [],
      toHandOver: [],
      pricesHidden: true,
    })
    const dashboard = await sam.as.query(api.dashboard.summary, {
      businessId: s.businessId,
    })
    expect(dashboard?.toBillValue).toBeNull()
    expect(dashboard?.owingValue).toBeNull()
    expect(dashboard?.paidThisMonth).toBeNull()
  })
})

describe('giving a job away', () => {
  test('whoever can edit the job can, and it says who did', async () => {
    const s = await setup()
    const { sam, jobId } = await withSubcontractor(s, { prices: true })

    await pay(s, jobId, { as: sam, method: 'noCharge', complete: true })

    expect(await statusOf(s, jobId)).toBe('paid')
    expect((await moneyOn(s, jobId))?.payments[0]).toMatchObject({
      method: 'noCharge',
      amount: 0,
      recordedByName: 'Sam',
    })
  })

  test('someone who cannot see the price can too', async () => {
    const s = await setup()
    const { sam, jobId } = await withSubcontractor(s)
    await pay(s, jobId, { as: sam, method: 'noCharge', complete: true })
    expect(await statusOf(s, jobId)).toBe('paid')
  })

  test('earns nothing in the figures that add up job prices', async () => {
    const s = await setup()
    const given = await insertJob(s)
    const earned = await insertJob(s)
    await s.t.run(async (ctx) => {
      for (const id of [given, earned]) {
        await ctx.db.patch(id, { scheduledAt: Date.now() })
      }
    })
    await pay(s, given, { method: 'noCharge', complete: true })
    await pay(s, earned, { complete: true })

    const overview = await s.owner.as.query(api.analytics.overview, {
      businessId: s.businessId,
      months: 3,
    })
    expect(overview?.revenueByMonth.at(-1)?.value).toBe(PRICE)
    const dashboard = await s.owner.as.query(api.dashboard.summary, {
      businessId: s.businessId,
    })
    // The waived job's $0 adds nothing to what came in.
    expect(dashboard?.paidThisMonth).toBe(PRICE)
  })

  test('what was kept before giving away the rest still counts', async () => {
    const s = await setup()
    const jobId = await insertJob(s)
    await s.t.run((ctx) => ctx.db.patch(jobId, { scheduledAt: Date.now() }))
    await pay(s, jobId, { amount: 5000 })
    await pay(s, jobId, { method: 'noCharge', complete: true })
    expect(await statusOf(s, jobId)).toBe('paid')

    const overview = await s.owner.as.query(api.analytics.overview, {
      businessId: s.businessId,
      months: 3,
    })
    expect(overview?.revenueByMonth.at(-1)?.value).toBe(5000)
  })

  test('taken back, the job earned its price again', async () => {
    const s = await setup()
    const jobId = await insertJob(s)
    await s.t.run((ctx) => ctx.db.patch(jobId, { scheduledAt: Date.now() }))
    const { paymentId } = await pay(s, jobId, {
      method: 'noCharge',
      complete: true,
    })
    await takeBack(s, jobId, paymentId)

    const overview = await s.owner.as.query(api.analytics.overview, {
      businessId: s.businessId,
      months: 3,
    })
    expect(overview?.revenueByMonth.at(-1)?.value).toBe(PRICE)
  })
})

describe('what a job’s own money says', () => {
  test('a cancelled job is not owed anything', async () => {
    const s = await setup()
    const jobId = await insertJob(s)
    await pay(s, jobId, { amount: 5000 })
    await s.owner.as.mutation(api.jobs.cancel, {
      businessId: s.businessId,
      jobId,
    })
    const money = await moneyOn(s, jobId)
    expect(money?.owing).toBe(0)
    expect(money?.paid).toBe(5000)
  })

  test('a price corrected below what came in says so', async () => {
    const s = await setup()
    const jobId = await insertJob(s)
    await pay(s, jobId)
    await s.owner.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      price: 15000,
    })
    const money = await moneyOn(s, jobId)
    expect(money?.overpaid).toBe(7000)
    expect(money?.owing).toBe(0)
  })

  test('and says nothing of it to someone who cannot see prices', async () => {
    const s = await setup()
    const { sam, jobId } = await withSubcontractor(s)
    await pay(s, jobId, { as: sam })
    await s.owner.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      price: 15000,
    })
    expect((await moneyOn(s, jobId, sam))?.overpaid).toBe(0)
    expect((await moneyOn(s, jobId))?.overpaid).toBe(7000)
  })
})

describe('what a job’s card says', () => {
  /** The row the day's list draws for this job. */
  async function cardOf(s: Setup, jobId: Id<'jobs'>, as: TestActor = s.owner) {
    const job = await jobOf(s, jobId)
    const business = await s.t.run((ctx) => ctx.db.get(s.businessId))
    const day = await as.as.query(api.jobs.listDay, {
      businessId: s.businessId,
      dayKey: dayKeyOf(job?.scheduledAt ?? 0, business?.timezone ?? 'UTC'),
    })
    return day.find((row) => row._id === jobId)
  }

  test('nothing about work still to come, even with a deposit', async () => {
    const s = await setup()
    const jobId = await insertJob(s)
    await pay(s, jobId, { amount: 5000 })
    const card = await cardOf(s, jobId)
    expect(card).toBeDefined()
    expect(card?.payment).toBeUndefined()
  })

  test('finished and nothing recorded', async () => {
    const s = await setup()
    const jobId = await insertJob(s, { status: 'completed' })
    expect((await cardOf(s, jobId))?.payment).toEqual({
      methods: [],
      paid: 0,
      owing: PRICE,
    })
  })

  test('each way it was paid, once, oldest first', async () => {
    const s = await setup()
    const jobId = await insertJob(s, { status: 'invoiced' })
    const now = Date.now()
    await pay(s, jobId, {
      method: 'cash',
      amount: 1000,
      receivedAt: now - DAY,
    })
    await pay(s, jobId, {
      method: 'card',
      amount: 1000,
      receivedAt: now - 3 * DAY,
    })
    await pay(s, jobId, { method: 'cash', amount: 1000, receivedAt: now })
    expect((await cardOf(s, jobId))?.payment).toEqual({
      methods: ['card', 'cash'],
      paid: 3000,
      owing: PRICE - 3000,
    })
  })

  test('not what was taken back', async () => {
    const s = await setup()
    const jobId = await insertJob(s, { status: 'invoiced' })
    await pay(s, jobId, { method: 'card', amount: 1000 })
    const cash = await pay(s, jobId, { method: 'cash', amount: 1000 })
    await takeBack(s, jobId, cash.paymentId)
    expect((await cardOf(s, jobId))?.payment).toEqual({
      methods: ['card'],
      paid: 1000,
      owing: PRICE - 1000,
    })
  })

  test('how it was paid, and no figure, for someone who cannot see prices', async () => {
    const s = await setup()
    const { sam, jobId } = await withSubcontractor(s)
    await pay(s, jobId, { as: sam, complete: true })
    expect((await cardOf(s, jobId, sam))?.payment).toEqual({
      methods: ['cash'],
      paid: 0,
      owing: 0,
    })
    expect((await cardOf(s, jobId))?.payment?.paid).toBe(PRICE)
  })
})

describe('whether the work is over', () => {
  const finished = async (s: Setup, jobId: Id<'jobs'>) => {
    const job = await jobOf(s, jobId)
    return job ? sinksOnDay(job) : null
  }
  const moveTo = (s: Setup, jobId: Id<'jobs'>, status: 'booked' | 'invoiced') =>
    s.owner.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      status,
    })

  test('paid at the door, it is', async () => {
    const s = await setup()
    const jobId = await insertJob(s)
    await pay(s, jobId, { complete: true })
    expect(await finished(s, jobId)).toBe(true)
  })

  test('billed and settled ahead of the visit, it is not', async () => {
    const s = await setup()
    const jobId = await insertJob(s)
    await moveTo(s, jobId, 'invoiced')
    await pay(s, jobId, { method: 'bankTransfer', complete: true })
    expect(await statusOf(s, jobId)).toBe('paid')
    expect(await finished(s, jobId)).toBe(false)
  })

  test('marked invoiced at the door, it is', async () => {
    const s = await setup()
    const jobId = await insertJob(s)
    await s.owner.as.mutation(api.payments.markInvoiced, {
      businessId: s.businessId,
      jobId,
    })
    expect(await finished(s, jobId)).toBe(true)
  })

  test('moved back to work still to do, it no longer is', async () => {
    const s = await setup()
    const jobId = await insertJob(s)
    await s.owner.as.mutation(api.jobs.complete, {
      businessId: s.businessId,
      jobId,
    })
    expect((await jobOf(s, jobId))?.completedAt).toBeTypeOf('number')

    await moveTo(s, jobId, 'booked')
    expect((await jobOf(s, jobId))?.completedAt).toBeUndefined()

    await moveTo(s, jobId, 'invoiced')
    expect(await finished(s, jobId)).toBe(false)
  })
})

describe('who took a payment, and how this address paid last', () => {
  test('says who recorded each one, for the hand-over form', async () => {
    const s = await setup()
    const jobId = await insertJob(s)
    await pay(s, jobId, { complete: true })
    expect((await moneyOn(s, jobId))?.payments[0].recordedBy).toBe(
      s.ownerMembershipId,
    )
  })

  async function paidJob(
    s: Setup,
    method: 'cash' | 'card' | 'cheque' | 'noCharge',
    fields: Parameters<typeof insertJob>[1] = {},
  ) {
    const jobId = await insertJob(s, { status: 'completed', ...fields })
    const { paymentId } = await pay(s, jobId, { method, complete: true })
    return { jobId, paymentId }
  }

  test('the last job here that was paid', async () => {
    const s = await setup()
    await paidJob(s, 'cash')
    await paidJob(s, 'card')
    const today = await insertJob(s, { status: 'completed' })
    expect((await moneyOn(s, today))?.lastTime?.method).toBe('card')
  })

  test('skips a visit given away, which says nothing about how they pay', async () => {
    const s = await setup()
    await paidJob(s, 'card')
    await paidJob(s, 'noCharge')
    const today = await insertJob(s, { status: 'completed' })
    expect((await moneyOn(s, today))?.lastTime?.method).toBe('card')
  })

  test('nothing when there has been nothing', async () => {
    const s = await setup()
    const today = await insertJob(s, { status: 'completed' })
    expect((await moneyOn(s, today))?.lastTime).toBeNull()
  })

  test('not this job’s own payment', async () => {
    const s = await setup()
    const jobId = await insertJob(s, { status: 'invoiced' })
    await pay(s, jobId, { method: 'card', amount: 1000 })
    expect((await moneyOn(s, jobId))?.lastTime).toBeNull()
  })

  test('not a payment taken back', async () => {
    const s = await setup()
    const earlier = await insertJob(s, { status: 'invoiced' })
    await pay(s, earlier, { method: 'card', amount: 1000 })
    const cash = await pay(s, earlier, { method: 'cash', amount: 1000 })
    await takeBack(s, earlier, cash.paymentId)
    const today = await insertJob(s, { status: 'completed' })
    expect((await moneyOn(s, today))?.lastTime?.method).toBe('card')
  })

  test('not a job in the Recycle bin', async () => {
    const s = await setup()
    const { jobId } = await paidJob(s, 'card')
    await s.t.run((ctx) => ctx.db.patch(jobId, { deletedAt: Date.now() }))
    const today = await insertJob(s, { status: 'completed' })
    expect((await moneyOn(s, today))?.lastTime).toBeNull()
  })

  test('is not asked once the job is settled or called off', async () => {
    const s = await setup()
    await paidJob(s, 'card')
    const { jobId: paid } = await paidJob(s, 'cash')
    const cancelled = await insertJob(s, { status: 'cancelled' })
    expect((await moneyOn(s, paid))?.lastTime).toBeNull()
    expect((await moneyOn(s, cancelled))?.lastTime).toBeNull()
  })

  test('tells a subcontractor only about their own visits', async () => {
    const s = await setup()
    const { sam, samId, jobId } = await withSubcontractor(s, { prices: true })
    await paidJob(s, 'card')
    expect((await moneyOn(s, jobId, sam))?.lastTime).toBeNull()

    const theirs = await insertJob(s, {
      status: 'completed',
      assignedMembershipId: samId,
    })
    await pay(s, theirs, { as: sam, method: 'cheque', complete: true })
    expect((await moneyOn(s, jobId, sam))?.lastTime?.method).toBe('cheque')
  })
})

describe('a subcontractor’s reach', () => {
  test('cannot touch or see a job that is not theirs', async () => {
    const s = await setup()
    const { sam } = await withSubcontractor(s, { prices: true })
    const ownersJob = await insertJob(s, { status: 'completed' })

    await expect(pay(s, ownersJob, { as: sam })).rejects.toThrow(/NO_ACCESS/)
    await expect(
      sam.as.mutation(api.payments.markInvoiced, {
        businessId: s.businessId,
        jobId: ownersJob,
      }),
    ).rejects.toThrow(/NO_ACCESS/)
    expect(await moneyOn(s, ownersJob, sam)).toBeNull()
  })

  test('adds up only their own work', async () => {
    const s = await setup()
    const { sam, jobId } = await withSubcontractor(s, { prices: true })
    const ownersJob = await insertJob(s, { status: 'completed' })
    await pay(s, ownersJob)
    await pay(s, jobId, { as: sam, complete: true, amount: 5000 })

    const summary = await figures(s, sam)
    expect(summary?.scope).toBe('assignee')
    expect(summary?.paidThisMonth).toBe(5000)
    expect(summary?.owingValue).toBe(PRICE - 5000)
  })

  test('takes back their own, not someone else’s', async () => {
    const s = await setup()
    const { sam, jobId } = await withSubcontractor(s, { prices: true })

    const theirs = await pay(s, jobId, { as: sam, amount: 1000 })
    expect((await moneyOn(s, jobId, sam))?.payments[0].canRemove).toBe(true)
    await takeBack(s, jobId, theirs.paymentId, sam)

    const owners = await pay(s, jobId, { amount: 1000 })
    await expect(takeBack(s, jobId, owners.paymentId, sam)).rejects.toThrow(
      /NO_ACCESS/,
    )
    expect((await moneyOn(s, jobId, sam))?.payments[0].canRemove).toBe(false)
    // The owner's say is the last.
    await takeBack(s, jobId, owners.paymentId)
  })
})

describe('the owner’s figures', () => {
  test('to bill, owing and paid this month, from what was really paid', async () => {
    const s = await setup()
    const untouched = await insertJob(s, { status: 'completed' })
    const billed = await insertJob(s, { status: 'invoiced', invoicedAt: 1 })
    const part = await insertJob(s)
    const settled = await insertJob(s)
    await pay(s, part, { complete: true, amount: 10000 })
    await pay(s, settled, { complete: true, method: 'card' })
    expect([untouched, billed].length).toBe(2)

    const summary = await figures(s)
    expect(summary?.toBill).toBe(1)
    expect(summary?.toBillValue).toBe(PRICE)
    expect(summary?.owing).toBe(2)
    expect(summary?.owingValue).toBe(PRICE + (PRICE - 10000))
    expect(summary?.paidThisMonth).toBe(10000 + PRICE)
    expect(summary?.paidThisMonthByMethod).toEqual(
      expect.arrayContaining([
        { method: 'cash', value: 10000 },
        { method: 'card', value: PRICE },
      ]),
    )

    const dashboard = await s.owner.as.query(api.dashboard.summary, {
      businessId: s.businessId,
    })
    expect(dashboard).toMatchObject({
      toBill: 1,
      toBillValue: PRICE,
      owing: 2,
      owingValue: 2 * PRICE - 10000,
      paidThisMonth: 10000 + PRICE,
    })
  })

  test('money received last month is not this month’s', async () => {
    const s = await setup()
    const jobId = await insertJob(s, { status: 'completed' })
    await pay(s, jobId, { receivedAt: Date.now() - 45 * DAY })
    expect((await figures(s))?.paidThisMonth).toBe(0)
  })

  test('a payment taken back no longer counts', async () => {
    const s = await setup()
    const jobId = await insertJob(s, { status: 'completed' })
    const { paymentId } = await pay(s, jobId)
    await takeBack(s, jobId, paymentId)
    const summary = await figures(s)
    expect(summary?.paidThisMonth).toBe(0)
    expect(summary?.toBillValue).toBe(PRICE)
  })

  test('a job in the Recycle bin takes its money with it', async () => {
    const s = await setup()
    const jobId = await insertJob(s, { status: 'completed' })
    await pay(s, jobId)
    await s.owner.as.mutation(api.bin.deleteJob, {
      businessId: s.businessId,
      jobId,
    })
    expect((await figures(s))?.paidThisMonth).toBe(0)
    expect(await moneyOn(s, jobId)).toBeNull()
  })

  test('analytics counts paid work as earned', async () => {
    const s = await setup()
    const jobId = await insertJob(s)
    await s.t.run((ctx) => ctx.db.patch(jobId, { scheduledAt: Date.now() }))
    await pay(s, jobId, { complete: true })
    const overview = await s.owner.as.query(api.analytics.overview, {
      businessId: s.businessId,
      months: 3,
    })
    expect(overview?.revenueByMonth.at(-1)?.value).toBe(PRICE)
  })
})

describe('each person’s own figures', () => {
  const line = (
    summary: Awaited<ReturnType<typeof figures>>,
    membershipId: Id<'memberships'>,
  ) => summary?.byPerson.find((one) => one.membershipId === membershipId)

  test('a subcontractor’s own work is not in the owner’s', async () => {
    const s = await setup()
    const { sam, samId, jobId } = await withSubcontractor(s, { prices: true })
    await insertJob(s, { status: 'completed' })
    const ownersPaid = await insertJob(s, { status: 'completed' })
    await pay(s, ownersPaid, { method: 'card', amount: 10000 })
    await pay(s, jobId, { as: sam, complete: true })

    const summary = await figures(s)
    expect(line(summary, s.ownerMembershipId)).toMatchObject({
      toBill: 1,
      toBillValue: PRICE,
      owing: 1,
      owingValue: PRICE - 10000,
      paidThisMonth: 10000,
      paidThisMonthByMethod: [{ method: 'card', value: 10000 }],
    })
    expect(line(summary, samId)).toMatchObject({
      name: 'Sam',
      toBill: 0,
      owing: 0,
      paidThisMonth: PRICE,
      paidThisMonthByMethod: [{ method: 'cash', value: PRICE }],
    })
    // The business's own totals still add up all of it.
    expect(summary?.paidThisMonth).toBe(PRICE + 10000)
  })

  test('the person looking comes first', async () => {
    const s = await setup()
    const { sam, jobId } = await withSubcontractor(s, { prices: true })
    const ownersJob = await insertJob(s, { status: 'completed' })
    await pay(s, ownersJob)
    await pay(s, jobId, { as: sam, complete: true })
    expect((await figures(s))?.byPerson[0].membershipId).toBe(
      s.ownerMembershipId,
    )
  })

  test('money marked for someone else counts as theirs', async () => {
    const s = await setup()
    const { sam, samId, jobId } = await withSubcontractor(s, { prices: true })
    await pay(s, jobId, {
      as: sam,
      complete: true,
      handOver: { to: s.ownerMembershipId },
    })

    const summary = await figures(s)
    expect(line(summary, s.ownerMembershipId)?.paidThisMonth).toBe(PRICE)
    expect(line(summary, samId)).toBeUndefined()
    // Theirs, but still to reach them.
    expect(summary?.toHandOver).toHaveLength(1)
  })

  test('a job’s balance stays with whoever leads it', async () => {
    const s = await setup()
    const { sam, samId, jobId } = await withSubcontractor(s, { prices: true })
    await pay(s, jobId, {
      as: sam,
      complete: true,
      amount: 5000,
      handOver: { to: s.ownerMembershipId },
    })
    expect(line(await figures(s), samId)?.owingValue).toBe(PRICE - 5000)
  })

  test('a payment taken back leaves their line', async () => {
    const s = await setup()
    const { sam, samId, jobId } = await withSubcontractor(s, { prices: true })
    const { paymentId } = await pay(s, jobId, { as: sam, amount: 5000 })
    await takeBack(s, jobId, paymentId, sam)
    expect(line(await figures(s), samId)).toBeUndefined()
  })

  test('a job given away gives nobody a line', async () => {
    const s = await setup()
    const { sam, samId, jobId } = await withSubcontractor(s, { prices: true })
    await pay(s, jobId, { as: sam, method: 'noCharge', complete: true })
    expect(line(await figures(s), samId)).toBeUndefined()
  })

  test('a subcontractor sees only their own line', async () => {
    const s = await setup()
    const { sam, samId, jobId } = await withSubcontractor(s, { prices: true })
    const ownersJob = await insertJob(s, { status: 'completed' })
    await pay(s, ownersJob)
    await pay(s, jobId, { as: sam, complete: true })
    expect(
      (await figures(s, sam))?.byPerson.map((one) => one.membershipId),
    ).toEqual([samId])
  })

  test('someone who cannot see prices gets no lines at all', async () => {
    const s = await setup()
    const { sam, jobId } = await withSubcontractor(s)
    await pay(s, jobId, { as: sam, complete: true })
    expect((await figures(s, sam))?.byPerson).toEqual([])
  })
})

const ZONE = 'Australia/Perth'

/** The business counts from this long ago. */
function countFromAgo(s: Setup, days: number) {
  return s.t.run((ctx) =>
    ctx.db.patch(s.businessId, { paymentsFrom: Date.now() - days * DAY }),
  )
}

describe('counting from a day', () => {
  const countFrom = (s: Setup, day: string | null, as: TestActor = s.owner) =>
    as.as.mutation(api.payments.setCountsFrom, {
      businessId: s.businessId,
      day,
    })
  const daysAgoKey = (days: number) =>
    addDaysToKey(dayKeyOf(Date.now(), ZONE), -days)

  test('older work keeps its status and is counted apart', async () => {
    const s = await setup()
    const oldDone = await insertJob(s, {
      status: 'completed',
      scheduledAt: Date.now() - 40 * DAY,
    })
    const oldBilled = await insertJob(s, {
      status: 'invoiced',
      invoicedAt: 1,
      scheduledAt: Date.now() - 40 * DAY,
    })
    await insertJob(s, { status: 'completed' })
    await countFromAgo(s, 10)

    const summary = await figures(s)
    expect(summary).toMatchObject({
      toBill: 1,
      toBillValue: PRICE,
      owing: 0,
      owingValue: 0,
      olderNotCounted: 2,
      olderNotCountedValue: 2 * PRICE,
      canMoveCountsFrom: true,
    })
    expect(summary?.countsFrom).toBeGreaterThan(0)
    expect(
      await s.owner.as.query(api.dashboard.summary, {
        businessId: s.businessId,
      }),
    ).toMatchObject({ toBill: 1, owing: 0 })
    // Nothing about the jobs themselves changed.
    expect(await statusOf(s, oldDone)).toBe('completed')
    expect(await statusOf(s, oldBilled)).toBe('invoiced')
  })

  test('a visit booked before the day but done or billed after it counts', async () => {
    const s = await setup()
    const longAgo = Date.now() - 40 * DAY
    const doneSince = await insertJob(s, {
      status: 'completed',
      scheduledAt: longAgo,
      completedAt: Date.now() - DAY,
    })
    const billedSince = await insertJob(s, {
      status: 'invoiced',
      scheduledAt: longAgo,
      completedAt: longAgo,
      invoicedAt: Date.now() - DAY,
    })
    // Done and billed before the day: older work, never asked.
    await insertJob(s, {
      status: 'invoiced',
      scheduledAt: longAgo,
      completedAt: longAgo,
      invoicedAt: longAgo,
    })
    await countFromAgo(s, 10)

    expect(await figures(s)).toMatchObject({
      toBill: 1,
      owing: 1,
      olderNotCounted: 1,
    })
    const lists = (list: 'toBill' | 'owing') =>
      s.owner.as.query(api.payments.outstanding, {
        businessId: s.businessId,
        list,
      })
    expect((await lists('toBill'))?.rows.map((row) => row._id)).toEqual([
      doneSince,
    ])
    expect((await lists('owing'))?.rows.map((row) => row._id)).toEqual([
      billedSince,
    ])
  })

  test('money that came in counts, whatever job it was for', async () => {
    const s = await setup()
    const oldBilled = await insertJob(s, {
      status: 'invoiced',
      invoicedAt: 1,
      scheduledAt: Date.now() - 40 * DAY,
    })
    await countFromAgo(s, 10)
    await pay(s, oldBilled, { method: 'bankTransfer' })

    const summary = await figures(s)
    expect(summary?.paidThisMonth).toBe(PRICE)
    expect(summary?.olderNotCounted).toBe(0)
  })

  test('the oldest bill still waiting, for how long it has waited', async () => {
    const s = await setup()
    await insertJob(s, { status: 'invoiced', invoicedAt: 5000 })
    await insertJob(s, { status: 'invoiced', invoicedAt: 9000 })
    expect((await figures(s))?.owingSince).toBe(5000)
  })

  test('the owner moves it back, or counts every job', async () => {
    const s = await setup()
    await insertJob(s, {
      status: 'completed',
      scheduledAt: Date.now() - 40 * DAY,
    })
    await countFromAgo(s, 10)
    expect((await figures(s))?.toBill).toBe(0)

    await countFrom(s, daysAgoKey(60))
    const business = await s.t.run((ctx) => ctx.db.get(s.businessId))
    expect(business?.paymentsFrom).toBe(startOfDayInZone(daysAgoKey(60), ZONE))
    expect((await figures(s))?.toBill).toBe(1)

    await countFrom(s, daysAgoKey(5))
    expect((await figures(s))?.toBill).toBe(0)

    await countFrom(s, null)
    expect((await figures(s))?.countsFrom).toBeNull()
    expect((await figures(s))?.toBill).toBe(1)
  })

  test('every job is the owner’s choice, which the one-off leaves alone', async () => {
    const s = await setup()
    await countFromAgo(s, 10)
    await countFrom(s, null)
    expect(
      (await s.t.run((ctx) => ctx.db.get(s.businessId)))?.paymentsFrom,
    ).toBe(0)
    expect(
      await s.t.query(internal.migrations.paymentsFromV1.remaining, {}),
    ).toEqual([])
    expect(
      (await s.t.mutation(internal.migrations.paymentsFromV1.run, {})).changes,
    ).toEqual([])
    expect((await figures(s))?.countsFrom).toBeNull()
  })

  test.each(['tomorrow', '2026-02-30', 'soon'])(
    'not a day to come, nor one that is not a day: %s',
    async (day) => {
      const s = await setup()
      const key = day === 'tomorrow' ? daysAgoKey(-1) : day
      await expect(countFrom(s, key)).rejects.toThrow('INVALID_DAY')
    },
  )

  test('only the owner’s to move', async () => {
    const s = await setup()
    const { sam } = await withSubcontractor(s, { prices: true })
    await expect(countFrom(s, daysAgoKey(3), sam)).rejects.toThrow('NO_ACCESS')
    expect((await figures(s, sam))?.canMoveCountsFrom).toBe(false)
  })

  test('the one-off gives each business without a day today, and only once', async () => {
    const s = await setup()
    const keeps = await s.t.run((ctx) =>
      ctx.db.insert('businesses', {
        name: 'Already set',
        slug: 'already-set',
        state: 'WA',
        timezone: ZONE,
        createdAt: 0,
        paymentsFrom: 123,
      }),
    )

    const preview = await s.t.mutation(internal.migrations.paymentsFromV1.run, {
      dryRun: true,
    })
    expect(preview.changes.map((one) => one.businessId)).toEqual([s.businessId])
    expect(
      (await s.t.run((ctx) => ctx.db.get(s.businessId)))?.paymentsFrom,
    ).toBeUndefined()

    await s.t.mutation(internal.migrations.paymentsFromV1.run, {})
    expect(
      (await s.t.run((ctx) => ctx.db.get(s.businessId)))?.paymentsFrom,
    ).toBe(startOfDayInZone(dayKeyOf(Date.now(), ZONE), ZONE))
    expect((await s.t.run((ctx) => ctx.db.get(keeps)))?.paymentsFrom).toBe(123)

    expect(
      (await s.t.mutation(internal.migrations.paymentsFromV1.run, {})).changes,
    ).toEqual([])
    expect(
      await s.t.query(internal.migrations.paymentsFromV1.remaining, {}),
    ).toEqual([])
  })
})

describe('the lists to chase', () => {
  const list = (
    s: Setup,
    which: 'toBill' | 'owing',
    extra: { person?: Id<'memberships'> } = {},
    as: TestActor = s.owner,
  ) =>
    as.as.query(api.payments.outstanding, {
      businessId: s.businessId,
      list: which,
      ...extra,
    })

  test('owing, oldest visit first, with what is left on each', async () => {
    const s = await setup()
    const newer = await insertJob(s, {
      status: 'invoiced',
      invoicedAt: 1,
      scheduledAt: Date.now() - 5 * DAY,
    })
    const older = await insertJob(s, {
      status: 'invoiced',
      invoicedAt: 1,
      scheduledAt: Date.now() - 20 * DAY,
    })
    await insertJob(s, { status: 'completed' })
    await pay(s, newer, { amount: 5000 })

    const owing = await list(s, 'owing')
    expect(owing?.rows.map((row) => row._id)).toEqual([older, newer])
    expect(owing?.rows[1]).toMatchObject({
      clientName: 'J. Nguyen',
      suburb: 'Bayswater',
      price: PRICE,
      paid: 5000,
      owing: PRICE - 5000,
      lead: s.ownerMembershipId,
    })
    expect(owing?.more).toBe(false)
  })

  test('leaves out older work, as the figures do', async () => {
    const s = await setup()
    await insertJob(s, {
      status: 'completed',
      scheduledAt: Date.now() - 40 * DAY,
    })
    const counted = await insertJob(s, { status: 'completed' })
    await countFromAgo(s, 10)
    expect((await list(s, 'toBill'))?.rows.map((row) => row._id)).toEqual([
      counted,
    ])
  })

  test('one person’s, by who leads the job', async () => {
    const s = await setup()
    const { samId, jobId } = await withSubcontractor(s, { prices: true })
    await s.t.run((ctx) => ctx.db.patch(jobId, { status: 'completed' }))
    await insertJob(s, { status: 'completed' })

    expect(
      (await list(s, 'toBill', { person: samId }))?.rows.map((row) => row._id),
    ).toEqual([jobId])
    expect((await list(s, 'toBill'))?.rows).toHaveLength(2)
  })

  test('nobody from another business', async () => {
    const s = await setup()
    await insertJob(s, { status: 'completed' })
    const kim = await createActor(s.t, { email: 'kim@harbour.test' })
    const harbour = await createBusiness(s.t, kim, 'Harbour Pest')
    expect(
      (await list(s, 'toBill', { person: harbour.ownerMembershipId }))?.rows,
    ).toEqual([])
  })

  test('a subcontractor sees their own, with no figure if prices are hidden', async () => {
    const s = await setup()
    const { sam, jobId } = await withSubcontractor(s)
    await s.t.run((ctx) => ctx.db.patch(jobId, { status: 'completed' }))
    await insertJob(s, { status: 'completed' })

    const theirs = await list(s, 'toBill', {}, sam)
    expect(theirs?.rows.map((row) => row._id)).toEqual([jobId])
    expect(theirs?.rows[0]).toMatchObject({ price: 0, paid: 0, owing: 0 })
    expect(theirs?.pricesHidden).toBe(true)
  })

  test('not a job in the Recycle bin', async () => {
    const s = await setup()
    const jobId = await insertJob(s, { status: 'completed' })
    await s.owner.as.mutation(api.bin.deleteJob, {
      businessId: s.businessId,
      jobId,
    })
    expect((await list(s, 'toBill'))?.rows).toEqual([])
  })
})

describe('money in, by month', () => {
  const month = (
    s: Setup,
    extra: { month?: string; person?: Id<'memberships'> } = {},
    as: TestActor = s.owner,
  ) => as.as.query(api.payments.paidIn, { businessId: s.businessId, ...extra })

  test('this month, newest first, by method and by person', async () => {
    const s = await setup()
    const first = await insertJob(s, { status: 'completed' })
    const second = await insertJob(s, { status: 'completed' })
    await pay(s, first, { amount: 10000, receivedAt: Date.now() - 1000 })
    await pay(s, second, { method: 'card' })

    const paid = await month(s)
    expect(paid).toMatchObject({
      thisMonth: true,
      total: PRICE + 10000,
      byMethod: [
        { method: 'card', value: PRICE, count: 1 },
        { method: 'cash', value: 10000, count: 1 },
      ],
      byPerson: [{ membershipId: s.ownerMembershipId, value: PRICE + 10000 }],
      more: false,
    })
    expect(paid?.rows.map((row) => row.method)).toEqual(['card', 'cash'])
    expect(paid?.rows[1]).toMatchObject({
      jobId: first,
      clientName: 'J. Nguyen',
      amount: 10000,
      dayKey: dayKeyOf(Date.now() - 1000, ZONE),
      whose: s.ownerMembershipId,
    })
  })

  test('another month, and whether there is one before it', async () => {
    const s = await setup()
    const jobId = await insertJob(s, { status: 'completed' })
    const longAgo = Date.now() - 45 * DAY
    await pay(s, jobId, { receivedAt: longAgo })
    const key = dayKeyOf(longAgo, ZONE).slice(0, 7)

    const then = await month(s, { month: key })
    expect(then?.rows).toHaveLength(1)
    expect(then).toMatchObject({ thisMonth: false, hasEarlier: false })

    const now = await month(s)
    expect(now?.rows).toEqual([])
    expect(now?.hasEarlier).toBe(true)
  })

  test('not what was taken back, nor a job given away', async () => {
    const s = await setup()
    const taken = await insertJob(s, { status: 'completed' })
    const given = await insertJob(s, { status: 'completed' })
    const { paymentId } = await pay(s, taken)
    await takeBack(s, taken, paymentId)
    await pay(s, given, { method: 'noCharge' })

    const paid = await month(s)
    expect(paid?.rows).toEqual([])
    expect(paid?.total).toBe(0)
  })

  test('one person’s: their own work, or money marked for them', async () => {
    const s = await setup()
    const { sam, samId, jobId } = await withSubcontractor(s, { prices: true })
    const another = await insertJob(s, { assignedMembershipId: samId })
    await pay(s, jobId, {
      as: sam,
      complete: true,
      handOver: { to: s.ownerMembershipId },
    })
    await pay(s, another, { as: sam, complete: true, method: 'card' })

    expect(
      (await month(s, { person: s.ownerMembershipId }))?.rows.map(
        (row) => row.jobId,
      ),
    ).toEqual([jobId])
    const sams = await month(s, { person: samId })
    expect(sams?.rows.map((row) => row.jobId)).toEqual([another])
    expect(sams?.rows[0].whoseName).toBe('Sam')
  })

  test('a subcontractor sees money on their own work only', async () => {
    const s = await setup()
    const { sam, jobId } = await withSubcontractor(s, { prices: true })
    const ownersJob = await insertJob(s, { status: 'completed' })
    await pay(s, ownersJob)
    await pay(s, jobId, { as: sam, complete: true })
    expect((await month(s, {}, sam))?.rows.map((row) => row.jobId)).toEqual([
      jobId,
    ])
  })

  test('no figure for someone who cannot see prices', async () => {
    const s = await setup()
    const { sam, jobId } = await withSubcontractor(s)
    await pay(s, jobId, { as: sam, complete: true })
    const theirs = await month(s, {}, sam)
    expect(theirs).toMatchObject({ total: null, byMethod: [], byPerson: [] })
    expect(theirs?.rows[0]).toMatchObject({ method: 'cash', amount: 0 })
  })

  test('not a month that is not one', async () => {
    const s = await setup()
    await expect(month(s, { month: '2026-13' })).rejects.toThrow('INVALID_DAY')
  })

  test('an earlier month only if this caller would see money in it', async () => {
    const s = await setup()
    const { sam } = await withSubcontractor(s, { prices: true })
    const ownersJob = await insertJob(s, { status: 'completed' })
    await pay(s, ownersJob, { receivedAt: Date.now() - 45 * DAY })
    expect((await month(s))?.hasEarlier).toBe(true)
    expect((await month(s, {}, sam))?.hasEarlier).toBe(false)
  })

  test('a payment put on a day says so', async () => {
    const s = await setup()
    const jobId = await insertJob(s, { status: 'invoiced', invoicedAt: 1 })
    await pay(s, jobId, { method: 'bankTransfer' })
    const dated = await insertJob(s, { status: 'invoiced', invoicedAt: 1 })
    await pay(s, dated, {
      method: 'bankTransfer',
      receivedAt: Date.now() - 1000,
    })
    const rows = (await month(s))?.rows ?? []
    expect(rows.find((row) => row.jobId === jobId)?.dayOnly).toBe(false)
    expect(rows.find((row) => row.jobId === dated)?.dayOnly).toBe(true)
    const money = await s.owner.as.query(api.payments.forJob, {
      businessId: s.businessId,
      jobId: dated,
    })
    expect(money?.payments[0]?.dayOnly).toBe(true)
  })

  test('Paid this month is the month the page asks for', async () => {
    const s = await setup()
    const jobId = await insertJob(s, { status: 'completed' })
    await pay(s, jobId)
    const thisMonth = dayKeyOf(Date.now(), ZONE).slice(0, 7)
    const lastMonth = addDaysToKey(`${thisMonth}-01`, -1).slice(0, 7)
    const summaryFor = (key: string) =>
      s.owner.as.query(api.payments.summary, {
        businessId: s.businessId,
        month: key,
      })
    expect((await summaryFor(thisMonth))?.paidThisMonth).toBe(PRICE)
    expect((await summaryFor(lastMonth))?.paidThisMonth).toBe(0)
    await expect(summaryFor('2026-13')).rejects.toThrow('INVALID_DAY')
  })
})

describe('handing money over', () => {
  const tick = (
    s: Setup,
    as: TestActor,
    paymentIds: Array<Id<'payments'>>,
    done = true,
  ) =>
    as.as.mutation(api.payments.setHandOverDone, {
      businessId: s.businessId,
      paymentIds,
      done,
    })

  const mark = (
    s: Setup,
    as: TestActor,
    jobId: Id<'jobs'>,
    paymentId: Id<'payments'>,
    handOver: {
      from?: Id<'memberships'>
      to: Id<'memberships'>
      note?: string
    } | null,
  ) =>
    as.as.mutation(api.payments.setHandOver, {
      businessId: s.businessId,
      jobId,
      paymentId,
      handOver,
    })

  test('cash is nobody else’s until someone says so', async () => {
    const s = await setup()
    const { sam, jobId } = await withSubcontractor(s, { prices: true })
    await pay(s, jobId, { as: sam, complete: true })

    expect((await figures(s))?.toHandOver).toEqual([])
    expect((await figures(s, sam))?.toHandOver).toEqual([])
    expect((await moneyOn(s, jobId))?.payments[0].handOver).toBeNull()
  })

  test('marked in the same tap, on a job the owner gave them', async () => {
    const s = await setup()
    const { sam, samId, jobId } = await withSubcontractor(s, { prices: true })
    const { paymentId } = await pay(s, jobId, {
      as: sam,
      complete: true,
      handOver: { to: s.ownerMembershipId },
    })

    expect((await figures(s))?.toHandOver).toEqual([
      expect.objectContaining({
        from: samId,
        fromName: 'Sam',
        to: s.ownerMembershipId,
        value: PRICE,
        paymentIds: [paymentId],
      }),
    ])
  })

  test('the other way round, and the person owed sees it off their own list', async () => {
    const s = await setup()
    const { sam, samId } = await withSubcontractor(s, { prices: true })
    const theirWorkDoneByOwner = await insertJob(s, { status: 'completed' })
    await pay(s, theirWorkDoneByOwner, {
      handOver: { to: samId, note: 'Sam’s client, I just covered it' },
    })

    expect(await moneyOn(s, theirWorkDoneByOwner, sam)).toBeNull()
    expect((await figures(s, sam))?.toHandOver).toEqual([
      expect.objectContaining({
        from: s.ownerMembershipId,
        to: samId,
        value: PRICE,
      }),
    ])
  })

  test('the owner can write up what someone else is holding', async () => {
    const s = await setup()
    const { samId, jobId } = await withSubcontractor(s, { prices: true })
    await pay(s, jobId, {
      complete: true,
      handOver: { from: samId, to: s.ownerMembershipId },
    })
    expect((await figures(s))?.toHandOver[0].from).toBe(samId)
  })

  test('any way the money came, with a note of what was agreed', async () => {
    const s = await setup()
    const { sam, jobId } = await withSubcontractor(s, { prices: true })
    await pay(s, jobId, {
      as: sam,
      method: 'card',
      complete: true,
      handOver: {
        to: s.ownerMembershipId,
        note: '  Sam keeps $50, the rest to Terence ',
      },
    })
    expect((await moneyOn(s, jobId))?.payments[0].handOver).toMatchObject({
      fromName: 'Sam',
      note: 'Sam keeps $50, the rest to Terence',
      doneAt: null,
    })
  })

  test('marked afterwards, changed, and taken off again', async () => {
    const s = await setup()
    const { sam, samId, jobId } = await withSubcontractor(s, { prices: true })
    const { paymentId } = await pay(s, jobId, { as: sam, complete: true })

    await mark(s, sam, jobId, paymentId, { to: s.ownerMembershipId })
    expect((await figures(s))?.toHandOver).toHaveLength(1)

    await mark(s, s.owner, jobId, paymentId, {
      from: s.ownerMembershipId,
      to: samId,
    })
    expect((await figures(s))?.toHandOver[0].to).toBe(samId)

    await mark(s, sam, jobId, paymentId, null)
    expect((await figures(s))?.toHandOver).toEqual([])
    expect((await moneyOn(s, jobId))?.payments[0].handOver).toBeNull()
  })

  test('either of them can tick it off, and put the tick back', async () => {
    const s = await setup()
    const { sam, jobId } = await withSubcontractor(s, { prices: true })
    const { paymentId } = await pay(s, jobId, {
      as: sam,
      complete: true,
      handOver: { to: s.ownerMembershipId },
    })
    expect((await moneyOn(s, jobId, sam))?.payments[0].handOver?.canTick).toBe(
      true,
    )

    await tick(s, sam, [paymentId])
    expect((await figures(s))?.toHandOver).toEqual([])
    const row = (await moneyOn(s, jobId))?.payments[0]
    expect(row?.handOver?.doneAt).toBeTypeOf('number')

    await tick(s, s.owner, [paymentId], false)
    expect((await figures(s))?.toHandOver).toHaveLength(1)
    expect((await moneyOn(s, jobId))?.payments[0].handOver?.doneAt).toBeNull()

    await tick(s, s.owner, [paymentId])
    await tick(s, s.owner, [paymentId])
    expect((await figures(s))?.toHandOver).toEqual([])
  })

  test('the owner can tick off one between two others', async () => {
    const s = await setup()
    const { sam, jobId } = await withSubcontractor(s, { prices: true })
    const pat = await createActor(s.t, { email: 'pat@coastal.test' })
    const patId = await joinBusiness(
      s.t,
      s.owner,
      pat,
      s.businessId,
      'subcontractor',
    )
    const { paymentId } = await pay(s, jobId, {
      as: sam,
      complete: true,
      handOver: { to: patId },
    })
    await tick(s, s.owner, [paymentId])
    expect((await figures(s))?.toHandOver).toEqual([])
  })

  test('it is nobody else’s to tick', async () => {
    const s = await setup()
    const { sam, jobId } = await withSubcontractor(s, { prices: true })
    const pat = await createActor(s.t, { email: 'pat@coastal.test' })
    await joinBusiness(s.t, s.owner, pat, s.businessId, 'subcontractor')
    const { paymentId } = await pay(s, jobId, {
      as: sam,
      complete: true,
      handOver: { to: s.ownerMembershipId },
    })
    await expect(tick(s, pat, [paymentId])).rejects.toThrow(/NO_ACCESS/)
  })

  test('marking one needs the job to be yours to edit', async () => {
    const s = await setup()
    const { sam } = await withSubcontractor(s, { prices: true })
    const ownersJob = await insertJob(s, { status: 'completed' })
    const { paymentId } = await pay(s, ownersJob)
    await expect(
      mark(s, sam, ownersJob, paymentId, { to: s.ownerMembershipId }),
    ).rejects.toThrow(/NO_ACCESS/)
  })

  test('not to themselves, not on No charge, not a long story', async () => {
    const s = await setup()
    const jobId = await insertJob(s, { status: 'completed' })
    const free = await insertJob(s, { status: 'completed' })
    const to = s.ownerMembershipId
    await expect(pay(s, jobId, { handOver: { to } })).rejects.toThrow(
      /INVALID_PAYMENT/,
    )
    const { sam, samId } = await withSubcontractor(s, { prices: true })
    expect(sam).toBeDefined()
    await expect(
      pay(s, free, { method: 'noCharge', handOver: { to: samId } }),
    ).rejects.toThrow(/INVALID_PAYMENT/)
    await expect(
      pay(s, jobId, { handOver: { to: samId, note: 'x'.repeat(201) } }),
    ).rejects.toThrow(/INVALID_PAYMENT/)
  })

  test('not to someone from another business', async () => {
    const s = await setup()
    const other = await createActor(s.t, { email: 'other@elsewhere.test' })
    const { ownerMembershipId: stranger } = await createBusiness(s.t, other)
    const jobId = await insertJob(s, { status: 'completed' })
    await expect(pay(s, jobId, { handOver: { to: stranger } })).rejects.toThrow(
      /NOT_FOUND/,
    )
  })

  test('someone who cannot see prices can mark it, and sees no figure', async () => {
    const s = await setup()
    const { sam, jobId } = await withSubcontractor(s)
    await pay(s, jobId, {
      as: sam,
      complete: true,
      handOver: { to: s.ownerMembershipId },
    })
    expect((await figures(s, sam))?.toHandOver).toEqual([])
    expect((await figures(s))?.toHandOver[0].value).toBe(PRICE)
    expect((await moneyOn(s, jobId, sam))?.payments[0]).toMatchObject({
      amount: 0,
      handOver: { doneAt: null },
    })
  })

  test('a payment taken back has nothing to hand over', async () => {
    const s = await setup()
    const { sam, jobId } = await withSubcontractor(s, { prices: true })
    const { paymentId } = await pay(s, jobId, {
      as: sam,
      handOver: { to: s.ownerMembershipId },
    })
    await takeBack(s, jobId, paymentId, sam)
    expect((await figures(s))?.toHandOver).toEqual([])
    await expect(
      mark(s, sam, jobId, paymentId, { to: s.ownerMembershipId }),
    ).rejects.toThrow(/NOT_FOUND/)
  })

  test('a job in the bin takes it along, for the person owed too', async () => {
    const s = await setup()
    const { sam, samId } = await withSubcontractor(s, { prices: true })
    const jobId = await insertJob(s, { status: 'completed' })
    await pay(s, jobId, { handOver: { to: samId } })
    expect((await figures(s, sam))?.toHandOver).toHaveLength(1)

    await s.owner.as.mutation(api.bin.deleteJob, {
      businessId: s.businessId,
      jobId,
    })
    expect((await figures(s, sam))?.toHandOver).toEqual([])
  })
})

describe('the rules on their own', () => {
  const none = moneyOf([])
  const cash = (amount: number, deposit?: boolean) => ({
    amount,
    method: 'cash' as const,
    deposit,
  })

  test('nothing moves a job into or out of Paid by asking', () => {
    expect(() => assertStatusChange('completed', 'paid')).toThrow(
      /STATUS_NOT_SETTABLE/,
    )
    expect(() => assertStatusChange('paid', 'completed')).toThrow(/JOB_PAID/)
    expect(() => assertStatusChange('paid', 'cancelled')).toThrow(/JOB_PAID/)
    expect(() => assertStatusChange('paid', 'paid')).not.toThrow()
  })

  test('a payment taken back is not money', () => {
    expect(moneyOf([cash(100), { ...cash(50), removedAt: 1 }])).toEqual({
      paid: 100,
      afterWork: 100,
      waived: false,
    })
  })

  test('paid past the price is nothing owing, not a negative', () => {
    expect(owingOn(100, moneyOf([cash(150)]))).toBe(0)
  })

  test('no price and no payment is not settled', () => {
    expect(isSettled(0, none)).toBe(false)
  })

  test.each<
    [
      string,
      JobStatus,
      ReturnType<typeof moneyOf>,
      number | undefined,
      JobStatus,
    ]
  >([
    [
      'booked, deposit',
      'booked',
      moneyOf([cash(50, true)]),
      undefined,
      'booked',
    ],
    [
      'booked, covered',
      'booked',
      moneyOf([cash(200, true)]),
      undefined,
      'booked',
    ],
    [
      'cancelled, covered',
      'cancelled',
      moneyOf([cash(200)]),
      undefined,
      'cancelled',
    ],
    ['completed, nothing', 'completed', none, undefined, 'completed'],
    [
      'completed, deposit',
      'completed',
      moneyOf([cash(50, true)]),
      undefined,
      'completed',
    ],
    [
      'completed, part',
      'completed',
      moneyOf([cash(50)]),
      undefined,
      'invoiced',
    ],
    ['completed, all', 'completed', moneyOf([cash(200)]), undefined, 'paid'],
    ['invoiced, nothing', 'invoiced', none, 1, 'invoiced'],
    ['paid, all gone', 'paid', none, undefined, 'completed'],
    ['paid, all gone, billed', 'paid', none, 1, 'invoiced'],
    [
      'paid, deposit left',
      'paid',
      moneyOf([cash(50, true)]),
      undefined,
      'completed',
    ],
    ['paid, part left', 'paid', moneyOf([cash(50)]), undefined, 'invoiced'],
  ])('%s', (_name, status, money, invoicedAt, expected) => {
    expect(statusFromMoney({ status, price: 200, invoicedAt }, money)).toBe(
      expected,
    )
  })

  test.each([
    ['completed', undefined, true],
    ['paid', 1, true],
    ['paid', undefined, false],
    ['invoiced', 1, true],
    ['invoiced', undefined, false],
    ['booked', undefined, false],
    ['cancelled', 1, false],
  ])(
    'on the day’s list, %s with completedAt %s sinks: %s',
    (status, completedAt, sinks) => {
      expect(sinksOnDay({ status, completedAt })).toBe(sinks)
    },
  )

  test('billed at the door sinks; billed ahead of the work does not', () => {
    const job = (id: string, scheduledAt: number, completedAt?: number) => ({
      id,
      scheduledAt,
      status: 'invoiced' as JobStatus,
      completedAt,
    })
    const ordered = orderForDay([job('at the door', 1, 500), job('ahead', 2)])
    expect(ordered.map((j) => j.id)).toEqual(['ahead', 'at the door'])
  })

  test('finishing honours the choice until the money covers it', () => {
    expect(finishedStatus('invoiced', 200, moneyOf([cash(50)]))).toBe(
      'invoiced',
    )
    expect(finishedStatus('completed', 200, moneyOf([cash(200)]))).toBe('paid')
  })
})

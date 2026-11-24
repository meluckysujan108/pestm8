import { describe, expect, test } from 'vitest'
import {
  activityDayLabel,
  activityWords,
  earlierLine,
  feedCaption,
  feedEndLine,
  feedJobLine,
  feedNothingBy,
  originLine,
  paymentWords,
  whoDidIt,
} from './jobActivity'
import type { ActivityEntry } from '../../convex/jobActivity'
import type { Id } from '../../convex/_generated/dataModel'

const TZ = 'Australia/Perth'
const TODAY = '2026-11-24'
/** 9:00am, Wed 25 Nov 2026, in Perth. */
const NINE = Date.UTC(2026, 10, 25, 1, 0)
const HOUR = 60 * 60 * 1000

const terence = { name: 'Terence', you: false }
const kevin = { name: 'Kevin', you: false }
const jo = { name: 'Jo', you: false }
const me = { name: 'Sam', you: true }

function entry(over: Partial<ActivityEntry>): ActivityEntry {
  return {
    _id: 'a1' as Id<'jobActivity'>,
    at: NINE,
    action: 'job.update',
    by: terence,
    inAccountOf: null,
    changes: [],
    payment: null,
    interval: null,
    binRoot: null,
    ...over,
  }
}

const words = (over: Partial<ActivityEntry>) =>
  activityWords(entry(over), TZ, TODAY)

describe('who did it', () => {
  test('a name, or You for the person reading', () => {
    expect(whoDidIt(entry({}))).toBe('Terence')
    expect(whoDidIt(entry({ by: me }))).toBe('You')
  })

  test('and whose account it was done in, when that was someone else’s', () => {
    expect(whoDidIt(entry({ inAccountOf: kevin }))).toBe(
      'Terence, in Kevin’s account',
    )
    expect(whoDidIt(entry({ inAccountOf: me }))).toBe(
      'Terence, in your account',
    )
  })
})

describe('an edit, a sentence for each change', () => {
  test('moved on the same day says the times and the day', () => {
    expect(
      words({
        changes: [{ field: 'scheduledAt', from: NINE, to: NINE + 2 * HOUR }],
      }).lines,
    ).toEqual(['Moved it from 9:00am to 11:00am, Wed 25 Nov'])
  })

  test('moved to another day says both moments', () => {
    expect(
      words({
        changes: [{ field: 'scheduledAt', from: NINE, to: NINE + 24 * HOUR }],
      }).lines,
    ).toEqual(['Moved it from Wed 25 Nov, 9:00am to Thu 26 Nov, 9:00am'])
  })

  test('status, length, service and address', () => {
    expect(
      words({
        changes: [
          { field: 'status', from: 'booked', to: 'completed' },
          { field: 'durationMinutes', from: 60, to: 90 },
          { field: 'jobType', from: 'General Pest Control', to: 'Rodents' },
          { field: 'property', from: '12 Wattle St, Bayswater', to: null },
        ],
      }).lines,
    ).toEqual([
      'Changed the status from Booked to Completed',
      'Changed the length from 1 hr to 1 hr 30 min',
      'Changed the service from General Pest Control to Rodents',
      'Changed the address from 12 Wattle St, Bayswater to another address',
    ])
  })

  test('people, with "you" for the person reading', () => {
    expect(
      words({
        changes: [
          { field: 'lead', from: kevin, to: me },
          { field: 'alsoGoing', added: [kevin, jo], removed: [me] },
        ],
      }).lines,
    ).toEqual([
      'Made you the lead, instead of Kevin',
      'Added Kevin and Jo as also going',
      'Took you off it',
    ])
  })

  test('the price, or only that it changed for someone who can’t see it', () => {
    expect(
      words({ changes: [{ field: 'price', from: 19500, to: 22050 }] }).lines,
    ).toEqual(['Changed the price from $195 to $220.50'])
    expect(
      words({ changes: [{ field: 'price', from: null, to: null }] }).lines,
    ).toEqual(['Changed the price'])
  })

  test('a work order added, changed and taken off', () => {
    expect(
      words({ changes: [{ field: 'workOrder', to: 'PO-1' }] }).lines,
    ).toEqual(['Added work order PO-1'])
    expect(
      words({ changes: [{ field: 'workOrder', from: 'PO-1', to: 'PO-2' }] })
        .lines,
    ).toEqual(['Changed the work order from PO-1 to PO-2'])
    expect(
      words({ changes: [{ field: 'workOrder', from: 'PO-2' }] }).lines,
    ).toEqual(['Took off work order PO-2'])
  })
})

describe('an action, said once', () => {
  test('finishing it is said by its status alone', () => {
    expect(
      words({
        action: 'job.complete',
        changes: [{ field: 'status', from: 'booked', to: 'completed' }],
      }).lines,
    ).toEqual(['Changed the status from Booked to Completed'])
  })

  test('a payment says how much and how, and what it did to the status', () => {
    expect(
      words({
        action: 'payment.record',
        payment: { method: 'card', amount: 19500, deposit: false },
        changes: [{ field: 'status', from: 'completed', to: 'paid' }],
      }).lines,
    ).toEqual([
      'Recorded a payment of $195 by card',
      'Changed the status from Completed to Paid',
    ])
  })

  test('a visit its Recurring Job’s stop cancelled says why, not the status', () => {
    expect(
      words({
        action: 'recurrence.stop',
        changes: [{ field: 'status', from: 'booked', to: 'cancelled' }],
      }).lines,
    ).toEqual(['Cancelled when its Recurring Job was stopped'])
  })

  test('handed on names both people once', () => {
    expect(
      words({
        action: 'membership.handOn',
        changes: [{ field: 'lead', from: kevin, to: jo }],
      }).lines,
    ).toEqual(['Handed it to Jo from Kevin, who is no longer on the team'])
    expect(
      words({
        action: 'membership.takeOff',
        changes: [{ field: 'alsoGoing', added: [], removed: [kevin] }],
      }).lines,
    ).toEqual(['Took Kevin off it, who is no longer on the team'])
  })

  test('the Recycle bin, and what it went in with', () => {
    expect(words({ action: 'bin.delete', binRoot: 'job' }).lines).toEqual([
      'Deleted this job',
    ])
    expect(words({ action: 'bin.delete', binRoot: 'client' }).lines).toEqual([
      'Deleted it with its client',
    ])
    expect(words({ action: 'bin.restore' }).lines).toEqual([
      'Restored it from the Recycle bin',
    ])
  })

  test('made to repeat, as often as it was set', () => {
    expect(
      words({ action: 'recurrence.convert', interval: 'Every 3 months' }).lines,
    ).toEqual(['Made it repeat every 3 months'])
  })
})

describe('payments in words', () => {
  test('by how it was paid, and how much where that may be seen', () => {
    expect(paymentWords({ method: 'cash', amount: 5000, deposit: true })).toBe(
      'a deposit of $50 by cash',
    )
    expect(
      paymentWords({ method: 'bankTransfer', amount: null, deposit: false }),
    ).toBe('a payment by bank transfer')
    expect(
      paymentWords({ method: 'other', amount: 1000, deposit: false }),
    ).toBe('a payment of $10')
    expect(
      paymentWords({ method: 'noCharge', amount: 0, deposit: false }),
    ).toBe('no charge')
    expect(paymentWords(null)).toBe('a payment')
  })
})

describe('where a history begins', () => {
  test('its first line when nobody’s booking is in it', () => {
    expect(originLine({ at: NINE, bySeries: false }, TZ, TODAY)).toEqual({
      line: 'Booked',
      when: 'Wed 25 Nov',
    })
    expect(originLine({ at: NINE, bySeries: true }, TZ, TODAY).line).toBe(
      'Put on the schedule by its Recurring Job',
    )
  })

  test('and what it never saw', () => {
    expect(earlierLine(NINE, TZ, TODAY)).toBe(
      'Changes before Wed 25 Nov weren’t recorded.',
    )
    expect(earlierLine(null, TZ, TODAY)).toBe(
      'Earlier changes weren’t recorded.',
    )
  })
})

describe('the business’s Activity (Settings → Activity)', () => {
  test('a day is Today, Yesterday, or its date', () => {
    expect(activityDayLabel(TODAY, TODAY)).toBe('Today')
    expect(activityDayLabel('2026-11-23', TODAY)).toBe('Yesterday')
    expect(activityDayLabel('2026-11-20', TODAY)).toBe('Fri 20 Nov')
    expect(activityDayLabel('2025-12-31', TODAY)).toBe('Wed 31 Dec 2025')
  })

  test('a line names its job: what, for whom, and when', () => {
    const job = {
      state: 'open' as const,
      jobType: 'General Pest Control',
      client: 'J. Nguyen',
      suburb: 'Bayswater',
      scheduledAt: NINE,
    }
    expect(feedJobLine(job, TZ, TODAY)).toBe(
      'General Pest Control · J. Nguyen, Bayswater · Wed 25 Nov',
    )
    // A client outside the reader's book is left out, not guessed at.
    expect(feedJobLine({ ...job, client: null, suburb: null }, TZ, TODAY)).toBe(
      'General Pest Control · Wed 25 Nov',
    )
    expect(feedJobLine({ state: 'gone' }, TZ, TODAY)).toBe(
      'A job since deleted for good',
    )
  })

  test('its foot: nothing older, and where the history begins when it began after the jobs', () => {
    const kevinTran = { name: 'Kevin Tran', you: false }
    const you = { name: 'Terence', you: true }
    // A business that began with its history holds every change.
    expect(feedEndLine(null, null, TZ, TODAY)).toBe('That’s every change.')
    expect(feedEndLine(null, kevinTran, TZ, TODAY)).toBe(
      'Nothing earlier by Kevin Tran.',
    )
    expect(feedEndLine(null, you, TZ, TODAY)).toBe('Nothing earlier by you.')
    // One whose jobs were booked before it began says when it began.
    expect(feedEndLine(NINE, null, TZ, TODAY)).toBe(
      'Changes before Wed 25 Nov weren’t recorded.',
    )
    expect(feedEndLine(NINE, kevinTran, TZ, TODAY)).toBe(
      'Nothing earlier by Kevin Tran. Changes before Wed 25 Nov weren’t recorded.',
    )
  })

  test('narrowed to one person, it names them as its lines do', () => {
    expect(feedCaption(null)).toBe('Every change to every job, newest first.')
    expect(feedCaption({ name: 'Kevin Tran', you: false })).toBe(
      'Changes made by Kevin Tran, newest first.',
    )
    expect(feedCaption({ name: 'Terence', you: true })).toBe(
      'Changes you made, newest first.',
    )
    expect(feedNothingBy({ name: 'Kevin Tran', you: false })).toBe(
      'Kevin Tran hasn’t changed a job.',
    )
    expect(feedNothingBy({ name: 'Terence', you: true })).toBe(
      'You haven’t changed a job.',
    )
  })
})

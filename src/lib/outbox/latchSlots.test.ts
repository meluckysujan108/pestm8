import { describe, expect, test } from 'vitest'
import {
  ADD_AFTER_DRAW_MS,
  ROW_WAIT_MS,
  addRule,
  answeredView,
  latchSlots,
  realRowOf,
} from './latchSlots'
import { bookingFor, itemFor } from './outboxStore.fixtures'
import type { DayRow } from '#/lib/offline/keeper'
import type { Id } from '../../../convex/_generated/dataModel'
import type { DrawSource, LatchInput, SlotLatch } from './latchSlots'
import type { OutboxItem } from './outboxItem'

/**
 * Where a day's bookings not sent yet are drawn, so nothing on screen moves
 * under a thumb: each keeps its slot until the next redraw, the real job
 * taking its place there once sent, and a booking is never drawn beside the
 * job it made.
 */

const TZ = 'Australia/Perth'
const DAY = '2026-10-27'
const OTHER_DAY = '2026-10-29'
/** 9am on DAY in Perth. */
const NINE = Date.UTC(2026, 9, 27, 1)
const NOW = Date.UTC(2026, 9, 27, 0)
const HOUR = 3_600_000

let made = 0
function booking(
  at: number,
  extra: Partial<OutboxItem> = {},
  createdAt = NOW - 60_000,
): OutboxItem {
  made++
  return itemFor(
    'u1',
    {
      booking: bookingFor({ scheduledAt: at }),
      updatedAt: made,
      ...extra,
    },
    createdAt,
  )
}

function sent(item: OutboxItem, id: string): OutboxItem {
  return {
    ...item,
    state: 'sent',
    result: { id },
    sentAt: NOW,
    updatedAt: item.updatedAt + 1,
  }
}

function row(id: string, extra: Partial<DayRow> = {}): DayRow {
  return {
    _id: id as Id<'jobs'>,
    scheduledAt: NINE,
    ...extra,
  } as DayRow
}

function input(over: Partial<LatchInput> = {}): LatchInput {
  return {
    items: [],
    drawing: true,
    rows: [],
    redrawKey: 'day',
    dayShown: DAY,
    timezone: TZ,
    dayLive: false,
    now: NOW,
    mayAdd: () => true,
    ...over,
  }
}

/** Two renders in a row, the latch held between them as the hook holds it. */
function then(
  prev: SlotLatch | null,
  over: Partial<LatchInput>,
): ReturnType<typeof latchSlots> {
  return latchSlots(prev, input(over))
}

describe('a day’s bookings not sent yet', () => {
  test('nothing is drawn, or decided, until they can be read; hydrating, nothing is noted either', () => {
    const hydrating = then(null, { items: null, drawing: false })
    expect(hydrating).toEqual({
      latch: null,
      slots: [],
      hidden: new Set(),
      heading: null,
      recheckAt: null,
    })
    // Drawn, but the phone's bookings not read yet: only when it drew.
    const drawn = then(null, { items: null, now: NOW })
    expect(drawn.slots).toEqual([])
    expect(drawn.heading).toBeNull()
    expect(drawn.latch).toEqual({ redrawKey: 'day', since: NOW, slots: [] })
  })

  test('first drawn in the order they are booked for, then saved; each with its chip', () => {
    const late = booking(NINE + 2 * HOUR)
    const early = booking(NINE)
    const sending = booking(NINE + HOUR, {
      state: 'sending',
      attempts: 1,
      lastAttemptAt: NOW,
    })
    const drawn = then(null, { items: [late, early, sending] })
    expect(drawn.slots.map((s) => [s.localId, s.chip])).toEqual([
      [early.localId, 'waiting'],
      [sending.localId, 'sending'],
      [late.localId, 'waiting'],
    ])
    expect(drawn.slots[0].key).toBe(`outbox:${early.localId}`)
    expect(drawn.heading).toBe('2 jobs not sent yet, 1 sending')
  })

  test('the heading counts what might be booked again by mistake, singular and plural', () => {
    const one = booking(NINE)
    expect(then(null, { items: [one] }).heading).toBe('1 job not sent yet')
    const look = booking(NINE, { state: 'needsLook', problem: { code: 'X' } })
    expect(then(null, { items: [one, look] }).heading).toBe(
      '2 jobs not sent yet',
    )
    const going = booking(NINE, { state: 'sending' })
    expect(then(null, { items: [going] }).heading).toBe('1 job sending')
  })
})

describe('keeping the slot', () => {
  test('a booking on screen keeps its place while it goes, whatever is added', () => {
    const a = booking(NINE + HOUR)
    const first = then(null, { items: [a] })
    // Booked earlier in the day, kept since: appended, not put first.
    const b = booking(NINE)
    const next = then(first.latch, { items: [a, b] })
    expect(next.slots.map((s) => s.localId)).toEqual([a.localId, b.localId])
  })

  test('the job match: once sent and in the list, the slot draws the real job, which the list leaves out', () => {
    const a = booking(NINE)
    const first = then(null, { items: [a] })
    const real = row('job-1')
    const next = then(first.latch, {
      items: [sent(a, 'job-1')],
      rows: [real],
      dayLive: true,
    })
    expect(next.slots).toHaveLength(1)
    expect(next.slots[0]).toMatchObject({
      key: `outbox:${a.localId}`,
      real,
      chip: null,
    })
    expect([...next.hidden]).toEqual(['job-1'])
    expect(next.heading).toBe('Sent')
  })

  test('the series match: a Recurring Job is its series’ visit on the day', () => {
    const a = booking(NINE, {
      kind: 'series',
      booking: bookingFor({
        scheduledAt: NINE,
        repeat: { count: 1, unit: 'month' },
      }),
    })
    const first = then(null, { items: [a] })
    const visit = row('visit-1', {
      recurrenceId: 'series-1' as Id<'recurrences'>,
    })
    const next = then(first.latch, {
      items: [sent(a, 'series-1')],
      rows: [row('other'), visit],
      dayLive: true,
    })
    expect(next.slots[0].real).toBe(visit)
    expect([...next.hidden]).toEqual(['visit-1'])
    expect(realRowOf(sent(a, 'series-1'), [visit])).toBe(visit)
    expect(realRowOf(sent(a, 'nope'), [visit])).toBeNull()
  })

  test('latched until the redraw: then the job is the list’s, in its order, and the group is gone', () => {
    const a = booking(NINE)
    const first = then(null, { items: [a] })
    const held = then(first.latch, {
      items: [sent(a, 'job-1')],
      rows: [row('job-1')],
      dayLive: true,
    })
    // Gone from the phone since (deleted once sent): the slot still holds.
    const gone = then(held.latch, {
      items: [],
      rows: [row('job-1')],
      dayLive: true,
    })
    expect(gone.slots).toHaveLength(1)
    expect(gone.hidden.has('job-1')).toBe(true)
    const redrawn = then(gone.latch, {
      items: [sent(a, 'job-1')],
      rows: [row('job-1')],
      dayLive: true,
      redrawKey: 'another day and back',
    })
    expect(redrawn.slots).toEqual([])
    expect(redrawn.hidden.size).toBe(0)
    expect(redrawn.heading).toBeNull()
  })

  test('never twice: a booking whose job is in the list is never drawn as itself', () => {
    const a = sent(booking(NINE), 'job-1')
    const drawn = then(null, { items: [a], rows: [row('job-1')] })
    expect(drawn.slots).toEqual([])
  })

  test('never twice, before the phone knows it was sent: a job carrying its request id is the booking’s', () => {
    const a = booking(NINE, { state: 'sending', attempts: 1 })
    const job = row('job-1', { clientRequestId: a.requestId })
    // Not on screen yet: left to the list, never drawn beside its job.
    expect(then(null, { items: [a], rows: [job] }).slots).toEqual([])
    // On screen: the slot draws it, and the list leaves it out.
    const first = then(null, { items: [a] })
    expect(first.slots.map((slot) => slot.chip)).toEqual(['sending'])
    const next = then(first.latch, { items: [a], rows: [job], dayLive: true })
    expect(next.slots[0]).toMatchObject({ real: job, chip: null })
    expect([...next.hidden]).toEqual(['job-1'])
    expect(next.heading).toBe('Sent')
    // Another booking's job is not this one's.
    expect(realRowOf(a, [row('job-2', { clientRequestId: 'other' })])).toBe(
      null,
    )
    // A series' visits never carry it: matched by what it was answered with.
    const series = booking(NINE, { kind: 'series' })
    expect(
      realRowOf(series, [row('v', { clientRequestId: series.requestId })]),
    ).toBeNull()
  })

  test('a series matched by its first visit alone (`firstJobId`), as the server’s `find` says', () => {
    const a = booking(NINE, { kind: 'series' })
    const visit = row('visit-1')
    const settled: OutboxItem = {
      ...sent(a, 'series-1'),
      result: { id: 'series-1', firstJobId: 'visit-1' as Id<'jobs'> },
    }
    expect(realRowOf(settled, [row('other'), visit])).toBe(visit)
    const first = then(null, { items: [a] })
    const next = then(first.latch, {
      items: [settled],
      rows: [row('other'), visit],
      dayLive: true,
    })
    expect(next.slots[0].real).toBe(visit)
    expect([...next.hidden]).toEqual(['visit-1'])
  })

  test('a slot on screen as its booking is sent waits a while for its job, the day live: the answer is heard before the list draws the job', () => {
    const a = booking(NINE)
    const first = then(null, { items: [a] })
    const answered = then(first.latch, {
      items: [sent(a, 'job-1')],
      dayLive: true,
      now: NOW + 10,
    })
    expect(answered.slots.map((slot) => slot.chip)).toEqual(['sent'])
    expect(answered.heading).toBe('Sent')
    expect(answered.recheckAt).toBe(NOW + ROW_WAIT_MS)
    // The job comes: drawn in the same slot.
    const landed = then(answered.latch, {
      items: [sent(a, 'job-1')],
      rows: [row('job-1')],
      dayLive: true,
      now: NOW + 50,
    })
    expect(landed.slots[0].real?._id).toBe('job-1')
    expect(landed.recheckAt).toBeNull()
    // It never does: once it has waited, the slot goes, being last.
    const never = then(answered.latch, {
      items: [sent(a, 'job-1')],
      dayLive: true,
      now: NOW + ROW_WAIT_MS,
    })
    expect(never.slots).toEqual([])
    expect(never.recheckAt).toBeNull()
  })

  test('the latch is the same object while nothing changes, so the screen settles', () => {
    const a = booking(NINE)
    const first = then(null, { items: [a] })
    const again = then(first.latch, { items: [a] })
    expect(again.latch).toBe(first.latch)
    const changed = then(first.latch, {
      items: [{ ...a, state: 'sending', updatedAt: a.updatedAt + 1 }],
    })
    expect(changed.latch).not.toBe(first.latch)
  })
})

describe('sent, with nothing to draw it as yet', () => {
  test('of the day shown: "Sent" until the day is live, then the slot goes, being last', () => {
    const a = booking(NINE)
    const b = booking(NINE + HOUR)
    const first = then(null, { items: [a, b] })
    const sentOnly = then(first.latch, {
      items: [a, sent(b, 'job-2')],
      dayLive: false,
    })
    expect(sentOnly.slots.map((s) => s.chip)).toEqual(['waiting', 'sent'])
    // Once its job has had time to come (ROW_WAIT_MS).
    const live = then(sentOnly.latch, {
      items: [a, sent(b, 'job-2')],
      dayLive: true,
      now: NOW + ROW_WAIT_MS,
    })
    expect(live.slots.map((s) => s.localId)).toEqual([a.localId])
  })

  test('first seen sent (settled after a reload): "Sent", until the day is live', () => {
    const a = sent(booking(NINE), 'job-1')
    expect(then(null, { items: [a] }).slots.map((s) => s.chip)).toEqual([
      'sent',
    ])
    expect(then(null, { items: [a], dayLive: true }).slots).toEqual([])
  })

  test('an item of another day drops its slot as soon as it is sent (S18)', () => {
    const elsewhere = booking(Date.UTC(2026, 9, 29, 1), {
      state: 'needsLook',
      problem: { code: 'INVALID_ASSIGNEE' },
    })
    const first = then(null, { items: [elsewhere] })
    expect(first.slots).toHaveLength(1)
    const next = then(first.latch, {
      items: [sent(elsewhere, 'job-9')],
      dayLive: false,
    })
    expect(next.slots).toEqual([])
    // As its own day shows it, it is drawn as sent there.
    expect(
      then(null, { items: [sent(elsewhere, 'job-9')], dayShown: OTHER_DAY })
        .slots,
    ).toHaveLength(1)
  })

  test('discarded or wiped while unsent: its slot goes with it', () => {
    const a = booking(NINE)
    const b = booking(NINE + HOUR)
    const first = then(null, { items: [a, b] })
    const next = then(first.latch, { items: [b] })
    expect(next.slots.map((s) => s.localId)).toEqual([b.localId])
  })
})

describe('coming onto the screen', () => {
  test('a booking not on screen comes only where it moves nothing a thumb may be on', () => {
    const a = booking(NINE)
    const empty = then(null, { items: [], now: NOW })
    const asked: Array<string> = []
    const late = then(empty.latch, {
      items: [a],
      now: NOW + ADD_AFTER_DRAW_MS + 1,
      mayAdd: (item, latch) => {
        asked.push(item.localId)
        expect(latch.since).toBe(NOW)
        return false
      },
    })
    expect(asked).toEqual([a.localId])
    expect(late.slots).toEqual([])
    // The next redraw draws it.
    const redrawn = then(late.latch, {
      items: [a],
      redrawKey: 'another day and back',
      mayAdd: (_item, latch) => latch.slots.length === 0,
    })
    expect(redrawn.slots).toHaveLength(1)
  })

  test('the window runs from the list’s first draw, not from when the phone’s bookings are first read', () => {
    const a = booking(NINE)
    // Drawn empty; the read of the phone's bookings slow, retried.
    const empty = then(null, { items: null, now: NOW })
    const asked: Array<number> = []
    const read = then(empty.latch, {
      items: [a],
      now: NOW + 4_000,
      mayAdd: (_item, latch) => {
        asked.push(latch.since)
        return addRule(
          { mayDraw: () => true, keptHere: new Set() },
          { drawsCards: false, now: NOW + 4_000 },
        )(a, latch)
      },
    })
    expect(asked).toEqual([NOW])
    expect(read.slots).toEqual([])
  })

  test('the redraw’s first draw starts a new window', () => {
    const first = then(null, { items: [], now: NOW })
    expect(first.latch?.since).toBe(NOW)
    const later = then(first.latch, { items: [], now: NOW + 10_000 })
    expect(later.latch?.since).toBe(NOW)
    const redrawn = then(later.latch, {
      items: [],
      now: NOW + 20_000,
      redrawKey: 'next',
    })
    expect(redrawn.latch?.since).toBe(NOW + 20_000)
  })
})

describe('what may come onto the screen (`addRule`)', () => {
  const latch: SlotLatch = { redrawKey: 'day', since: NOW, slots: [] }
  const source = (over: Partial<DrawSource> = {}): DrawSource => ({
    mayDraw: () => true,
    keptHere: new Set(),
    ...over,
  })

  test('under the day’s cards or a group already there, at any time', () => {
    const a = booking(NINE)
    const late = NOW + 60_000
    expect(addRule(source(), { drawsCards: true, now: late })(a, latch)).toBe(
      true,
    )
    const group = { ...latch, slots: [{ localId: 'x', item: a }] }
    expect(addRule(source(), { drawsCards: false, now: late })(a, group)).toBe(
      true,
    )
  })

  test('in place of “This day is clear.” only within the window, or booked here just now', () => {
    const a = booking(NINE)
    const rule = (now: number, over?: Partial<DrawSource>) =>
      addRule(source(over), { drawsCards: false, now })(a, latch)
    expect(rule(NOW + ADD_AFTER_DRAW_MS)).toBe(true)
    expect(rule(NOW + ADD_AFTER_DRAW_MS + 1)).toBe(false)
    expect(rule(NOW + 60_000, { keptHere: new Set([a.localId]) })).toBe(true)
  })

  test('never one its sheet is still deciding, or closed on its job', () => {
    const a = booking(NINE)
    expect(
      addRule(source({ mayDraw: () => false }), { drawsCards: true, now: NOW })(
        a,
        latch,
      ),
    ).toBe(false)
  })
})

describe('as the server answered it (`answeredView`)', () => {
  test('sent, with its job, from the moment the answer is heard', () => {
    const a = booking(NINE, { state: 'sending', attempts: 1 })
    expect(answeredView(a, undefined)).toBe(a)
    const viewed = answeredView(a, { id: 'job-1', at: NOW + 5 })
    expect(viewed).toMatchObject({
      state: 'sent',
      result: { id: 'job-1' },
      sentAt: NOW + 5,
    })
    // Once stored as sent, as stored.
    const stored = sent(a, 'job-1')
    expect(answeredView(stored, { id: 'job-1', at: NOW + 5 })).toBe(stored)
  })
})

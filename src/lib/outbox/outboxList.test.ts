import { describe, expect, test } from 'vitest'
import { ADD_AFTER_DRAW_MS } from './latchSlots'
import {
  bookedForClient,
  firstDrawOffers,
  jobTabShows,
  listAddRule,
} from './outboxList'
import { beginSendChange } from './outboxStore'
import { bookingFor, itemFor } from './outboxStore.fixtures'
import type { Id } from '../../../convex/_generated/dataModel'
import type { DrawSource, SlotLatch } from './latchSlots'
import type { BookingProperty } from './outboxItem'

/**
 * The bookings on this phone in a list of every day (plan part 2c §9.8):
 * when the Job tab's group may come above its list, and which bookings are
 * a client's.
 */

const NOW = Date.UTC(2026, 9, 27, 0)

describe('the Job tab’s first drawing (`firstDrawOffers`)', () => {
  test('reached in the app: its bookings may come on as it first draws', () => {
    expect(firstDrawOffers({ hydrating: false, byHistory: false })).toBe(true)
  })

  test('never on a full page load, whose first render hydrates over a list the HTML drew without them', () => {
    expect(firstDrawOffers({ hydrating: true, byHistory: false })).toBe(false)
  })

  test('never with Back or Forward (`cameByHistory`): the router puts the scroll back where it was', () => {
    expect(firstDrawOffers({ hydrating: false, byHistory: true })).toBe(false)
    expect(firstDrawOffers({ hydrating: true, byHistory: true })).toBe(false)
  })
})

describe('what may come onto a list of every day (`listAddRule`)', () => {
  const latch: SlotLatch = { redrawKey: 'list', since: NOW, slots: [] }
  const source = (over: Partial<DrawSource> = {}): DrawSource => ({
    mayDraw: () => true,
    keptHere: new Map(),
    ...over,
  })

  test('offered: only within the window of the list first drawing, a group already there or not, since what is under it moves', () => {
    const a = itemFor('u1', {}, NOW)
    const group = { ...latch, slots: [{ localId: 'x', item: a }] }
    const rule = (now: number, held = latch) =>
      listAddRule(source(), { now, offered: true })(a, held)
    expect(rule(NOW + ADD_AFTER_DRAW_MS)).toBe(true)
    expect(rule(NOW + ADD_AFTER_DRAW_MS + 1)).toBe(false)
    expect(rule(NOW + 60_000, group)).toBe(false)
  })

  test('not offered (a full page load, Back): nothing as it draws, however soon', () => {
    const a = itemFor('u1', {}, NOW - 60_000)
    expect(listAddRule(source(), { now: NOW, offered: false })(a, latch)).toBe(
      false,
    )
  })

  test('booked here just now, at any time: offered, or since the list drew', () => {
    // Both saved before the list drew; one booked in this tab before it
    // drew, the other noted as booked here since (an Edit's Book).
    const before = itemFor('u1', {}, NOW - 60_000)
    const after = itemFor('u1', {}, NOW - 60_000)
    const here = source({
      keptHere: new Map([
        [before.localId, NOW - 60_000],
        [after.localId, NOW + 30_000],
      ]),
    })
    const late = NOW + 60_000
    expect(listAddRule(here, { now: late, offered: true })(before, latch)).toBe(
      true,
    )
    // Not offered: booked earlier in this page load is no more just now
    // than any other booking; booked here since the list drew is, by when
    // this tab did so, not by the booking's own time.
    expect(
      listAddRule(here, { now: late, offered: false })(before, latch),
    ).toBe(false)
    expect(listAddRule(here, { now: late, offered: false })(after, latch)).toBe(
      true,
    )
  })

  test('not offered: one booked here before the list drew stays off when the sender changes it since (sending, held, refused)', () => {
    const kept = itemFor('u1', {}, NOW - 60_000)
    const here = source({ keptHere: new Map([[kept.localId, NOW - 60_000]]) })
    const sending = beginSendChange(NOW + 30_000)(kept)
    if (typeof sending === 'string') throw new Error(sending)
    expect(sending.state).toBe('sending')
    expect(sending.updatedAt).toBeGreaterThan(NOW)
    expect(
      listAddRule(here, { now: NOW + 60_000, offered: false })(sending, latch),
    ).toBe(false)
  })

  test('never one its sheet is still deciding, or closed on its job', () => {
    const a = itemFor('u1', {}, NOW)
    expect(
      listAddRule(
        source({ mayDraw: () => false, keptHere: new Map([[a.localId, NOW]]) }),
        { now: NOW, offered: true },
      )(a, latch),
    ).toBe(false)
  })
})

describe('which bookings the Job tab lists (`jobTabShows`)', () => {
  const a = itemFor('u1', {}, NOW)
  const led = { assignedMembershipId: 'm-lead' }
  const shared = {
    assignedMembershipId: 'm-lead',
    alsoGoing: [{ _id: 'm-also' }],
  }
  const all = { status: undefined, person: undefined, mine: null }

  test('only under “All statuses”: a booking has no status yet', () => {
    expect(jobTabShows(all)(a, led)).toBe(true)
    expect(jobTabShows({ ...all, status: 'pending' })(a, led)).toBe(false)
  })

  test('the person chosen: one they lead or are also going on', () => {
    expect(jobTabShows({ ...all, person: 'm-lead' })(a, led)).toBe(true)
    expect(jobTabShows({ ...all, person: 'm-also' })(a, shared)).toBe(true)
    expect(jobTabShows({ ...all, person: 'm-also' })(a, led)).toBe(false)
  })

  test('My jobs: one the person leads or is also going on', () => {
    expect(jobTabShows({ ...all, mine: 'm-also' })(a, shared)).toBe(true)
    expect(jobTabShows({ ...all, mine: 'm-also' })(a, led)).toBe(false)
    // With a person chosen too, both.
    expect(
      jobTabShows({ ...all, person: 'm-lead', mine: 'm-also' })(a, led),
    ).toBe(false)
  })
})

describe('which bookings are a client’s (`bookedForClient`)', () => {
  const C1 = 'c1'
  const ours = new Set(['p1', 'p2'])
  const on = (property: BookingProperty) => ({
    booking: bookingFor({ property: property as never }),
  })
  const newSite = (clientId: string) =>
    on({
      newProperty: {
        clientId,
        addressLine: '3 Rokeby Rd',
        suburb: 'Subiaco',
        postcode: '6008',
        state: 'WA',
      } as never,
    })

  test('one on a site of theirs; not one on anybody else’s', () => {
    const p1 = on({ propertyId: 'p1' as Id<'properties'> })
    const p9 = on({ propertyId: 'p9' as Id<'properties'> })
    expect(bookedForClient(p1, { clientId: C1, propertyIds: ours })).toBe(true)
    expect(bookedForClient(p9, { clientId: C1, propertyIds: ours })).toBe(false)
  })

  test('one on a new site for them, which only every site lists (it has no id yet)', () => {
    expect(
      bookedForClient(newSite(C1), { clientId: C1, propertyIds: ours }),
    ).toBe(true)
    expect(
      bookedForClient(newSite('c2'), { clientId: C1, propertyIds: ours }),
    ).toBe(false)
    expect(
      bookedForClient(newSite(C1), {
        clientId: C1,
        propertyIds: ours,
        site: 'p1',
      }),
    ).toBe(false)
  })

  test('one site chosen: only that site’s', () => {
    const p1 = on({ propertyId: 'p1' as Id<'properties'> })
    const p2 = on({ propertyId: 'p2' as Id<'properties'> })
    const shown = { clientId: C1, propertyIds: ours, site: 'p1' }
    expect(bookedForClient(p1, shown)).toBe(true)
    expect(bookedForClient(p2, shown)).toBe(false)
  })

  test('a new client’s is nobody’s yet, nor one made on a booking still on the phone (2c-I)', () => {
    const fresh = on({ newClient: { clientName: 'Jane Nguyen' } as never })
    const dependant = on({ local: 'parent-1' })
    expect(bookedForClient(fresh, { clientId: C1, propertyIds: ours })).toBe(
      false,
    )
    expect(
      bookedForClient(dependant, { clientId: C1, propertyIds: ours }),
    ).toBe(false)
  })
})

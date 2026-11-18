import { describe, expect, test } from 'vitest'
import { ADD_AFTER_DRAW_MS } from './latchSlots'
import {
  bookedForClient,
  firstDrawOffers,
  jobTabShows,
  listAddRule,
  madeAtOf,
  outboxSiteLine,
} from './outboxList'
import { beginSendChange } from './outboxStore'
import { DISPLAY, bookingFor, itemFor } from './outboxStore.fixtures'
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

  test('“Just my jobs”: one the person leads or is also going on', () => {
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

  test('a new client’s is nobody’s yet, nor is one made on it (2c-I)', () => {
    const fresh = itemFor('u1', {
      booking: bookingFor({
        property: { newClient: { clientName: 'Jane Nguyen' } as never },
      }),
    })
    const dependant = on({ local: fresh.localId })
    expect(bookedForClient(fresh, { clientId: C1, propertyIds: ours })).toBe(
      false,
    )
    expect(
      bookedForClient(dependant, {
        clientId: C1,
        propertyIds: ours,
        parentOf: (localId) => (localId === fresh.localId ? fresh : undefined),
      }),
    ).toBe(false)
    // Nothing to say what it is made on: nobody's.
    expect(
      bookedForClient(dependant, { clientId: C1, propertyIds: ours }),
    ).toBe(false)
  })

  test('one made on a booking on the phone (2c-I) is theirs as that one is: by that one’s booking while it isn’t sent, by the site it went to once it is', () => {
    // Marta's new site, booked on the phone, and a second visit on it.
    const parent = itemFor('u1', { booking: newSite(C1).booking })
    const second = on({ local: parent.localId })
    let now = parent
    const ask = (over: { site?: string; madeAt?: Map<string, string> } = {}) =>
      bookedForClient(second, {
        clientId: C1,
        propertyIds: ours,
        parentOf: (localId) => (localId === parent.localId ? now : undefined),
        ...over,
      })
    // Not sent: on every site's list, never one site's (it has no id yet),
    // and never another client's.
    expect(ask()).toBe(true)
    expect(ask({ site: 'p1' })).toBe(false)
    expect(
      bookedForClient(second, {
        clientId: 'c2',
        propertyIds: new Set(['p9']),
        parentOf: () => now,
      }),
    ).toBe(false)
    // Sent before this page load, with nothing of the site heard: their
    // jobs show where it was booked, by its request id.
    now = { ...parent, state: 'sent', result: { id: 'job-1' } }
    expect(ask()).toBe(false)
    expect(ask({ madeAt: new Map([[parent.requestId, 'p2']]) })).toBe(true)
    expect(
      ask({ madeAt: new Map([[parent.requestId, 'p2']]), site: 'p1' }),
    ).toBe(false)
    // Heard as it was sent.
    now = {
      ...parent,
      state: 'sent',
      result: { id: 'job-1', propertyId: 'p2' as Id<'properties'> },
    }
    expect(ask({ site: 'p2' })).toBe(true)
  })

  test('one level only: one made on one that is itself made on another is nobody’s', () => {
    const grand = itemFor('u1', { booking: newSite(C1).booking })
    const parent = itemFor('u1', {
      booking: bookingFor({ property: { local: grand.localId } as never }),
    })
    const byKey = new Map([grand, parent].map((i) => [i.localId, i]))
    expect(
      bookedForClient(on({ local: parent.localId }), {
        clientId: C1,
        propertyIds: ours,
        parentOf: (localId) => byKey.get(localId),
      }),
    ).toBe(false)
  })
})

describe('the site under a client’s booking on the phone (`outboxSiteLine`), on their Jobs tab and their sheet kept on the phone alike', () => {
  // Bob Smith, with two sites: each list names one only where there are
  // more than one.
  const sites = new Map([
    ['p1', '1 Hay St'],
    ['p2', '22 Ord St'],
  ])
  const client = {
    has: (at: string) => sites.has(at),
    siteOf: (at: string) => sites.get(at),
  }
  const on = (property: BookingProperty, addressLine: string) => ({
    booking: bookingFor({ property: property as never }),
    display: { ...DISPLAY, addressLine },
  })

  test('one on a site of theirs, by their own list', () => {
    const p2 = on({ propertyId: 'p2' as Id<'properties'> }, '22 Ord St')
    expect(outboxSiteLine(p2, 'p2', client)).toBe('22 Ord St')
    // One site: their list names none, so neither does the row.
    expect(
      outboxSiteLine(p2, 'p2', { has: () => true, siteOf: () => undefined }),
    ).toBeUndefined()
  })

  test('one on a new site for them, which their list hasn’t got: as its card shows it', () => {
    const fresh = on(
      {
        newProperty: { clientId: 'c1', addressLine: '9 Ocean Rd' } as never,
      },
      '9 Ocean Rd',
    )
    // Its card has no site id yet.
    expect(outboxSiteLine(fresh, '', client)).toBe('9 Ocean Rd')
  })

  test('one made on a booking on the phone (2c-I), whose card has no site id: the site that one makes, as its card shows it, whether or not that one has gone', () => {
    // Booked on "Bob Smith — 9 Ocean Rd, Cottesloe / Not sent yet".
    const second = on({ local: 'local-a' }, '9 Ocean Rd')
    expect(outboxSiteLine(second, '', client)).toBe('9 Ocean Rd')
  })

  test('one on a site nobody’s list has: no line', () => {
    const p9 = on({ propertyId: 'p9' as Id<'properties'> }, '5 Elsewhere Rd')
    expect(outboxSiteLine(p9, 'p9', client)).toBeUndefined()
  })
})

describe('where a client’s jobs were booked from a phone (`madeAtOf`)', () => {
  test('the site of each job and service by the request id it was booked under; none for one booked without', () => {
    expect(
      madeAtOf({
        visits: [
          { propertyId: 'p1', clientRequestId: 'r1' },
          { propertyId: 'p2' },
        ],
        series: [{ propertyId: 'p3', clientRequestId: 'r3' }],
      }),
    ).toEqual(
      new Map([
        ['r1', 'p1'],
        ['r3', 'p3'],
      ]),
    )
    expect(madeAtOf(undefined)).toEqual(new Map())
    expect(madeAtOf(null)).toEqual(new Map())
  })
})

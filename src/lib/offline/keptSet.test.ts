import { describe, expect, test } from 'vitest'
import { ConvexQueryClient, convexQuery } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import { keptOutOfHtml, rq } from '#/lib/routeQueries'
import {
  KEPT_FNS,
  KEPT_MAX_AGE_MS,
  KEPT_SHAPE,
  KEPT_UPGRADE_MARGIN_MS,
  confirmsLater,
  inWindow,
  keptFnOf,
  keptQueries,
  keptWindow,
  lensOf,
  rowAsOf,
  shapeOk,
  shouldUpgrade,
  usableRow,
} from './keptSet'
import type { Access } from '#/lib/access'
import type { Id } from '../../../convex/_generated/dataModel'
import type { KeptOwner, KeptRow } from './keptStore'
import type { KeptUse } from './keptSet'

/**
 * The rules for what is kept on the phone and when a kept answer may stand
 * in for the server's.
 */

const B = 'b1' as Id<'businesses'>

describe('keptWindow', () => {
  test('on a Sunday, the week it ends and the next (19 Oct to 1 Nov)', () => {
    const w = keptWindow('2026-10-25')
    expect(w.weekStarts).toEqual(['2026-10-19', '2026-10-26'])
    expect(w.dayKeys).toHaveLength(14)
    expect(w.dayKeys[0]).toBe('2026-10-19')
    expect(w.dayKeys.at(-1)).toBe('2026-11-01')
  })

  test('on a Monday, the week it starts and the next', () => {
    const w = keptWindow('2026-10-26')
    expect(w.weekStarts).toEqual(['2026-10-26', '2026-11-02'])
    expect(w.dayKeys.at(-1)).toBe('2026-11-08')
  })

  test('across the end of a month and of a year', () => {
    expect(keptWindow('2026-09-30').dayKeys.slice(1, 4)).toEqual([
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
    ])
    const w = keptWindow('2026-12-31')
    expect(w.weekStarts).toEqual(['2026-12-28', '2027-01-04'])
    expect(w.dayKeys).toContain('2027-01-01')
    expect(w.dayKeys.at(-1)).toBe('2027-01-10')
  })
})

describe('keptQueries', () => {
  const hash = new ConvexQueryClient(
    'https://happy-otter-123.convex.cloud',
  ).hashFn()
  const w = keptWindow('2026-10-25')

  test('asks for both weeks, every day, and what New Job is made of', () => {
    const names = keptQueries(B, w).map(({ queryKey }) => queryKey[1])
    expect(names.filter((n) => n === 'jobs:listWeek')).toHaveLength(2)
    expect(names.filter((n) => n === 'jobs:listDay')).toHaveLength(14)
    expect(new Set(names)).toEqual(new Set(KEPT_FNS))
  })

  test('hashes to the very entries the loaders and pages use', () => {
    const kept = keptQueries(B, w).map(({ queryKey }) => hash(queryKey))
    const pages = [
      ...w.weekStarts.map((k) => rq.week(B, k)),
      ...w.dayKeys.map((k) => rq.day(B, k)),
      rq.directory(B),
      rq.roster(B),
      rq.jobTypes(B),
    ].map(({ queryKey }) => hash(queryKey))
    expect(kept).toEqual(pages)
    // As a page that builds its own key from the function reference would.
    expect(kept).toContain(
      hash(
        convexQuery(api.jobs.listDay, { businessId: B, dayKey: '2026-10-20' })
          .queryKey,
      ),
    )
  })
})

describe('keptFnOf', () => {
  test('names each kept function, and nothing else', () => {
    expect(keptFnOf(rq.day(B, '2026-10-20').queryKey)).toBe('jobs:listDay')
    expect(keptFnOf(rq.directory(B).queryKey)).toBe('clients:directory')
    expect(keptFnOf(rq.access(B).queryKey)).toBeNull()
    expect(keptFnOf(rq.month(B, '2026-10').queryKey)).toBeNull()
    expect(keptFnOf(['convexQuery', 'jobs:listDay', 'skip'])).toBeNull()
    expect(keptFnOf(['other', 'jobs:listDay', {}])).toBeNull()
  })

  test('never anything kept out of the HTML', () => {
    const licences = rq.memberLicences(B, 'm1' as Id<'memberships'>).queryKey
    expect(keptOutOfHtml(licences)).toBe(true)
    expect(keptFnOf(licences)).toBeNull()
    for (const fn of KEPT_FNS) {
      expect(keptOutOfHtml(['convexQuery', fn, { businessId: B }])).toBe(false)
    }
  })
})

describe('inWindow', () => {
  const w = keptWindow('2026-10-25')

  test('days and weeks by the window, everything else always', () => {
    expect(inWindow(rq.day(B, '2026-10-19').queryKey, w)).toBe(true)
    expect(inWindow(rq.day(B, '2026-11-02').queryKey, w)).toBe(false)
    expect(inWindow(rq.week(B, '2026-10-26').queryKey, w)).toBe(true)
    expect(inWindow(rq.week(B, '2026-10-12').queryKey, w)).toBe(false)
    expect(inWindow(rq.directory(B).queryKey, w)).toBe(true)
  })
})

/** What access:me answers, with `extra` over a member in their own account. */
function access(extra: Partial<Access> = {}): Access {
  return {
    membershipId: 'm1' as Id<'memberships'>,
    role: 'owner',
    caps: {} as Access['caps'],
    actingAs: null,
    expiresAt: null,
    degraded: null,
    viewingAs: null,
    ...extra,
  }
}

describe('lensOf', () => {
  const other = { membershipId: 'm2' as Id<'memberships'>, name: 'Sam' }

  test('a member in their own account, and an owner by his view', () => {
    expect(lensOf(access())).toBe('m1|-')
    expect(lensOf(access({ view: null }))).toBe('m1|-')
    expect(lensOf(access({ view: { mode: 'everyone' } }))).toBe('m1|everyone')
    expect(lensOf(access({ view: { mode: 'mine' } }))).toBe('m1|mine')
  })

  test('nobody while working in or looking at someone else’s account', () => {
    expect(lensOf(access({ actingAs: other }))).toBeNull()
    expect(lensOf(access({ viewingAs: other }))).toBeNull()
    expect(lensOf(access({ view: { mode: 'account' } }))).toBeNull()
    expect(lensOf(undefined)).toBeNull()
  })
})

describe('shapeOk', () => {
  test('lists for the lists, clients and sites for the directory', () => {
    expect(shapeOk('jobs:listDay', [])).toBe(true)
    expect(shapeOk('jobs:listDay', {})).toBe(false)
    expect(shapeOk('clients:directory', { clients: [], sites: [] })).toBe(true)
    expect(shapeOk('clients:directory', { clients: [] })).toBe(false)
    expect(shapeOk('clients:directory', [])).toBe(false)
    expect(shapeOk('memberships:listForBusiness', null)).toBe(false)
  })
})

const NOW = Date.UTC(2026, 9, 25, 2)

const owner: KeptOwner = {
  key: 'owner',
  userId: 'u1',
  businessId: B,
  slug: 'pest-co',
  timezone: 'Australia/Perth',
  membershipId: 'm1' as Id<'memberships'>,
  lens: 'm1|-',
  epoch: 'e1',
  claimedAt: NOW - 60_000,
  liveAt: 0,
}

function row(extra: Partial<KeptRow> = {}): KeptRow {
  return {
    hash: 'h',
    fn: 'jobs:listDay',
    queryKey: [
      'convexQuery',
      'jobs:listDay',
      { businessId: B, dayKey: '2026-10-25' },
    ],
    businessId: B,
    lens: 'm1|-',
    data: [],
    savedAt: NOW - 60_000,
    shape: KEPT_SHAPE,
    build: 'test',
    ...extra,
  }
}

describe('usableRow', () => {
  const at: KeptUse = {
    owner,
    userId: 'u1',
    businessId: B,
    lens: 'm1|-',
    window: keptWindow('2026-10-25'),
    now: NOW,
  }

  test('a row kept for this person, business and view, in the window', () => {
    expect(usableRow(row(), at)).toBe(true)
  })

  test.each([
    ['another person', { ...at, userId: 'u2' }],
    ['another business', { ...at, businessId: 'b2' }],
    ['another view', { ...at, lens: 'm1|mine' }],
    [
      'an owner row for another view',
      { ...at, owner: { ...owner, lens: 'm1|mine' } },
    ],
    ['three weeks on', { ...at, now: NOW + KEPT_MAX_AGE_MS }],
    ['a window it has left', { ...at, window: keptWindow('2026-11-09') }],
  ])('not for %s', (_, use) => {
    expect(usableRow(row(), use)).toBe(false)
  })

  test.each([
    ['an older shape', row({ shape: KEPT_SHAPE + 1 })],
    ['another view’s row', row({ lens: 'm1|everyone' })],
    ['a row of another business', row({ businessId: 'b2' })],
    [
      'a key for another business',
      row({
        queryKey: [
          'convexQuery',
          'jobs:listDay',
          { businessId: 'b2', dayKey: '2026-10-25' },
        ],
      }),
    ],
    ['the wrong function', row({ fn: 'jobs:listWeek' })],
    ['an answer of the wrong shape', row({ data: { jobs: [] } })],
  ])('not %s', (_, kept) => {
    expect(usableRow(kept, at)).toBe(false)
  })
})

describe('rowAsOf', () => {
  test('when written, or when last confirmed live, whichever is later', () => {
    expect(rowAsOf(row({ savedAt: 5_000 }), { ...owner, liveAt: 0 })).toBe(
      5_000,
    )
    expect(rowAsOf(row({ savedAt: 5_000 }), { ...owner, liveAt: 9_000 })).toBe(
      9_000,
    )
  })
})

describe('shouldUpgrade', () => {
  const page = { dataUpdatedAt: NOW, live: false }

  test('only a copy confirmed more than 2 min after the page’s answer', () => {
    expect(shouldUpgrade(page, NOW + KEPT_UPGRADE_MARGIN_MS, true)).toBe(false)
    expect(shouldUpgrade(page, NOW + KEPT_UPGRADE_MARGIN_MS + 1, true)).toBe(
      true,
    )
    expect(shouldUpgrade(page, NOW - 60_000, true)).toBe(false)
  })

  test('never for the same data, nor over a live answer', () => {
    expect(shouldUpgrade(page, NOW + 3_600_000, false)).toBe(false)
    expect(shouldUpgrade({ ...page, live: true }, NOW + 3_600_000, true)).toBe(
      false,
    )
  })
})

describe('confirmsLater', () => {
  const page = { dataUpdatedAt: NOW, live: false }

  test('the same data, confirmed more than 2 min after the page’s answer', () => {
    expect(confirmsLater(page, NOW + KEPT_UPGRADE_MARGIN_MS, false)).toBe(false)
    expect(confirmsLater(page, NOW + KEPT_UPGRADE_MARGIN_MS + 1, false)).toBe(
      true,
    )
  })

  test('never for different data, which upgrades instead, nor a live answer', () => {
    expect(confirmsLater(page, NOW + 3_600_000, true)).toBe(false)
    expect(confirmsLater({ ...page, live: true }, NOW + 3_600_000, false)).toBe(
      false,
    )
  })
})

import { describe, expect, test, vi } from 'vitest'
import {
  IDLE_SAVE_GUARD,
  createSaveGuard,
} from '#/components/forms/saveWarningRules'
import { sendsByRow, sendsOf, standingSends, withSent } from './sheetChecks'
import type { SheetSends } from './sheetChecks'
import { NO_OURS, buildMatchIndex } from '../../convex/lib/clientMatch'
import {
  NOTHING_SEEN,
  NOT_CHECKED,
  SITE_UNCHECKED,
  bookAtSees,
  bookingAt,
  bookingWork,
  isSeen,
  matchClientsOf,
  matchRowsWithWork,
  namedSiteOf,
  namedWorkMoved,
  pickOpenWork,
  refusedMatchSees,
  refusedSiteRows,
  seenOf,
  seenSeriesOf,
  siteBehindNote,
  siteFooter,
  siteTargets,
  siteWorkRows,
  uncheckedKeysOf,
  uncheckedRows,
  withSeen,
  withSeenAll,
  workClause,
  workDayOf,
} from './siteWorkRows'
import type {
  OpenWork,
  OpenWorkRow,
  OpenWorkSeries,
  RefusedSiteContext,
  Seen,
  SiteCheck,
  SiteTarget,
} from './siteWorkRows'
import type { MatchFix } from './clientMatchRows'
import type { MatchClient, MatchSite } from '../../convex/lib/clientMatch'
import type { Id } from '../../convex/_generated/dataModel'

/**
 * Is this site already booked? The rows New Job shows at Book about work at
 * the site (the matching plan's §3, M5), the lines about what couldn't be
 * checked, and the clause a match row adds about its site's work (FW13),
 * case by case over a small book in Perth.
 */

const TZ = 'Australia/Perth'
/** Monday 26 Oct 2026, the week this week's answer is asked for. */
const TODAY = '2026-10-26'
const WEEK = '2026-10-26'

/** `hh:mm` on `dayKey` in Perth (UTC+8, no daylight saving). */
function perth(dayKey: string, hh = 9, mm = 0): number {
  const [y, m, d] = dayKey.split('-').map(Number)
  return Date.UTC(y, m - 1, d, hh - 8, mm)
}

const cid = (id: string) => id as Id<'clients'>
const pid = (id: string) => id as Id<'properties'>
const jid = (id: string) => id as Id<'jobs'>
const rid = (id: string) => id as Id<'recurrences'>

const client = (id: string, name: string): MatchClient => ({
  _id: cid(id),
  name,
  kind: 'person',
})
const site = (
  id: string,
  clientId: string,
  addressLine: string,
  suburb: string,
  postcode = '6053',
): MatchSite => ({
  _id: pid(id),
  clientId: cid(clientId),
  addressLine,
  suburb,
  postcode,
})

const JANE = client('c-jane', 'Jane Nguyen')
const BOB = client('c-bob', 'Bob Smith')
const JANE_SITE = site('p-jane', 'c-jane', '12 Wattle St', 'Bayswater')
const BOB_SITE = site('p-bob', 'c-bob', '12 Wattle St', 'Maylands')
const BOB_OTHER = site('p-bob2', 'c-bob', '4 Kalinda Way', 'Morley', '6062')
const INDEX = buildMatchIndex(
  {
    clients: [JANE, BOB],
    sites: [JANE_SITE, BOB_SITE, BOB_OTHER],
    contacts: [],
  },
  { areaCode: '08', ours: NO_OURS },
)

const M_SAM = 'm-sam' as Id<'memberships'>
const PEOPLE = new Map<string, string>([[M_SAM, 'Sam Lee']])

/** A job of the person's own, at `propertyId`, booked `when`. */
function theirs(
  id: string,
  propertyId: string,
  when: number,
  extra: Partial<Extract<OpenWorkRow, { jobId: Id<'jobs'> }>> = {},
): OpenWorkRow {
  return {
    propertyId: pid(propertyId),
    at: when,
    scheduledAt: when,
    status: 'booked',
    jobId: jid(id),
    jobType: 'General Pest',
    assignedMembershipId: M_SAM,
    ...extra,
  }
}

/** Someone else's: a site and a date, and nothing more (C5). */
function others(
  propertyId: string,
  when: number,
  series?: string,
): OpenWorkRow {
  return {
    propertyId: pid(propertyId),
    at: when,
    scheduledAt: when,
    ...(series ? { series: rid(series) } : {}),
  }
}

function workOf(
  rows: ReadonlyArray<OpenWorkRow>,
  series: ReadonlyArray<OpenWorkSeries> = [],
): OpenWork {
  return { rows: [...rows], series: [...series] }
}

const chosen = (s: MatchSite = JANE_SITE): Array<SiteTarget> => [
  { site: s, how: 'chosen' },
]

/** A booking on Friday 30 Oct at 9am, at Jane's site, as New Job checks it. */
function check(extra: Partial<SiteCheck> = {}): SiteCheck {
  return {
    work: workOf([]),
    timezone: TZ,
    today: TODAY,
    at: perth('2026-10-30'),
    repeats: false,
    targets: chosen(),
    seen: NOTHING_SEEN,
    index: INDEX,
    people: PEOPLE,
    typedAddress: '',
    ...extra,
  }
}

describe('Already booked, at the site chosen', () => {
  test('a job of the person’s own: when, what, who, and its number to open', () => {
    const rows = siteWorkRows(
      check({
        work: workOf([
          theirs('j-123', 'p-jane', perth('2026-10-29', 10), {
            jobNumber: 123,
          }),
        ]),
      }),
    )
    expect(rows).toEqual([
      {
        id: 'site:job:j-123',
        label: 'Already booked',
        message:
          '12 Wattle St has a job on Thu 29 Oct at 10:00am — General Pest, Sam Lee (#123).',
        fix: {
          kind: 'openJob',
          label: 'Open #123',
          jobId: 'j-123',
          dayKey: '2026-10-29',
        },
        shows: { rows: [expect.anything()], series: [] },
        propertyId: 'p-jane',
      },
    ])
  })

  test('with no number, “Open the job”; a visit, “Open the visit”', () => {
    const [plain] = siteWorkRows(
      check({ work: workOf([theirs('j-1', 'p-jane', perth('2026-10-29'))]) }),
    )
    expect(plain.fix).toMatchObject({ label: 'Open the job' })
    expect(plain.message).toBe(
      '12 Wattle St has a job on Thu 29 Oct at 9:00am — General Pest, Sam Lee.',
    )
    const [visit] = siteWorkRows(
      check({
        work: workOf([
          theirs('j-2', 'p-jane', perth('2026-10-29'), {
            recurrenceId: rid('r-1'),
            jobNumber: 9,
          }),
        ]),
      }),
    )
    expect(visit.message).toBe(
      '12 Wattle St has a Recurring Job visit on Thu 29 Oct — Sam Lee.',
    )
    expect(visit.fix).toMatchObject({ label: 'Open the visit', jobId: 'j-2' })
  })

  test('a job for several services: the services as one, then who', () => {
    const [row] = siteWorkRows(
      check({
        work: workOf([
          theirs('j-123', 'p-jane', perth('2026-10-29', 10), {
            jobNumber: 123,
            jobType: 'General Pest Control, Termite Inspection, Rodents',
          }),
        ]),
      }),
    )
    expect(row.message).toBe(
      '12 Wattle St has a job on Thu 29 Oct at 10:00am — General Pest Control, Termite Inspection and Rodents, Sam Lee (#123).',
    )
    const [two] = siteWorkRows(
      check({
        work: workOf([
          theirs('j-124', 'p-jane', perth('2026-10-29', 10), {
            jobType: 'General Pest Control, Termite Inspection',
          }),
        ]),
      }),
    )
    expect(two.message).toBe(
      '12 Wattle St has a job on Thu 29 Oct at 10:00am — General Pest Control and Termite Inspection, Sam Lee.',
    )
  })

  test('two jobs in one slot, the double booking this is for: a row each of the person’s own, one of someone else’s', () => {
    const slot = perth('2026-10-29', 10)
    const rows = siteWorkRows(
      check({
        work: workOf([
          theirs('j-123', 'p-jane', slot, { jobNumber: 123 }),
          theirs('j-124', 'p-jane', slot, { jobNumber: 124 }),
        ]),
      }),
    )
    expect(rows.map((r) => r.id)).toEqual(['site:job:j-123', 'site:job:j-124'])
    expect(rows.map((r) => r.fix?.label)).toEqual(['Open #123', 'Open #124'])

    // Someone else's two: one row, which books past both, the server
    // taking the slot back as one.
    const theirTwo = [
      others('p-jane', slot, 'r-1'),
      others('p-jane', slot, 'r-2'),
    ]
    const [one, ...more] = siteWorkRows(check({ work: workOf(theirTwo) }))
    expect(more).toEqual([])
    expect(one.id).toBe('site:day:p-jane:2026-10-29')
    expect(one.message).toBe(
      '12 Wattle St has another job booked on Thu 29 Oct.',
    )
    expect(one.shows.rows).toEqual(theirTwo)
    expect(seenOf([one])).toEqual([{ propertyId: 'p-jane', at: slot }])
    expect(seenSeriesOf([one]).sort()).toEqual(['r-1', 'r-2'])

    // Every id on a panel its own.
    const mixed = siteWorkRows(
      check({ work: workOf([theirs('j-123', 'p-jane', slot), ...theirTwo]) }),
    )
    expect(new Set(mixed.map((r) => r.id)).size).toBe(mixed.length)
  })

  test('someone else’s two on one day, at different times: one row, as its words are the date alone, booking past both', () => {
    const morning = others('p-jane', perth('2026-10-29', 9))
    const afternoon = others('p-jane', perth('2026-10-29', 14))
    const rows = siteWorkRows(
      check({
        work: workOf([
          morning,
          afternoon,
          theirs('j-2', 'p-jane', perth('2026-11-01')),
        ]),
      }),
    )
    // The one row of theirs, and the person's own job after it: neither
    // a second line reading the same, nor one pushing the job out.
    expect(rows.map((r) => [r.id, r.message])).toEqual([
      [
        'site:day:p-jane:2026-10-29',
        '12 Wattle St has another job booked on Thu 29 Oct.',
      ],
      [
        'site:job:j-2',
        '12 Wattle St has a job on Sun 1 Nov at 9:00am — General Pest, Sam Lee.',
      ],
    ])
    // Both slots, the nearer first.
    expect(seenOf([rows[0]])).toEqual([
      { propertyId: 'p-jane', at: perth('2026-10-29', 14) },
      { propertyId: 'p-jane', at: perth('2026-10-29', 9) },
    ])
    // The days are the business's: 11pm and 1am Perth are two of them.
    const twoDays = siteWorkRows(
      check({
        work: workOf([
          others('p-jane', perth('2026-10-28', 23)),
          others('p-jane', perth('2026-10-29', 1)),
        ]),
      }),
    )
    expect(twoDays.map((r) => r.message)).toEqual([
      '12 Wattle St has another job booked on Thu 29 Oct.',
      '12 Wattle St has another job booked on Wed 28 Oct.',
    ])
  })

  test('someone else’s: its date and nothing more, and nothing to open (C5)', () => {
    const [row] = siteWorkRows(
      check({ work: workOf([others('p-jane', perth('2026-10-29'))]) }),
    )
    expect(row.message).toBe(
      '12 Wattle St has another job booked on Thu 29 Oct.',
    )
    expect(row.fix).toBeUndefined()
    expect(row.fix2).toBeUndefined()
  })

  test('within a week either side, inclusive, by the business’s own days, not hours', () => {
    const rows = siteWorkRows(
      check({
        work: workOf([
          // Fri 6 Nov, 11:30pm: seven days on.
          others('p-jane', perth('2026-11-06', 23, 30)),
          // Sat 7 Nov, 12:30am: the same day in UTC, eight in Perth.
          others('p-jane', perth('2026-11-07', 0, 30)),
          // Fri 23 Oct, 6am: seven days before.
          others('p-jane', perth('2026-10-23', 6)),
          // Thu 22 Oct, 11pm: eight.
          others('p-jane', perth('2026-10-22', 23)),
        ]),
      }),
    )
    expect(rows.map((r) => r.message)).toEqual([
      '12 Wattle St has another job booked on Fri 23 Oct.',
      '12 Wattle St has another job booked on Fri 6 Nov.',
    ])
  })

  test('nearest first, the earlier of two as near, at most two, and the rest counted', () => {
    const rows = siteWorkRows(
      check({
        work: workOf([
          others('p-jane', perth('2026-10-26')),
          others('p-jane', perth('2026-10-31')),
          others('p-jane', perth('2026-10-29')),
        ]),
      }),
    )
    expect(rows.map((r) => r.message)).toEqual([
      '12 Wattle St has another job booked on Thu 29 Oct.',
      '12 Wattle St has another job booked on Sat 31 Oct.',
      'Another job or visit is booked at this site within a week of this one.',
    ])
  })

  test('the rest past two is one row that counts them, which Book anyway books past: the server is never left to name what the phone held (FW17d for sites)', () => {
    // The owner's own one-offs Thu, Sat and Tue; booked on Fri 30 Oct.
    const j1 = theirs('j-1', 'p-jane', perth('2026-10-29'), { jobNumber: 1 })
    const j2 = theirs('j-2', 'p-jane', perth('2026-10-31'), { jobNumber: 2 })
    const j3 = theirs('j-3', 'p-jane', perth('2026-11-03'), { jobNumber: 3 })
    const fri = check({ work: workOf([j1, j2, j3]), at: perth('2026-10-30') })
    const rows = siteWorkRows(fri)
    expect(rows.map((r) => [r.id, r.label, r.fix?.label])).toEqual([
      ['site:job:j-1', 'Already booked', 'Open #1'],
      ['site:job:j-2', 'Already booked', 'Open #2'],
      ['site:more', 'And 1 more', undefined],
    ])
    expect(rows[2].message).toBe(
      'Another job or visit is booked at this site within a week of this one.',
    )
    expect(rows[2].propertyId).toBe(pid('p-jane'))
    // All three go back as seen, j-3 by its id too.
    expect(seenOf(rows)).toEqual([
      { propertyId: pid('p-jane'), at: j1.at, jobId: jid('j-1') },
      { propertyId: pid('p-jane'), at: j2.at, jobId: jid('j-2') },
      { propertyId: pid('p-jane'), at: j3.at, jobId: jid('j-3') },
    ])
    expect(
      siteWorkRows({ ...fri, seen: withSeenAll(NOTHING_SEEN, rows) }),
    ).toEqual([])
    // Its foot is the rows' own.
    expect(siteFooter(rows, 'Book anyway')).toBe(
      'Open one, or press Book anyway to book this one as well.',
    )
  })

  test('the rest at another site than the rows above are about is said by its address, never “this site”: under rows about the address typed it would read as that one', () => {
    // New client typed at 12 Wattle St, Bayswater 6053: Jane's site there,
    // and Bob's 12 Wattle St in Maylands, the same postcode.
    const typedAt = check({
      targets: [
        { site: JANE_SITE, how: 'address' },
        { site: BOB_SITE, how: 'street' },
      ],
      typedAddress: '12 Wattle St',
      work: workOf([
        theirs('j-1', 'p-jane', perth('2026-10-30', 8)),
        theirs('j-2', 'p-jane', perth('2026-10-31')),
        theirs('j-3', 'p-bob', perth('2026-11-04')),
      ]),
    })
    const rows = siteWorkRows(typedAt)
    expect(rows.map((r) => r.message)).toEqual([
      '12 Wattle St, Bayswater (Jane Nguyen’s) has a job on Fri 30 Oct.',
      '12 Wattle St, Bayswater (Jane Nguyen’s) has a job on Sat 31 Oct.',
      'Another job or visit is booked at 12 Wattle St, Maylands within a week of this one.',
    ])
    expect(rows[2].propertyId).toBe(pid('p-bob'))
    // At the site the rows above are about: "this site", as it was.
    const same = siteWorkRows({
      ...typedAt,
      work: workOf([
        theirs('j-1', 'p-jane', perth('2026-10-30', 8)),
        theirs('j-2', 'p-jane', perth('2026-10-31')),
        theirs('j-4', 'p-jane', perth('2026-11-02')),
      ]),
    })
    expect(same[2].message).toBe(
      'Another job or visit is booked at this site within a week of this one.',
    )
    // The rows above at both, the rest at one of them: by its address.
    const both = siteWorkRows({
      ...typedAt,
      work: workOf([
        theirs('j-1', 'p-jane', perth('2026-10-30', 8)),
        theirs('j-3', 'p-bob', perth('2026-10-30', 10)),
        theirs('j-2', 'p-jane', perth('2026-11-02')),
      ]),
    })
    expect(both[2].message).toBe(
      'Another job or visit is booked at 12 Wattle St, Bayswater within a week of this one.',
    )
    // At several: these sites.
    const several = siteWorkRows({
      ...typedAt,
      work: workOf([
        theirs('j-1', 'p-jane', perth('2026-10-30', 8)),
        theirs('j-2', 'p-jane', perth('2026-10-30', 10)),
        theirs('j-3', 'p-bob', perth('2026-11-02')),
        theirs('j-4', 'p-jane', perth('2026-11-03')),
      ]),
    })
    expect(several[2].message).toBe(
      '2 other jobs or visits are booked at these sites within a week of this one.',
    )
  })

  test('not done or cancelled work, nor another site’s', () => {
    expect(
      siteWorkRows(
        check({
          work: workOf([
            theirs('j-1', 'p-jane', perth('2026-10-29'), {
              status: 'completed',
            }),
            others('p-bob', perth('2026-10-29')),
          ]),
        }),
      ),
    ).toEqual([])
  })

  test('nothing seen already: by its slot, by its job when the office moved it, or by its Recurring Job', () => {
    const job = theirs('j-1', 'p-jane', perth('2026-10-29'))
    const moved = { ...job, scheduledAt: perth('2026-10-31') }
    const visit = others('p-jane', perth('2026-10-28'), 'r-1')
    const work = workOf([moved, visit])
    const seen: Seen = {
      pairs: [{ propertyId: pid('p-jane'), at: perth('2026-10-29') }],
      series: [],
    }
    expect(siteWorkRows(check({ work, seen })).map((r) => r.id)).toEqual([
      'site:day:p-jane:2026-10-28',
    ])
    expect(
      siteWorkRows(
        check({ work, seen: { pairs: seen.pairs, series: [rid('r-1')] } }),
      ),
    ).toEqual([])
    // By its id alone, wherever its slot now is.
    expect(
      isSeen(moved, {
        pairs: [{ propertyId: pid('p-jane'), at: 1, jobId: jid('j-1') }],
        series: [],
      }),
    ).toBe(true)
  })
})

describe('where a new client or site is checked (FW2)', () => {
  const typed = {
    addressLine: '12 Wattle St',
    suburb: 'Bayswater',
    postcode: '6053',
  }

  test('every site at the address typed, whoever’s; then the same street in the same postcode; then those only like it of the clients named', () => {
    expect(
      siteTargets(INDEX, { mode: 'new', typed, clients: [] }).map((t) => [
        t.site._id,
        t.how,
      ]),
    ).toEqual([
      ['p-jane', 'address'],
      ['p-bob', 'street'],
    ])
    const misspelt = { ...typed, addressLine: '12 Watle St' }
    expect(
      siteTargets(INDEX, {
        mode: 'site',
        typed: misspelt,
        clients: [cid('c-jane')],
      }).map((t) => [t.site._id, t.how]),
    ).toEqual([['p-jane', 'near']])
    // Only of the clients named.
    expect(
      siteTargets(INDEX, { mode: 'site', typed: misspelt, clients: [] }),
    ).toEqual([])
  })

  test('nothing typed, or no site chosen: nothing to check', () => {
    expect(
      siteTargets(INDEX, {
        mode: 'new',
        typed: { addressLine: ' ', suburb: '', postcode: '' },
        clients: [],
      }),
    ).toEqual([])
    expect(siteTargets(INDEX, { mode: 'existing', site: null })).toEqual([])
    expect(siteTargets(INDEX, { mode: 'existing', site: JANE_SITE })).toEqual(
      chosen(),
    )
  })

  test('the row names whose site it is, and books there or opens the job', () => {
    const job = theirs('j-123', 'p-jane', perth('2026-10-29'), {
      jobNumber: 123,
    })
    const targets = siteTargets(INDEX, { mode: 'new', typed, clients: [] })
    const [row] = siteWorkRows(check({ work: workOf([job]), targets }))
    expect(row.message).toBe(
      '12 Wattle St, Bayswater (Jane Nguyen’s) has a job on Thu 29 Oct.',
    )
    expect(row.fix).toEqual({
      kind: 'bookAt',
      label: 'Book at 12 Wattle St',
      clientId: 'c-jane',
      propertyId: 'p-jane',
    })
    expect(row.fix2).toMatchObject({ kind: 'openJob', label: 'Open #123' })
  })

  test('the same street, and only like it, say so', () => {
    const [street] = siteWorkRows(
      check({
        work: workOf([theirs('j-1', 'p-bob', perth('2026-10-29'))]),
        targets: [{ site: BOB_SITE, how: 'street' }],
      }),
    )
    expect(street.message).toBe(
      'Bob Smith’s 12 Wattle St in Maylands, the same postcode, has a job on Thu 29 Oct.',
    )
    // Another suburb's site, known by no name: Book at names the suburb,
    // so it never reads as the address typed (the match rows' own words).
    expect(street.fix).toEqual({
      kind: 'bookAt',
      label: 'Book at 12 Wattle St, Maylands',
      clientId: 'c-bob',
      propertyId: 'p-bob',
    })
    const [theirStreet] = siteWorkRows(
      check({
        work: workOf([others('p-bob', perth('2026-10-29'))]),
        targets: [{ site: BOB_SITE, how: 'street' }],
      }),
    )
    expect(theirStreet.message).toBe(
      '12 Wattle St in Maylands, the same postcode, has another job booked on Thu 29 Oct.',
    )
    expect(theirStreet.fix).toMatchObject({
      label: 'Book at 12 Wattle St, Maylands',
      propertyId: 'p-bob',
    })
    const [near] = siteWorkRows(
      check({
        work: workOf([theirs('j-1', 'p-jane', perth('2026-10-29'))]),
        targets: [{ site: JANE_SITE, how: 'near' }],
        typedAddress: '12 Watle St',
      }),
    )
    expect(near.message).toBe(
      '12 Watle St looks like Jane Nguyen’s 12 Wattle St, Bayswater, which has a job on Thu 29 Oct.',
    )
  })

  test('someone else’s work at an address typed: no client named and nothing to open (C5), but Book at the site there', () => {
    const [row] = siteWorkRows(
      check({
        work: workOf([others('p-jane', perth('2026-10-29'))]),
        targets: [{ site: JANE_SITE, how: 'address' }],
      }),
    )
    expect(row.message).toBe(
      '12 Wattle St, Bayswater has another job booked on Thu 29 Oct.',
    )
    // The site is one the person may book at, and the label names only
    // the address: booking there rather than a second site at it (FW2).
    expect(row.fix).toEqual({
      kind: 'bookAt',
      label: 'Book at 12 Wattle St',
      clientId: 'c-jane',
      propertyId: 'p-jane',
    })
    expect(row.fix2).toBeUndefined()
    const [near] = siteWorkRows(
      check({
        work: workOf([others('p-jane', perth('2026-10-29'))]),
        targets: [{ site: JANE_SITE, how: 'near' }],
        typedAddress: '12 Watle St',
      }),
    )
    expect(near.message).toBe(
      '12 Watle St looks like 12 Wattle St, Bayswater, which has another job booked on Thu 29 Oct.',
    )
    expect(near.fix).toMatchObject({ kind: 'bookAt', propertyId: 'p-jane' })
  })

  test('in New site for, another client’s site at the address is said with its date, never booked at: the booking stays on the client chosen', () => {
    // New site for Bob Smith, typed at Jane Nguyen's address.
    const targets = siteTargets(INDEX, {
      mode: 'site',
      typed,
      clients: [cid('c-bob')],
    })
    expect(targets.map((t) => [t.site._id, t.how])).toEqual([
      ['p-jane', 'address'],
      ['p-bob', 'street'],
    ])
    const janes = theirs('j-123', 'p-jane', perth('2026-10-29'), {
      jobNumber: 123,
    })
    const bobs = theirs('j-7', 'p-bob', perth('2026-10-31'), { jobNumber: 7 })
    const rows = siteWorkRows(
      check({ work: workOf([janes, bobs]), targets, bookFor: cid('c-bob') }),
    )
    expect(rows.map((r) => [r.message, r.fix?.label, r.fix2?.label])).toEqual([
      // Jane's: whose it is, and the job to open, but no Book at, which
      // would take Bob's booking onto Jane's client.
      [
        '12 Wattle St, Bayswater (Jane Nguyen’s) has a job on Thu 29 Oct.',
        'Open #123',
        undefined,
      ],
      // Bob's own: booked there as ever.
      [
        'Bob Smith’s 12 Wattle St in Maylands, the same postcode, has a job on Sat 31 Oct.',
        'Book at 12 Wattle St, Maylands',
        'Open #7',
      ],
    ])
    expect(siteFooter([rows[0]], 'Book anyway')).toBe(
      'Open it, or press Book anyway to book this one as well.',
    )
    // Someone else's work at Jane's: its date, and nothing to tap.
    const [theirsThere] = siteWorkRows(
      check({
        work: workOf([others('p-jane', perth('2026-10-29'))]),
        targets,
        bookFor: cid('c-bob'),
      }),
    )
    expect(theirsThere.message).toBe(
      '12 Wattle St, Bayswater has another job booked on Thu 29 Oct.',
    )
    expect(theirsThere.fix).toBeUndefined()
    expect(siteFooter([theirsThere], 'Book anyway')).toBe(
      'Press Book anyway to book this one as well.',
    )
    // No client chosen yet: nothing is booked at.
    expect(
      siteWorkRows(
        check({ work: workOf([janes, bobs]), targets, bookFor: null }),
      ).map((r) => [r.fix?.kind, r.fix2]),
    ).toEqual([
      ['openJob', undefined],
      ['openJob', undefined],
    ])
    // In New client, Book at any of them, as before.
    expect(
      siteWorkRows(check({ work: workOf([janes, bobs]), targets })).map(
        (r) => r.fix?.kind,
      ),
    ).toEqual(['bookAt', 'bookAt'])
  })

  test('a client archived or inactive, named only by a possessive, is said to be so in a sentence of its own, as the match rows say it', () => {
    const amy: MatchClient = {
      ...client('c-amy', 'Amy Lo'),
      status: 'inactive',
    }
    const sam: MatchClient = { ...client('c-sam', 'Sam Wu'), archivedAt: 1 }
    const amySite = site('p-amy', 'c-amy', '3 Elm St', 'Bayswater')
    const samSite = site('p-sam', 'c-sam', '5 Elm St', 'Maylands')
    const index = buildMatchIndex(
      { clients: [amy, sam], sites: [amySite, samSite], contacts: [] },
      { areaCode: '08', ours: NO_OURS },
    )
    const visit = theirs('j-1', 'p-amy', perth('2026-10-29'), {
      recurrenceId: rid('r-amy'),
    })
    const [address] = siteWorkRows(
      check({
        index,
        work: workOf([visit]),
        targets: [{ site: amySite, how: 'address' }],
      }),
    )
    expect(address.message).toBe(
      '3 Elm St, Bayswater (Amy Lo’s) has a Recurring Job visit on Thu 29 Oct. Amy Lo is inactive.',
    )
    const [street] = siteWorkRows(
      check({
        index,
        work: workOf([theirs('j-2', 'p-sam', perth('2026-10-29'))]),
        targets: [{ site: samSite, how: 'street' }],
      }),
    )
    expect(street.message).toBe(
      'Sam Wu’s 5 Elm St in Maylands, the same postcode, has a job on Thu 29 Oct. Sam Wu is archived.',
    )
    const [near] = siteWorkRows(
      check({
        index,
        work: workOf([visit]),
        targets: [{ site: amySite, how: 'near' }],
        typedAddress: '3 Elms St',
      }),
    )
    expect(near.message).toBe(
      '3 Elms St looks like Amy Lo’s 3 Elm St, Bayswater, which has a Recurring Job visit on Thu 29 Oct. Amy Lo is inactive.',
    )
    const [repeats] = siteWorkRows(
      check({
        index,
        repeats: true,
        work: workOf(
          [visit],
          [
            {
              _id: rid('r-amy'),
              propertyId: pid('p-amy'),
              nextAt: perth('2026-10-29'),
              intervalCount: 3,
              intervalUnit: 'month',
              jobType: 'General Pest',
            },
          ],
        ),
        targets: [{ site: amySite, how: 'address' }],
      }),
    )
    expect(repeats.message).toBe(
      '3 Elm St, Bayswater (Amy Lo’s) already has a Recurring Job: General Pest every 3 months, next Thu 29 Oct. Amy Lo is inactive.',
    )
    // Not where no client is named: the site chosen, or someone else's
    // work, which names no client (C5).
    const [chosenRow] = siteWorkRows(
      check({ index, work: workOf([visit]), targets: chosen(amySite) }),
    )
    expect(chosenRow.message).toBe(
      '3 Elm St has a Recurring Job visit on Thu 29 Oct — Sam Lee.',
    )
    const [theirsRow] = siteWorkRows(
      check({
        index,
        work: workOf([others('p-amy', perth('2026-10-29'))]),
        targets: [{ site: amySite, how: 'address' }],
      }),
    )
    expect(theirsRow.message).toBe(
      '3 Elm St, Bayswater has another job booked on Thu 29 Oct.',
    )
  })
})

describe('Already repeats', () => {
  const quarterly: OpenWorkSeries = {
    _id: rid('r-1'),
    propertyId: pid('p-jane'),
    nextAt: perth('2027-01-11'),
    intervalCount: 3,
    intervalUnit: 'month',
    jobType: 'General Pest',
  }
  const nextVisit = theirs('j-9', 'p-jane', perth('2027-01-11'), {
    recurrenceId: rid('r-1'),
  })

  test('a Recurring Job booked where one of the person’s runs: what and how often, its next visit, and that visit to open', () => {
    const rows = siteWorkRows(
      check({ repeats: true, work: workOf([nextVisit], [quarterly]) }),
    )
    expect(rows).toEqual([
      {
        id: 'site:series:r-1',
        label: 'Already repeats',
        message:
          '12 Wattle St already has a Recurring Job: General Pest every 3 months, next Mon 11 Jan 2027.',
        fix: {
          kind: 'openJob',
          label: 'Open the Recurring Job',
          jobId: 'j-9',
          dayKey: '2027-01-11',
        },
        shows: { rows: [], series: ['r-1'] },
        propertyId: 'p-jane',
      },
    ])
  })

  test('several services, said as one', () => {
    const [row] = siteWorkRows(
      check({
        repeats: true,
        work: workOf(
          [nextVisit],
          [
            {
              ...quarterly,
              jobType: 'General Pest Control, Termite Inspection',
            },
          ],
        ),
      }),
    )
    expect(row.message).toBe(
      '12 Wattle St already has a Recurring Job: General Pest Control and Termite Inspection every 3 months, next Mon 11 Jan 2027.',
    )
  })

  test('someone else’s: that there is one, and when it next comes, if the phone knows', () => {
    const theirsNot: OpenWorkSeries = {
      _id: rid('r-2'),
      propertyId: pid('p-jane'),
    }
    expect(
      siteWorkRows(
        check({
          repeats: true,
          work: workOf(
            [others('p-jane', perth('2026-12-01'), 'r-2')],
            [theirsNot],
          ),
        }),
      ).map((r) => [r.message, r.fix]),
    ).toEqual([
      ['12 Wattle St already has a Recurring Job, next Tue 1 Dec.', undefined],
    ])
    expect(
      siteWorkRows(check({ repeats: true, work: workOf([], [theirsNot]) }))[0]
        .message,
    ).toBe('12 Wattle St already has a Recurring Job.')
  })

  test('first, and its own visits near the date aren’t rows of their own', () => {
    const near = theirs('j-8', 'p-jane', perth('2026-10-29'), {
      recurrenceId: rid('r-1'),
    })
    const rows = siteWorkRows(
      check({
        repeats: true,
        work: workOf(
          [near, nextVisit, others('p-jane', perth('2026-10-31'))],
          [quarterly],
        ),
      }),
    )
    expect(rows.map((r) => r.label)).toEqual([
      'Already repeats',
      'Already booked',
    ])
    expect(rows[0].message).toContain('next Thu 29 Oct')
    expect(rows[1].message).toBe(
      '12 Wattle St has another job booked on Sat 31 Oct.',
    )
  })

  test('not for a one-off booking, nor once seen', () => {
    expect(
      siteWorkRows(check({ work: workOf([nextVisit], [quarterly]) })),
    ).toEqual([])
    expect(
      siteWorkRows(
        check({
          repeats: true,
          work: workOf([nextVisit], [quarterly]),
          seen: { pairs: [], series: [rid('r-1')] },
        }),
      ),
    ).toEqual([])
  })
})

describe('when the booking is (`bookingAt`)', () => {
  const now = perth(TODAY, 10)

  test('a one-off when it is booked; a series at its anchor, or for one started weeks ago, at its first visit from now', () => {
    expect(
      bookingAt({ scheduledAt: perth('2026-10-30'), repeat: null }, TZ, now),
    ).toBe(perth('2026-10-30'))
    expect(
      bookingAt(
        {
          scheduledAt: perth('2026-10-30'),
          repeat: { count: 3, unit: 'month' },
        },
        TZ,
        now,
      ),
    ).toBe(perth('2026-10-30'))
    // Weekly from Mon 5 Oct: the first visit from yesterday on is today's.
    expect(
      bookingAt(
        {
          scheduledAt: perth('2026-10-05'),
          repeat: { count: 1, unit: 'week' },
        },
        TZ,
        now,
      ),
    ).toBe(perth('2026-10-26'))
  })
})

describe('what is seen', () => {
  const job = theirs('j-1', 'p-jane', perth('2026-10-29'))
  const visit = others('p-jane', perth('2026-10-28'), 'r-2')
  const mine = theirs('j-2', 'p-jane', perth('2026-10-31'), {
    recurrenceId: rid('r-1'),
  })

  test('each job or visit shown once, with its id only in scope; each Recurring Job, as a series or through a visit', () => {
    const shown = [
      { shows: { rows: [job, visit], series: [] } },
      { shows: { rows: [job, mine], series: [rid('r-3')] } },
    ]
    expect(seenOf(shown)).toEqual([
      { propertyId: 'p-jane', at: job.at, jobId: 'j-1' },
      { propertyId: 'p-jane', at: visit.at },
      { propertyId: 'p-jane', at: mine.at, jobId: 'j-2' },
    ])
    expect(seenSeriesOf(shown).sort()).toEqual(['r-1', 'r-2', 'r-3'])
  })

  test('added to, and the same back when nothing is new', () => {
    const once = withSeen(NOTHING_SEEN, { rows: [job, visit], series: [] })
    expect(once).toEqual({
      pairs: seenOf([{ shows: { rows: [job, visit], series: [] } }]),
      series: ['r-2'],
    })
    expect(withSeen(once, { rows: [job], series: [rid('r-2')] })).toBe(once)
  })
})

describe('which answer checks the date (`pickOpenWork`)', () => {
  const thisWeek = { startKey: WEEK, work: workOf([]) }
  const lastWeek = { startKey: '2026-10-19', work: workOf([]) }

  test('none held; none covering the date; else the newest that does', () => {
    expect(pickOpenWork([], '2026-10-30')).toEqual({ kind: 'none' })
    expect(pickOpenWork([thisWeek], '2026-09-01')).toEqual({ kind: 'past' })
    expect(pickOpenWork([lastWeek, thisWeek], '2026-10-30')).toEqual({
      kind: 'answer',
      answer: thisWeek,
    })
    // Last week's still checks this week, with no signal on the Monday.
    expect(pickOpenWork([lastWeek], '2026-10-30')).toEqual({
      kind: 'answer',
      answer: lastWeek,
    })
    // A date only last week's reaches back to.
    expect(pickOpenWork([lastWeek, thisWeek], '2026-09-22')).toEqual({
      kind: 'answer',
      answer: lastWeek,
    })
  })

  test('a date just past the twenty weeks: the newest whose days reach within a week of it, so the work near it the phone holds is still checked', () => {
    // This week's runs to Sun 14 Feb 2027; Wed 17 Feb is three days on.
    expect(pickOpenWork([thisWeek], '2027-02-17')).toEqual({
      kind: 'answer',
      answer: thisWeek,
    })
    expect(pickOpenWork([lastWeek, thisWeek], '2027-02-17')).toEqual({
      kind: 'answer',
      answer: thisWeek,
    })
    // Seven days on is the last it reaches; eight is past.
    expect(pickOpenWork([thisWeek], '2027-02-21').kind).toBe('answer')
    expect(pickOpenWork([thisWeek], '2027-02-22')).toEqual({ kind: 'past' })
    // And before: from Mon 28 Sept, a week back is the first it reaches.
    expect(pickOpenWork([thisWeek], '2026-09-21').kind).toBe('answer')
    expect(pickOpenWork([thisWeek], '2026-09-20')).toEqual({ kind: 'past' })
  })

  test('there, a job of the person’s own three days before is a row, and the day it stops is said', () => {
    const answer = {
      startKey: WEEK,
      work: workOf([theirs('j-1', 'p-jane', perth('2027-02-14', 10))]),
    }
    const pick = pickOpenWork([answer], '2027-02-17')
    expect(pick.kind).toBe('answer')
    const rows = siteWorkRows(
      check({ work: answer.work, at: perth('2027-02-17') }),
    )
    expect(rows.map((r) => r.message)).toEqual([
      '12 Wattle St has a job on Sun 14 Feb 2027 at 10:00am — General Pest, Sam Lee.',
    ])
    expect(
      uncheckedRows({
        pick: pick.kind,
        startKey: WEEK,
        dayKey: '2027-02-17',
        repeats: false,
        targets: 1,
        timezone: TZ,
        today: TODAY,
      }).map((r) => r.message),
    ).toEqual([
      'Bookings at this site after Sun 14 Feb 2027 can’t be checked on this phone.',
    ])
  })
})

describe('what can’t be checked (`uncheckedRows`, `siteBehindNote`)', () => {
  const base = {
    pick: 'answer' as const,
    startKey: WEEK,
    dayKey: '2026-10-30',
    repeats: false,
    targets: 1,
    timezone: TZ,
    today: TODAY,
  }
  const said = (rows: ReturnType<typeof uncheckedRows>) =>
    rows.map((r) => [r.id, r.label, r.message, r.fix])

  test('no answer on the phone at all: a row, with nothing to fix, so the first press says it', () => {
    expect(said(uncheckedRows({ ...base, pick: 'none' }))).toEqual([
      ['site:unchecked', 'Not checked', SITE_UNCHECKED, undefined],
    ])
    expect(SITE_UNCHECKED).toBe(
      'Other bookings at this site can’t be checked on this phone.',
    )
    expect(NOT_CHECKED).toBe('Not checked')
    expect(uncheckedRows({ ...base, pick: 'none' })[0].shows).toEqual({
      rows: [],
      series: [],
    })
  })

  test('nothing to check, nothing said: no site chosen, no address typed, or one no client has', () => {
    for (const pick of ['none', 'answer'] as const) {
      expect(uncheckedRows({ ...base, pick, targets: 0 })).toEqual([])
      expect(
        uncheckedRows({ ...base, pick, targets: 0, dayKey: '2027-02-10' }),
      ).toEqual([])
    }
  })

  test('a date no answer reaches within a week of is said as one just past the edge is, however far: nothing on the phone checks it (and, for a booking kept on the phone or a narrowed book, nothing on the server either)', () => {
    // This week's runs from Mon 28 Sept to Sun 14 Feb 2027.
    for (const dayKey of ['2027-02-22', '2027-03-10', '2027-10-26']) {
      expect(
        said(uncheckedRows({ ...base, pick: 'past', dayKey })),
        dayKey,
      ).toEqual([
        [
          'site:unchecked:after',
          'Not checked',
          'Bookings at this site after Sun 14 Feb 2027 can’t be checked on this phone.',
          undefined,
        ],
      ])
    }
    expect(
      said(uncheckedRows({ ...base, pick: 'past', dayKey: '2026-08-03' })),
    ).toEqual([
      [
        'site:unchecked:before',
        'Not checked',
        'Bookings at this site before Mon 28 Sept can’t be checked on this phone.',
        undefined,
      ],
    ])
    // So the press count never turns on how far off the booking is: a
    // day inside the edge, a day past it, and months past it, alike.
    const presses = (dayKey: string) =>
      uncheckedRows({
        ...base,
        pick: pickOpenWork([{ startKey: WEEK, work: workOf([]) }], dayKey).kind,
        dayKey,
      }).length
    expect(['2027-02-10', '2027-02-22', '2027-06-01'].map(presses)).toEqual([
      1, 1, 1,
    ])
    // Nothing to check, nothing said, there too.
    expect(uncheckedRows({ ...base, pick: 'past', targets: 0 })).toEqual([])
  })

  test('with the server’s check (M7): a date whose week either side is wholly past the days held is the server’s to name, and not said', () => {
    const server = { ...base, serverChecks: true }
    // This week's runs from Mon 28 Sept to Sun 14 Feb 2027; Recurring Job
    // visits are made to Sat 24 Apr 2027 (HORIZON_DAYS).
    for (const dayKey of ['2027-02-22', '2027-04-15', '2026-09-20']) {
      expect(
        uncheckedRows({ ...server, pick: 'past', dayKey }),
        dayKey,
      ).toEqual([])
    }
    // A week that straddles an edge: the phone holds part of it, and says
    // where it stops, as without.
    expect(said(uncheckedRows({ ...server, dayKey: '2027-02-10' }))).toEqual([
      [
        'site:unchecked:after',
        'Not checked',
        'Bookings at this site after Sun 14 Feb 2027 can’t be checked on this phone.',
        undefined,
      ],
    ])
    expect(
      said(uncheckedRows({ ...server, pick: 'past', dayKey: '2027-02-21' })),
    ).toHaveLength(1)
    // No usable answer on the phone: still said.
    expect(said(uncheckedRows({ ...server, pick: 'none' }))).toEqual([
      ['site:unchecked', 'Not checked', SITE_UNCHECKED, undefined],
    ])
    expect(
      uncheckedRows({
        ...server,
        capped: true,
        lastAt: perth('2026-11-03'),
      }),
    ).toHaveLength(1)
  })

  test('with the server’s check, a one-off whose week after runs past the Recurring Job visits made so far is still said: a running one’s visit there is on nobody’s books yet; a Recurring Job being booked is the server’s to name at any date', () => {
    const server = { ...base, serverChecks: true }
    const after = [
      'site:unchecked:after',
      'Not checked',
      'Bookings at this site after Sun 14 Feb 2027 can’t be checked on this phone.',
      undefined,
    ]
    // Visits are made 180 days ahead, by a daily run: to Thu 22 Apr 2027
    // at the least, two days short of today's horizon, to be sure.
    expect(
      uncheckedRows({ ...server, pick: 'past', dayKey: '2027-04-15' }),
    ).toEqual([])
    for (const dayKey of ['2027-04-16', '2027-05-24', '2027-08-02']) {
      expect(
        said(uncheckedRows({ ...server, pick: 'past', dayKey })),
        dayKey,
      ).toEqual([after])
      expect(
        uncheckedRows({ ...server, pick: 'past', dayKey, repeats: true }),
        dayKey,
      ).toEqual([])
    }
  })

  test('with the server’s check, a one-off past the Recurring Job visits made so far, where none runs at a site checked: every booking near it is a one-off, which the server names, so not said; where one runs, or that can’t be told, still said', () => {
    const server = { ...base, serverChecks: true }
    for (const dayKey of ['2027-04-16', '2027-05-04', '2027-08-02']) {
      expect(
        uncheckedRows({ ...server, pick: 'past', dayKey, seriesThere: false }),
        dayKey,
      ).toEqual([])
      expect(
        uncheckedRows({ ...server, pick: 'past', dayKey, seriesThere: true }),
        dayKey,
      ).toHaveLength(1)
      // Not with the server's check: the phone says it, as it always has.
      expect(
        uncheckedRows({ ...base, pick: 'past', dayKey, seriesThere: false }),
        dayKey,
      ).toHaveLength(1)
    }
    // A week that straddles the edge of the weeks held: still said.
    expect(
      uncheckedRows({ ...server, dayKey: '2027-02-10', seriesThere: false }),
    ).toHaveLength(1)
  })

  test('an answer cut short before the week after the date, or for a Recurring Job, can’t say', () => {
    expect(
      said(
        uncheckedRows({ ...base, capped: true, lastAt: perth('2026-11-03') }),
      ),
    ).toEqual([['site:unchecked', 'Not checked', SITE_UNCHECKED, undefined]])
    expect(
      uncheckedRows({ ...base, capped: true, lastAt: perth('2026-12-01') }),
    ).toEqual([])
    expect(
      said(
        uncheckedRows({
          ...base,
          capped: true,
          repeats: true,
          lastAt: perth('2026-12-01'),
        }),
      ),
    ).toEqual([['site:unchecked', 'Not checked', SITE_UNCHECKED, undefined]])
  })

  test('a week either side past the answer’s ends names the day it stops', () => {
    // This week's runs from Mon 28 Sept to Sun 14 Feb.
    expect(said(uncheckedRows({ ...base, dayKey: '2027-02-10' }))).toEqual([
      [
        'site:unchecked:after',
        'Not checked',
        'Bookings at this site after Sun 14 Feb 2027 can’t be checked on this phone.',
        undefined,
      ],
    ])
    expect(said(uncheckedRows({ ...base, dayKey: '2026-10-01' }))).toEqual([
      [
        'site:unchecked:before',
        'Not checked',
        'Bookings at this site before Mon 28 Sept can’t be checked on this phone.',
        undefined,
      ],
    ])
    // A week inside both ends: nothing.
    expect(uncheckedRows({ ...base, dayKey: '2027-02-07' })).toEqual([])
    expect(uncheckedRows({ ...base, dayKey: '2026-10-05' })).toEqual([])
  })

  test('how old, only where the rows came from an answer that may be behind', () => {
    const at = perth(TODAY, 9, 42)
    const note = {
      said: true,
      behind: true,
      asOf: at,
      timezone: TZ,
      today: TODAY,
    }
    expect(siteBehindNote(note)).toBe(
      'From the jobs on this phone, updated 9:42am.',
    )
    expect(siteBehindNote({ ...note, asOf: null })).toBe(
      'From the jobs on this phone.',
    )
    expect(siteBehindNote({ ...note, said: false })).toBeNull()
    expect(siteBehindNote({ ...note, behind: false })).toBeNull()
  })
})

describe('the foot of the panel (`siteFooter`)', () => {
  const open = {
    kind: 'openJob' as const,
    label: 'Open #123',
    jobId: jid('j-1'),
    dayKey: '2026-10-29',
  }
  const bookAt = {
    kind: 'bookAt' as const,
    label: 'Book at 12 Wattle St',
    clientId: cid('c-jane'),
    propertyId: pid('p-jane'),
  }

  test('open it, or one; book there; or book this one too', () => {
    expect(siteFooter([{ fix: open }], 'Book anyway')).toBe(
      'Open it, or press Book anyway to book this one as well.',
    )
    expect(siteFooter([{ fix: open }, { fix: open }], 'Book anyway')).toBe(
      'Open one, or press Book anyway to book this one as well.',
    )
    expect(siteFooter([{ fix: bookAt }], 'Book anyway')).toBe(
      'Book there, or press Book anyway to book this one as well.',
    )
    expect(siteFooter([{}], 'Book anyway')).toBe(
      'Press Book anyway to book this one as well.',
    )
  })

  test('by the fix each row offers first: at an address typed, Book at, with Open #123 second, is “Book there”', () => {
    expect(siteFooter([{ fix: bookAt, fix2: open }], 'Book anyway')).toBe(
      'Book there, or press Book anyway to book this one as well.',
    )
    expect(
      siteFooter([{ fix: bookAt, fix2: open }, { fix: bookAt }], 'Book anyway'),
    ).toBe('Book there, or press Book anyway to book this one as well.')
    // Beside a Recurring Job to open there, Book at still leads.
    expect(
      siteFooter([{ fix: open }, { fix: bookAt, fix2: open }], 'Book anyway'),
    ).toBe('Book there, or press Book anyway to book this one as well.')
  })

  test('with only what couldn’t be checked, book it; beside work found, as for that work', () => {
    const notChecked = { label: NOT_CHECKED }
    expect(siteFooter([notChecked], 'Book anyway')).toBe(
      'Press Book anyway to book it.',
    )
    expect(siteFooter([{ fix: open }, notChecked], 'Book anyway')).toBe(
      'Open it, or press Book anyway to book this one as well.',
    )
    expect(
      siteFooter([{ label: 'Already booked' }, notChecked], 'Book anyway'),
    ).toBe('Press Book anyway to book this one as well.')
  })
})

describe('a match row naming its site’s work (FW13)', () => {
  const bookAtJane: MatchFix = {
    kind: 'bookAt',
    label: 'Book at 12 Wattle St',
    clientId: cid('c-jane'),
    propertyId: pid('p-jane'),
  }
  const janeRow = {
    id: 'match:c-jane',
    message: '12 Wattle St, Bayswater is Jane Nguyen’s. Same name and address.',
    fix: bookAtJane,
  }
  const useBob = {
    id: 'match:c-bob',
    message: 'Bob Smith, of Maylands, has the same mobile.',
    fix: {
      kind: 'use',
      label: 'Use Bob Smith',
      clientId: cid('c-bob'),
    } as MatchFix,
  }

  test('the site a row books at, and the clients rows name', () => {
    expect(namedSiteOf(janeRow)).toBe('p-jane')
    expect(namedSiteOf(useBob)).toBeNull()
    expect(matchClientsOf([janeRow, useBob]).sort()).toEqual([
      'c-bob',
      'c-jane',
    ])
  })

  test('says what is booked there within a week, not seen yet, and names it for the fix to mark seen', () => {
    const job = theirs('j-123', 'p-jane', perth('2026-10-29'), {
      jobNumber: 123,
    })
    const visit = others('p-jane', perth('2026-10-31'), 'r-2')
    const far = others('p-jane', perth('2026-11-20'))
    const { rows, named } = matchRowsWithWork([janeRow, useBob], {
      work: workOf([job, visit, far]),
      timezone: TZ,
      today: TODAY,
      at: perth('2026-10-30'),
      seen: NOTHING_SEEN,
    })
    expect(rows[0].message).toBe(
      '12 Wattle St, Bayswater is Jane Nguyen’s. Same name and address. It has a job on Thu 29 Oct (#123) and another job booked on Sat 31 Oct.',
    )
    expect(rows[1]).toBe(useBob)
    expect(named.get('match:c-jane')).toEqual([job, visit])
    expect(named.has('match:c-bob')).toBe(false)

    // Once its fix has marked them seen, the row says nothing more.
    const seen = withSeen(NOTHING_SEEN, {
      rows: named.get('match:c-jane') ?? [],
      series: [],
    })
    const after = matchRowsWithWork([janeRow], {
      work: workOf([job, visit, far]),
      timezone: TZ,
      today: TODAY,
      at: perth('2026-10-30'),
      seen,
    })
    expect(after.rows[0]).toBe(janeRow)
    expect(after.named.size).toBe(0)
  })

  test('a visit of the person’s own Recurring Job is one', () => {
    expect(
      workClause(
        [
          theirs('j-2', 'p-jane', perth('2026-10-29'), {
            recurrenceId: rid('r-1'),
          }),
        ],
        { timezone: TZ, today: TODAY },
      ),
    ).toBe('It has a Recurring Job visit on Thu 29 Oct.')
  })

  test('someone else’s two on one day are said once', () => {
    expect(
      workClause(
        [
          others('p-jane', perth('2026-10-29', 9)),
          others('p-jane', perth('2026-10-29', 14)),
        ],
        { timezone: TZ, today: TODAY },
      ),
    ).toBe('It has another job booked on Thu 29 Oct.')
  })
})

describe('both checks from one reading (`bookingWork`)', () => {
  const quarterly: OpenWorkSeries = {
    _id: rid('r-1'),
    propertyId: pid('p-jane'),
    nextAt: perth('2026-11-09'),
    intervalCount: 1,
    intervalUnit: 'year',
    jobType: 'Termite Inspection',
  }
  const visit = theirs('j-9', 'p-jane', perth('2026-11-09'), {
    recurrenceId: rid('r-1'),
    status: 'recurring',
  })
  const held = [{ startKey: WEEK, work: workOf([visit], [quarterly]) }]
  const { work: _work, ...base } = check()

  test('a Recurring Job months past every answer’s weeks, where one runs: Already repeats, whatever the dates, and what near it couldn’t be checked', () => {
    // Eight months on: no answer reaches within a week of it.
    const at = perth('2027-06-30')
    const work = bookingWork({
      held,
      dayKey: '2027-06-30',
      matchRows: [],
      check: { ...base, at, repeats: true },
    })
    expect(work.pick).toBe('past')
    expect(work.read).toBe(held[0])
    expect(work.found.map((r) => [r.label, r.message])).toEqual([
      [
        'Already repeats',
        '12 Wattle St already has a Recurring Job: Termite Inspection every year, next Mon 9 Nov.',
      ],
    ])
    expect(work.unchecked.map((r) => r.message)).toEqual([
      'Bookings at this site after Sun 14 Feb 2027 can’t be checked on this phone.',
    ])
    // A one-off there: no Recurring Job row, only what couldn't be checked.
    const oneOff = bookingWork({
      held,
      dayKey: '2027-06-30',
      matchRows: [],
      check: { ...base, at },
    })
    expect(oneOff.found).toEqual([])
    expect(oneOff.unchecked.map((r) => r.id)).toEqual(['site:unchecked:after'])
  })

  test('with the server’s check, a date wholly past the weeks held: not said where every site checked is one the server checks (chosen, or at the address typed exactly); said where one is only like it, or in the same street, which only the phone looks at', () => {
    // Past the twenty weeks, inside the Recurring Job visits made.
    const far = (targets: SiteCheck['targets']) =>
      bookingWork({
        held,
        dayKey: '2027-03-31',
        matchRows: [],
        check: { ...base, at: perth('2027-03-31'), targets },
        serverChecks: true,
      }).unchecked.map((r) => r.id)
    expect(far([{ site: JANE_SITE, how: 'chosen' }])).toEqual([])
    expect(
      far([
        { site: JANE_SITE, how: 'address' },
        { site: BOB_SITE, how: 'address' },
      ]),
    ).toEqual([])
    // "30 Watle St" typed, like Jane's 30 Wattle St: the server checks only
    // sites at "30 Watle St" exactly, so Jane's work there that week is
    // checked by neither.
    expect(far([{ site: JANE_SITE, how: 'near' }])).toEqual([
      'site:unchecked:after',
    ])
    expect(
      far([
        { site: BOB_SITE, how: 'address' },
        { site: JANE_SITE, how: 'street' },
      ]),
    ).toEqual(['site:unchecked:after'])
  })

  test('with the server’s check, a one-off past the Recurring Job visits made so far: said only at a site where one runs, as the answer read has every one running in the business', () => {
    // Tue 4 May 2027: past the visits made (to Thu 22 Apr 2027 at least).
    const far = (targets: SiteCheck['targets'], at = held) =>
      bookingWork({
        held: at,
        dayKey: '2027-05-04',
        matchRows: [],
        check: { ...base, at: perth('2027-05-04'), targets },
        serverChecks: true,
      }).unchecked.map((r) => r.id)
    // Jane's site has a Recurring Job (`quarterly`); Bob's none.
    expect(far([{ site: JANE_SITE, how: 'chosen' }])).toEqual([
      'site:unchecked:after',
    ])
    expect(far([{ site: BOB_SITE, how: 'chosen' }])).toEqual([])
    expect(
      far([
        { site: BOB_SITE, how: 'address' },
        { site: JANE_SITE, how: 'address' },
      ]),
    ).toEqual(['site:unchecked:after'])
    // None running anywhere.
    expect(
      far(
        [{ site: JANE_SITE, how: 'chosen' }],
        [{ startKey: WEEK, work: workOf([]) }],
      ),
    ).toEqual([])
  })

  test('nothing held: only that it couldn’t be checked; an answer covering the date: the work near it', () => {
    const none = bookingWork({
      held: [],
      dayKey: '2026-10-30',
      matchRows: [],
      check: base,
    })
    expect(none.pick).toBe('none')
    expect(none.read).toBeNull()
    expect(none.found).toEqual([])
    expect(none.unchecked.map((r) => r.message)).toEqual([SITE_UNCHECKED])
    const near = bookingWork({
      held: [
        {
          startKey: WEEK,
          work: workOf([theirs('j-1', 'p-jane', perth('2026-10-29'))]),
        },
      ],
      dayKey: '2026-10-30',
      matchRows: [],
      check: base,
    })
    expect(near.found.map((r) => r.id)).toEqual(['site:job:j-1'])
    expect(near.unchecked).toEqual([])
  })

  test('a match row’s fix books past the work it named and every row about the site it books at, an Already repeats there too', () => {
    const job = theirs('j-123', 'p-jane', perth('2026-10-29'), {
      jobNumber: 123,
    })
    const janeRow = {
      id: 'match:c-jane',
      message:
        '12 Wattle St, Bayswater is Jane Nguyen’s. Same name and address.',
      fix: {
        kind: 'bookAt',
        label: 'Book at 12 Wattle St',
        clientId: cid('c-jane'),
        propertyId: pid('p-jane'),
      } as MatchFix,
    }
    const work = bookingWork({
      held: [{ startKey: WEEK, work: workOf([job, visit], [quarterly]) }],
      dayKey: '2026-10-30',
      matchRows: [janeRow],
      check: {
        ...base,
        repeats: true,
        targets: [{ site: JANE_SITE, how: 'address' }],
      },
    })
    // The job is the match row's words, not a row of its own; the
    // Recurring Job running there is.
    expect(work.matchRows[0].message).toBe(
      '12 Wattle St, Bayswater is Jane Nguyen’s. Same name and address. It has a job on Thu 29 Oct (#123).',
    )
    expect(work.found.map((r) => r.id)).toEqual(['site:series:r-1'])
    expect(work.named.get('match:c-jane')).toEqual([job])
    expect(work.fixSees.get('match:c-jane')).toEqual({
      rows: [job],
      series: ['r-1'],
    })
    // Once the fix has marked it so, at her site the press after it is
    // told of neither.
    const seen = withSeen(NOTHING_SEEN, work.fixSees.get('match:c-jane')!)
    const after = bookingWork({
      held: [{ startKey: WEEK, work: workOf([job, visit], [quarterly]) }],
      dayKey: '2026-10-30',
      matchRows: [],
      check: { ...base, repeats: true, seen },
    })
    expect(after.found).toEqual([])
  })

  test('what couldn’t be checked, said beside a fix, isn’t said again on the press after it (`uncheckedSeen`), nor anything new hidden by it', () => {
    // A date nineteen and a half weeks out: its week after runs past the
    // twenty weeks the phone holds. A match row names her job there.
    const job = others('p-jane', perth('2027-02-10'))
    const janeRow = {
      id: 'match:c-jane',
      message:
        '12 Wattle St, Bayswater is Jane Nguyen’s. Same name and address.',
      fix: {
        kind: 'bookAt',
        label: 'Book at 12 Wattle St',
        clientId: cid('c-jane'),
        propertyId: pid('p-jane'),
      } as MatchFix,
    }
    const at = perth('2027-02-11')
    const press1 = bookingWork({
      held: [{ startKey: WEEK, work: workOf([job]) }],
      dayKey: '2027-02-11',
      matchRows: [janeRow],
      check: { ...base, at, targets: [{ site: JANE_SITE, how: 'address' }] },
    })
    expect(press1.named.get('match:c-jane')).toEqual([job])
    expect(press1.unchecked.map((r) => r.message)).toEqual([
      'Bookings at this site after Sun 14 Feb 2027 can’t be checked on this phone.',
    ])
    // The match row's fix taken: at her site, the work it named seen, and
    // the row beside it read. The press after it has nothing to say.
    const seen = withSeen(NOTHING_SEEN, press1.fixSees.get('match:c-jane')!)
    const read = new Set(
      uncheckedKeysOf(press1.unchecked, [{ site: JANE_SITE, how: 'address' }]),
    )
    const press2 = bookingWork({
      held: [{ startKey: WEEK, work: workOf([job]) }],
      dayKey: '2027-02-11',
      matchRows: [],
      check: { ...base, at, seen },
      uncheckedSeen: read,
    })
    expect(press2.found).toEqual([])
    expect(press2.unchecked).toEqual([])
    // Without it, the same row again, on its own: a third press to book.
    expect(
      bookingWork({
        held: [{ startKey: WEEK, work: workOf([job]) }],
        dayKey: '2027-02-11',
        matchRows: [],
        check: { ...base, at, seen },
      }).unchecked.map((r) => r.id),
    ).toEqual(['site:unchecked:after'])
    // With nothing on the phone, the same.
    const none = bookingWork({
      held: [],
      dayKey: '2026-10-30',
      matchRows: [],
      check: base,
    })
    expect(
      bookingWork({
        held: [],
        dayKey: '2026-10-30',
        matchRows: [],
        check: base,
        uncheckedSeen: new Set(uncheckedKeysOf(none.unchecked, chosen())),
      }).unchecked,
    ).toEqual([])
    // A row it didn't say is still said: "before", say, for a date the
    // other side of the weeks held.
    expect(
      bookingWork({
        held: [{ startKey: WEEK, work: workOf([]) }],
        dayKey: '2026-10-01',
        matchRows: [],
        check: { ...base, at: perth('2026-10-01') },
        uncheckedSeen: read,
      }).unchecked.map((r) => r.id),
    ).toEqual(['site:unchecked:before'])
    // Only what couldn't be checked is kept so: work found is `seen`'s.
    expect(
      uncheckedKeysOf([...press1.found, ...press1.unchecked], chosen()),
    ).toHaveLength(1)
  })

  test('…read for the sites it was said for only: booked at another site after the fix (picked by hand), it is said again there', () => {
    // Nothing on the phone. A new client typed at 12 Wattle St, Bayswater:
    // Jane's site there is checked, and can't be.
    const press1 = bookingWork({
      held: [],
      dayKey: '2026-10-30',
      matchRows: [],
      check: { ...base, targets: [{ site: JANE_SITE, how: 'address' }] },
    })
    expect(press1.unchecked.map((r) => r.message)).toEqual([
      'Other bookings at this site can’t be checked on this phone.',
    ])
    // Book on Jane Nguyen taken beside it: read, at her site.
    const read = new Set(
      uncheckedKeysOf(press1.unchecked, [{ site: JANE_SITE, how: 'address' }]),
    )
    const at = (targets: Array<SiteTarget>) =>
      bookingWork({
        held: [],
        dayKey: '2026-10-30',
        matchRows: [],
        check: { ...base, targets },
        uncheckedSeen: read,
      }).unchecked.map((r) => r.message)
    // At her site, the press after the fix books.
    expect(at(chosen(JANE_SITE))).toEqual([])
    // Bob's picked by hand from the Property picker instead: the same
    // words, about a site they were never said for, said again.
    expect(at(chosen(BOB_SITE))).toEqual([
      'Other bookings at this site can’t be checked on this phone.',
    ])
    // So too where the booking is checked at hers and another's.
    expect(
      at([
        { site: JANE_SITE, how: 'address' },
        { site: BOB_SITE, how: 'street' },
      ]),
    ).toEqual(['Other bookings at this site can’t be checked on this phone.'])
  })
})

describe('Book at from a row about the site’s work (`withSeenAll`)', () => {
  test('books past every row the panel showed of it, so the press after it isn’t asked about the second', () => {
    const first = theirs('j-1', 'p-jane', perth('2026-10-29'))
    const second = theirs('j-2', 'p-jane', perth('2026-10-31'))
    const targets = siteTargets(INDEX, {
      mode: 'new',
      typed: {
        addressLine: '12 Wattle St',
        suburb: 'Bayswater',
        postcode: '6053',
      },
      clients: [],
    })
    const shown = siteWorkRows(
      check({ work: workOf([first, second]), targets }),
    )
    expect(shown.map((r) => r.fix?.label)).toEqual([
      'Book at 12 Wattle St',
      'Book at 12 Wattle St',
    ])
    // At her site, as Book at leaves the booking, after the first row's.
    const seen = withSeenAll(NOTHING_SEEN, shown)
    expect(
      siteWorkRows(check({ work: workOf([first, second]), seen })),
    ).toEqual([])
    expect(withSeenAll(NOTHING_SEEN, [])).toBe(NOTHING_SEEN)
  })

  test('and the work a match row beside them named at the site it books at, which that row said in their place (`bookAtSees`)', () => {
    // Three of her own jobs at her site within the week: the match row
    // names the nearest two, and the third is a site row of its own.
    const j123 = theirs('j-123', 'p-jane', perth('2026-10-29'), {
      jobNumber: 123,
    })
    const j124 = theirs('j-124', 'p-jane', perth('2026-10-31'), {
      jobNumber: 124,
    })
    const j125 = theirs('j-125', 'p-jane', perth('2026-11-02'), {
      jobNumber: 125,
    })
    const elsewhere = theirs('j-9', 'p-bob', perth('2026-10-30'))
    const janeRow = {
      id: 'match:c-jane',
      message:
        '12 Wattle St, Bayswater is Jane Nguyen’s. Same name and address.',
      fix: {
        kind: 'bookAt',
        label: 'Book at 12 Wattle St',
        clientId: cid('c-jane'),
        propertyId: pid('p-jane'),
      } as MatchFix,
    }
    const work = workOf([j123, j124, j125])
    const press1 = bookingWork({
      held: [{ startKey: WEEK, work }],
      dayKey: '2026-10-30',
      matchRows: [janeRow],
      check: {
        ...check(),
        targets: [{ site: JANE_SITE, how: 'address' }],
      },
    })
    expect(press1.named.get('match:c-jane')).toEqual([j123, j124])
    expect(
      press1.found.map((r) => [r.id, r.fix?.label, r.fix2?.label]),
    ).toEqual([['site:job:j-125', 'Book at 12 Wattle St', 'Open #125']])
    // The site row's Book at taken: at her site, the press after it is
    // told of none of the three.
    const named = new Map([
      ...press1.named,
      ['match:c-bob', [elsewhere]] as const,
    ])
    const seen = withSeenAll(
      NOTHING_SEEN,
      bookAtSees(pid('p-jane'), press1.found, named),
    )
    expect(siteWorkRows(check({ work, seen }))).toEqual([])
    // The site rows alone would leave the two the match row named.
    expect(
      siteWorkRows(
        check({ work, seen: withSeenAll(NOTHING_SEEN, press1.found) }),
      ).map((r) => r.id),
    ).toEqual(['site:job:j-123', 'site:job:j-124'])
    // Work a match row named at another site isn't booked past.
    expect(isSeen(elsewhere, seen)).toBe(false)
    expect(bookAtSees(pid('p-jane'), press1.found, new Map())).toEqual(
      press1.found,
    )
  })

  test('a refused match row’s fix books past what the press refused showed at the site it books at, as the phone’s own match row’s does, though its words name none of it (`refusedMatchSees`)', () => {
    // 12 Wattle St holds three jobs within the week. The phone has the
    // site as Jane's, and her row names the nearest two; the third is a
    // site row of its own. The site has just gone to Amy Lo's record on
    // another phone, so the server names Amy, with Book on Amy Lo there.
    const j123 = theirs('j-123', 'p-jane', perth('2026-10-29'), {
      jobNumber: 123,
    })
    const j124 = theirs('j-124', 'p-jane', perth('2026-10-31'), {
      jobNumber: 124,
    })
    const j125 = theirs('j-125', 'p-jane', perth('2026-11-02'), {
      jobNumber: 125,
    })
    const elsewhere = theirs('j-9', 'p-bob', perth('2026-10-30'))
    const janeRow = {
      id: 'match:c-jane',
      message:
        '12 Wattle St, Bayswater is Jane Nguyen’s. Same name and address.',
      fix: {
        kind: 'bookAt',
        label: 'Book at 12 Wattle St',
        clientId: cid('c-jane'),
        propertyId: pid('p-jane'),
      } as MatchFix,
    }
    const work = workOf([j123, j124, j125, elsewhere])
    const press1 = bookingWork({
      held: [{ startKey: WEEK, work }],
      dayKey: '2026-10-30',
      matchRows: [janeRow],
      check: {
        ...check(),
        targets: [{ site: JANE_SITE, how: 'address' }],
      },
    })
    expect(press1.found.map((r) => r.id)).toEqual(['site:job:j-125'])
    const amyRow = {
      fix: {
        kind: 'bookAt',
        label: 'Book on Amy Lo',
        clientId: cid('c-amy'),
        propertyId: pid('p-jane'),
      } as MatchFix,
    }
    const atJane = { ...check(), work }
    // The phone's own row's fix: the press after it, at the site, is told
    // of none of the three.
    const own = withSeen(NOTHING_SEEN, press1.fixSees.get('match:c-jane')!)
    expect(siteWorkRows({ ...atJane, seen: own })).toEqual([])
    // Amy's, beside Jane's row still standing in the phone's own words:
    // the same.
    const sees = refusedMatchSees(amyRow, press1.found, press1.named)
    expect(sees).toBeDefined()
    const seen = withSeen(NOTHING_SEEN, sees!)
    expect(siteWorkRows({ ...atJane, seen })).toEqual([])
    // Work at another site isn't booked past.
    expect(isSeen(elsewhere, seen)).toBe(false)
    // In the place of a phone row naming the two (`namedRowsOnPanel`
    // leaves its work out, as its words are gone): the site row alone.
    const alone = withSeen(
      NOTHING_SEEN,
      refusedMatchSees(amyRow, press1.found, new Map())!,
    )
    expect(siteWorkRows({ ...atJane, seen: alone }).map((r) => r.id)).toEqual([
      'site:job:j-123',
      'site:job:j-124',
    ])
    // A "Not checked" row beside them is no work to book past.
    const unchecked = {
      propertyId: null,
      shows: { rows: [], series: [] },
    }
    expect(
      refusedMatchSees(amyRow, [...press1.found, unchecked], new Map()),
    ).toEqual(refusedMatchSees(amyRow, press1.found, new Map()))
    // A row booking at no site (Use, Show them) books past nothing.
    expect(
      refusedMatchSees(
        {
          fix: {
            kind: 'use',
            label: 'Use Amy Lo',
            clientId: cid('c-amy'),
          },
        },
        press1.found,
        press1.named,
      ),
    ).toBeUndefined()
    // Nothing shown at its site: nothing.
    expect(
      refusedMatchSees(
        {
          fix: {
            kind: 'bookAt',
            label: 'Book on Bob Smith',
            clientId: cid('c-bob'),
            propertyId: pid('p-elsewhere'),
          },
        },
        press1.found,
        press1.named,
      ),
    ).toBeUndefined()
  })

  test('a match row’s fix, the phone’s own or a refused one’s, books past what an “And 3 more” about several sites counts at the site it books at, as it does the rows above: the press after it isn’t told of them again, and the other site’s stay to be told of', () => {
    // New client typed at 12 Wattle St, Bayswater 6053: Jane's site there,
    // and Bob's 12 Wattle St in Maylands, the same street and postcode.
    // Seven jobs of the owner's own within the week between them.
    const job = (id: string, at: string, when: number, n: number) =>
      theirs(id, at, when, { jobNumber: n })
    const a1 = job('j-a1', 'p-jane', perth('2026-10-30', 10), 1)
    const a2 = job('j-a2', 'p-jane', perth('2026-10-30', 11), 2)
    const b1 = job('j-b1', 'p-bob', perth('2026-10-29'), 11)
    const a3 = job('j-a3', 'p-jane', perth('2026-11-01'), 3)
    const a4 = job('j-a4', 'p-jane', perth('2026-11-02'), 4)
    const b2 = job('j-b2', 'p-bob', perth('2026-11-03'), 12)
    const a5 = job('j-a5', 'p-jane', perth('2026-11-04'), 5)
    const work = workOf([a1, a2, b1, a3, a4, b2, a5])
    const janeRow = {
      id: 'match:c-jane',
      message:
        '12 Wattle St, Bayswater is Jane Nguyen’s. Same name and address.',
      fix: {
        kind: 'bookAt',
        label: 'Book at 12 Wattle St',
        clientId: cid('c-jane'),
        propertyId: pid('p-jane'),
      } as MatchFix,
    }
    const press1 = bookingWork({
      held: [{ startKey: WEEK, work }],
      dayKey: '2026-10-30',
      matchRows: [janeRow],
      check: {
        ...check(),
        targets: [
          { site: JANE_SITE, how: 'address' },
          { site: BOB_SITE, how: 'street' },
        ],
        typedAddress: '12 Wattle St',
      },
    })
    // Jane's row names the two on the day; two rows, then the rest at
    // both sites, two of its three at Jane's.
    expect(press1.named.get('match:c-jane')).toEqual([a1, a2])
    expect(press1.found.map((r) => [r.id, r.propertyId])).toEqual([
      ['site:job:j-b1', pid('p-bob')],
      ['site:job:j-a3', pid('p-jane')],
      ['site:more', null],
    ])
    expect(press1.found[2].message).toBe(
      '3 other jobs or visits are booked at these sites within a week of this one.',
    )
    const atJane = { ...check(), work }
    // The phone's own row's fix: at her site, the press after it is told
    // of none of the five.
    const own = withSeen(NOTHING_SEEN, press1.fixSees.get('match:c-jane')!)
    expect(siteWorkRows({ ...atJane, seen: own })).toEqual([])
    for (const there of [a1, a2, a3, a4, a5]) {
      expect(isSeen(there, own)).toBe(true)
    }
    // Bob's stay to be told of, should the booking go there.
    expect(isSeen(b1, own)).toBe(false)
    expect(isSeen(b2, own)).toBe(false)
    // A refused row's fix at the same site, the phone's row beside it: the
    // same.
    const amyRow = {
      fix: {
        kind: 'bookAt',
        label: 'Book on Amy Lo',
        clientId: cid('c-amy'),
        propertyId: pid('p-jane'),
      } as MatchFix,
    }
    const refused = withSeen(
      NOTHING_SEEN,
      refusedMatchSees(amyRow, press1.found, press1.named)!,
    )
    expect(siteWorkRows({ ...atJane, seen: refused })).toEqual([])
    expect(isSeen(b2, refused)).toBe(false)
    // In the place of the phone's row, whose words are gone: what the
    // site's own rows showed and counted there, never the two it named.
    const alone = withSeen(
      NOTHING_SEEN,
      refusedMatchSees(amyRow, press1.found, new Map())!,
    )
    expect(siteWorkRows({ ...atJane, seen: alone }).map((r) => r.id)).toEqual([
      'site:job:j-a1',
      'site:job:j-a2',
    ])
    // At Bob's: his two, though one was counted beside Jane's.
    const bobRow = {
      fix: {
        kind: 'bookAt',
        label: 'Book at 12 Wattle St',
        clientId: cid('c-bob'),
        propertyId: pid('p-bob'),
      } as MatchFix,
    }
    const atBob = withSeen(
      NOTHING_SEEN,
      refusedMatchSees(bobRow, press1.found, press1.named)!,
    )
    expect(
      siteWorkRows({ ...atJane, targets: chosen(BOB_SITE), seen: atBob }),
    ).toEqual([])
    expect(isSeen(a4, atBob)).toBe(false)
  })
})

describe('the day and repeat the site’s rows are read for (`workDayOf`)', () => {
  test('a series’ first visit’s day, which the time alone can move by a whole interval: its rows go with it', () => {
    // 10am on Tuesday 27 Oct; a weekly Recurring Job dated Monday.
    const now = perth('2026-10-27', 10)
    const weekly = { count: 1, unit: 'week' as const }
    const dayOf = (hh: number) =>
      workDayOf(
        new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(
          bookingAt(
            { scheduledAt: perth('2026-10-26', hh), repeat: weekly },
            TZ,
            now,
          ),
        ),
        weekly,
      )
    // At 9am, more than a day before: booked from next Monday.
    expect(dayOf(9)).toBe('2026-11-02|1|week')
    // At 11am, not: from Monday itself. The form's day is the same.
    expect(dayOf(11)).toBe('2026-10-26|1|week')
    expect(workDayOf('2026-10-30', null)).toBe('2026-10-30||')
  })
})

describe('what the match check hangs on beyond what was typed (`namedWorkMoved`)', () => {
  test('the day and repeat, only once moved from those rows naming work were read for', () => {
    // Rows naming work, read for this day: nothing has moved.
    expect(
      namedWorkMoved({ naming: true, workDay: 'a', readFor: 'a' }),
    ).toBeNull()
    // The date moved under them: they go.
    expect(namedWorkMoved({ naming: true, workDay: 'b', readFor: 'a' })).toBe(
      'b',
    )
    // Rows naming no work stay, the date moved or not (M3).
    expect(
      namedWorkMoved({ naming: false, workDay: 'b', readFor: 'a' }),
    ).toBeNull()
    // The press showing rows reads them for the day as it is: unchanged
    // from just before it, so the rows just shown stay.
    expect(namedWorkMoved({ naming: false, workDay: 'b', readFor: 'a' })).toBe(
      namedWorkMoved({ naming: true, workDay: 'b', readFor: 'b' }),
    )
  })
})

describe('what the server found as the booking went (SITE_BOOKED, SITE_REPEATS; M7 §4.5)', () => {
  const wattle = site('p-jane', 'c-jane', '12 Wattle St', 'Bayswater')
  const typedCtx = (
    extra: Partial<
      Exclude<RefusedSiteContext['at'], { mode: 'existing' }>
    > = {},
    held: ReadonlyArray<MatchSite> = [wattle],
  ): RefusedSiteContext => ({
    timezone: TZ,
    today: TODAY,
    at: {
      mode: 'new',
      typed: {
        addressLine: '12 Wattle St',
        suburb: 'Bayswater',
        postcode: '6053',
      },
      ...extra,
    },
    siteOf: (id) => held.find((s) => s._id === id),
  })
  const existingCtx: RefusedSiteContext = {
    timezone: TZ,
    today: TODAY,
    at: { mode: 'existing', site: { addressLine: '12 Wattle St' } },
    siteOf: () => undefined,
  }
  const said = (rows: ReturnType<typeof refusedSiteRows>) =>
    rows.map((r) => [r.id, r.label, r.message, r.fix?.label, r.fix2?.label])

  test('someone else’s work: by its date alone, once a day at a site, and whose never (C5)', () => {
    const rows = refusedSiteRows(
      {
        code: 'SITE_BOOKED',
        rows: [
          {
            propertyId: pid('p-jane'),
            at: 1,
            scheduledAt: perth('2026-11-03', 9),
          },
          {
            propertyId: pid('p-jane'),
            at: 2,
            scheduledAt: perth('2026-11-03', 14),
          },
        ],
      },
      existingCtx,
    )
    expect(said(rows)).toEqual([
      [
        'site:day:p-jane:2026-11-03',
        'Already booked',
        '12 Wattle St has another job booked on Tue 3 Nov.',
        undefined,
        undefined,
      ],
    ])
    // At an address typed: the site from the list, and Book at the site
    // where the list holds it; whose it is, not even where the server says
    // (a client the person may see), as the phone's row says it.
    expect(
      said(
        refusedSiteRows(
          {
            code: 'SITE_BOOKED',
            rows: [
              {
                propertyId: pid('p-jane'),
                at: 1,
                scheduledAt: perth('2026-11-03'),
                clientName: 'Jane Nguyen',
              },
            ],
          },
          typedCtx(),
        ),
      ),
    ).toEqual([
      [
        'site:day:p-jane:2026-11-03',
        'Already booked',
        '12 Wattle St, Bayswater has another job booked on Tue 3 Nov.',
        'Book at 12 Wattle St',
        undefined,
      ],
    ])
    // A site the list doesn't hold yet: the address as typed, no fix.
    expect(
      said(
        refusedSiteRows(
          {
            code: 'SITE_BOOKED',
            rows: [
              {
                propertyId: pid('p-new'),
                at: 1,
                scheduledAt: perth('2026-11-03'),
              },
            ],
          },
          typedCtx(),
        ),
      ),
    ).toEqual([
      [
        'site:day:p-new:2026-11-03',
        'Already booked',
        '12 Wattle St, Bayswater has another job booked on Tue 3 Nov.',
        undefined,
        undefined,
      ],
    ])
  })

  test('the person’s own: its number and Open #123 by the server’s id; a visit, Open the visit', () => {
    expect(
      said(
        refusedSiteRows(
          {
            code: 'SITE_BOOKED',
            rows: [
              {
                propertyId: pid('p-jane'),
                at: 1,
                scheduledAt: perth('2026-11-03', 10),
                jobId: jid('j-1'),
                jobNumber: 123,
              },
              {
                propertyId: pid('p-jane'),
                at: 2,
                scheduledAt: perth('2026-11-05', 10),
                jobId: jid('j-2'),
                jobNumber: 124,
                series: rid('r-1'),
              },
            ],
          },
          existingCtx,
        ),
      ),
    ).toEqual([
      [
        'site:job:j-1',
        'Already booked',
        '12 Wattle St has a job on Tue 3 Nov at 10:00am (#123).',
        'Open #123',
        undefined,
      ],
      [
        'site:job:j-2',
        'Already booked',
        '12 Wattle St has a Recurring Job visit on Thu 5 Nov.',
        'Open the visit',
        undefined,
      ],
    ])
    // At an address typed: Book at first, Open second; in New site for,
    // Book at only at the chosen client's.
    const own = {
      code: 'SITE_BOOKED' as const,
      rows: [
        {
          propertyId: pid('p-jane'),
          at: 1,
          scheduledAt: perth('2026-11-03', 10),
          jobId: jid('j-1'),
          jobNumber: 123,
        },
      ],
    }
    // As the phone's row at an address typed says it: Open #123 names it.
    expect(said(refusedSiteRows(own, typedCtx()))[0]).toEqual([
      'site:job:j-1',
      'Already booked',
      '12 Wattle St, Bayswater has a job on Tue 3 Nov.',
      'Book at 12 Wattle St',
      'Open #123',
    ])
    expect(
      said(
        refusedSiteRows(
          own,
          typedCtx({ mode: 'site', bookFor: cid('c-other') }),
        ),
      )[0].slice(3),
    ).toEqual(['Open #123', undefined])
  })

  test('the rest it named: "And 2 more", the person’s own one each', () => {
    const rows = refusedSiteRows(
      {
        code: 'SITE_BOOKED',
        rows: [
          {
            propertyId: pid('p-jane'),
            at: 1,
            scheduledAt: perth('2026-11-03'),
          },
        ],
        more: [
          { propertyId: pid('p-jane'), at: 2, jobId: jid('j-2') },
          { propertyId: pid('p-jane'), at: 3, jobId: jid('j-3') },
        ],
      },
      existingCtx,
    )
    expect(said(rows)[1]).toEqual([
      'site:more',
      'And 2 more',
      '2 other jobs or visits are booked at this site within a week of this one.',
      undefined,
      undefined,
    ])
  })

  test('someone else’s rest is counted by the day, as their rows are, and not at all on a day a row already says (C5)', () => {
    // A subcontractor's refusal: someone else's Thu 9:00 named, Thu 13:00
    // and 15:00 in `more`, one entry a slot. The phone would say one dated
    // row and no count: their number is no more the person's in a count.
    const thu = {
      code: 'SITE_BOOKED' as const,
      rows: [
        {
          propertyId: pid('p-jane'),
          at: perth('2026-10-29', 9),
          scheduledAt: perth('2026-10-29', 9),
        },
      ],
      more: [
        { propertyId: pid('p-jane'), at: perth('2026-10-29', 13) },
        { propertyId: pid('p-jane'), at: perth('2026-10-29', 15) },
      ],
    }
    expect(said(refusedSiteRows(thu, existingCtx))).toEqual([
      [
        'site:day:p-jane:2026-10-29',
        'Already booked',
        '12 Wattle St has another job booked on Thu 29 Oct.',
        undefined,
        undefined,
      ],
    ])
    // Two slots on another day are one more, as their row would be.
    expect(
      said(
        refusedSiteRows(
          {
            ...thu,
            more: [
              ...thu.more,
              { propertyId: pid('p-jane'), at: perth('2026-10-30', 9) },
              { propertyId: pid('p-jane'), at: perth('2026-10-30', 14) },
            ],
          },
          existingCtx,
        ),
      )[1],
    ).toEqual([
      'site:more',
      'And 1 more',
      'Another job or visit is booked at this site within a week of this one.',
      undefined,
      undefined,
    ])
  })

  test('“And N more” says which rows it counts, by the ids the phone’s own rows have: the same work told again by the server counts what the phone’s count counted', () => {
    // Booked on Fri 30 Oct at Jane's: someone else's Thu, Sat and Tue, and
    // the person's own job on Wed 4 Nov.
    const phone = siteWorkRows(
      check({
        work: workOf([
          others('p-jane', perth('2026-10-29')),
          others('p-jane', perth('2026-10-31')),
          others('p-jane', perth('2026-11-03')),
          theirs('j-4', 'p-jane', perth('2026-11-04')),
        ]),
      }),
    )
    expect(phone.map((row) => [row.id, row.counts])).toEqual([
      ['site:day:p-jane:2026-10-29', undefined],
      ['site:day:p-jane:2026-10-31', undefined],
      ['site:more', ['site:day:p-jane:2026-11-03', 'site:job:j-4']],
    ])
    // The server tells the same four, the two nearest as rows.
    const told = refusedSiteRows(
      {
        code: 'SITE_BOOKED',
        rows: [
          {
            propertyId: pid('p-jane'),
            at: perth('2026-10-29'),
            scheduledAt: perth('2026-10-29'),
          },
          {
            propertyId: pid('p-jane'),
            at: perth('2026-10-31'),
            scheduledAt: perth('2026-10-31'),
          },
        ],
        more: [
          { propertyId: pid('p-jane'), at: perth('2026-11-03') },
          {
            propertyId: pid('p-jane'),
            at: perth('2026-11-04'),
            jobId: jid('j-4'),
          },
        ],
      },
      existingCtx,
    )
    expect(told.map((row) => row.id)).toEqual(phone.map((row) => row.id))
    expect(told.at(-1)?.counts).toEqual(phone.at(-1)?.counts)
    // A Recurring Job's rest, by its ids.
    expect(
      refusedSiteRows(
        {
          code: 'SITE_REPEATS',
          series: [{ recurrenceId: rid('r-1'), propertyId: pid('p-jane') }],
          more: [rid('r-2'), rid('r-3')],
        },
        existingCtx,
      ).at(-1)?.counts,
    ).toEqual(['site:series:r-2', 'site:series:r-3'])
  })

  test('at an address typed, whose it is only for the person’s own work, with whether that client is archived or inactive', () => {
    const amy: MatchClient = {
      _id: cid('c-jane'),
      name: 'Amy Lo',
      kind: 'person',
      status: 'inactive',
    }
    const ctx = { ...typedCtx(), clientOf: () => amy }
    const at = perth('2026-10-29')
    // Someone else's: the server may name the client the person may see;
    // the phone's row names none (C5), and nor does this.
    expect(
      said(
        refusedSiteRows(
          {
            code: 'SITE_BOOKED',
            rows: [
              {
                propertyId: pid('p-jane'),
                at,
                scheduledAt: at,
                clientName: 'Jane Nguyen',
              },
            ],
          },
          ctx,
        ),
      )[0][2],
    ).toBe('12 Wattle St, Bayswater has another job booked on Thu 29 Oct.')
    // The person's own: whose, and that she is inactive, before Book at.
    expect(
      said(
        refusedSiteRows(
          {
            code: 'SITE_BOOKED',
            rows: [
              {
                propertyId: pid('p-jane'),
                at,
                scheduledAt: at,
                clientName: 'Amy Lo',
                jobId: jid('j-1'),
                jobNumber: 123,
              },
            ],
          },
          ctx,
        ),
      )[0],
    ).toEqual([
      'site:job:j-1',
      'Already booked',
      '12 Wattle St, Bayswater (Amy Lo’s) has a job on Thu 29 Oct. Amy Lo is inactive.',
      'Book at 12 Wattle St',
      'Open #123',
    ])
  })

  test('a Recurring Job: how often and what where the server said, its next visit, and no fix', () => {
    expect(
      said(
        refusedSiteRows(
          {
            code: 'SITE_REPEATS',
            series: [
              {
                recurrenceId: rid('r-1'),
                propertyId: pid('p-jane'),
                nextAt: perth('2026-11-10'),
                intervalCount: 3,
                intervalUnit: 'month',
                jobType: 'General Pest',
              },
              { recurrenceId: rid('r-2'), propertyId: pid('p-jane') },
            ],
            more: [rid('r-3')],
          },
          existingCtx,
        ),
      ),
    ).toEqual([
      [
        'site:series:r-1',
        'Already repeats',
        '12 Wattle St already has a Recurring Job: General Pest every 3 months, next Tue 10 Nov.',
        undefined,
        undefined,
      ],
      [
        'site:series:r-2',
        'Already repeats',
        '12 Wattle St already has a Recurring Job.',
        undefined,
        undefined,
      ],
      [
        'site:more:series',
        'And 1 more',
        'Another Recurring Job runs at this site.',
        undefined,
        undefined,
      ],
    ])
  })

  test('the rest at an address typed is “this site” only where it and every row above are at one site; else the address, which the server checks every site at (two clients’ sites there)', () => {
    // 12 Wattle St, Bayswater is two tenants' sites, Jane's (p-jane) and
    // Bob's (p-bob), neither on the phone's list yet. The rows are Jane's,
    // nearest first; what the server counts past them is Bob's.
    const ctx = typedCtx({}, [])
    const jane = (n: number, day: string) => ({
      propertyId: pid('p-jane'),
      at: perth(day),
      scheduledAt: perth(day),
      clientName: 'Jane Nguyen',
      jobId: jid(`j-${n}`),
      jobNumber: 100 + n,
    })
    const rows = [
      jane(1, '2026-10-28'),
      jane(2, '2026-10-29'),
      jane(3, '2026-10-30'),
    ]
    const booked = (
      more: ReadonlyArray<{ propertyId: Id<'properties'>; at: number }>,
    ) => said(refusedSiteRows({ code: 'SITE_BOOKED', rows, more }, ctx))
    const bob = { propertyId: pid('p-bob'), at: perth('2026-10-29', 14) }
    const all = booked([bob])
    expect(all.slice(0, 3).map((row) => row[2])).toEqual([
      '12 Wattle St, Bayswater (Jane Nguyen’s) has a job on Wed 28 Oct.',
      '12 Wattle St, Bayswater (Jane Nguyen’s) has a job on Thu 29 Oct.',
      '12 Wattle St, Bayswater (Jane Nguyen’s) has a job on Fri 30 Oct.',
    ])
    // Not "this site", which would read as Jane's.
    expect(all[3]).toEqual([
      'site:more',
      'And 1 more',
      'Another job or visit is booked at 12 Wattle St, Bayswater within a week of this one.',
      undefined,
      undefined,
    ])
    // Both sites in the count: the address typed.
    expect(
      booked([bob, { propertyId: pid('p-jane'), at: perth('2026-10-31') }])[3],
    ).toEqual([
      'site:more',
      'And 2 more',
      '2 other jobs or visits are booked at 12 Wattle St, Bayswater within a week of this one.',
      undefined,
      undefined,
    ])
    // All of it at Jane's: "this site" is hers, as the rows above are.
    expect(
      booked([{ propertyId: pid('p-jane'), at: perth('2026-10-31') }])[3][2],
    ).toBe(
      'Another job or visit is booked at this site within a week of this one.',
    )
    // The rows above at both: so is the address, however few are counted.
    expect(
      said(
        refusedSiteRows(
          {
            code: 'SITE_BOOKED',
            rows: [rows[0], { ...rows[1], propertyId: pid('p-bob') }],
            more: [{ propertyId: pid('p-jane'), at: perth('2026-10-31') }],
          },
          ctx,
        ),
      )[2][2],
    ).toBe(
      'Another job or visit is booked at 12 Wattle St, Bayswater within a week of this one.',
    )

    // A Recurring Job: what it counts is by id alone, so where it is isn't
    // said; at an address typed, never "this site", at one site above or
    // several. At the site chosen, the server checks that site alone.
    const repeats = (propertyIds: ReadonlyArray<string>) => ({
      code: 'SITE_REPEATS' as const,
      series: propertyIds.map((id, i) => ({
        recurrenceId: rid(`r-${i + 1}`),
        propertyId: pid(id),
      })),
      more: [rid('r-9')],
    })
    for (const [ids, held] of [
      [['p-jane', 'p-bob'], []],
      [['p-jane', 'p-jane'], []],
      [['p-jane'], [wattle]],
    ] as const) {
      expect(
        said(refusedSiteRows(repeats(ids), typedCtx({}, held))).at(-1),
        ids.join(),
      ).toEqual([
        'site:more:series',
        'And 1 more',
        'Another Recurring Job runs at 12 Wattle St, Bayswater.',
        undefined,
        undefined,
      ])
    }
    expect(
      said(refusedSiteRows(repeats(['p-jane']), existingCtx)).at(-1)?.[2],
    ).toBe('Another Recurring Job runs at this site.')
  })
})

describe('a refused row of the site’s work, once the phone’s copy holds that work too (M7)', () => {
  // An owner books at Jane's 12 Wattle St. The office has just booked #1
  // there for Thu 29 Oct, which this phone's copy doesn't hold yet: Book
  // is refused, and the panel shows the server's row.
  const refusal = {
    code: 'SITE_BOOKED' as const,
    rows: [
      {
        propertyId: pid('p-jane'),
        at: perth('2026-10-29', 10),
        scheduledAt: perth('2026-10-29', 10),
        jobId: jid('j-1'),
        jobNumber: 1,
      },
    ],
  }
  const caughtUp = workOf([
    theirs('j-1', 'p-jane', perth('2026-10-29', 10), {
      jobNumber: 1,
      jobType: 'General Pest Control',
    }),
  ])

  test('is the same work: the phone’s own check counts what refused rows standing named as seen, so Book anyway books on its one press, never showing the job again in more words', () => {
    const source = 'new-job-site-work'
    const save = vi.fn()
    let state = IDLE_SAVE_GUARD
    const guard = createSaveGuard((next) => {
      state = next
    })
    guard.attach()
    let work = workOf([])
    let byRow: ReadonlyMap<string, SheetSends> = new Map()
    // As New Job's check: seen, with what refused rows standing named
    // (`refusedSiteSends`).
    const seenNow = () =>
      withSent(NOTHING_SEEN, standingSends(byRow, guard.refused(), source))
    guard.register(source, () =>
      siteWorkRows(check({ work, seen: seenNow() })).map((row) => ({
        id: row.id,
        kind: 'site' as const,
        label: row.label,
        message: row.message,
      })),
    )
    const press = () =>
      guard.guard({ preventDefault: () => {} }, () => {
        save()
      })
    press()
    expect(save).toHaveBeenCalledTimes(1)
    const rows = refusedSiteRows(refusal, {
      timezone: TZ,
      today: TODAY,
      at: { mode: 'existing', site: { addressLine: '12 Wattle St' } },
      siteOf: () => undefined,
    })
    expect(rows.map((r) => [r.id, r.message])).toEqual([
      ['site:job:j-1', '12 Wattle St has a job on Thu 29 Oct at 10:00am (#1).'],
    ])
    // As the panel draws them (their fixes the sheet's own).
    expect(
      guard.inject(
        source,
        rows.map((r) => ({
          id: r.id,
          kind: 'site' as const,
          label: r.label,
          message: r.message,
        })),
      ),
    ).toBe(true)
    byRow = sendsByRow(byRow, [], source, rows, sendsOf(refusal))
    expect(state.open).toBe(true)

    // The push with #1 lands. The phone's own row for it says more than
    // the server sent, by the same id.
    work = caughtUp
    expect(siteWorkRows(check({ work })).map((r) => [r.id, r.message])).toEqual(
      [
        [
          'site:job:j-1',
          '12 Wattle St has a job on Thu 29 Oct at 10:00am — General Pest Control, Sam Lee (#1).',
        ],
      ],
    )
    // Book anyway: books, on this one press.
    press()
    expect(save).toHaveBeenCalledTimes(2)
    // And what goes back names the job, by its id.
    expect(seenNow().pairs).toEqual([
      {
        propertyId: pid('p-jane'),
        at: perth('2026-10-29', 10),
        jobId: jid('j-1'),
      },
    ])
  })

  test('work the server didn’t name is still news: another job there the copy now holds is shown', () => {
    const seen = withSent(NOTHING_SEEN, sendsOf(refusal))
    const more = workOf([
      ...caughtUp.rows,
      theirs('j-2', 'p-jane', perth('2026-10-31', 14), { jobNumber: 2 }),
    ])
    expect(siteWorkRows(check({ work: more, seen })).map((r) => r.id)).toEqual([
      'site:job:j-2',
    ])
  })
})

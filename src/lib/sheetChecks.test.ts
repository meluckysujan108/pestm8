import { describe, expect, test, vi } from 'vitest'
import { ConvexError } from 'convex/values'
import { convexCode } from '#/components/forms/describeError'
import {
  IDLE_SAVE_GUARD,
  SAVE_CHECK_TIMEOUT_MS,
  createSaveGuard,
  onScreen,
} from '#/components/forms/saveWarningRules'
import type {
  SaveGuardState,
  SaveWarning,
} from '#/components/forms/saveWarningRules'
import {
  FOUND_WHEN_SAVING,
  HOLD_WAIT_MS,
  NOTHING_SENT,
  alreadyListed,
  bookingSheetChecks,
  countsTheRest,
  createHoldWait,
  createPressReads,
  joinSends,
  matchCheckFor,
  namedOnPanel,
  pressChecks,
  resentChecks,
  rowKey,
  seesWholeSchedule,
  sendChecked,
  sendsByRow,
  sendsOf,
  sheetRefusalOf,
  siteCheckFor,
  standingSends,
  withSent,
} from './sheetChecks'
import type { SheetSends } from './sheetChecks'
import {
  NOTHING_SEEN,
  bookAtSees,
  isSeen,
  refusedMatchSees,
  withSeen,
  withSeenAll,
} from './siteWorkRows'
import type { Seen, SiteRow } from './siteWorkRows'
import {
  bookingDismissed,
  newSiteRows,
  ownSiteDismissed,
  ownSiteRows,
  refusedMatchRows,
  refusedOwnSiteRow,
} from './clientMatchRows'
import { NO_OURS, buildMatchIndex } from '../../convex/lib/clientMatch'
import { ALL_CAPABILITIES, jobScope } from '../../convex/lib/capabilities'
import type { MembershipFacts, Role } from '../../convex/lib/capabilities'
import type { Id } from '../../convex/_generated/dataModel'

const client = (id: string) => id as Id<'clients'>
const site = (id: string) => id as Id<'properties'>
const job = (id: string) => id as Id<'jobs'>
const series = (id: string) => id as Id<'recurrences'>

const MATCHED = {
  code: 'MATCHED_CLIENT',
  candidates: [
    {
      clientId: 'c-jane',
      name: 'Jane Nguyen',
      suburb: 'Nightcliff',
      evidence: ['name', 'mobile'],
      auto: false,
    },
  ],
  more: ['c-two', 'c-three'],
}

const BOOKED = {
  code: 'SITE_BOOKED',
  rows: [
    // Someone else's: by its slot alone, no job id (C5).
    { propertyId: 'p-1', at: 1_000, scheduledAt: 1_000 },
    // The person's own visit: its job and its series.
    {
      propertyId: 'p-1',
      at: 2_000,
      scheduledAt: 2_100,
      jobId: 'j-own',
      jobNumber: 12,
      series: 'r-own',
    },
  ],
  more: [{ propertyId: 'p-1', at: 3_000 }],
}

const REPEATS = {
  code: 'SITE_REPEATS',
  series: [{ recurrenceId: 'r-1', propertyId: 'p-1', nextAt: 5_000 }],
  more: ['r-2'],
}

describe('a refusal, read from the server’s own answer (RK16)', () => {
  test('the three codes, each with its details, are refusals the sheet shows', () => {
    for (const data of [MATCHED, BOOKED, REPEATS]) {
      const error = new ConvexError(data)
      expect(sheetRefusalOf(error)).toEqual(data)
    }
  })

  test('a message that only names a code never reads as one', () => {
    for (const code of ['MATCHED_CLIENT', 'SITE_BOOKED', 'SITE_REPEATS']) {
      const error = new Error(
        `[Request ID: 1] Server Error Uncaught Error: ${code} at handler`,
      )
      expect(sheetRefusalOf(error)).toBeNull()
    }
    // A validator quoting an argument that holds one.
    expect(
      sheetRefusalOf(
        new Error(
          'ArgumentValidationError: Value "SITE_BOOKED" does not match',
        ),
      ),
    ).toBeNull()
  })

  test('a code alone, or details in no shape the server sends, has no rows to show: FormAlert says it', () => {
    // FormAlert's words are by its code (`convexCode`).
    expect(convexCode(new ConvexError('MATCHED_CLIENT'))).toBe('MATCHED_CLIENT')
    expect(sheetRefusalOf(new ConvexError('MATCHED_CLIENT'))).toBeNull()
    expect(
      sheetRefusalOf(new ConvexError({ code: 'SITE_BOOKED', rows: [] })),
    ).toBeNull()
    expect(
      sheetRefusalOf(
        new ConvexError({
          code: 'SITE_BOOKED',
          rows: [{ propertyId: 'p-1', at: 'soon', scheduledAt: 1 }],
        }),
      ),
    ).toBeNull()
    expect(sheetRefusalOf(new ConvexError({ code: 'NOT_FOUND' }))).toBeNull()
  })

  test('entries in any other shape are left out, not shown', () => {
    expect(
      sheetRefusalOf(
        new ConvexError({
          code: 'MATCHED_CLIENT',
          candidates: [
            { clientId: 'c-jane', name: 'Jane Nguyen', evidence: ['name'] },
            { clientId: 7, name: 'Not a client' },
          ],
        }),
      ),
    ).toEqual({
      code: 'MATCHED_CLIENT',
      candidates: [
        { clientId: 'c-jane', name: 'Jane Nguyen', evidence: ['name'] },
      ],
    })
  })
})

describe('what the save after a refusal sends back', () => {
  test('MATCHED_CLIENT: every client it named, and every one in `more`, as dismissed (FW17d)', () => {
    const refusal = sheetRefusalOf(new ConvexError(MATCHED))!
    expect(sendsOf(refusal)).toEqual({
      ...NOTHING_SENT,
      dismissed: ['c-jane', 'c-two', 'c-three'],
    })
  })

  test('SITE_BOOKED: each job and visit by site and slot, its job id only where the server sent one, every `more` entry, and a visit’s series', () => {
    const refusal = sheetRefusalOf(new ConvexError(BOOKED))!
    const sends = sendsOf(refusal)
    expect(sends).toEqual({
      dismissed: [],
      seen: [
        { propertyId: 'p-1', at: 1_000 },
        { propertyId: 'p-1', at: 2_000, jobId: 'j-own' },
        { propertyId: 'p-1', at: 3_000 },
      ],
      seenSeries: ['r-own'],
    })
    // No `jobId: undefined` key: the validator is strict.
    expect(Object.keys(sends.seen[0])).toEqual(['propertyId', 'at'])
  })

  test('SITE_REPEATS: every Recurring Job named and in `more`, as seen series', () => {
    const refusal = sheetRefusalOf(new ConvexError(REPEATS))!
    expect(sendsOf(refusal)).toEqual({
      ...NOTHING_SENT,
      seenSeries: ['r-1', 'r-2'],
    })
  })

  test('each once, across refusals', () => {
    const a: SheetSends = {
      dismissed: [client('c-1')],
      seen: [{ propertyId: site('p-1'), at: 1 }],
      seenSeries: [series('r-1')],
    }
    const b: SheetSends = {
      dismissed: [client('c-1'), client('c-2')],
      seen: [
        { propertyId: site('p-1'), at: 1 },
        { propertyId: site('p-1'), at: 1, jobId: job('j-1') },
      ],
      seenSeries: [series('r-1')],
    }
    expect(joinSends(a, b)).toEqual({
      dismissed: ['c-1', 'c-2'],
      seen: [
        { propertyId: 'p-1', at: 1 },
        { propertyId: 'p-1', at: 1, jobId: 'j-1' },
      ],
      seenSeries: ['r-1'],
    })
  })
})

describe('the checks New Job sends (§4.2)', () => {
  const seen = {
    pairs: [{ propertyId: site('p-9'), at: 9 }],
    series: [series('r-9')],
  }
  const sends: SheetSends = {
    dismissed: [client('c-refused')],
    seen: [{ propertyId: site('p-1'), at: 1, jobId: job('j-1') }],
    seenSeries: [series('r-1')],
  }

  test('with a new client: matchCheck by the sheet, every client the matcher returned and every one a refusal named, and siteCheck', () => {
    expect(
      bookingSheetChecks({
        property: {
          newClient: {
            clientName: 'Jane Nguyen',
            addressLine: '12 Wattle St',
            suburb: 'Nightcliff',
            state: 'NT',
            postcode: '0810',
          },
        },
        dismissed: [client('c-phone'), client('c-refused')],
        seen,
        sends,
      }),
    ).toEqual({
      matchCheck: { by: 'sheet', dismissed: ['c-phone', 'c-refused'] },
      siteCheck: {
        seen: [
          { propertyId: 'p-9', at: 9 },
          { propertyId: 'p-1', at: 1, jobId: 'j-1' },
        ],
        seenSeries: ['r-9', 'r-1'],
      },
    })
  })

  test('with a new site for a client: matchCheck too', () => {
    const checks = bookingSheetChecks({
      property: {
        newProperty: {
          clientId: client('c-1'),
          addressLine: '5 X St',
          suburb: 'Darwin',
          state: 'NT',
          postcode: '0800',
        },
      },
      dismissed: [],
      seen: NOTHING_SEEN,
      sends: NOTHING_SENT,
    })
    expect(checks).toEqual({
      matchCheck: { by: 'sheet', dismissed: [] },
      siteCheck: { seen: [], seenSeries: [] },
    })
  })

  test('at an existing site: siteCheck alone, since nothing is made to match', () => {
    const checks = bookingSheetChecks({
      property: { propertyId: site('p-1') },
      dismissed: [client('c-ignored')],
      seen,
      sends: NOTHING_SENT,
    })
    expect(checks).toEqual({
      siteCheck: { seen: [{ propertyId: 'p-9', at: 9 }], seenSeries: ['r-9'] },
    })
    expect('matchCheck' in checks).toBe(false)
  })

  test('matchCheck’s dismissed and siteCheck’s pairs, each once and in the validator’s shape', () => {
    expect(matchCheckFor([client('a'), client('a'), client('b')])).toEqual({
      by: 'sheet',
      dismissed: ['a', 'b'],
    })
    const check = siteCheckFor(
      {
        pairs: [
          { propertyId: site('p'), at: 1, jobId: undefined },
          { propertyId: site('p'), at: 1 },
        ],
        series: [],
      },
      NOTHING_SENT,
    )
    expect(check.seen).toEqual([{ propertyId: 'p', at: 1 }])
    expect(Object.keys(check.seen[0])).toEqual(['propertyId', 'at'])
  })

  test('a refused row’s Book at books past what it named, as the phone’s own fixes do', () => {
    expect(withSent(NOTHING_SEEN, NOTHING_SENT)).toBe(NOTHING_SEEN)
    expect(withSent(seen, sends)).toEqual({
      pairs: [
        { propertyId: 'p-9', at: 9 },
        { propertyId: 'p-1', at: 1, jobId: 'j-1' },
      ],
      series: ['r-9', 'r-1'],
    })
  })
})

describe('whether the server tells the person of every job at a site (`seesWholeSchedule`)', () => {
  const caps = (seeOthers: boolean) =>
    Object.fromEntries(
      ALL_CAPABILITIES.map((c) => [
        c,
        c === 'schedules.seeOthers' && seeOthers,
      ]),
    ) as Record<(typeof ALL_CAPABILITIES)[number], boolean>
  const member = (role: Role): MembershipFacts =>
    ({
      _id: `m-${role}`,
      role,
      parentMembershipId: null,
    }) as unknown as MembershipFacts

  test.each([
    // [who, working in, can see everyone's schedule (as a switch has it)]
    ['owner', null, false],
    ['owner', null, true],
    ['owner', 'subcontractor', false],
    ['owner', 'subcontractor', true],
    ['owner', 'contractor', false],
    ['contractor', null, false],
    ['contractor', null, true],
    ['contractor', 'subcontractor', false],
    ['subcontractor', null, false],
    ['subcontractor', null, true],
  ] as const)(
    '%s in %s’s account, seeOthers %s: as `jobScope` reads it',
    (role, acting, seeOthers) => {
      const server =
        jobScope(caps(seeOthers), member(acting ?? role), []).kind ===
        'business'
      expect(
        seesWholeSchedule({
          role,
          caps: caps(seeOthers),
          actingAs:
            acting === null
              ? null
              : { membershipId: member(acting)._id, name: 'Kevin' },
        }),
      ).toBe(server)
    },
  )
})

describe('a press of Book with its checks (`sendChecked`)', () => {
  type Row = { id: string; message: string }
  const DAY = {
    id: 'site:day:p-1:2026-11-10',
    message: '12 Wattle St has another job booked on Tue 10 Nov.',
  }
  const JANE = {
    id: 'match:c-jane',
    message: 'Jane Nguyen, of Nightcliff, has the same name and mobile.',
  }
  const listedAs = (row: Row, source = 'new-job-site-work') => ({
    ...row,
    source,
  })
  const rowsFor = (refusal: { code: string }) =>
    Promise.resolve({
      source: 'new-job-site-work',
      rows: refusal.code === 'SITE_BOOKED' ? [DAY] : [JANE],
    })

  test('a refusal’s rows are shown, with what it names to send back, and the press ends as the refusal', async () => {
    const error = new ConvexError(BOOKED)
    const send = vi.fn(() => Promise.reject(error))
    const inject = vi.fn()
    await expect(
      sendChecked<string, Row>({
        send,
        rowsOf: rowsFor,
        listed: () => [],
        inject,
      }),
    ).rejects.toBe(error)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(NOTHING_SENT, false)
    expect(inject).toHaveBeenCalledWith(
      'new-job-site-work',
      [DAY],
      sendsOf(sheetRefusalOf(error)!),
      error,
    )
  })

  test('only what is new is shown: a row already listed by this press, in the same words, isn’t said again', async () => {
    const error = new ConvexError(MATCHED)
    const inject = vi.fn()
    const old = { id: 'match:c-old', message: 'Sam Wu has the same email.' }
    await expect(
      sendChecked<string, Row>({
        send: () => Promise.reject(error),
        rowsOf: () =>
          Promise.resolve({
            source: 'new-job-client-match',
            rows: [old, JANE],
          }),
        listed: () => [listedAs(old, 'new-job-client-match')],
        inject,
      }),
    ).rejects.toBe(error)
    expect(inject.mock.calls[0][1]).toEqual([JANE])
  })

  test('a row of an id already listed, in other words, is new: the phone said the address looks like one of theirs, the server that it is one', async () => {
    const error = new ConvexError(MATCHED)
    const inject = vi.fn()
    const send = vi.fn(() => Promise.reject(error))
    const exact = {
      id: 'match:own-site',
      message: 'Jane Nguyen already has 12 Watle St, Bayswater.',
    }
    await expect(
      sendChecked<string, Row>({
        send,
        rowsOf: () =>
          Promise.resolve({ source: 'add-property-own-site', rows: [exact] }),
        listed: () => [
          listedAs(
            {
              id: 'match:own-site',
              message:
                '12 Watle St looks like Jane Nguyen’s 12 Wattle St, Bayswater.',
            },
            'add-property-own-site',
          ),
        ],
        inject,
      }),
    ).rejects.toBe(error)
    expect(send).toHaveBeenCalledTimes(1)
    expect(inject.mock.calls[0][1]).toEqual([exact])
  })

  test('a row of the site’s work of an id already listed, in other words, is shown, never sent again unseen', async () => {
    const error = new ConvexError(BOOKED)
    const send = vi.fn(() => Promise.reject(error))
    const inject = vi.fn()
    const now = {
      id: DAY.id,
      message: '12 Wattle St, Bayswater has another job booked on Tue 10 Nov.',
    }
    await expect(
      sendChecked<string, Row>({
        send,
        rowsOf: () =>
          Promise.resolve({ source: 'new-job-site-work', rows: [now] }),
        listed: () => [listedAs(DAY)],
        inject,
      }),
    ).rejects.toBe(error)
    expect(send).toHaveBeenCalledTimes(1)
    expect(inject.mock.calls[0][1]).toEqual([now])
  })

  test('a client the server found is never sent again by itself, even in words already listed: it names only clients the press didn’t dismiss', async () => {
    const error = new ConvexError(MATCHED)
    const send = vi.fn(() => Promise.reject(error))
    const inject = vi.fn()
    await expect(
      sendChecked<string, Row>({
        send,
        rowsOf: () =>
          Promise.resolve({ source: 'new-job-client-match', rows: [JANE] }),
        listed: () => [listedAs(JANE, 'new-job-client-match')],
        inject,
      }),
    ).rejects.toBe(error)
    expect(send).toHaveBeenCalledTimes(1)
    expect(inject.mock.calls[0][1]).toEqual([JANE])
  })

  test('a refusal naming only what the person has booked past is sent again at once, with it, and books once', async () => {
    const error = new ConvexError(BOOKED)
    const send = vi
      .fn<(extra: SheetSends, again: boolean) => Promise<string>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce('job-1')
    const inject = vi.fn()
    await expect(
      sendChecked<string, Row>({
        send,
        rowsOf: rowsFor,
        // Shown at Book and booked past; the server told it by its other
        // slot after the week turned.
        listed: () => [listedAs(DAY)],
        inject,
      }),
    ).resolves.toBe('job-1')
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1][0]).toEqual(sendsOf(sheetRefusalOf(error)!))
    // The send again is told it is one (New Job's goes straight).
    expect(send.mock.calls.map((call) => call[1])).toEqual([false, true])
    expect(inject).not.toHaveBeenCalled()
  })

  test('a count of the rest that doesn’t say what it counts is new: a second refusal whose only change is its “And N more” is shown, never sent again unseen, and never alone: the rows it is the rest of are said with it', async () => {
    const MORE = {
      id: 'site:more',
      message:
        '5 other jobs or visits are booked at this site within a week of this one.',
    }
    // Shown and booked past: the nearest row and "And 3 more". Another
    // phone books two more there; the server names the same row, and 5.
    const error = new ConvexError({
      code: 'SITE_BOOKED',
      rows: [{ propertyId: 'p-1', at: 1_000, scheduledAt: 1_000 }],
      more: [2, 3, 4, 5, 6].map((at) => ({ propertyId: 'p-1', at })),
    })
    const send = vi.fn(() => Promise.reject(error))
    const inject = vi.fn()
    await expect(
      sendChecked<string, Row>({
        send,
        rowsOf: () =>
          Promise.resolve({ source: 'new-job-site-work', rows: [DAY, MORE] }),
        listed: () => [listedAs(DAY), listedAs(MORE)],
        inject,
      }),
    ).rejects.toBe(error)
    expect(send).toHaveBeenCalledTimes(1)
    // "And 5 more" beside the row it is the rest of, as the phone says it.
    expect(inject.mock.calls[0][1]).toEqual([DAY, MORE])
    for (const id of ['match:more', 'site:more', 'site:more:series']) {
      expect(countsTheRest(id)).toBe(true)
    }
    expect(countsTheRest('site:day:p-1:2026-11-10')).toBe(false)

    // Only the phone's row listed, and the server's count new: the same.
    const alone = vi.fn()
    await expect(
      sendChecked<string, Row>({
        send,
        rowsOf: () =>
          Promise.resolve({ source: 'new-job-site-work', rows: [DAY, MORE] }),
        listed: () => [listedAs(DAY)],
        inject: alone,
      }),
    ).rejects.toBe(error)
    expect(alone.mock.calls[0][1]).toEqual([DAY, MORE])

    // With another row new, that one and the count: what was said stays
    // unsaid.
    const THU = {
      id: 'site:day:p-1:2026-11-12',
      message: '12 Wattle St has another job booked on Thu 12 Nov.',
    }
    const beside = vi.fn()
    await expect(
      sendChecked<string, Row>({
        send,
        rowsOf: () =>
          Promise.resolve({
            source: 'new-job-site-work',
            rows: [DAY, THU, MORE],
          }),
        listed: () => [listedAs(DAY)],
        inject: beside,
      }),
    ).rejects.toBe(error)
    expect(beside.mock.calls[0][1]).toEqual([THU, MORE])
  })

  test('a count of the rest counting only rows listed is no news: someone else’s three visits told again after the week turned are sent again at once, and book; one more than was counted is shown, with the rows it is the rest of', async () => {
    type Counted = Row & { counts?: ReadonlyArray<string> }
    const WED = {
      id: 'site:day:p-1:2026-11-11',
      message: '12 Wattle St has another job booked on Wed 11 Nov.',
    }
    const THU = 'site:day:p-1:2026-11-12'
    const FRI = 'site:day:p-1:2026-11-13'
    const rest = (counts: ReadonlyArray<string>): Counted => ({
      id: 'site:more',
      message:
        counts.length === 1
          ? 'Another job or visit is booked at this site within a week of this one.'
          : `${counts.length} other jobs or visits are booked at this site within a week of this one.`,
      counts,
    })
    // Shown at Book and booked past: Tue, Wed, and "And 1 more" (Thu).
    const listed = () => [
      listedAs(DAY),
      listedAs(WED),
      { ...rest([THU]), source: 'new-job-site-work' },
    ]
    // The week turns before Book anyway: the server tells all three by
    // their other slots, the two rows as before, and Thursday's in `more`.
    const error = new ConvexError({
      code: 'SITE_BOOKED',
      rows: [
        { propertyId: 'p-1', at: 1_007, scheduledAt: 1_000 },
        { propertyId: 'p-1', at: 2_007, scheduledAt: 2_000 },
      ],
      more: [{ propertyId: 'p-1', at: 3_007 }],
    })
    const send = vi
      .fn<(extra: SheetSends, again: boolean) => Promise<string>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce('job-1')
    const hold = vi.fn(() => Promise.resolve(true))
    const inject = vi.fn()
    await expect(
      sendChecked<string, Counted>({
        send,
        rowsOf: () =>
          Promise.resolve({
            source: 'new-job-site-work',
            rows: [DAY, WED, rest([THU])],
          }),
        hold,
        listed,
        inject,
      }),
    ).resolves.toBe('job-1')
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1]).toEqual([sendsOf(sheetRefusalOf(error)!), true])
    expect(inject).not.toHaveBeenCalled()
    expect(hold).not.toHaveBeenCalled()

    // Thursday listed as a row of its own (the phone said it): the same.
    expect(
      alreadyListed(rest([THU]), 'new-job-site-work', [
        listedAs({ id: THU, message: 'Thu' }),
      ]),
    ).toBe(true)
    // Listed by another check, or a count that doesn't say what it counts:
    // new.
    expect(
      alreadyListed(rest([THU]), 'new-job-site-work', [
        { ...rest([THU]), source: 'new-job-client-match' },
      ]),
    ).toBe(false)
    expect(
      alreadyListed(rest([]), 'new-job-site-work', [
        { ...rest([]), source: 'new-job-site-work' },
      ]),
    ).toBe(false)

    // Friday besides, counted by nothing listed: new, and said with the
    // rows it is the rest of.
    const more = vi.fn()
    await expect(
      sendChecked<string, Counted>({
        send: () => Promise.reject(error),
        rowsOf: () => ({
          source: 'new-job-site-work',
          rows: [DAY, WED, rest([THU, FRI])],
        }),
        listed,
        inject: more,
      }),
    ).rejects.toBe(error)
    expect(more.mock.calls[0][1]).toEqual([DAY, WED, rest([THU, FRI])])
  })

  test('what an earlier refusal sent again by itself named stays with rows of its own check: a client found on the send again sends back none of the site’s work, which a change of the day would leave standing with it', async () => {
    const booked = new ConvexError(BOOKED)
    const matched = new ConvexError(MATCHED)
    const send = vi
      .fn<(extra: SheetSends, again: boolean) => Promise<string>>()
      .mockRejectedValueOnce(booked)
      .mockRejectedValueOnce(matched)
    const inject = vi.fn()
    await expect(
      sendChecked<string, Row>({
        send,
        rowsOf: (refusal) =>
          refusal.code === 'MATCHED_CLIENT'
            ? { source: 'new-job-client-match', rows: [JANE] }
            : { source: 'new-job-site-work', rows: [DAY] },
        // The site's work told again in the words shown: sent again.
        listed: () => [listedAs(DAY)],
        inject,
      }),
    ).rejects.toBe(matched)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1][0]).toEqual(sendsOf(sheetRefusalOf(booked)!))
    expect(inject.mock.calls[0][0]).toBe('new-job-client-match')
    expect(inject.mock.calls[0][2]).toEqual(sendsOf(sheetRefusalOf(matched)!))

    // Kept with Jane's row as New Job keeps it; the day changed, the site's
    // own rows go and hers stays: the next press sends her as dismissed,
    // and no work as seen at a date it was never shown for.
    const kept = sendsByRow(
      new Map(),
      [],
      'new-job-client-match',
      [JANE],
      inject.mock.calls[0][2],
    )
    const sends = standingSends(kept, [
      { source: 'new-job-client-match', id: JANE.id },
    ])
    expect(
      bookingSheetChecks({
        property: { newClient: { name: 'Jane Nguyen' } } as never,
        dismissed: [],
        seen: NOTHING_SEEN,
        sends,
      }),
    ).toEqual({
      matchCheck: {
        by: 'sheet',
        dismissed: ['c-jane', 'c-two', 'c-three'],
      },
      siteCheck: { seen: [], seenSeries: [] },
    })
  })

  test('rows the panel won’t take wait for nothing: none read for the form as it is now (another client mode), or turned down (`mayShow`: the check edited since the press), and FormAlert says it at once', async () => {
    const error = new ConvexError(MATCHED)
    const hold = vi.fn(() => Promise.resolve(true))
    const none = vi.fn()
    await expect(
      sendChecked<string, Row>({
        send: () => Promise.reject(error),
        rowsOf: () => ({ source: 'new-job-client-match', rows: [] }),
        hold,
        listed: () => [],
        inject: none,
      }),
    ).rejects.toBe(error)
    expect(hold).not.toHaveBeenCalled()
    expect(none.mock.calls[0][1]).toEqual([])

    const mayShow = vi.fn(() => false)
    const down = vi.fn()
    await expect(
      sendChecked<string, Row>({
        send: () => Promise.reject(error),
        rowsOf: () => ({ source: 'new-job-client-match', rows: [JANE] }),
        hold,
        mayShow,
        listed: () => [],
        inject: down,
      }),
    ).rejects.toBe(error)
    expect(mayShow).toHaveBeenCalledWith('new-job-client-match')
    expect(hold).not.toHaveBeenCalled()

    // Taken: the wait runs, as before.
    await expect(
      sendChecked<string, Row>({
        send: () => Promise.reject(error),
        rowsOf: () => ({ source: 'new-job-client-match', rows: [JANE] }),
        hold,
        mayShow: () => true,
        listed: () => [],
        inject: vi.fn(),
      }),
    ).rejects.toBe(error)
    expect(hold).toHaveBeenCalledTimes(1)
  })

  test('…with the panel’s own gate: the mobile corrected while the booking was out, a client the list doesn’t hold yet doesn’t keep “Booking…” for 3 s', async () => {
    vi.useFakeTimers()
    try {
      const guard = createSaveGuard(() => {})
      guard.attach()
      guard.register('new-job-client-match', () => [])
      let refuse: (error: unknown) => void = () => {}
      const holdWait = createHoldWait()
      const inject = vi.fn((source: string, rows: ReadonlyArray<Row>) =>
        guard.inject(
          source,
          rows.map((row) => ({ ...row, label: 'x' })),
        ),
      )
      let pressed: Promise<unknown> = Promise.resolve()
      guard.guard({ preventDefault: () => {} }, () => {
        pressed = sendChecked<string, Row>({
          send: () =>
            new Promise<string>((_, reject) => {
              refuse = reject
            }),
          rowsOf: () => ({ source: 'new-job-client-match', rows: [JANE] }),
          // Jane isn't on this phone's list yet.
          hold: () => holdWait.until(() => false),
          mayShow: guard.mayInject,
          listed: guard.listed,
          inject,
        })
        return pressed
      })
      const settled = vi.fn()
      pressed.then(settled, settled)
      guard.edited('new-job-client-match')
      refuse(new ConvexError(MATCHED))
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toHaveBeenCalledTimes(1)
      expect(guard.injected()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  test('…and the wait ends as the panel turns the rows down: the mobile corrected 100 ms into “Booking…”, while the list still doesn’t hold Jane Nguyen, ends the press then, not 3 s on; with no edit, the rows wait the 3 s and go on', async () => {
    vi.useFakeTimers()
    try {
      const press = (edit: boolean) => {
        const guard = createSaveGuard(() => {})
        guard.attach()
        guard.register('new-job-client-match', () => [])
        const holdWait = createHoldWait()
        const error = new ConvexError(MATCHED)
        const started = Date.now()
        let pressed: Promise<unknown> = Promise.resolve()
        guard.guard({ preventDefault: () => {} }, () => {
          pressed = sendChecked<string, Row>({
            send: () => Promise.reject(error),
            rowsOf: () => ({ source: 'new-job-client-match', rows: [JANE] }),
            // Jane isn't on this phone's list yet, nor comes on it.
            hold: (_refusal, turnedDown) => holdWait.until(() => turnedDown()),
            mayShow: guard.mayInject,
            listed: guard.listed,
            inject: (source, rows) =>
              guard.inject(
                source,
                rows.map((row) => ({ ...row, label: 'x' })),
              ),
          })
          return pressed
        })
        const ended = { at: -1, error: null as unknown }
        pressed.then(
          () => {},
          (e: unknown) => {
            ended.at = Date.now() - started
            ended.error = e
          },
        )
        if (edit) {
          setTimeout(() => {
            guard.edited('new-job-client-match')
            // The form's commit after the edit (`useEffect(() =>
            // holdWait.poke())`).
            holdWait.poke()
          }, 100)
        }
        return { guard, ended, error }
      }

      const edited = press(true)
      await vi.advanceTimersByTimeAsync(100)
      expect(edited.ended.at).toBe(100)
      expect(edited.ended.error).toBe(edited.error)
      expect(edited.guard.injected()).toEqual([])

      const kept = press(false)
      await vi.advanceTimersByTimeAsync(HOLD_WAIT_MS - 1)
      expect(kept.ended.at).toBe(-1)
      await vi.advanceTimersByTimeAsync(1)
      expect(kept.ended.at).toBe(HOLD_WAIT_MS)
      expect(kept.guard.injected().map((w) => w.id)).toEqual([JANE.id])
    } finally {
      vi.useRealTimers()
    }
  })

  test('the wait is told whether the panel would turn the rows down now, asked as it runs, not once (`turnedDown`)', async () => {
    const error = new ConvexError(MATCHED)
    let takes = true
    const told: { turnedDown?: () => boolean; answer?: () => void } = {}
    const pressed = sendChecked<string, Row>({
      send: () => Promise.reject(error),
      rowsOf: () => ({ source: 'new-job-client-match', rows: [JANE] }),
      hold: (_refusal, turnedDown) => {
        told.turnedDown = turnedDown
        return new Promise<void>((resolve) => (told.answer = resolve))
      },
      mayShow: (source) => source === 'new-job-client-match' && takes,
      listed: () => [],
      inject: vi.fn(),
    })
    await vi.waitFor(() => expect(told.turnedDown).toBeDefined())
    expect(told.turnedDown?.()).toBe(false)
    takes = false
    expect(told.turnedDown?.()).toBe(true)
    told.answer?.()
    await expect(pressed).rejects.toBe(error)
  })

  test('a refusal sent again by itself waits for nothing: the wait for what fixes need (`hold`) is only for rows to be shown', async () => {
    const error = new ConvexError(BOOKED)
    const send = vi
      .fn<(extra: SheetSends, again: boolean) => Promise<string>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce('job-1')
    // The list doesn't hold the site: a wait would run its 3 s.
    const hold = vi.fn(() => new Promise<boolean>(() => {}))
    const inject = vi.fn()
    await expect(
      sendChecked<string, Row>({
        send,
        rowsOf: rowsFor,
        hold,
        listed: () => [listedAs(DAY)],
        inject,
      }),
    ).resolves.toBe('job-1')
    expect(hold).not.toHaveBeenCalled()
    expect(inject).not.toHaveBeenCalled()
  })

  test('rows to be shown wait for the hold, and are read again once it answers: Book at comes in with the site held', async () => {
    type Fixed = Row & { fix?: string }
    const error = new ConvexError(BOOKED)
    let held = false
    let answer: (held: boolean) => void = () => {}
    const hold = vi.fn(
      () => new Promise<boolean>((resolve) => (answer = resolve)),
    )
    const inject = vi.fn()
    const pressed = sendChecked<string, Fixed>({
      send: () => Promise.reject(error),
      rowsOf: () => ({
        source: 'new-job-site-work',
        rows: [held ? { ...DAY, fix: 'Book at 12 Wattle St' } : DAY],
      }),
      hold,
      listed: () => [],
      inject,
    })
    await vi.waitFor(() => expect(hold).toHaveBeenCalledTimes(1))
    expect(inject).not.toHaveBeenCalled()
    held = true
    answer(true)
    await expect(pressed).rejects.toBe(error)
    expect(inject.mock.calls[0][1]).toEqual([
      { ...DAY, fix: 'Book at 12 Wattle St' },
    ])

    // Held already: read once more, and shown at once.
    const once = vi.fn()
    await expect(
      sendChecked<string, Row>({
        send: () => Promise.reject(error),
        rowsOf: rowsFor,
        hold: () => Promise.resolve(true),
        listed: () => [],
        inject: once,
      }),
    ).rejects.toBe(error)
    expect(once.mock.calls[0][1]).toEqual([DAY])
  })

  test('never a loop: refused again with nothing new, the rows are shown after all', async () => {
    const error = new ConvexError(BOOKED)
    const send = vi.fn(() => Promise.reject(error))
    const inject = vi.fn()
    await expect(
      sendChecked<string, Row>({
        send,
        rowsOf: rowsFor,
        listed: () => [listedAs(DAY)],
        inject,
      }),
    ).rejects.toBe(error)
    expect(send).toHaveBeenCalledTimes(2)
    expect(inject).toHaveBeenCalledTimes(1)
    expect(inject.mock.calls[0][1]).toEqual([DAY])
  })

  test('the second send carries what the first refusal named, joined with the next', async () => {
    const first = new ConvexError(BOOKED)
    const second = new ConvexError(REPEATS)
    const send = vi
      .fn<(extra: SheetSends, again: boolean) => Promise<string>>()
      .mockRejectedValueOnce(first)
      .mockRejectedValueOnce(second)
    const inject = vi.fn()
    await expect(
      sendChecked<string, Row>({
        send,
        rowsOf: (refusal) =>
          Promise.resolve({
            source: 'new-job-site-work',
            rows:
              refusal.code === 'SITE_BOOKED'
                ? [DAY]
                : [
                    {
                      id: 'site:series:r-1',
                      message: '12 Wattle St already has a Recurring Job.',
                    },
                  ],
          }),
        listed: () => [listedAs(DAY)],
        inject,
      }),
    ).rejects.toBe(second)
    expect(inject.mock.calls[0][2]).toEqual(
      joinSends(
        sendsOf(sheetRefusalOf(first)!),
        sendsOf(sheetRefusalOf(second)!),
      ),
    )
  })

  test('not sent again by itself once the form was edited since the press (`asPressed`): the rows are shown, or FormAlert says it', async () => {
    const error = new ConvexError(BOOKED)
    const send = vi.fn(() => Promise.reject(error))
    const inject = vi.fn()
    await expect(
      sendChecked<string, Row>({
        send,
        rowsOf: rowsFor,
        // Shown and booked past, but the person typed while it was out.
        listed: () => [listedAs(DAY)],
        inject,
        asPressed: () => false,
      }),
    ).rejects.toBe(error)
    expect(send).toHaveBeenCalledTimes(1)
    expect(inject).toHaveBeenCalledTimes(1)
    expect(inject.mock.calls[0][1]).toEqual([DAY])
  })

  test('a send again carries what the send refused carried and what the refusal named, never the form read again (`pressChecks`)', async () => {
    // The press: Tom Lee new, the phone's rows at 12 Wattle St shown and
    // booked past.
    const pressed = {
      matchCheck: matchCheckFor([client('c-ray')]),
      siteCheck: {
        seen: [{ propertyId: site('p-1'), at: 1_000 }],
        seenSeries: [],
      },
    }
    // While it was out, Tom Lee reached the phone's list from another
    // phone, never shown: read afresh, he would go as dismissed.
    let form = pressed
    const read = vi.fn((extra: SheetSends) => {
      void extra
      return form
    })
    const checks = pressChecks(read)
    const error = new ConvexError(BOOKED)
    const book = vi
      .fn<(c: ReturnType<typeof checks>) => Promise<string>>()
      .mockImplementationOnce(() => {
        form = {
          ...pressed,
          matchCheck: matchCheckFor([client('c-ray'), client('c-tomlee')]),
        }
        return Promise.reject(error)
      })
      .mockResolvedValueOnce('job-1')
    await expect(
      sendChecked<string, Row>({
        send: (extra, again) => book(checks(extra, again)),
        rowsOf: rowsFor,
        listed: () => [listedAs(DAY)],
        inject: vi.fn(),
        asPressed: () => true,
      }),
    ).resolves.toBe('job-1')
    expect(read).toHaveBeenCalledTimes(1)
    expect(book.mock.calls[1][0]).toEqual(
      resentChecks(pressed, sendsOf(sheetRefusalOf(error)!)),
    )
    expect(book.mock.calls[1][0].matchCheck).toEqual(
      matchCheckFor([client('c-ray')]),
    )
    expect(book.mock.calls[1][0].siteCheck).toEqual({
      seen: [
        { propertyId: site('p-1'), at: 1_000 },
        { propertyId: site('p-1'), at: 2_000, jobId: job('j-own') },
        { propertyId: site('p-1'), at: 3_000 },
      ],
      seenSeries: [series('r-own')],
    })
    // A press of its own reads the form afresh.
    checks(NOTHING_SENT, false)
    expect(read).toHaveBeenCalledTimes(2)
  })

  test('what a send again carries: each once, in the validator’s shape, and no check the send refused didn’t carry', () => {
    const extra = joinSends(sendsOf(sheetRefusalOf(new ConvexError(BOOKED))!))
    const atSite = resentChecks(
      {
        siteCheck: {
          seen: [{ propertyId: site('p-1'), at: 1_000 }],
          seenSeries: [series('r-own')],
        },
      },
      extra,
    )
    expect(atSite).not.toHaveProperty('matchCheck')
    expect(atSite.siteCheck?.seenSeries).toEqual([series('r-own')])
    expect(atSite.siteCheck?.seen).toHaveLength(3)
    expect(
      resentChecks(
        { matchCheck: matchCheckFor([client('c-jane')]) },
        { ...NOTHING_SENT, dismissed: [client('c-jane'), client('c-two')] },
      ),
    ).toEqual({
      matchCheck: matchCheckFor([client('c-jane'), client('c-two')]),
    })
  })

  test('anything else is thrown as it came, with nothing shown', async () => {
    for (const error of [
      new ConvexError('NOT_FOUND'),
      new Error('Uncaught Error: SITE_BOOKED'),
      new ConvexError('MATCHED_CLIENT'),
    ]) {
      const inject = vi.fn()
      const rowsOf = vi.fn(rowsFor)
      await expect(
        sendChecked<string, Row>({
          send: () => Promise.reject(error),
          rowsOf,
          listed: () => [],
          inject,
        }),
      ).rejects.toBe(error)
      expect(rowsOf).not.toHaveBeenCalled()
      expect(inject).not.toHaveBeenCalled()
    }
  })
})

describe('a site only like theirs on the phone, theirs exactly on the server', () => {
  // Jane's sheet holds 12 Wattle St. Another phone has just added
  // 12 Watle St to her, which this phone doesn't hold yet; 12 Watle St is
  // typed, and the phone's row says it looks like 12 Wattle St.
  const index = buildMatchIndex(
    {
      clients: [
        {
          _id: client('c-jane'),
          name: 'Jane Nguyen',
          kind: 'person',
          status: 'active',
        },
      ],
      sites: [
        {
          _id: site('p-jane'),
          clientId: client('c-jane'),
          addressLine: '12 Wattle St',
          suburb: 'Bayswater',
          postcode: '6053',
        },
      ],
      contacts: [],
      complete: true,
    } as unknown as Parameters<typeof buildMatchIndex>[0],
    { areaCode: '08', ours: NO_OURS },
  )
  const typed = {
    addressLine: '12 Watle St',
    suburb: 'Bayswater',
    postcode: '6053',
  }
  const refusal = new ConvexError({
    code: 'MATCHED_CLIENT',
    candidates: [
      {
        clientId: 'c-jane',
        name: 'Jane Nguyen',
        propertyId: 'p-new',
        evidence: ['site'],
        auto: false,
      },
    ],
  })
  /** Book anyway (Save anyway) past the phone's row: the refusal, then
   * whatever the press after it would send. */
  async function press(at: {
    source: string
    phoneRows: ReadonlyArray<{ id: string; message: string }>
    dismissed: ReadonlyArray<Id<'clients'>>
    rows: (r: NonNullable<ReturnType<typeof sheetRefusalOf>>) => ReadonlyArray<{
      id: string
      message: string
    }>
  }) {
    const sent: Array<ReadonlyArray<Id<'clients'>>> = []
    const inject = vi.fn()
    const outcome = await sendChecked({
      send: (extra) => {
        sent.push([...at.dismissed, ...extra.dismissed])
        return sent.length === 1
          ? Promise.reject(refusal)
          : Promise.resolve('made')
      },
      rowsOf: (r) => Promise.resolve({ source: at.source, rows: at.rows(r) }),
      listed: () => at.phoneRows.map((row) => ({ ...row, source: at.source })),
      inject,
    }).catch((error: unknown) => error)
    return { outcome, sent, inject }
  }

  test('New Job’s New site for: the server’s row is shown, and nothing made', async () => {
    const ctx = { index, contacts: [], verb: 'book' as const }
    const phoneRows = newSiteRows(ctx, client('c-jane'), typed)
    expect(phoneRows.map((row) => row.message)).toEqual([
      '12 Watle St looks like Jane Nguyen’s 12 Wattle St, Bayswater.',
    ])
    const at = {
      mode: 'site' as const,
      clientId: client('c-jane'),
      site: typed,
    }
    // Only like hers: the server's exact check stays on.
    expect(bookingDismissed(ctx, { ...at, added: null })).toEqual([])
    const { outcome, sent, inject } = await press({
      source: 'new-job-client-match',
      phoneRows,
      dismissed: bookingDismissed(ctx, { ...at, added: null }),
      rows: (r) =>
        r.code === 'MATCHED_CLIENT' ? refusedMatchRows(ctx, r, at) : [],
    })
    expect(outcome).toBe(refusal)
    expect(sent).toEqual([[]])
    expect(inject).toHaveBeenCalledTimes(1)
    expect(inject.mock.calls[0][1]).toEqual([
      expect.objectContaining({
        id: 'match:c-jane',
        message:
          'Jane Nguyen already has 12 Watle St, Bayswater. Open Jane Nguyen from Clients to book this job.',
      }),
    ])
  })

  test('Add property on Jane’s sheet: the same', async () => {
    const sites = [
      {
        _id: site('p-jane'),
        addressLine: '12 Wattle St',
        suburb: 'Bayswater',
        postcode: '6053',
      },
    ]
    const phoneRows = ownSiteRows('Jane Nguyen', sites, typed)
    expect(phoneRows.map((row) => row.message)).toEqual([
      '12 Watle St looks like Jane Nguyen’s 12 Wattle St, Bayswater.',
    ])
    expect(ownSiteDismissed(client('c-jane'), sites, typed)).toEqual([])
    const { outcome, sent, inject } = await press({
      source: 'add-property-own-site',
      phoneRows,
      dismissed: ownSiteDismissed(client('c-jane'), sites, typed),
      rows: (r) =>
        r.code === 'MATCHED_CLIENT'
          ? [refusedOwnSiteRow('Jane Nguyen', sites, r, typed)]
          : [],
    })
    expect(outcome).toBe(refusal)
    expect(sent).toEqual([[]])
    expect(inject.mock.calls[0][1]).toEqual([
      expect.objectContaining({
        id: 'match:own-site',
        message: 'Jane Nguyen already has 12 Watle St, Bayswater.',
      }),
    ])
  })
})

describe('what rows a refusal put on the panel send back', () => {
  const day = { source: 'new-job-site-work', id: 'site:day:p-1:2026-11-10' }
  const more = { source: 'new-job-site-work', id: 'site:more' }
  const jane = { source: 'new-job-client-match', id: 'match:c-jane' }
  const first: SheetSends = {
    ...NOTHING_SENT,
    seen: [{ propertyId: site('p-1'), at: 1 }],
  }
  const second: SheetSends = {
    ...NOTHING_SENT,
    seen: [{ propertyId: site('p-1'), at: 2 }],
  }

  test('only those still standing, of one check or every one', () => {
    const byRow = new Map([
      [rowKey(day), first],
      [rowKey(jane), { ...NOTHING_SENT, dismissed: [client('c-jane')] }],
    ])
    expect(standingSends(byRow, [day, jane])).toEqual({
      dismissed: ['c-jane'],
      seen: [{ propertyId: 'p-1', at: 1 }],
      seenSeries: [],
    })
    expect(standingSends(byRow, [day, jane], 'new-job-site-work')).toEqual(
      first,
    )
    // Taken off the panel (a fix, an edit): it sends nothing more.
    expect(standingSends(byRow, [jane], 'new-job-site-work')).toEqual(
      NOTHING_SENT,
    )
  })

  test('a row put back in the place of one of its id still standing keeps what that one sent: a second refusal’s “And N more” still books past the first’s', () => {
    const once = sendsByRow(new Map(), [], more.source, [day, more], first)
    const twice = sendsByRow(once, [day, more], more.source, [more], second)
    expect(standingSends(twice, [day, more])).toEqual(joinSends(first, second))
    // The first's row gone by then: its key goes with it.
    const after = sendsByRow(once, [more], more.source, [more], second)
    expect(after.has(rowKey(day))).toBe(false)
    expect(after.get(rowKey(more))).toEqual(joinSends(first, second))
  })

  test('the work match rows named is sent as seen only for rows the panel says in the phone’s own words', () => {
    // FW13: the phone's match row for Jane names her Thu job. A refusal's
    // row for Jane stands in its place, and says none of it.
    const thu = { propertyId: site('p-jane'), at: 29 }
    const named = new Map([
      ['match:c-jane', [thu]],
      ['match:c-tom', [{ propertyId: site('p-tom'), at: 30 }]],
    ])
    expect(namedOnPanel(named, [], 'new-job-client-match')).toEqual([
      thu,
      { propertyId: 'p-tom', at: 30 },
    ])
    expect(namedOnPanel(named, [jane], 'new-job-client-match')).toEqual([
      { propertyId: 'p-tom', at: 30 },
    ])
    // Another check's row of the same id is no match row's.
    expect(
      namedOnPanel(
        named,
        [{ source: 'new-job-site-work', id: 'match:c-jane' }],
        'new-job-client-match',
      ),
    ).toEqual([thu, { propertyId: 'p-tom', at: 30 }])
  })
})

describe('a fix waits for the live list to hold what it books at', () => {
  test('answers at once when it already does', async () => {
    await expect(createHoldWait().until(() => true)).resolves.toBe(true)
  })

  test('answers as soon as an answer pushed holds it', async () => {
    vi.useFakeTimers()
    try {
      const wait = createHoldWait()
      let held = false
      const answer = wait.until(() => held)
      vi.advanceTimersByTime(1_000)
      held = true
      wait.poke()
      await expect(answer).resolves.toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  test('gives up after 3 s, and the row goes without the fix', async () => {
    vi.useFakeTimers()
    try {
      const wait = createHoldWait()
      const answer = wait.until(() => false)
      wait.poke()
      vi.advanceTimersByTime(HOLD_WAIT_MS)
      await expect(answer).resolves.toBe(false)
      expect(HOLD_WAIT_MS).toBe(3_000)
    } finally {
      vi.useRealTimers()
    }
  })
})

test('the note the panel ends with while a refusal’s rows show', () => {
  expect(FOUND_WHEN_SAVING).toBe('PestM8 found this when saving.')
})

describe('what a save sends is what its press’s checks found (`createPressReads`)', () => {
  test('a note goes to the press that began it: a later press starts afresh, an earlier one’s late answer goes nowhere, and a check that ran out of time found nothing', () => {
    const reads = createPressReads<{ dismissed: Array<string>; seen: number }>()
    expect(reads.last()).toEqual({})
    const first = new AbortController()
    // Two checks of one press share its signal, and its record.
    const a = reads.begin(first.signal)
    const b = reads.begin(first.signal)
    a('dismissed', ['c-jane'])
    b('seen', 2)
    expect(reads.last()).toEqual({ dismissed: ['c-jane'], seen: 2 })
    const second = new AbortController()
    const c = reads.begin(second.signal)
    expect(reads.last()).toEqual({})
    // The first press's slower check, answering late.
    a('dismissed', ['c-old'])
    expect(reads.last()).toEqual({})
    second.abort()
    c('dismissed', ['c-mei'])
    expect(reads.last()).toEqual({})
  })

  test('a press the guard dropped (the client mode switched while it waited for the week’s work), answering after a later press began, puts nothing in what the later one showed: a refused row’s fix books past only that', async () => {
    const reads = createPressReads<{ shown: ReadonlyArray<string> }>()
    let form: 'existing' | 'new' = 'existing'
    let listHolds = false
    let workCame: () => void = () => {}
    const work = new Promise<void>((resolve) => {
      workCame = resolve
    })
    // As New Job's site check: what it shows read from the form as it is
    // when it answers, noted with its press, and put where the panel's
    // foot reads it (`siteShown`), by every answer however late.
    const shownNow = () =>
      form === 'new' && listHolds ? ['site:series:r-1'] : []
    let foot: ReadonlyArray<string> = []
    let checking = false
    const guard = createSaveGuard((state) => {
      checking = state.checking
    })
    guard.attach()
    guard.register('new-job-site-work', (signal) => {
      const note = reads.begin(signal)
      const answer = () => {
        note('shown', shownNow())
        foot = shownNow()
        return []
      }
      return form === 'existing' ? work.then(answer) : answer()
    })
    // The first press waits for the week's work ("Checking…").
    guard.guard({ preventDefault: () => {} }, () => {})
    expect(checking).toBe(true)
    // New client: the press is dropped, and the next one shows nothing.
    guard.reset()
    form = 'new'
    let saved = false
    guard.guard({ preventDefault: () => {} }, () => {
      // As the booking goes (`sheetChecksFor`).
      reads.sending()
      saved = true
    })
    expect(saved).toBe(true)
    expect(reads.last()).toEqual({ shown: [] })
    // A site at the address lands, and the week's work: the first press
    // answers, for the form as it is now.
    listHolds = true
    workCame()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(foot).toEqual(['site:series:r-1'])
    expect(reads.last()).toEqual({ shown: [] })
    // What the fix reads (`pressShown`): the press whose booking went,
    // never the one dropped, which never sends.
    expect(reads.sent()).toEqual({ shown: [] })
  })

  // Clients → New client, the office having just added Mei Chen on another
  // phone, this phone's list a moment behind it.
  const mei = buildMatchIndex(
    {
      clients: [
        {
          _id: client('c-mei'),
          name: 'Mei Chen',
          kind: 'person',
          status: 'active',
          contactKeys: { mobile: ['61491570177'] },
        },
      ],
      sites: [],
      contacts: [],
      complete: true,
    } as unknown as Parameters<typeof buildMatchIndex>[0],
    { areaCode: '08', ours: NO_OURS },
  )
  const nobody = buildMatchIndex(
    { clients: [], sites: [], contacts: [], complete: true },
    { areaCode: '08', ours: NO_OURS },
  )
  const typed = {
    name: 'Mei Chen',
    phone: '0491 570 177',
    email: 'mei@chenfamily.net.au',
    site: { addressLine: '3 Hay St', suburb: 'Subiaco', postcode: '6008' },
  }

  test('a client the list takes in while a slower check is still looking (an email’s domain) was never shown: the save doesn’t send them as booked past, and the server names them', async () => {
    expect(bookingDismissed({ index: mei }, { mode: 'new', typed })).toEqual([
      client('c-mei'),
    ])
    const reads = createPressReads<{
      dismissed: ReadonlyArray<Id<'clients'>>
    }>()
    let index = nobody
    let domainAnswer: (found: Array<never>) => void = () => {}
    const guard = createSaveGuard(() => {})
    guard.attach()
    guard.register('new-client-match', (signal) => {
      reads.begin(signal)(
        'dismissed',
        bookingDismissed({ index }, { mode: 'new', typed }),
      )
      return []
    })
    guard.register(
      'email',
      () =>
        new Promise<Array<never>>((resolve) => {
          domainAnswer = resolve
        }),
    )
    const sent: Array<ReadonlyArray<Id<'clients'>>> = []
    guard.guard({ preventDefault: () => {} }, () => {
      sent.push(matchCheckFor(reads.last().dismissed ?? []).dismissed)
    })
    // The push with Mei lands while the domain is still looked up.
    index = mei
    domainAnswer([])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sent).toEqual([[]])
    // Read again as it goes, it would have been Mei, never shown.
    expect(bookingDismissed({ index }, { mode: 'new', typed })).toEqual([
      client('c-mei'),
    ])
  })

  test('a check that ran out of time found nothing, though the list came a moment after: nothing is sent as booked past', async () => {
    vi.useFakeTimers()
    try {
      const reads = createPressReads<{
        dismissed: ReadonlyArray<Id<'clients'>>
      }>()
      let listCame: () => void = () => {}
      const guard = createSaveGuard(() => {})
      guard.attach()
      guard.register('new-client-match', (signal) => {
        const note = reads.begin(signal)
        return new Promise<Array<never>>((resolve) => {
          listCame = () => {
            note(
              'dismissed',
              bookingDismissed({ index: mei }, { mode: 'new', typed }),
            )
            resolve([])
          }
        })
      })
      const sent: Array<ReadonlyArray<Id<'clients'>>> = []
      guard.guard({ preventDefault: () => {} }, () => {
        sent.push(matchCheckFor(reads.last().dismissed ?? []).dismissed)
      })
      vi.advanceTimersByTime(SAVE_CHECK_TIMEOUT_MS)
      // The list's answer, a frame late.
      listCame()
      await vi.runAllTimersAsync()
      expect(sent).toEqual([[]])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a refused row’s fix books past what the press refused showed: the record of the press whose booking went (`sent`)', () => {
  test('`sending()` keeps the newest press’s record as its save goes; a later press begun, still checking, leaves `sent()` the one that went; none gone yet, or its check out of time, and a fix books past nothing', () => {
    const reads = createPressReads<{ shown: ReadonlyArray<string> }>()
    expect(reads.sent()).toBeNull()
    const first = new AbortController()
    reads.begin(first.signal)('shown', [])
    // Begun, its booking not gone: still nothing.
    expect(reads.sent()).toBeNull()
    expect(reads.sending()).toEqual({ shown: [] })
    const second = new AbortController()
    reads.begin(second.signal)('shown', ['site:series:r-1'])
    expect(reads.last()).toEqual({ shown: ['site:series:r-1'] })
    expect(reads.sent()).toEqual({ shown: [] })
    expect(reads.sending()).toEqual({ shown: ['site:series:r-1'] })
    expect(reads.sent()).toEqual({ shown: ['site:series:r-1'] })
    // A press whose site check ran out of time: its booking goes with
    // nothing of what it would have shown, and its late answer goes
    // nowhere, so `pressShown` is null.
    const third = new AbortController()
    const late = reads.begin(third.signal)
    third.abort()
    expect(reads.sending()).toEqual({})
    late('shown', ['site:day:p-x:5000'])
    expect(reads.sent()).toEqual({})
  })

  // New Job at 12 Wattle St, on one bar of signal: the site check answers
  // at once from the phone's copy, noting what it showed with its press
  // (`siteWarnings`), and an email's domain is looked up ("Checking…").
  const X = site('p-x')
  const repeats: SiteRow = {
    id: 'site:series:r-1',
    label: 'Already repeats',
    message: '12 Wattle St already repeats every 3 months.',
    shows: { rows: [], series: [series('r-1')] },
    propertyId: X,
  }
  const friday: SiteRow = {
    id: 'site:day:p-x:5000',
    label: 'Already booked',
    message: '12 Wattle St has another job booked on Fri 31 Oct.',
    shows: {
      rows: [{ propertyId: X, at: 5_000, scheduledAt: 5_000 }],
      series: [],
    },
    propertyId: X,
  }
  const unseenBy = (seen: Seen) => (row: SiteRow) =>
    row.shows.rows.some((r) => !isSeen(r, seen)) ||
    row.shows.series.some((id) => !seen.series.includes(id))

  function bookingSheet(work: () => ReadonlyArray<SiteRow>) {
    const reads = createPressReads<{
      site: Seen
      shown: { rows: ReadonlyArray<SiteRow> }
    }>()
    let seen: Seen = NOTHING_SEEN
    let state: SaveGuardState = IDLE_SAVE_GUARD
    const drawn = new Set<string>()
    const guard = createSaveGuard((next) => {
      state = next
      for (const w of onScreen(next)) drawn.add(w.id)
    })
    guard.attach()
    guard.register('new-job-site-work', (signal) => {
      const note = reads.begin(signal)
      const rows = work().filter(unseenBy(seen))
      note('site', withSeenAll(seen, rows))
      note('shown', { rows })
      return rows.map((row): SaveWarning => ({
        id: row.id,
        kind: 'site',
        label: row.label,
        message: row.message,
      }))
    })
    let domain: ((found: Array<SaveWarning>) => void) | null = null
    guard.register('new-job-client-email', () =>
      domain === null
        ? []
        : new Promise<Array<SaveWarning>>((resolve) => {
            domain = resolve
          }),
    )
    // Each booking: what it sends as booked past (`sheetChecksFor`), and
    // which rows had been on screen by then.
    const sends: Array<{
      check: ReturnType<typeof siteCheckFor>
      drawn: ReadonlySet<string>
    }> = []
    const book = () => {
      sends.push({
        check: siteCheckFor(reads.sending().site ?? seen, NOTHING_SENT),
        drawn: new Set(drawn),
      })
    }
    return {
      sends,
      drawn,
      state: () => state,
      seen: () => seen,
      // As `pressShown`: the record of the press whose booking went.
      shown: () => reads.sent()?.shown ?? null,
      seeAlso: (next: Seen) => {
        seen = next
      },
      press: (slow = false) => {
        domain = slow ? () => {} : null
        guard.guard({ preventDefault: () => {} }, book)
      },
      domainAnswers: async () => {
        const answer = domain
        domain = null
        answer?.([])
        await new Promise((resolve) => setTimeout(resolve, 0))
      },
      refused: (source: string, row: SaveWarning) => {
        expect(guard.inject(source, [row])).toBe(true)
      },
      tap: (source: string) => {
        const row = onScreen(state).find((w) => w.source === source)
        expect(row?.fix).toBeDefined()
        guard.fix(row!, (change) => change())
      },
    }
  }

  test('Book on Jane Nguyen tapped while Book anyway is still “Checking…” books past nothing the panel never showed: Jane Nguyen’s Recurring Job at the site is shown before a booking goes past it', async () => {
    let listHoldsX = false
    const sheet = bookingSheet(() => (listHoldsX ? [repeats] : []))
    // The phone doesn't hold Jane Nguyen's site yet: nothing found, and the
    // booking goes; refused MATCHED_CLIENT. The list catches up.
    sheet.press()
    expect(sheet.sends).toHaveLength(1)
    listHoldsX = true
    const row = {
      fix: {
        kind: 'bookAt' as const,
        label: 'Book on Jane Nguyen',
        clientId: client('c-jane'),
        propertyId: X,
      },
    }
    sheet.refused('new-job-client-match', {
      id: 'match:c-jane',
      kind: 'match',
      label: 'Already a client',
      message: 'Jane Nguyen already has 12 Wattle St.',
      fix: {
        label: row.fix.label,
        // As `refusedMatchFix`.
        apply: () => {
          const shown = sheet.shown()
          const sees = shown && refusedMatchSees(row, shown.rows, new Map())
          sheet.seeAlso(sees ? withSeen(sheet.seen(), sees) : sheet.seen())
        },
      },
    })
    // Book anyway: the site check now finds the Recurring Job at once, and
    // the email's domain keeps the press "Checking…", the refused row
    // alone on screen, its fix tapped meanwhile.
    sheet.press(true)
    expect(sheet.state().checking).toBe(true)
    expect(onScreen(sheet.state()).map((w) => w.id)).toEqual(['match:c-jane'])
    sheet.tap('new-job-client-match')
    expect(sheet.seen()).toEqual(NOTHING_SEEN)
    // The domain answers: the fix was an edit, so the press looks again,
    // and shows the Recurring Job rather than booking past it.
    await sheet.domainAnswers()
    expect(sheet.sends).toHaveLength(1)
    expect(onScreen(sheet.state()).map((w) => w.id)).toEqual([repeats.id])
    // Book anyway past it, shown.
    sheet.press()
    expect(sheet.sends).toHaveLength(2)
    expect(sheet.sends[1].check.seenSeries).toEqual([series('r-1')])
    expect(sheet.sends[1].drawn.has(repeats.id)).toBe(true)
  })

  test('Book at 12 Wattle St on a refused row, tapped while Book anyway is still “Checking…”, books past nothing the panel never showed: a visit the phone took in at the site since is shown before a booking goes past it', async () => {
    let fridayIn = false
    const sheet = bookingSheet(() => (fridayIn ? [friday] : []))
    const tuesday = { propertyId: X, at: 1_000 }
    // Nothing on the phone: the booking goes; refused SITE_BOOKED for
    // another member's Tue job.
    sheet.press()
    expect(sheet.sends).toHaveLength(1)
    sheet.refused('new-job-site-work', {
      id: 'site:day:p-x:1000',
      kind: 'site',
      label: 'Already booked',
      message: '12 Wattle St has another job booked on Tue 28 Oct.',
      fix: {
        label: 'Book at 12 Wattle St',
        // As `refusedSiteFix`: what the refused rows standing named, and
        // what the press refused showed.
        apply: () => {
          const refusedThere = { ...NOTHING_SENT, seen: [tuesday] }
          const shown = sheet.shown()
          sheet.seeAlso(
            withSent(
              shown
                ? withSeenAll(
                    sheet.seen(),
                    bookAtSees(X, shown.rows, new Map()),
                  )
                : sheet.seen(),
              refusedThere,
            ),
          )
        },
      },
    })
    // Another member books Fri there, and the phone's copy takes it in.
    fridayIn = true
    sheet.press(true)
    expect(sheet.state().checking).toBe(true)
    expect(onScreen(sheet.state()).map((w) => w.id)).toEqual([
      'site:day:p-x:1000',
    ])
    sheet.tap('new-job-site-work')
    expect(sheet.seen()).toEqual({ pairs: [tuesday], series: [] })
    await sheet.domainAnswers()
    expect(sheet.sends).toHaveLength(1)
    expect(onScreen(sheet.state()).map((w) => w.id)).toEqual([friday.id])
    sheet.press()
    expect(sheet.sends).toHaveLength(2)
    expect(sheet.sends[1].check.seen).toContainEqual({
      propertyId: X,
      at: 5_000,
    })
    expect(sheet.sends[1].drawn.has(friday.id)).toBe(true)
  })
})

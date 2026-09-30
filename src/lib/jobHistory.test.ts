import { describe, expect, it } from 'vitest'
import {
  historyCard,
  nextVisit,
  pastVisits,
  reportsByVisit,
  sameService,
} from './jobHistory'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 8, 30, 4) // 30 Sept 2026, midday in Perth
const TODAY = Date.UTC(2026, 8, 29, 16) // its midnight in Perth

function visit(
  _id: string,
  daysFromNow: number,
  status: string,
  jobType = 'General Pest Control',
  recurrenceId?: string,
) {
  return {
    _id,
    scheduledAt: NOW + daysFromNow * DAY,
    status,
    jobType,
    ...(recurrenceId !== undefined && { recurrenceId }),
  }
}

const THIS = visit('this', 0.5, 'booked', 'General Pest Control', 'rec_gpc')

describe('pastVisits', () => {
  it('keeps what is past, newest first, whatever order the query sent', () => {
    // As `properties.jobHistory` sends them: by creation, the projections
    // (made last) first.
    const visits = [
      visit('march', 180, 'recurring', 'General Pest Control', 'rec_gpc'),
      visit('next', 7, 'booked', 'General Pest Control', 'rec_gpc'),
      visit('lastWeek', -7, 'completed', 'General Pest Control', 'rec_gpc'),
      visit('lastMonth', -30, 'invoiced', 'Termite Inspection'),
      visit('yesterday', -1, 'completed', 'Bait station check', 'rec_bait'),
    ]
    expect(
      pastVisits(visits, { startOfToday: TODAY, excludeJobId: THIS._id }).map(
        (v) => v._id,
      ),
    ).toEqual(['yesterday', 'lastWeek', 'lastMonth'])
  })

  it('leaves today’s visits to the Schedule, closed or not', () => {
    const visits = [
      visit('thisMorning', -0.2, 'booked'),
      visit('doneThisMorning', -0.25, 'completed'),
      visit('yesterday', -1, 'completed'),
    ]
    expect(
      pastVisits(visits, { startOfToday: TODAY, excludeJobId: THIS._id }).map(
        (v) => v._id,
      ),
    ).toEqual(['yesterday'])
  })

  it('leaves out this job, and a projection nobody booked', () => {
    const visits = [
      { ...THIS, scheduledAt: NOW - DAY },
      visit('unbooked', -2, 'recurring', 'Bait station check', 'rec_bait'),
      visit('cancelled', -3, 'cancelled', 'Wasps'),
      visit('neverClosed', -4, 'booked'),
    ]
    expect(
      pastVisits(visits, { startOfToday: TODAY, excludeJobId: THIS._id }).map(
        (v) => v._id,
      ),
    ).toEqual(['cancelled', 'neverClosed'])
  })
})

describe('historyCard', () => {
  const past = pastVisits(
    [
      visit('bait1', -1, 'completed', 'Bait station check', 'rec_bait'),
      visit('bait2', -3, 'completed', 'Bait station check', 'rec_bait'),
      visit('cancelled', -4, 'cancelled', 'Wasps'),
      visit('gpc', -7, 'completed', 'General Pest Control', 'rec_gpc'),
      visit('bait3', -9, 'completed', 'Bait station check', 'rec_bait'),
      visit('gpcOld', -14, 'completed', 'General Pest Control', 'rec_gpc'),
    ],
    { startOfToday: TODAY, excludeJobId: THIS._id },
  )

  it('leads with the last visit for this service, then the most recent others', () => {
    const card = historyCard(THIS, past)
    expect(card.last?._id).toBe('gpc')
    expect(card.recent.map((v) => v._id)).toEqual(['bait1', 'bait2'])
  })

  it('shows only visits that happened', () => {
    const card = historyCard(THIS, past, 5)
    expect(card.recent.map((v) => v._id)).not.toContain('cancelled')
  })

  it('shows three recent visits when this service has none here', () => {
    const card = historyCard(visit('x', 1, 'booked', 'Rodents'), past)
    expect(card.last).toBeUndefined()
    expect(card.recent.map((v) => v._id)).toEqual(['bait1', 'bait2', 'gpc'])
  })
})

describe('pastVisits and reports', () => {
  it('keeps a projection whose day has passed when a report was written on it', () => {
    const visits = [
      visit('reported', -2, 'recurring', 'Bait station check', 'rec_bait'),
      visit('silent', -4, 'recurring', 'Bait station check', 'rec_bait'),
    ]
    expect(
      pastVisits(visits, {
        startOfToday: TODAY,
        excludeJobId: THIS._id,
        withReports: new Set(['reported']),
      }).map((v) => v._id),
    ).toEqual(['reported'])
  })
})

describe('sameService', () => {
  it('matches the series, or the same services by name', () => {
    expect(
      sameService(THIS, visit('a', -7, 'completed', 'Other', 'rec_gpc')),
    ).toBe(true)
    expect(
      sameService(THIS, visit('b', -7, 'completed', ' general pest control ')),
    ).toBe(true)
    expect(
      sameService(THIS, visit('c', -7, 'completed', 'Termite Inspection')),
    ).toBe(false)
  })

  it('counts a visit for every one of this job’s services, in any order', () => {
    const both = visit(
      'd',
      -30,
      'completed',
      'Termite Inspection, General Pest Control',
    )
    const once = visit('e', 5, 'booked', 'General Pest Control')
    // A visit that included this job's service, among others.
    expect(sameService(once, both)).toBe(true)
    // The same services, picked in the other order.
    expect(
      sameService(
        visit('f', 5, 'booked', 'General  Pest Control, termite inspection'),
        both,
      ),
    ).toBe(true)
    // Not a visit for only some of them.
    expect(
      sameService(both, visit('g', -3, 'completed', 'General Pest Control')),
    ).toBe(false)
  })

  it('leads the card with the last visit that included the service', () => {
    const past = pastVisits(
      [
        visit(
          'both',
          -30,
          'completed',
          'General Pest Control, Termite Inspection',
        ),
        visit('gpcYearAgo', -365, 'completed', 'General Pest Control'),
      ],
      { startOfToday: TODAY, excludeJobId: 'x' },
    )
    expect(historyCard(visit('x', 3, 'booked'), past).last?._id).toBe('both')
  })
})

describe('nextVisit', () => {
  const series = [
    visit('past', -7, 'completed', 'General Pest Control', 'rec_gpc'),
    THIS,
    visit('cancelledNext', 7, 'cancelled', 'General Pest Control', 'rec_gpc'),
    visit('projected', 14, 'recurring', 'General Pest Control', 'rec_gpc'),
    visit('booked', 21, 'booked', 'General Pest Control', 'rec_gpc'),
    visit('otherSeries', 2, 'booked', 'Bait station check', 'rec_bait'),
  ]

  it('is the series’ next visit after this one, skipping a cancelled one', () => {
    expect(nextVisit(THIS, series, NOW)?._id).toBe('projected')
  })

  it('is counted from now for a past visit', () => {
    const past = series[0]
    expect(nextVisit(past, series, NOW)?._id).toBe('this')
  })

  it('is nothing for a one-off, or when none is booked yet', () => {
    expect(nextVisit(visit('once', 1, 'booked'), series, NOW)).toBeUndefined()
    expect(nextVisit(THIS, [THIS], NOW)).toBeUndefined()
  })
})

describe('reportsByVisit', () => {
  it('files each report under a visit shown, and the rest with the others', () => {
    const reports = [
      { _id: 'r1', jobId: 'gpc' },
      { _id: 'r2', jobId: 'gpc' },
      { _id: 'r3' },
      { _id: 'r4', jobId: 'movedAway' },
      { _id: 'r5', jobId: 'next' },
    ]
    const { byVisit, unlinked } = reportsByVisit(
      reports,
      new Set(['gpc', 'next']),
    )
    expect(byVisit.get('gpc')?.map((r) => r._id)).toEqual(['r1', 'r2'])
    expect(byVisit.get('next')?.map((r) => r._id)).toEqual(['r5'])
    expect(unlinked.map((r) => r._id)).toEqual(['r3', 'r4'])
  })
})

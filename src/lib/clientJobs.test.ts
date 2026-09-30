import { describe, expect, it } from 'vitest'
import { byYear, clientOverview, seriesView } from './clientJobs'

const DAY = 86_400_000
const TZ = 'Australia/Perth'
const NOW = Date.UTC(2026, 8, 30, 4) // 30 Sept 2026, midday in Perth
const TODAY = Date.UTC(2026, 8, 29, 16) // its midnight in Perth

function visit(
  _id: string,
  days: number,
  status: string,
  recurrenceId?: string,
  propertyId = 'p1',
  jobType = 'General Pest Control',
) {
  return {
    _id,
    scheduledAt: NOW + days * DAY,
    status,
    jobType,
    propertyId,
    ...(recurrenceId !== undefined && { recurrenceId }),
  }
}

const WEEKLY = {
  _id: 'rec_gpc',
  jobType: 'General Pest Control',
  interval: { count: 1, unit: 'week' as const },
  active: true,
  propertyId: 'p1',
  anchorDate: NOW - 28 * DAY,
}

const at = { startOfToday: TODAY, startOfTomorrow: TODAY + DAY, timezone: TZ }

describe('seriesView', () => {
  const visits = [
    visit('w-28', -28, 'invoiced', 'rec_gpc'),
    visit('w-21', -21, 'completed', 'rec_gpc'),
    visit('w-14', -14, 'recurring', 'rec_gpc'),
    visit('w-7', -7, 'cancelled', 'rec_gpc'),
    visit('w0', 0, 'booked', 'rec_gpc'),
    visit('w7', 7, 'recurring', 'rec_gpc'),
    visit('other', 3, 'booked', 'rec_bait'),
  ]

  it('splits a service’s visits into coming, done and to book', () => {
    const view = seriesView(WEEKLY, visits, at)
    expect(view.upcoming.map((v) => v._id)).toEqual(['w0', 'w7'])
    expect(view.done.map((v) => v._id)).toEqual(['w-21', 'w-28'])
    expect(view.overdue.map((v) => v._id)).toEqual(['w-14'])
    expect(view.next?._id).toBe('w0')
    expect(view.nextDue).toBeUndefined()
  })

  it('says when a running service is next due when nothing is booked for it', () => {
    const yearly = {
      ...WEEKLY,
      _id: 'rec_termite',
      interval: { count: 1, unit: 'year' as const },
      anchorDate: NOW - 300 * DAY,
    }
    const view = seriesView(
      yearly,
      [visit('t0', -300, 'completed', 'rec_termite')],
      at,
    )
    expect(view.next).toBeUndefined()
    // A year after the anchor, to the minute.
    expect(view.nextDue).toBe(NOW - 300 * DAY + 365 * DAY)
  })

  it('gives a stopped service no next date', () => {
    const view = seriesView({ ...WEEKLY, active: false }, [], at)
    expect(view.nextDue).toBeUndefined()
  })
})

describe('clientOverview', () => {
  const series = [
    WEEKLY,
    { ...WEEKLY, _id: 'rec_old', active: false, jobType: 'Rodents' },
  ]
  const visits = [
    visit('w-7', -7, 'completed', 'rec_gpc'),
    visit('w2', 2, 'recurring', 'rec_gpc'),
    visit('w9', 9, 'recurring', 'rec_gpc'),
    visit('once-30', -30, 'completed'),
    visit('once5', 5, 'booked'),
    visit('once-cancel', 0.5, 'cancelled'),
    // Out of a series this viewer can't see: a job of its own here.
    visit('stray', -3, 'completed', 'rec_hidden'),
    visit('site2', 1, 'booked', undefined, 'p2'),
  ]

  it('comes up with each running service’s next visit and the one-offs booked ahead', () => {
    const view = clientOverview({ series, visits }, at)
    expect(view.comingUp.map((v) => v._id)).toEqual(['site2', 'w2', 'once5'])
    expect(view.next?._id).toBe('site2')
    expect(view.last?._id).toBe('stray')
  })

  it('lists running services first, and every visit of no listed service as a one-off', () => {
    const view = clientOverview({ series, visits }, at)
    expect(view.series.map((s) => s.series._id)).toEqual(['rec_gpc', 'rec_old'])
    expect(view.oneOffs.map((v) => v._id)).toEqual([
      'once5',
      'site2',
      'once-cancel',
      'stray',
      'once-30',
    ])
  })

  it('narrows everything to one site', () => {
    const view = clientOverview({ series, visits }, { ...at, propertyId: 'p2' })
    expect(view.series).toEqual([])
    expect(view.oneOffs.map((v) => v._id)).toEqual(['site2'])
    expect(view.next?._id).toBe('site2')
  })
})

describe('byYear', () => {
  it('groups by the year where the business is', () => {
    // 31 Dec 2025, 5pm UTC: already 1 Jan 2026 in Perth.
    const newYear = { _id: 'a', scheduledAt: Date.UTC(2025, 11, 31, 17) }
    const before = { _id: 'b', scheduledAt: Date.UTC(2025, 11, 31, 10) }
    expect(
      byYear([newYear, before], TZ).map(([y, v]) => [y, v.length]),
    ).toEqual([
      ['2026', 1],
      ['2025', 1],
    ])
  })
})

describe('every visit has a place, and only what happened is done', () => {
  it('shows a series visit never closed, and leaves a cancelled one out of the drawn', () => {
    const visits = [
      visit('x', -8, 'booked', 'rec_gpc'),
      visit('c', -15, 'cancelled', 'rec_gpc'),
      visit('n', 6, 'recurring', 'rec_gpc'),
    ]
    const view = clientOverview({ series: [WEEKLY], visits }, at)
    expect(view.series[0].notClosed.map((v) => v._id)).toEqual(['x'])
    expect(view.drawn.has('x')).toBe(true)
    // A report on it goes with the other reports.
    expect(view.drawn.has('c')).toBe(false)
  })

  it('keeps a visit invoiced ahead of its day to come, not done', () => {
    const visits = [
      visit('ahead', 32, 'invoiced', 'rec_gpc'),
      visit('onceAhead', 10, 'invoiced'),
      visit('before', -7, 'completed', 'rec_gpc'),
    ]
    const view = clientOverview({ series: [WEEKLY], visits }, at)
    expect(view.last?._id).toBe('before')
    expect(view.series[0].done.map((v) => v._id)).toEqual(['before'])
    expect(view.comingUp.map((v) => v._id)).toEqual(['onceAhead', 'ahead'])
    expect(view.next?._id).toBe('onceAhead')
  })

  it('names as next only what Coming up shows', () => {
    // Moved out of a service the viewer can't see: a job of its own.
    const view = clientOverview(
      { series: [], visits: [visit('stray', 6, 'recurring', 'rec_hidden')] },
      at,
    )
    expect(view.comingUp.map((v) => v._id)).toEqual(['stray'])
    expect(view.next?._id).toBe('stray')
  })
})

describe('when a service is next due', () => {
  const yearly = {
    ...WEEKLY,
    _id: 'rec_termite',
    interval: { count: 1, unit: 'year' as const },
    anchorDate: NOW - 333 * DAY,
  }

  it('skips an occurrence a visit moved earlier still holds', () => {
    // This year's visit was projected for NOW + 32 days, done 10 days ago.
    const moved = {
      ...visit('early', -10, 'completed', 'rec_termite'),
      occurrenceAt: NOW - 333 * DAY + 365 * DAY,
    }
    const view = seriesView(yearly, [moved], at)
    expect(view.nextDue).toBe(NOW - 333 * DAY + 2 * 365 * DAY)
  })

  it('skips one used by a visit in the Recycle bin or someone else’s', () => {
    const view = seriesView(
      { ...yearly, lastTaken: NOW - 333 * DAY + 365 * DAY },
      [],
      at,
    )
    expect(view.nextDue).toBe(NOW - 333 * DAY + 2 * 365 * DAY)
  })
})

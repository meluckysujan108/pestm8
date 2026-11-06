import { describe, expect, test } from 'vitest'
import {
  JOB_VIEWS,
  activeJobView,
  jobListFiltersOf,
  recurringJobFiltersOf,
} from './jobViews'

describe('which Job view a URL is showing', () => {
  test('the section itself is the main view', () => {
    expect(activeJobView('/coastal-pest/job')).toBe('job')
  })

  test('a view under it wins over the section it sits in', () => {
    // '/job' is a suffix of nothing here, but it IS a prefix of the section —
    // matching in declaration order would call this the main view.
    expect(activeJobView('/coastal-pest/job/recurring')).toBe('recurring')
  })

  test('anything else falls back to the main view rather than nothing', () => {
    expect(activeJobView('/coastal-pest/job/not-a-view')).toBe('job')
    expect(activeJobView('/coastal-pest/schedule')).toBe('job')
  })

  test('every declared view is reachable from its own path', () => {
    for (const view of JOB_VIEWS) {
      expect(activeJobView(`/coastal-pest${view.path}`)).toBe(view.value)
    }
  })
})

describe('the Recurring Job view’s filters, read from its address', () => {
  test('nothing set is everyone’s, with what is to book first', () => {
    expect(recurringJobFiltersOf({})).toEqual({
      staffId: 'all',
      sort: 'toBook',
    })
  })

  test('a person and an order the view offers are kept', () => {
    expect(recurringJobFiltersOf({ staff: 'm_kev', sort: 'client' })).toEqual({
      staffId: 'm_kev',
      sort: 'client',
    })
  })

  test('an order the view doesn’t offer, or an empty person, is the default', () => {
    // `suburb` is the Schedule's day's, not this view's.
    expect(recurringJobFiltersOf({ staff: '', sort: 'suburb' })).toEqual({
      staffId: 'all',
      sort: 'toBook',
    })
  })
})

describe('the Job tab’s filters, read from its address', () => {
  test('reads a status, a person and the visit order', () => {
    expect(
      jobListFiltersOf({ status: 'completed', staff: 'm_kev', sort: 'visit' }),
    ).toEqual({ status: 'completed', staffId: 'm_kev', sort: 'visit' })
  })

  test('anything else is the default: every status, everyone’s, newest booked', () => {
    expect(jobListFiltersOf({})).toEqual({
      status: undefined,
      staffId: 'all',
      sort: 'booked',
    })
    // The Recurring Job view's orders, or anything mistyped, are not this
    // tab's.
    expect(
      jobListFiltersOf({ status: 'recurring', staff: '', sort: 'client' }),
    ).toEqual({ status: undefined, staffId: 'all', sort: 'booked' })
  })
})

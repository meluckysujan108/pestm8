import { describe, expect, test } from 'vitest'
import {
  isSignInRefusal,
  jobListSource,
  jobListView,
  jobsCaption,
  listsEverythingOf,
} from './jobListView'
import { JOB_LIST_STATUS_OPTIONS, parseJobListStatus } from './scheduleFilters'

describe('which list the Job tab reads', () => {
  test('the whole business pages; one person’s or one team’s work is read whole', () => {
    expect(jobListSource(listsEverythingOf({ listsEverything: true }))).toBe(
      'paged',
    )
    expect(jobListSource(listsEverythingOf({ listsEverything: false }))).toBe(
      'bounded',
    )
  })

  test('a backend from before the field reads the old list, filtered here', () => {
    // `access.me` as an older backend answers it: no `listsEverything` at all.
    const older = { membershipId: 'm1', role: 'owner', view: null }
    expect(listsEverythingOf(older)).toBeUndefined()
    expect(jobListSource(listsEverythingOf(older))).toBe('legacy')
    expect(jobListSource(listsEverythingOf(undefined))).toBe('legacy')
    // Anything but a boolean is not an answer.
    expect(listsEverythingOf({ listsEverything: 'yes' })).toBeUndefined()
  })
})

describe('the status in the address', () => {
  test('each status the filter offers reads as itself', () => {
    for (const option of JOB_LIST_STATUS_OPTIONS) {
      expect(parseJobListStatus(option.value)).toBe(option.value)
    }
  })

  test('anything else reads as no status, so the loader warms what the page reads', () => {
    // Recurring is a status, but not one this list holds — and not one the
    // server's list accepts.
    for (const raw of [
      'recurring',
      'all',
      'Completed',
      '',
      3,
      null,
      undefined,
    ]) {
      expect(parseJobListStatus(raw)).toBeUndefined()
    }
  })
})

describe('what the list area shows', () => {
  const settled = {
    filtered: false,
    rows: 0,
    loading: false,
    done: true,
    failed: false,
    confirmedEmpty: true,
  }

  test('jobs on screen are shown, whatever else is going on', () => {
    expect(jobListView({ ...settled, rows: 3, failed: true })).toBe('list')
    expect(jobListView({ ...settled, rows: 3, loading: true })).toBe('list')
  })

  test('nothing yet is the placeholder; nothing coming is Could not load', () => {
    expect(jobListView({ ...settled, loading: true, done: false })).toBe(
      'pending',
    )
    expect(jobListView({ ...settled, failed: true, done: false })).toBe(
      'failed',
    )
  })

  test('an empty list is "No jobs yet", and under a status "No matches"', () => {
    expect(jobListView(settled)).toBe('empty')
    expect(jobListView({ ...settled, filtered: true })).toBe('noMatches')
  })

  test('never "No jobs yet" while the warmed page still has jobs on it', () => {
    // "Just my jobs" picked: the paginator has already answered "none", and
    // `access.me` with the warmed page arrive a tick later.
    expect(jobListView({ ...settled, confirmedEmpty: false })).toBe('pending')
    expect(
      jobListView({ ...settled, filtered: true, confirmedEmpty: false }),
    ).toBe('pending')
  })

  test('a hunt for a row that stopped asking leaves the list, with its Show more', () => {
    // Every row the pages read was stepped over, and more are behind them:
    // not a placeholder for good, and not "No jobs yet".
    expect(jobListView({ ...settled, done: false })).toBe('list')
  })
})

describe('the caption', () => {
  test('digits and noun, one or many', () => {
    expect(jobsCaption({ count: 148 })).toBe('148 jobs')
    expect(jobsCaption({ count: 1 })).toBe('1 job')
    expect(jobsCaption({ count: 0 })).toBe('0 jobs')
  })

  test('a count that stopped counting says so', () => {
    expect(jobsCaption({ count: 1000, capped: true })).toBe('1000+ jobs')
  })

  test('a list of the newest says it holds only those', () => {
    expect(jobsCaption({ count: 200, newest: 200 })).toBe(
      '200 jobs · newest 200',
    )
  })
})

describe('refusals the route handles itself', () => {
  test('not signed in, or two-step sign-in not set up', () => {
    expect(isSignInRefusal({ data: 'Unauthenticated' })).toBe(true)
    expect(isSignInRefusal({ data: 'MFA_ENROLMENT_REQUIRED' })).toBe(true)
  })

  test('anything else is the list’s own to say', () => {
    expect(
      isSignInRefusal(new Error('[CONVEX Q(jobs:list)] Server Error')),
    ).toBe(false)
    expect(isSignInRefusal(null)).toBe(false)
  })
})

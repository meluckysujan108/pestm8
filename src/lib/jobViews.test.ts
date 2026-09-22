import { describe, expect, test } from 'vitest'
import { JOB_VIEWS, activeJobView } from './jobViews'

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

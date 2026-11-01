import { afterEach, describe, expect, test, vi } from 'vitest'
import { hookHarness } from '#/lib/offline/hooks.fixtures'
import {
  SHEET_RISE_MS,
  firstTab,
  useAddSiteOnce,
  useIntoViewOnOpen,
} from './clientSheetOpening'
import type * as React from 'react'

// React's hooks run here by the harness: there is no document to render
// into.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof React>()),
  ...(await import('#/lib/offline/hooks.fixtures')).hookHarness.hooks,
}))

/**
 * A client's sheet opened from Clients → New client, where the caller
 * turned out to be them already (the matching plan's §2.10): on Details,
 * with Add property open on the address they gave once, and only once.
 */

afterEach(() => {
  hookHarness.mount(() => null)
  vi.useRealTimers()
})

const NEW_ADDRESS = {
  addressLine: '40 Coode St',
  suburb: 'Bayswater',
  state: 'WA',
  postcode: '6053',
}

describe('the part the sheet opens on', () => {
  test('Details from New client, whether or not there is an address to add', () => {
    expect(firstTab({ addSite: NEW_ADDRESS })).toBe('details')
    // The address typed is theirs already: Details, where it is listed.
    expect(firstTab({})).toBe('details')
    expect(firstTab({ addSite: undefined })).toBe('details')
  })

  test('Jobs from anywhere else, as ever', () => {
    expect(firstTab(undefined)).toBe('jobs')
  })
})

describe('Add property on the address New client gave', () => {
  test('opens once: taken, it is gone for good, though the opener still holds it', () => {
    let given: typeof NEW_ADDRESS | undefined = NEW_ADDRESS
    const hook = hookHarness.mount(() => useAddSiteOnce(given))
    expect(hook.current().addSite).toEqual(NEW_ADDRESS)
    // Details drawn, Add property open on it.
    hook.current().taken()
    expect(hook.current().addSite).toBeUndefined()
    // Jobs, then Details again: the opener still passes it.
    hook.rerender()
    expect(hook.current().addSite).toBeUndefined()
    given = undefined
    hook.rerender()
    expect(hook.current().addSite).toBeUndefined()
  })
})

describe('Add property on the address New client gave, at the foot of Details', () => {
  /** The form, as far as bringing it into view goes. */
  const formAt = () => ({ current: { scrollIntoView: vi.fn() } })

  test('is brought into view once the sheet has slid up, and not focused', () => {
    vi.useFakeTimers()
    const form = formAt()
    hookHarness.mount(() => useIntoViewOnOpen(form, true))
    // Still sliding up: where the form is now isn't where it stops.
    vi.advanceTimersByTime(SHEET_RISE_MS - 1)
    expect(form.current.scrollIntoView).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    // Nearest: the whole form, its Add property too, where it fits.
    expect(form.current.scrollIntoView).toHaveBeenCalledExactlyOnceWith({
      block: 'nearest',
      behavior: 'smooth',
    })
    // Once: typing in it brings nothing back into view.
    vi.advanceTimersByTime(SHEET_RISE_MS * 4)
    expect(form.current.scrollIntoView).toHaveBeenCalledOnce()
  })

  test('not for Add another property, which opens where it was tapped', () => {
    vi.useFakeTimers()
    const form = formAt()
    hookHarness.mount(() => useIntoViewOnOpen(form, false))
    vi.advanceTimersByTime(SHEET_RISE_MS * 4)
    expect(form.current.scrollIntoView).not.toHaveBeenCalled()
  })

  test('nor once the form has gone, Cancelled before the sheet stopped', () => {
    vi.useFakeTimers()
    const form = formAt()
    const hook = hookHarness.mount(() => useIntoViewOnOpen(form, true))
    hook.unmount()
    vi.advanceTimersByTime(SHEET_RISE_MS * 4)
    expect(form.current.scrollIntoView).not.toHaveBeenCalled()
  })
})

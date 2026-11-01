import { afterEach, describe, expect, test, vi } from 'vitest'
import { hookHarness } from '#/lib/offline/hooks.fixtures'
import { firstTab, useAddSiteOnce } from './clientSheetOpening'
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

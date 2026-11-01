import { afterEach, expect, test, vi } from 'vitest'
import { hookHarness } from '#/lib/offline/hooks.fixtures'
import { useFixOnScreen } from './VerifiedAddressFields'
import { createSaveGuard } from './saveWarningRules'
import type { SaveGuardState, SaveWarning } from './saveWarningRules'
import type { AddressValue } from '#/lib/addressVerify'
import type * as React from 'react'

// React's hooks run here by the harness: there is no document to render into.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof React>()),
  ...(await import('#/lib/offline/hooks.fixtures')).hookHarness.hooks,
}))

/**
 * A row about the address kept in the list above Book as a fix takes the
 * booking to another client mode (New Job's Use Jane Nguyen: New client's
 * address block goes, New site for's comes, with the same ids and the same
 * address): its own fix is then applied by the block on screen, so Use NT
 * puts NT in the fields shown, never in the New client draft behind them.
 */

afterEach(() => {
  hookHarness.mount(() => null)
})

const press = () => ({ preventDefault: () => {} })

test('a row kept across a match fix is fixed by the block on screen, not the one gone', () => {
  const drafts: Record<'newClient' | 'newSite', Partial<AddressValue>> = {
    newClient: { suburb: 'Fannie Bay', state: 'WA', postcode: '0820' },
    newSite: { suburb: 'Fannie Bay', state: 'WA', postcode: '0820' },
  }
  /** An address block, by its ids, applying fixes to `draft`. */
  const block = (draft: 'newClient' | 'newSite') =>
    hookHarness.mount(() =>
      useFixOnScreen('p', (patch) => Object.assign(drafts[draft], patch)),
    )
  /** Its check at Book: "0820 is an NT postcode.", Use NT. */
  const check = (fix: (patch: Partial<AddressValue>) => void) => () => [
    {
      id: 'p-postcode:1',
      label: 'Postcode',
      message: '0820 is an NT postcode.',
      fix: { label: 'Use NT', apply: () => fix({ state: 'NT' }) },
    },
  ]
  const jane: SaveWarning = {
    id: 'match:c_jane',
    kind: 'match',
    label: 'Already a client',
    message: 'Jane Nguyen, of Bayswater, has the same name and mobile.',
    fix: { label: 'Use Jane Nguyen', apply: () => {} },
  }

  let state: SaveGuardState | null = null
  const guard = createSaveGuard((next) => (state = next))
  const shown = () => state?.shown ?? []

  // New client: its address block, and the check for who the caller is.
  const newClient = block('newClient').current()
  const gone = guard.register('p-address', check(newClient))
  guard.register('new-job-client-match', () => [jane])
  guard.guard(press(), () => {})
  expect(shown().map((w) => w.id)).toEqual(['p-postcode:1', 'match:c_jane'])

  // Use Jane Nguyen: New client's block goes, New site for's comes, drawn
  // with the same ids and holding the same address.
  guard.fix(shown()[1], (change) => {
    change()
    gone()
    guard.removed('p-address')
    const newSite = block('newSite').current()
    guard.register('p-address', check(newSite))
  })
  // The NT row stays, as shown and confirmed.
  const kept = shown().find((w) => w.id === 'p-postcode:1')
  expect(kept).toBeDefined()

  // Its Use NT, tapped now: NT in the fields shown.
  guard.fix(kept!, (change) => change())
  expect(drafts.newSite.state).toBe('NT')
  expect(drafts.newClient.state).toBe('WA')
  expect(shown()).toEqual([])
})

test('with no other block drawn with its ids, a block applies its own fixes', () => {
  const into: Array<Partial<AddressValue>> = []
  const fix = hookHarness
    .mount(() => useFixOnScreen('solo', (patch) => into.push(patch)))
    .current()
  fix({ postcode: '6053' })
  // Gone from the screen, it still applies its own: nothing else holds
  // those ids.
  hookHarness.mount(() => null)
  fix({ suburb: 'Bayswater' })
  expect(into).toEqual([{ postcode: '6053' }, { suburb: 'Bayswater' }])
})

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { rq } from '#/lib/routeQueries'
import { hookHarness } from './hooks.fixtures'
import { keeper } from './keeper'
import {
  useBehindOnce,
  useHandOverBody,
  useLateSince,
  useNewerClientsHint,
} from './useKept'
import type * as React from 'react'
import type { Id } from '../../../convex/_generated/dataModel'

// React's hooks run here by the harness, effects and timers included: there
// is no document to render into.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof React>()),
  ...(await import('./hooks.fixtures')).hookHarness.hooks,
}))

// The kept copy's keeper reads who is signed in (lib/rootState.ts), whose
// server function needs a deployment's address to load at all.
vi.mock('#/lib/initialState', () => ({ getInitialState: vi.fn() }))

/**
 * The keeper's hooks over time, as a page runs them: what they wait for,
 * what they measure, and what they decide once.
 */

const B = 'b1' as Id<'businesses'>
const TAP = Date.UTC(2026, 9, 25, 1)

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'Date',
    ],
  })
  vi.setSystemTime(TAP)
  vi.stubGlobal('navigator', { onLine: true })
  vi.stubGlobal('window', new EventTarget())
  vi.stubGlobal('document', {
    documentElement: { hasAttribute: () => false },
  })
})

afterEach(() => {
  hookHarness.mount(() => null)
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('how long a page has waited (`useLateSince`)', () => {
  test('the wait it opens with counts from the tap, so a loader’s own wait counts towards it', () => {
    // A loader that held the tap for a second.
    vi.setSystemTime(TAP + 1_000)
    const late = hookHarness.mount(() => useLateSince(true, 3_000, TAP))
    expect(late.current()).toBe(false)
    vi.advanceTimersByTime(1_999)
    expect(late.current()).toBe(false)
    vi.advanceTimersByTime(1)
    expect(late.current()).toBe(true)
  })

  test('a tap longer ago than the wait is late at the first tick: the route gives it only a tap that opened the page', () => {
    vi.setSystemTime(TAP + 10_000)
    const late = hookHarness.mount(() => useLateSince(true, 3_000, TAP))
    expect(late.current()).toBe(false)
    vi.advanceTimersByTime(0)
    expect(late.current()).toBe(true)
  })

  test('false again once it stops, and a later wait counts from when it began, never from the tap', () => {
    let pending = true
    const late = hookHarness.mount(() => useLateSince(pending, 3_000, TAP))
    vi.advanceTimersByTime(3_000)
    expect(late.current()).toBe(true)

    pending = false
    late.rerender()
    expect(late.current()).toBe(false)

    vi.advanceTimersByTime(20_000)
    pending = true
    late.rerender()
    expect(late.current()).toBe(false)
    vi.advanceTimersByTime(2_999)
    expect(late.current()).toBe(false)
    vi.advanceTimersByTime(1)
    expect(late.current()).toBe(true)
  })

  test('nothing waited for is never late', () => {
    const late = hookHarness.mount(() => useLateSince(false, 3_000, TAP))
    vi.advanceTimersByTime(60_000)
    expect(late.current()).toBe(false)
  })
})

describe('a sheet’s body across the hand-over (`useHandOverBody`)', () => {
  /** What the browser would measure of the body, and what watches it. */
  function body(height: number) {
    const observers: Array<{ fire: () => void; disconnected: boolean }> = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        disconnected = false
        constructor(private readonly callback: () => void) {
          observers.push(this)
        }
        observe() {}
        disconnect() {
          this.disconnected = true
        }
        fire() {
          if (!this.disconnected) this.callback()
        }
      },
    )
    const node = {
      height,
      getBoundingClientRect() {
        return { height: this.height }
      },
    }
    return { node: node as unknown as HTMLElement & typeof node, observers }
  }

  test('nothing held while the kept view shows; then the live sheet is held at its height, as it last measured', () => {
    const { node, observers } = body(630)
    let kept = true
    const held = hookHarness.mount(() => useHandOverBody(kept))
    held.current().ref(node)
    expect(held.current().style).toBeUndefined()

    // The kept view grows (the roster's names, a second line of the note).
    node.height = 652
    for (const observer of observers) observer.fire()
    expect(held.current().style).toBeUndefined()

    kept = false
    held.rerender()
    expect(held.current().style).toEqual({ flex: '0 1 auto', height: 652 })
    // No longer watched: the live sheet's own height changes nothing.
    expect(observers.every((observer) => observer.disconnected)).toBe(true)
    node.height = 900
    for (const observer of observers) observer.fire()
    held.rerender()
    expect(held.current().style).toEqual({ flex: '0 1 auto', height: 652 })
  })

  test('a sheet that never showed the kept view is never held', () => {
    const { node } = body(630)
    const held = hookHarness.mount(() => useHandOverBody(false))
    held.current().ref(node)
    expect(held.current().style).toBeUndefined()
  })
})

describe('words about an answer that may be behind, decided once (`useBehindOnce`)', () => {
  const KEY = rq.directory(B).queryKey

  test('decided as they show, and kept while they do, whatever the line does', () => {
    const lineLive = vi.spyOn(keeper, 'lineLive').mockReturnValue(true)
    let about = 'Zed'
    const behind = hookHarness.mount(() => useBehindOnce(KEY, true, about))
    // A once-live answer, asked for again on a line PestM8 is speaking on.
    expect(behind.current()).toBe(false)

    lineLive.mockReturnValue(false)
    vi.advanceTimersByTime(30_000)
    behind.rerender()
    expect(behind.current()).toBe(false)

    // Something else searched: decided again.
    about = 'Zee'
    behind.rerender()
    expect(behind.current()).toBe(true)
  })

  test('decided again once they have gone and show again', () => {
    const lineLive = vi.spyOn(keeper, 'lineLive').mockReturnValue(false)
    let showing = true
    const behind = hookHarness.mount(() => useBehindOnce(KEY, showing, 'Zed'))
    expect(behind.current()).toBe(true)

    showing = false
    behind.rerender()
    expect(behind.current()).toBe(false)
    lineLive.mockReturnValue(true)
    showing = true
    behind.rerender()
    expect(behind.current()).toBe(false)
  })

  test('as the server drew them while hydrating, and kept so after', () => {
    vi.spyOn(keeper, 'lineLive').mockReturnValue(false)
    const behind = hookHarness.mount(() => useBehindOnce(KEY, true, 'Zed'), {
      hydrating: true,
    })
    expect(behind.current()).toBe(false)
    behind.rerender()
    expect(behind.current()).toBe(false)
  })
})

describe('the line under a picker’s way in to a new client (`useNewerClientsHint`)', () => {
  const KEY = rq.directory(B).queryKey

  test('said where the client list may be behind, and kept while it shows', () => {
    const lineLive = vi.spyOn(keeper, 'lineLive').mockReturnValue(false)
    const hint = hookHarness.mount(() => useNewerClientsHint(KEY))
    expect(hint.current()).toBe('Newer clients show when you have signal.')

    // The line comes back while it shows: it stays, so the row above it
    // never moves as the search is typed into.
    lineLive.mockReturnValue(true)
    vi.advanceTimersByTime(30_000)
    hint.rerender()
    expect(hint.current()).toBe('Newer clients show when you have signal.')
  })

  test('nothing where the list is as new as PestM8 has it', () => {
    vi.spyOn(keeper, 'lineLive').mockReturnValue(true)
    const hint = hookHarness.mount(() => useNewerClientsHint(KEY))
    expect(hint.current()).toBeNull()
  })

  test('nothing while hydrating, as the server drew it', () => {
    vi.spyOn(keeper, 'lineLive').mockReturnValue(false)
    const hint = hookHarness.mount(() => useNewerClientsHint(KEY), {
      hydrating: true,
    })
    expect(hint.current()).toBeNull()
  })
})

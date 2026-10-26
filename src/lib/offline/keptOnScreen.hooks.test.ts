import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { hookHarness } from './hooks.fixtures'
import {
  KEPT_AFTER_DOWN_MS,
  KEPT_GONE_MS,
  keptShowing,
  showKept,
  useKeptAt,
  useNoteHolds,
  useOnScreen,
  useShowKeptAt,
} from './keptOnScreen'
import type * as React from 'react'
import type { KeptNote } from './useKept'

// React's hooks run here by the harness, effects and timers included: there
// is no document to render into.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof React>()),
  ...(await import('./hooks.fixtures')).hookHarness.hooks,
}))

/**
 * The hooks a kept line says it is showing with, and a notice reads it
 * with: the first render draws no line, as the server did, and both follow
 * the registry after.
 */

const PLACE = 'sheet-hooks'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  hookHarness.mount(() => null)
  vi.advanceTimersByTime(KEPT_GONE_MS)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('reading a place (`useKeptAt`)', () => {
  test('its first render says nothing shows, as the server and the hydration render do, then reads the place', () => {
    const gone = showKept(PLACE)
    const seen: Array<boolean> = []
    const kept = hookHarness.mount(() => {
      const value = useKeptAt(PLACE)
      seen.push(value)
      return value
    })
    expect(seen[0]).toBe(false)
    expect(kept.current()).toBe(true)
    gone()
  })

  test('follows the place as lines show and go', () => {
    const kept = hookHarness.mount(() => useKeptAt(PLACE))
    expect(kept.current()).toBe(false)
    const gone = showKept(PLACE)
    expect(kept.current()).toBe(true)
    gone()
    expect(kept.current()).toBe(true)
    vi.advanceTimersByTime(KEPT_GONE_MS)
    expect(kept.current()).toBe(false)
  })
})

describe('saying a line shows (`useShowKeptAt`)', () => {
  test('while on, and a moment after it turns off', () => {
    let on = true
    const hook = hookHarness.mount(() => useShowKeptAt(PLACE, on))
    expect(keptShowing(PLACE)).toBe(true)
    on = false
    hook.rerender()
    expect(keptShowing(PLACE)).toBe(true)
    vi.advanceTimersByTime(KEPT_GONE_MS)
    expect(keptShowing(PLACE)).toBe(false)
    on = true
    hook.rerender()
    expect(keptShowing(PLACE)).toBe(true)
  })

  test('off from the start, it says nothing', () => {
    hookHarness.mount(() => useShowKeptAt(PLACE, false))
    expect(keptShowing(PLACE)).toBe(false)
  })

  test('until it goes from the screen', () => {
    const hook = hookHarness.mount(() => useShowKeptAt(PLACE, true))
    expect(keptShowing(PLACE)).toBe(true)
    hook.unmount()
    vi.advanceTimersByTime(KEPT_GONE_MS)
    expect(keptShowing(PLACE)).toBe(false)
  })
})

describe('the page’s note holding the notice back (`useNoteHolds`)', () => {
  type Note = Pick<KeptNote, 'phase' | 'tone'>

  /** The note as KeptCopyNote says it shows: held while it holds. */
  function mountNote(first: Note) {
    let note = first
    const hook = hookHarness.mount(() => {
      const holds = useNoteHolds(note)
      useShowKeptAt(PLACE, holds)
      return holds
    })
    return {
      holds: () => hook.current(),
      say: (next: Note) => {
        note = next
        hook.rerender()
      },
    }
  }

  test('no signal, then the socket open again and nothing confirmed, then "Up to date.": held throughout, and a moment after', () => {
    const note = mountNote({ phase: 'shown', tone: 'no-signal' })
    expect(note.holds()).toBe(true)
    expect(keptShowing(PLACE)).toBe(true)
    note.say({ phase: 'shown', tone: 'kept' })
    // The first answer on the new line takes a while on one bar.
    vi.advanceTimersByTime(KEPT_AFTER_DOWN_MS - 1)
    expect(note.holds()).toBe(true)
    expect(keptShowing(PLACE)).toBe(true)
    note.say({ phase: 'shown', tone: 'live' })
    expect(note.holds()).toBe(false)
    expect(keptShowing(PLACE)).toBe(true)
    vi.advanceTimersByTime(KEPT_GONE_MS)
    expect(keptShowing(PLACE)).toBe(false)
  })

  test('a line that opens and never answers gets its notice once a fresh page’s answers would have', () => {
    const note = mountNote({ phase: 'shown', tone: 'unreachable' })
    note.say({ phase: 'shown', tone: 'kept' })
    vi.advanceTimersByTime(KEPT_AFTER_DOWN_MS)
    expect(note.holds()).toBe(false)
    vi.advanceTimersByTime(KEPT_GONE_MS)
    expect(keptShowing(PLACE)).toBe(false)
  })

  test('the line down again and back is timed afresh', () => {
    const note = mountNote({ phase: 'shown', tone: 'no-signal' })
    note.say({ phase: 'shown', tone: 'kept' })
    vi.advanceTimersByTime(KEPT_AFTER_DOWN_MS - 1_000)
    note.say({ phase: 'shown', tone: 'no-signal' })
    note.say({ phase: 'shown', tone: 'kept' })
    vi.advanceTimersByTime(KEPT_AFTER_DOWN_MS - 1)
    expect(note.holds()).toBe(true)
    vi.advanceTimersByTime(1)
    expect(note.holds()).toBe(false)
  })

  test('holds nothing while hydrating, as the server drew it, nor for a note that never said the line was down', () => {
    const note = mountNote({ phase: 'hydrating', tone: 'kept' })
    expect(note.holds()).toBe(false)
    note.say({ phase: 'shown', tone: 'kept' })
    expect(note.holds()).toBe(false)
    expect(keptShowing(PLACE)).toBe(false)
  })
})

describe('whether the note is on screen (`useOnScreen`)', () => {
  type Callback = (
    entries: Array<{ isIntersecting: boolean; intersectionRatio: number }>,
  ) => void

  test('taken as on screen until the browser says, then as it says, and the same with nothing to watch', () => {
    let tell: Callback = () => {}
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: Callback) {
          tell = callback
        }
        observe() {}
        disconnect() {}
      },
    )
    const node = {} as Element
    const onScreen = hookHarness.mount(() => useOnScreen(node))
    expect(onScreen.current()).toBe(true)
    tell([{ isIntersecting: false, intersectionRatio: 0 }])
    expect(onScreen.current()).toBe(false)
    tell([{ isIntersecting: true, intersectionRatio: 1 }])
    expect(onScreen.current()).toBe(true)
    expect(hookHarness.mount(() => useOnScreen(null)).current()).toBe(true)
  })
})

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { hookHarness } from '#/lib/offline/hooks.fixtures'
import { useSaveWarnings } from './SaveWarnings'
import { FIX_ARM_MS, SUBMIT_ARM_MS } from './saveWarningRules'
import type { SaveWarning } from './saveWarningRules'
import type * as React from 'react'

// React's hooks run here by the harness, timers included: there is no
// document to render into.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof React>()),
  ...(await import('#/lib/offline/hooks.fixtures')).hookHarness.hooks,
}))
// A fix is applied and drawn at once in the browser; here, just applied.
vi.mock('react-dom', () => ({ flushSync: (change: () => void) => change() }))

/**
 * The panel comes in above Book, under the thumb that pressed it (RK5): a
 * double tap must book nothing and apply nothing. So in a form that asks
 * for it (`arm`) Book takes no press for SUBMIT_ARM_MS, and a fix no tap for
 * FIX_ARM_MS, after the list comes in or changes under a press, or after a
 * fix, shown `armed` and `fixArmed` for their `aria-disabled`. A list that
 * only shrinks as a field is edited holds nothing, and a form that doesn't
 * ask is as it always was.
 */

const AT = Date.UTC(2026, 10, 1, 1)

const jane: SaveWarning = {
  id: 'match:c_jane',
  kind: 'match',
  label: 'Already a client',
  message: 'Jane Nguyen, of Bayswater, has the same name and mobile.',
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(AT)
})

afterEach(() => {
  hookHarness.mount(() => null)
  vi.useRealTimers()
})

const press = () => ({ preventDefault: vi.fn() })

function form(options?: { arm?: boolean }) {
  const hook = hookHarness.mount(() => useSaveWarnings(options))
  const save = vi.fn()
  const apply = vi.fn()
  hook
    .current()
    .fields.register('match', () => [
      { ...jane, fix: { label: 'Use Jane Nguyen', apply } },
    ])
  return { hook, save, apply }
}

describe('Book, as the list comes in (`arm`)', () => {
  test('a second press within half a second books nothing, and says so with `armed`', () => {
    const { hook, save } = form({ arm: true })
    expect(hook.current().armed).toBe(false)

    const first = press()
    hook.current().guard(first, save)
    expect(first.preventDefault).toHaveBeenCalled()
    expect(hook.current().warnings.map((w) => w.id)).toEqual([jane.id])
    expect(hook.current().armed).toBe(true)
    expect(hook.current().isArmed()).toBe(true)

    // The second tap of a double tap.
    vi.advanceTimersByTime(80)
    const second = press()
    hook.current().guard(second, save)
    expect(second.preventDefault).toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    expect(hook.current().warnings).toHaveLength(1)

    vi.advanceTimersByTime(SUBMIT_ARM_MS - 81)
    expect(hook.current().armed).toBe(true)
    vi.advanceTimersByTime(1)
    expect(hook.current().armed).toBe(false)
    expect(hook.current().isArmed()).toBe(false)

    // Read, and pressed again: Book anyway books.
    hook.current().guard(press(), save)
    expect(save).toHaveBeenCalledTimes(1)
  })

  test('a list that only shrinks as a field is edited holds nothing: Book then is meant', () => {
    const { hook, save } = form({ arm: true })
    hook.current().guard(press(), save)
    vi.advanceTimersByTime(SUBMIT_ARM_MS)
    expect(hook.current().armed).toBe(false)
    // The person edits the field, and its row goes: nothing came in under a
    // thumb, so the next press is taken at once.
    hook.current().fields.edited('match')
    expect(hook.current().warnings).toEqual([])
    expect(hook.current().armed).toBe(false)
    expect(hook.current().isArmed()).toBe(false)
    const next = press()
    hook.current().guard(next, save)
    // Taken: the checks ran again, and found the row again, a new set to
    // read, which holds once more.
    expect(hook.current().warnings).toHaveLength(1)
    expect(hook.current().armed).toBe(true)
    // So too a reset: another client mode chosen by hand.
    vi.advanceTimersByTime(SUBMIT_ARM_MS)
    hook.current().reset()
    expect(hook.current().warnings).toEqual([])
    expect(hook.current().armed).toBe(false)
    expect(save).not.toHaveBeenCalled()
  })

  test('a form that doesn’t ask for it saves on the second press as it always did', () => {
    const { hook, save } = form()
    hook.current().guard(press(), save)
    expect(hook.current().armed).toBe(false)
    expect(hook.current().isArmed()).toBe(false)
    hook.current().guard(press(), save)
    expect(save).toHaveBeenCalledTimes(1)
  })
})

describe('a fix, as the list comes in', () => {
  test('takes no tap for 400 ms in a form that asks, `fixArmed` meanwhile', () => {
    const { hook, save } = form({ arm: true })
    hook.current().guard(press(), save)
    expect(hook.current().fixArmed).toBe(true)
    expect(hook.current().fixIgnored()).toBe(true)
    vi.advanceTimersByTime(FIX_ARM_MS - 1)
    expect(hook.current().fixIgnored()).toBe(true)
    vi.advanceTimersByTime(1)
    expect(hook.current().fixArmed).toBe(false)
    expect(hook.current().fixIgnored()).toBe(false)
  })

  test('in any other form, a fix is taken at once, as it always was', () => {
    const { hook, save } = form()
    hook.current().guard(press(), save)
    expect(hook.current().fixArmed).toBe(false)
    expect(hook.current().fixIgnored()).toBe(false)
  })

  test('applied, it takes its row, and the button is held again', () => {
    const { hook, save, apply } = form({ arm: true })
    hook.current().guard(press(), save)
    vi.advanceTimersByTime(SUBMIT_ARM_MS)
    const [row] = hook.current().warnings
    hook.current().fields.fix(row as SaveWarning & { source: string })
    expect(apply).toHaveBeenCalledTimes(1)
    expect(hook.current().warnings).toEqual([])
    // The second tap of a double tap on the fix lands on whatever moved up
    // under it, Book among them.
    expect(hook.current().armed).toBe(true)
    expect(hook.current().isArmed()).toBe(true)
  })
})

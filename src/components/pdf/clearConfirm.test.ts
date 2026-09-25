import { describe, expect, it } from 'vitest'
import {
  CLEAR_ARM_MS,
  CLEAR_CONFIRM_MS,
  armedFor,
  tapClear,
} from './clearConfirm'

/**
 * Clearing a page of your marks takes two taps on the same button, close
 * together, on the same page — the viewer cannot ask through a dialog (see
 * `clearConfirm.ts`), so this is the whole of the safety catch.
 */

describe('tapClear', () => {
  it('asks first, and clears on the second tap', () => {
    const first = tapClear(null, 2, 1000)
    expect(first.clear).toBe(false)
    expect(armedFor(first.confirm, 2, 1000)).toBe(true)

    const second = tapClear(first.confirm, 2, 1000 + CLEAR_CONFIRM_MS - 1)
    expect(second).toEqual({ confirm: null, clear: true })
  })

  it('asks again once the wait runs out', () => {
    const first = tapClear(null, 2, 1000)
    expect(armedFor(first.confirm, 2, 1000 + CLEAR_CONFIRM_MS)).toBe(false)
    const late = tapClear(first.confirm, 2, 1000 + CLEAR_CONFIRM_MS)
    expect(late.clear).toBe(false)
    // …which is itself a first tap, waiting from now.
    expect(late.confirm).toEqual({ page: 2, at: 1000 + CLEAR_CONFIRM_MS })
  })

  it('never clears a page other than the one the first tap was for', () => {
    // Tapped on page 3, scrolled to page 4, tapped again.
    const first = tapClear(null, 2, 1000)
    expect(armedFor(first.confirm, 3, 1100)).toBe(false)
    const elsewhere = tapClear(first.confirm, 3, 1100)
    expect(elsewhere.clear).toBe(false)
    expect(elsewhere.confirm).toEqual({ page: 3, at: 1100 })
  })

  it('takes a double-tap as one tap, not as the answer', () => {
    // A thumb bouncing on the button: two clicks 150 ms apart.
    const first = tapClear(null, 2, 1000)
    const bounce = tapClear(first.confirm, 2, 1150)
    expect(bounce.clear).toBe(false)
    // Still asking, and still from the first tap: the bounce neither starts
    // the wait again nor ends it.
    expect(bounce.confirm).toBe(first.confirm)
    expect(armedFor(bounce.confirm, 2, 1150)).toBe(true)

    // Just before the question has been up long enough to have been read…
    expect(tapClear(first.confirm, 2, 1000 + CLEAR_ARM_MS - 1).clear).toBe(
      false,
    )
    // …and from then on, a real second tap.
    expect(tapClear(bounce.confirm, 2, 1000 + CLEAR_ARM_MS)).toEqual({
      confirm: null,
      clear: true,
    })
  })
})

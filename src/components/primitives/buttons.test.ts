import { describe, expect, test } from 'vitest'
import { HELD_BUTTON, PRIMARY_BUTTON } from './buttons'

/**
 * A button held for the half-second after the list above it came in
 * (`useSaveWarnings({ arm: true })`): seen to be held, never greyed.
 */
describe('HELD_BUTTON', () => {
  test('keeps the button pressed in while it is aria-disabled, at a button’s own press depth', () => {
    const pressed = /(?:^|\s)active:(scale-\[[^\]]+\])/.exec(
      PRIMARY_BUTTON,
    )?.[1]
    expect(pressed).toBeDefined()
    expect(HELD_BUTTON.split(/\s+/)).toContain(`aria-disabled:${pressed}`)
  })

  test('is not dimmed: half a second of grey would flash', () => {
    expect(HELD_BUTTON).not.toMatch(/opacity/)
  })
})

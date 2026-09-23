import { describe, expect, test } from 'vitest'
import {
  HOLD_MS,
  IDLE,
  TOUCH_CLICK_WINDOW_MS,
  acceptsClick,
  holdProgress,
  holdStep,
  releasedInside,
} from './holdGesture'
import type { HoldEvent, HoldPhase } from './holdGesture'

/** Runs a sequence of events and returns every effect, in order. */
function run(events: Array<HoldEvent>) {
  let phase: HoldPhase = IDLE
  const effects: Array<string> = []
  for (const event of events) {
    const next = holdStep(phase, event)
    phase = next.phase
    effects.push(next.effect)
  }
  return { phase, effects }
}

describe('a touch on a hold button', () => {
  test('held to full and lifted on the button: acts, once, on the lift', () => {
    const { effects, phase } = run([
      { type: 'down', at: 0 },
      { type: 'frame', at: 300 },
      { type: 'frame', at: HOLD_MS },
      { type: 'up', inside: true },
    ])
    expect(effects).toEqual(['none', 'none', 'armed', 'act'])
    expect(phase).toEqual(IDLE)
  })

  test('the fill completing does not act by itself — only the lift does', () => {
    const { effects } = run([
      { type: 'down', at: 0 },
      { type: 'frame', at: HOLD_MS + 5000 },
      { type: 'frame', at: HOLD_MS + 6000 },
    ])
    expect(effects).not.toContain('act')
  })

  test('a tap too short does not act, and asks to be held', () => {
    const { effects } = run([
      { type: 'down', at: 0 },
      { type: 'frame', at: 120 },
      { type: 'up', inside: true },
    ])
    expect(effects).toEqual(['none', 'none', 'hint'])
  })

  test('held to full and slid off before lifting: cancelled, silently', () => {
    const { effects } = run([
      { type: 'down', at: 0 },
      { type: 'frame', at: HOLD_MS },
      { type: 'up', inside: false },
    ])
    expect(effects).toEqual(['none', 'armed', 'none'])
  })

  test('a scroll that starts on the button cancels it, even when full', () => {
    for (const at of [100, HOLD_MS]) {
      const { effects, phase } = run([
        { type: 'down', at: 0 },
        { type: 'frame', at },
        { type: 'cancel' },
        { type: 'up', inside: true },
      ])
      expect(effects).not.toContain('act')
      expect(phase).toEqual(IDLE)
    }
  })

  test('a lift with no touch down before it does nothing', () => {
    expect(run([{ type: 'up', inside: true }]).effects).toEqual(['none'])
  })
})

describe('the fill', () => {
  test('runs from empty to full over the hold, and stays full once armed', () => {
    const filling: HoldPhase = { name: 'filling', startedAt: 1000 }
    expect(holdProgress(IDLE, 5000)).toBe(0)
    expect(holdProgress(filling, 1000)).toBe(0)
    expect(holdProgress(filling, 1000 + HOLD_MS / 2)).toBeCloseTo(0.5)
    expect(holdProgress(filling, 1000 + HOLD_MS * 3)).toBe(1)
    expect(holdProgress({ name: 'armed' }, 0)).toBe(1)
  })
})

describe('a click', () => {
  test('from a mouse, a keyboard or a screen reader acts at once', () => {
    expect(acceptsClick({ down: false, lastUpAt: null }, 10_000)).toBe(true)
  })

  test('that belongs to a touch is ignored — while it is down, and just after', () => {
    expect(acceptsClick({ down: true, lastUpAt: null }, 10_000)).toBe(false)
    expect(acceptsClick({ down: false, lastUpAt: 10_000 }, 10_050)).toBe(false)
    expect(
      acceptsClick(
        { down: false, lastUpAt: 10_000 },
        10_000 + TOUCH_CLICK_WINDOW_MS,
      ),
    ).toBe(true)
  })
})

describe('where the finger lifts', () => {
  const rect = { left: 100, top: 100, right: 200, bottom: 144 }

  test('on the button, or just beside it, counts', () => {
    expect(releasedInside(rect, 150, 120)).toBe(true)
    expect(releasedInside(rect, 90, 150)).toBe(true)
  })

  test('well off it does not', () => {
    expect(releasedInside(rect, 150, 200)).toBe(false)
    expect(releasedInside(rect, 40, 120)).toBe(false)
  })
})

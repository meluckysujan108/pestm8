import { describe, expect, it } from 'vitest'
import {
  FLING_GUARD_MS,
  IDLE,
  OWN_SCROLL_MS,
  isOwnScroll,
  scrolledAt,
  stepInput,
} from './markupInput'
import type {
  InputEffect,
  InputEvent,
  InputState,
  OwnScroll,
} from './markupInput'

/**
 * One finger draws, two pan and zoom. The case that decides whether markup
 * mode is usable at all: a pinch always starts with one finger, which has
 * already begun a stroke by the time the second lands — and that stroke must
 * not be saved, nor another begun when the pinch's last finger lifts.
 */

const AT = 10_000

function down(
  pointerId: number,
  extra: Partial<Extract<InputEvent, { type: 'down' }>> = {},
): InputEvent {
  return {
    type: 'down',
    pointerId,
    pointerType: 'touch',
    page: 2,
    primaryButton: true,
    at: AT,
    lastScrollAt: 0,
    ...extra,
  }
}
const move = (pointerId: number): InputEvent => ({ type: 'move', pointerId })
const up = (pointerId: number): InputEvent => ({ type: 'up', pointerId })
const cancel = (pointerId: number): InputEvent => ({
  type: 'cancel',
  pointerId,
})
const fingers = (count: number): InputEvent => ({ type: 'fingers', count })

/** Runs `events` from `state`, returning the effects in order and the end. */
function run(
  events: Array<InputEvent>,
  state: InputState = IDLE,
): { effects: Array<InputEffect>; state: InputState } {
  const effects: Array<InputEffect> = []
  for (const event of events) {
    const step = stepInput(state, event)
    state = step.state
    effects.push(step.effect)
  }
  return { effects, state }
}

describe('stepInput', () => {
  it('draws with one finger, on the page it started on', () => {
    const { effects, state } = run([down(1), move(1), move(1), up(1)])
    expect(effects).toEqual(['start', 'extend', 'extend', 'finish'])
    expect(state).toBe(IDLE)
    expect(stepInput(IDLE, down(1, { page: 4 })).state).toMatchObject({
      kind: 'drawing',
      page: 4,
    })
  })

  it('throws the stroke away when a second finger lands, and draws nothing until both lift', () => {
    const { effects, state } = run([
      down(1),
      move(1),
      down(2), // the pinch begins
      move(1),
      move(2),
      up(2), // one finger lifts first…
      move(1), // …and the other goes on moving
      up(1),
    ])
    expect(effects).toEqual([
      'start',
      'extend',
      'discard',
      null,
      null,
      null,
      null,
      null,
    ])
    expect(state).toBe(IDLE)
    // And the next touch draws again.
    expect(stepInput(state, down(3)).effect).toBe('start')
  })

  it('throws the stroke away when the touch events count two fingers first', () => {
    const { effects, state } = run([
      down(1),
      move(1),
      fingers(2), // the pinch's touchstart, before the pointer's down
      down(2),
      up(2),
      up(1),
    ])
    expect(effects).toEqual(['start', 'extend', 'discard', null, null, null])
    // Every pointer is up, but the touch events have the last word.
    expect(state).toMatchObject({ kind: 'blocked' })
    expect(run([fingers(0)], state).state).toBe(IDLE)
  })

  it('never draws with a pinch’s second finger, even if the first pointer was cancelled', () => {
    const { effects, state } = run([
      down(1),
      cancel(1), // a browser taking the first finger back as the second lands
      down(2), // …whose own pointer would otherwise start a stroke
      fingers(2),
      move(2),
      up(2),
      down(3), // a third finger, while one of the pinch's is still down
      fingers(1),
    ])
    expect(effects).toEqual([
      'start',
      'discard',
      'start',
      'discard',
      null,
      null,
      null,
      null,
    ])
    expect(state).toMatchObject({ kind: 'blocked' })
    const lifted = run([fingers(0), down(4)], state)
    expect(lifted.effects).toEqual([null, 'start'])
  })

  it('counts neither a lone finger nor its lifting against a stroke', () => {
    const { effects, state } = run([
      down(1),
      fingers(1),
      move(1),
      fingers(0), // a touchend that beats the pointerup
      up(1),
    ])
    expect(effects).toEqual(['start', null, 'extend', null, 'finish'])
    expect(state).toBe(IDLE)
  })

  it('discards a stroke the browser cancels', () => {
    const { effects, state } = run([down(1), move(1), cancel(1)])
    expect(effects).toEqual(['start', 'extend', 'discard'])
    expect(state).toBe(IDLE)
  })

  it('ignores a touch that only stopped a fling, until it lifts', () => {
    const { effects, state } = run([
      down(1, { lastScrollAt: AT - FLING_GUARD_MS + 20 }),
      move(1),
    ])
    expect(effects).toEqual([null, null])
    expect(state).toMatchObject({ kind: 'blocked' })
    expect(run([up(1)], state).state).toBe(IDLE)
    // A touch once the pages have been still long enough draws.
    expect(
      stepInput(IDLE, down(2, { lastScrollAt: AT - FLING_GUARD_MS })).effect,
    ).toBe('start')
    // A pencil stops a fling as a finger does; a mouse stops nothing.
    const justScrolled = { lastScrollAt: AT - 10 }
    expect(
      stepInput(IDLE, down(3, { ...justScrolled, pointerType: 'pen' })).effect,
    ).toBeNull()
    expect(
      stepInput(IDLE, down(4, { ...justScrolled, pointerType: 'mouse' }))
        .effect,
    ).toBe('start')
  })

  it('leaves a finger between the pages to scroll, and a second one then does not draw', () => {
    const { effects, state } = run([down(1, { page: null }), down(2), move(2)])
    expect(effects).toEqual([null, null, null])
    expect(run([up(1), up(2)], state).state).toBe(IDLE)
  })

  it('draws only with a mouse’s main button', () => {
    expect(
      stepInput(IDLE, down(1, { pointerType: 'mouse', primaryButton: false }))
        .effect,
    ).toBeNull()
    expect(stepInput(IDLE, down(1, { pointerType: 'mouse' })).effect).toBe(
      'start',
    )
  })

  it('does not stay blocked when a release was never seen', () => {
    // A right-click let go outside the window, then a normal press.
    const { state } = run([
      down(1, { pointerType: 'mouse', primaryButton: false }),
    ])
    expect(stepInput(state, down(1, { pointerType: 'mouse' })).effect).toBe(
      'start',
    )
  })

  it('keeps a pencil stroke going under a resting palm', () => {
    const pen = { pointerType: 'pen' }
    const { effects, state } = run([
      down(1, pen),
      move(1),
      down(2), // the palm
      fingers(1), // the pencil is not a finger: one palm is not a pinch
      move(2),
      move(1),
      up(2),
      move(1),
      up(1),
    ])
    expect(effects).toEqual([
      'start',
      'extend',
      null,
      null,
      null,
      'extend',
      null,
      'extend',
      'finish',
    ])
    expect(state).toBe(IDLE)
  })

  it('still lets a second finger end a finger’s stroke — only pencils have palms', () => {
    const { effects } = run([down(1), down(2, { pointerType: 'pen' })])
    expect(effects).toEqual(['start', 'discard'])
  })

  it('ends a full stroke where it is, and ignores the rest of that touch', () => {
    const { effects, state } = run([down(1), move(1), { type: 'full' }])
    expect(effects).toEqual(['start', 'extend', 'finish'])
    const after = run([move(1), up(1)], state)
    expect(after.effects).toEqual([null, null])
    expect(after.state).toBe(IDLE)
  })

  it('pays no attention to pointers it never saw go down', () => {
    // A mouse moving over the page with no button pressed, or a finger that
    // landed before markup mode began.
    expect(run([move(7), up(7), cancel(7)]).effects).toEqual([null, null, null])
  })
})

describe('scrolledAt', () => {
  it('draws a stroke started just after a two-finger pan, whose commit scrolled the pages', () => {
    // The pan's fingers lift at 1000; it settles for 200 ms and is committed
    // at 1210 as a scroll to y = 800, whose `scroll` event arrives a frame
    // later. A finger lands to circle something 100 ms after that.
    const own: OwnScroll = { x: 0, y: 800, at: 1210 }
    const lastScrollAt = scrolledAt(
      Number.NEGATIVE_INFINITY,
      own,
      { x: 0, y: 800 },
      1226,
    )
    expect(lastScrollAt).toBe(Number.NEGATIVE_INFINITY)
    expect(stepInput(IDLE, down(1, { at: 1326, lastScrollAt })).effect).toBe(
      'start',
    )
  })

  it('still counts the browser’s own scrolling, which a touch may be stopping', () => {
    const own: OwnScroll = { x: 0, y: 800, at: 1210 }
    // A fling from a gap between the pages, moving on from where the commit
    // left them.
    expect(scrolledAt(0, own, { x: 0, y: 812 }, 1240)).toBe(1240)
    // Long after the commit, even at the same place.
    expect(scrolledAt(0, own, { x: 0, y: 800 }, 1210 + OWN_SCROLL_MS)).toBe(
      1210 + OWN_SCROLL_MS,
    )
    // With no write of the viewer's own to compare against.
    expect(scrolledAt(0, null, { x: 0, y: 800 }, 1240)).toBe(1240)
  })

  it('knows its own scroll only where it left the pages, give or take a pixel', () => {
    const own: OwnScroll = { x: 40, y: 800, at: 1000 }
    expect(isOwnScroll(own, { x: 40.4, y: 799.6 }, 1016)).toBe(true)
    expect(isOwnScroll(own, { x: 42, y: 800 }, 1016)).toBe(false)
    expect(isOwnScroll(own, { x: 40, y: 800 }, 1000 + OWN_SCROLL_MS)).toBe(
      false,
    )
  })
})

/**
 * Who gets a touch in markup mode: the pen, or the pinch.
 *
 * One finger (or a mouse, or a pencil) draws; two fingers pan and zoom, the
 * way iOS Markup splits them. A pinch always starts with one finger landing
 * before the other, so the first finger has already begun a stroke by the
 * time the second arrives — the second finger then throws that stroke away,
 * and nothing more is drawn until every finger is up, so the pinch's last
 * finger lifting does not leave a squiggle behind it.
 *
 * Two witnesses say a second finger has landed, and either is enough: its
 * own `pointerdown`, and a touch event counting two fingers on the glass. The
 * pinch itself runs on the touch events, so they are the ones that cannot be
 * wrong about it; the pointer events alone would draw a line across the page
 * with the pinch's second finger if a browser ever cancelled the first
 * pointer as the second one landed.
 *
 * Pure, and fed the events one at a time, so every case — the second finger,
 * a cancelled touch, a touch that only stopped a fling, a palm under a pencil
 * — can be tested without a screen.
 */

/**
 * A touch this soon after the pages last scrolled stopped a fling: that is
 * all it was for, on iOS, and the tap code already ignores it as a tap. As a
 * stroke it would be a stray dot wherever the finger happened to catch the
 * page. Not a mouse's press, which stops nothing — a click just after the
 * wheel is a click.
 */
export const FLING_GUARD_MS = 100

/**
 * Where the viewer itself last set the scroll, and when: a zoom or a pan
 * being committed, a page picked from the grid.
 *
 * Only the browser's own scrolling can be a fling. The viewer's writes fire
 * `scroll` events too, and in markup mode every two-finger pan ends in one —
 * the pan settles for 200 ms and is then committed as a scroll — so without
 * telling them apart, a finger put down to circle something just after a pan
 * would count as stopping a fling that never happened, and draw nothing.
 * Pan, then draw, is the whole rhythm of marking up a page.
 */
export type OwnScroll = { x: number; y: number; at: number }

/**
 * How long after the viewer sets the scroll its `scroll` event may take to
 * arrive: the next frame, normally, or a few later on a phone busy laying the
 * pages out at a new zoom.
 */
export const OWN_SCROLL_MS = 500

/**
 * Whether a `scroll` event at `at` is the viewer's own write arriving: soon
 * after it, with the pages exactly where it put them. A scroll of the
 * browser's own always moves them somewhere else.
 */
export function isOwnScroll(
  own: OwnScroll | null,
  at: { x: number; y: number },
  now: number,
): boolean {
  return (
    own !== null &&
    now - own.at < OWN_SCROLL_MS &&
    Math.abs(at.x - own.x) < 1 &&
    Math.abs(at.y - own.y) < 1
  )
}

/**
 * When the pages last scrolled, as far as the fling guard is concerned, after
 * a `scroll` event at `now`: then, for the browser's scrolling, and unchanged
 * for the viewer's own.
 */
export function scrolledAt(
  lastScrollAt: number,
  own: OwnScroll | null,
  at: { x: number; y: number },
  now: number,
): number {
  return isOwnScroll(own, at, now) ? lastScrollAt : now
}

export type InputState =
  | { kind: 'idle' }
  | {
      kind: 'drawing'
      pointerId: number
      pointerType: string
      /** The 0-based page the stroke started on, and stays on. */
      page: number
      /** Touches resting under a pencil stroke: a palm, not a gesture. */
      palms: ReadonlySet<number>
    }
  | {
      /** Nothing draws until every one of these pointers is up… */
      kind: 'blocked'
      down: ReadonlySet<number>
      /** …and, after a two-finger gesture, until no finger is on the glass. */
      fingers: boolean
    }

export const IDLE: InputState = { kind: 'idle' }

export type InputEvent =
  | {
      type: 'down'
      pointerId: number
      pointerType: string
      /** The page under it, or null when it landed between pages. */
      page: number | null
      /** False for a mouse's right or middle button. */
      primaryButton: boolean
      at: number
      lastScrollAt: number
    }
  | { type: 'move'; pointerId: number }
  | { type: 'up'; pointerId: number }
  | { type: 'cancel'; pointerId: number }
  /** The stroke reached `MAX_STROKE_POINTS`. */
  | { type: 'full' }
  /**
   * A touch event: how many fingers are on the glass now. Pencils are not
   * counted — a pencil and a resting palm are not a pinch.
   */
  | { type: 'fingers'; count: number }

/**
 * What the caller does with the event: begin a stroke at it, add it to the
 * stroke, save the stroke (with it), throw the stroke away — or nothing.
 */
export type InputEffect = 'start' | 'extend' | 'finish' | 'discard' | null

export type InputStep = { state: InputState; effect: InputEffect }

function without(set: ReadonlySet<number>, id: number): ReadonlySet<number> {
  if (!set.has(id)) return set
  const next = new Set(set)
  next.delete(id)
  return next
}

function blocked(down: ReadonlySet<number>, fingers: boolean): InputState {
  return down.size === 0 && !fingers ? IDLE : { kind: 'blocked', down, fingers }
}

export function stepInput(state: InputState, event: InputEvent): InputStep {
  if (event.type === 'fingers') return countFingers(state, event.count)
  switch (state.kind) {
    case 'idle': {
      if (event.type !== 'down') return { state, effect: null }
      const fling =
        event.pointerType !== 'mouse' &&
        event.at - event.lastScrollAt < FLING_GUARD_MS
      const draws = event.page !== null && event.primaryButton && !fling
      if (!draws || event.page === null) {
        // Held down until it lifts: a finger between the pages is scrolling,
        // and one that stopped a fling should not start drawing the moment
        // it moves.
        return {
          state: blocked(new Set([event.pointerId]), false),
          effect: null,
        }
      }
      return {
        state: {
          kind: 'drawing',
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          page: event.page,
          palms: new Set(),
        },
        effect: 'start',
      }
    }

    case 'drawing': {
      switch (event.type) {
        case 'down': {
          // A hand resting on the glass while a pencil writes is not a
          // second finger. (iPadOS rejects most palms itself; the rest
          // arrive here as touches.)
          if (state.pointerType === 'pen' && event.pointerType === 'touch') {
            const palms = new Set(state.palms)
            palms.add(event.pointerId)
            return { state: { ...state, palms }, effect: null }
          }
          // A second finger: a pinch or a pan, never part of the stroke.
          const down = new Set(state.palms)
          down.add(state.pointerId)
          down.add(event.pointerId)
          return { state: blocked(down, false), effect: 'discard' }
        }
        case 'move':
          return {
            state,
            effect: event.pointerId === state.pointerId ? 'extend' : null,
          }
        case 'up':
          if (event.pointerId === state.pointerId) {
            return { state: IDLE, effect: 'finish' }
          }
          return {
            state: { ...state, palms: without(state.palms, event.pointerId) },
            effect: null,
          }
        case 'cancel':
          // The browser took the touch back — a system gesture, an alert —
          // and what was drawn so far is not what anyone finished.
          if (event.pointerId === state.pointerId) {
            return { state: IDLE, effect: 'discard' }
          }
          return {
            state: { ...state, palms: without(state.palms, event.pointerId) },
            effect: null,
          }
        case 'full':
          // Saved as it stands; the rest of this touch draws nothing.
          return {
            state: blocked(new Set([state.pointerId]), false),
            effect: 'finish',
          }
      }
      return { state, effect: null }
    }

    case 'blocked': {
      switch (event.type) {
        case 'down': {
          // The same pointer pressing again means its release was never
          // seen (a mouse let go outside the window): start afresh rather
          // than stay blocked for good.
          if (state.down.has(event.pointerId) && !state.fingers) {
            return stepInput(IDLE, event)
          }
          const down = new Set(state.down)
          down.add(event.pointerId)
          return { state: blocked(down, state.fingers), effect: null }
        }
        case 'up':
        case 'cancel':
          return {
            state: blocked(without(state.down, event.pointerId), state.fingers),
            effect: null,
          }
      }
      return { state, effect: null }
    }
  }
}

function countFingers(state: InputState, count: number): InputStep {
  if (count >= 2) {
    // Two fingers on the glass, whichever way that became known first.
    if (state.kind === 'drawing') {
      const down = new Set(state.palms)
      down.add(state.pointerId)
      return { state: blocked(down, true), effect: 'discard' }
    }
    if (state.kind === 'blocked') {
      return { state: { ...state, fingers: true }, effect: null }
    }
    return { state: blocked(new Set(), true), effect: null }
  }
  if (count === 0 && state.kind === 'blocked') {
    // Every finger is up. A pointer still listed is one whose release was
    // lost (a cancelled pointer sends nothing more), not one still down.
    return { state: IDLE, effect: null }
  }
  return { state, effect: null }
}

/**
 * The hold-to-act gesture (§2.3), as a state machine with no DOM in it, so
 * every rule below is unit-tested rather than trusted.
 *
 * Hold until the fill completes, then lift to act. It ACTS ON RELEASE, not at
 * the moment the fill completes, for one reason: a phone only lets a page
 * open a new tab (the Map) from an event the browser counts as the user's —
 * and for touch that is the finger lifting, never a timer that runs while it
 * is still down. Acting at full fill would leave the Map popup-blocked on
 * iOS, and on Android whenever no tap had come in the last few seconds. One
 * gesture for all four buttons keeps them learnable: Call, Text and Email
 * lift-to-act exactly as the Map does.
 *
 * Only touch and pen are held. A mouse click and a keyboard press are
 * deliberate by nature, so a click with no touch anywhere on the page just
 * before it acts at once — see `acceptsClick`. That includes a screen
 * reader's activation where it arrives as a plain click (Android's does; how
 * iOS VoiceOver delivers a double-tap here is still to be checked on a device).
 */

export const HOLD_MS = 650

/** How long after a touch ends the click the browser sends for it is still
 * that touch's, and ignored. */
export const TOUCH_CLICK_WINDOW_MS = 700

/** Lifting this far outside the button still counts as on it; further is a
 * deliberate slide-off, which cancels (WCAG 2.5.2). Moving the finger this far
 * from where it went down cancels too — the sheets move with a drag, so the
 * button can stay under a finger that is dismissing it. */
export const RELEASE_SLOP_PX = 16

export type HoldPhase =
  { name: 'idle' } | { name: 'filling'; startedAt: number } | { name: 'armed' }

export type HoldEvent =
  | { type: 'down'; at: number }
  | { type: 'frame'; at: number }
  | { type: 'up'; at: number; inside: boolean }
  | { type: 'cancel' }

/**
 * What the button does after an event:
 * - `act` — the hold completed and the finger lifted on the button;
 * - `hint` — lifted too soon, so say it has to be held;
 * - `armed` — the fill has just completed: lifting now will act;
 * - `none` — nothing to do.
 */
export type HoldEffect = 'act' | 'hint' | 'armed' | 'none'

export const IDLE: HoldPhase = { name: 'idle' }

export function holdStep(
  phase: HoldPhase,
  event: HoldEvent,
): { phase: HoldPhase; effect: HoldEffect } {
  switch (event.type) {
    case 'down':
      return { phase: { name: 'filling', startedAt: event.at }, effect: 'none' }
    case 'frame':
      if (phase.name === 'filling' && event.at - phase.startedAt >= HOLD_MS) {
        return { phase: { name: 'armed' }, effect: 'armed' }
      }
      return { phase, effect: 'none' }
    case 'up':
      // Held long enough counts even if the frame that would have armed it
      // never ran — a busy phone can deliver the lift before the next frame.
      if (
        phase.name === 'armed' ||
        (phase.name === 'filling' && event.at - phase.startedAt >= HOLD_MS)
      ) {
        return { phase: IDLE, effect: event.inside ? 'act' : 'none' }
      }
      if (phase.name === 'filling') {
        return { phase: IDLE, effect: event.inside ? 'hint' : 'none' }
      }
      return { phase: IDLE, effect: 'none' }
    case 'cancel':
      // The browser took the pointer — a scroll starting on the button — or
      // the button went away. Never an action.
      return { phase: IDLE, effect: 'none' }
  }
}

/** How full the fill is, 0 to 1. */
export function holdProgress(phase: HoldPhase, now: number): number {
  if (phase.name === 'armed') return 1
  if (phase.name === 'filling') {
    return Math.min(1, Math.max(0, (now - phase.startedAt) / HOLD_MS))
  }
  return 0
}

/**
 * Whether a click should act. A click that belongs to a touch — the one the
 * browser sends after a finger lifts — is ignored: the touch already acted,
 * or was a tap too short to. Any other click is a mouse or a keyboard, and
 * acts.
 *
 * `lastTouchAt` is the last touch ANYWHERE on the page, not only on this
 * button: an iPhone moves a near miss onto the nearest button — a thumb in
 * the gap between Call and Text sends its click to one of them, though
 * neither saw the finger — and that click must not dial either.
 */
export function acceptsClick(
  touch: { down: boolean; lastTouchAt: number | null },
  now: number,
): boolean {
  if (touch.down) return false
  return (
    touch.lastTouchAt === null ||
    now - touch.lastTouchAt >= TOUCH_CLICK_WINDOW_MS
  )
}

/** Whether a finger has moved far enough from where it went down to stop
 * counting as a hold. */
export function movedAway(
  start: { x: number; y: number },
  x: number,
  y: number,
): boolean {
  return Math.hypot(x - start.x, y - start.y) > RELEASE_SLOP_PX
}

/** Whether a finger lifted at (x, y) is on the button, give or take the slop. */
export function releasedInside(
  rect: { left: number; top: number; right: number; bottom: number },
  x: number,
  y: number,
): boolean {
  return (
    x >= rect.left - RELEASE_SLOP_PX &&
    x <= rect.right + RELEASE_SLOP_PX &&
    y >= rect.top - RELEASE_SLOP_PX &&
    y <= rect.bottom + RELEASE_SLOP_PX
  )
}

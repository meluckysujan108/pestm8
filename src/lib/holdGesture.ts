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
 * deliberate by nature, as is a screen reader's double-tap (a click with no
 * touch before it), so those act at once — see `acceptsClick`.
 */

export const HOLD_MS = 650

/** How long after a touch ends the click the browser sends for it is still
 * that touch's, and ignored. */
export const TOUCH_CLICK_WINDOW_MS = 700

/** Lifting this far outside the button still counts as on it; further is a
 * deliberate slide-off, which cancels (WCAG 2.5.2). */
export const RELEASE_SLOP_PX = 16

export type HoldPhase =
  { name: 'idle' } | { name: 'filling'; startedAt: number } | { name: 'armed' }

export type HoldEvent =
  | { type: 'down'; at: number }
  | { type: 'frame'; at: number }
  | { type: 'up'; inside: boolean }
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
      if (phase.name === 'armed') {
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
 * or was a tap too short to. Any other click is a mouse, a keyboard or a
 * screen reader, and acts.
 */
export function acceptsClick(
  touch: { down: boolean; lastUpAt: number | null },
  now: number,
): boolean {
  if (touch.down) return false
  return (
    touch.lastUpAt === null || now - touch.lastUpAt >= TOUCH_CLICK_WINDOW_MS
  )
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

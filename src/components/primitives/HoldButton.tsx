import { useCallback, useEffect, useRef, useState } from 'react'
import {
  IDLE,
  acceptsClick,
  holdProgress,
  holdStep,
  movedAway,
  releasedInside,
} from '#/lib/holdGesture'
import type { HoldEvent, HoldPhase } from '#/lib/holdGesture'
import type { ReactNode } from 'react'

/** How long "Hold" shows after a tap too short to act. */
const HINT_MS = 1400

/**
 * When a finger or pen last touched anywhere on the page. One listener for
 * the whole page, in the capture phase so it sees every touch before any
 * button does — see `acceptsClick` for why a button's own history is not
 * enough.
 */
let lastPageTouchAt: number | null = null
let listening = false
function listenForTouches() {
  if (listening) return
  listening = true
  const note = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') lastPageTouchAt = performance.now()
  }
  for (const type of ['pointerdown', 'pointerup', 'pointercancel'] as const) {
    window.addEventListener(type, note, { capture: true, passive: true })
  }
}

/**
 * Hold-to-act (§2.3): Call, Text, Email and Map, on the job card and in the
 * sheets. A touch fills the button; lifting after it is full acts, lifting
 * sooner shows `hint`, and sliding off or scrolling cancels. This exists so a
 * phone in a pocket, or a thumb brushing the screen on site, cannot dial a
 * client or leave the app. The rules, and why it acts on the lift rather than
 * when the fill completes, are in src/lib/holdGesture.ts.
 *
 * One button for every kind of pointer, decided per event: a touch or a pen
 * is held; a mouse click, a keyboard press and a screen reader's double-tap
 * act at once. It used to pick a branch from `(hover: none)`, which is false
 * until an effect runs — so for the first frame a phone got the unguarded
 * branch — and never true on a touchscreen laptop.
 */
export function HoldButton({
  onComplete,
  children,
  hint,
  className = '',
  ariaLabel,
  inScrollingList = false,
}: {
  /** The action. Called from inside the lift or the click itself, which is
   * what lets it open a new tab. */
  onComplete: () => void
  children: ReactNode
  /** Shown instead of `children` for a moment after a tap too short to act,
   * e.g. "Hold". Without one, the fill alone is the feedback. */
  hint?: ReactNode
  className?: string
  ariaLabel?: string
  /**
   * The button sits in a list the thumb scrolls — a job card. With the usual
   * `touch-action: none`, a flick that starts on it cannot scroll the list at
   * all, which on a phone full of cards is a dead strip across every one.
   * This lets the browser take a vertical drag; when it does it cancels the
   * pointer, and a cancelled pointer cancels the hold, so a scroll never
   * acts. A thumb held still still has to hold for the full time.
   */
  inScrollingList?: boolean
}) {
  const phase = useRef<HoldPhase>(IDLE)
  const touch = useRef<{
    down: boolean
    lastUpAt: number | null
    start: { x: number; y: number }
  }>({ down: false, lastUpAt: null, start: { x: 0, y: 0 } })
  const frame = useRef<number | null>(null)
  const hintTimer = useRef<number | null>(null)
  const [progress, setProgress] = useState(0)
  const [armed, setArmed] = useState(false)
  const [hinting, setHinting] = useState(false)

  const stopFrames = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
  }

  useEffect(() => {
    listenForTouches()
    return () => {
      stopFrames()
      if (hintTimer.current !== null) clearTimeout(hintTimer.current)
    }
  }, [])

  const dispatch = useCallback((event: HoldEvent) => {
    const next = holdStep(phase.current, event)
    phase.current = next.phase
    setProgress(holdProgress(next.phase, performance.now()))
    setArmed(next.phase.name === 'armed')
    if (next.phase.name !== 'filling') stopFrames()
    return next.effect
  }, [])

  const tick = useCallback(() => {
    const effect = dispatch({ type: 'frame', at: performance.now() })
    // A tick of the motor where there is one (Android): the fill is full,
    // and lifting now will act. The DOM types say every browser has it;
    // Safari does not, and calling it there would throw mid-hold.
    if (effect === 'armed' && 'vibrate' in navigator) navigator.vibrate(10)
    if (phase.current.name === 'filling') {
      frame.current = requestAnimationFrame(tick)
    }
  }, [dispatch])

  const showHint = () => {
    setHinting(true)
    if (hintTimer.current !== null) clearTimeout(hintTimer.current)
    hintTimer.current = window.setTimeout(() => setHinting(false), HINT_MS)
  }

  const status = armed
    ? 'Release to confirm'
    : progress > 0
      ? 'Keep holding to confirm'
      : hinting
        ? 'Hold to confirm'
        : ''

  return (
    <>
      <button
        type="button"
        aria-label={ariaLabel}
        // touch-action/user-select/callout guards keep the browser from
        // stealing the pointer with a scroll, a selection or a long-press menu.
        className={`${inScrollingList ? 'hold-target-scroll' : 'hold-target'} relative overflow-hidden ${className}`}
        onPointerDown={(e) => {
          if (e.pointerType === 'mouse') return
          try {
            e.currentTarget.setPointerCapture(e.pointerId)
          } catch {
            // A pointer the browser has already let go of; the lift still
            // arrives, and a lift without a hold does nothing.
          }
          touch.current = {
            down: true,
            lastUpAt: touch.current.lastUpAt,
            start: { x: e.clientX, y: e.clientY },
          }
          setHinting(false)
          stopFrames()
          dispatch({ type: 'down', at: performance.now() })
          frame.current = requestAnimationFrame(tick)
        }}
        onPointerMove={(e) => {
          if (e.pointerType === 'mouse' || phase.current.name === 'idle') return
          // Measured against where the finger went down, not against the
          // button: in a sheet the button travels with a drag-to-dismiss.
          if (movedAway(touch.current.start, e.clientX, e.clientY)) {
            dispatch({ type: 'cancel' })
          }
        }}
        onPointerUp={(e) => {
          if (e.pointerType === 'mouse') return
          const at = performance.now()
          touch.current = { ...touch.current, down: false, lastUpAt: at }
          const effect = dispatch({
            type: 'up',
            at,
            inside: releasedInside(
              e.currentTarget.getBoundingClientRect(),
              e.clientX,
              e.clientY,
            ),
          })
          if (effect === 'act') onComplete()
          else if (effect === 'hint') showHint()
        }}
        onPointerCancel={(e) => {
          if (e.pointerType === 'mouse') return
          touch.current = {
            ...touch.current,
            down: false,
            lastUpAt: performance.now(),
          }
          dispatch({ type: 'cancel' })
        }}
        // Android turns a long press into a context menu, which would take the
        // pointer mid-hold.
        onContextMenu={(e) => e.preventDefault()}
        onClick={(e) => {
          const own = touch.current.lastUpAt ?? -Infinity
          const page = lastPageTouchAt ?? -Infinity
          const latest = Math.max(own, page)
          const history = {
            down: touch.current.down,
            lastTouchAt: Number.isFinite(latest) ? latest : null,
          }
          if (!acceptsClick(history, performance.now())) {
            e.preventDefault()
            return
          }
          onComplete()
        }}
      >
        <span
          aria-hidden
          className={`absolute inset-y-0 left-0 transition-none ${armed ? 'bg-blue/25' : 'bg-blue/15'}`}
          style={{ width: `${progress * 100}%` }}
        />
        <span className="relative flex min-w-0 max-w-full flex-col items-center gap-1">
          {hinting && hint !== undefined ? hint : children}
        </span>
      </button>
      {/* Beside the button, not in it: a button's contents are presentational
        to assistive technology, and VoiceOver never announces a live region
        inside one. Always mounted, so it exists before its text changes. */}
      <span className="sr-only" role="status">
        {status}
      </span>
    </>
  )
}

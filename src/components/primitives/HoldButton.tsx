import { useCallback, useEffect, useRef, useState } from 'react'
import { useMediaQuery } from '#/lib/useMediaQuery'
import type { ReactNode } from 'react'

const HOLD_MS = 650

/**
 * Hold-to-call / hold-to-email (§2.3). Pointer-down starts a fill; releasing
 * before it completes cancels. This exists so a phone in a pocket, or a thumb
 * brushing the screen mid-job, cannot dial a client.
 *
 * On desktop a mouse click carries no such risk, so it degrades to a plain
 * click rather than making people hold the button down.
 */
export function HoldButton({
  onComplete,
  children,
  className = '',
  ariaLabel,
}: {
  onComplete: () => void
  children: ReactNode
  className?: string
  ariaLabel?: string
}) {
  const isTouch = useMediaQuery('(hover: none)')
  const [progress, setProgress] = useState(0)
  const frame = useRef<number | null>(null)
  const startedAt = useRef<number | null>(null)

  const stop = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    startedAt.current = null
    setProgress(0)
  }, [])

  useEffect(() => stop, [stop])

  const tick = useCallback(() => {
    if (startedAt.current === null) return
    const elapsed = performance.now() - startedAt.current
    const next = Math.min(1, elapsed / HOLD_MS)
    setProgress(next)

    if (next >= 1) {
      stop()
      onComplete()
      return
    }
    frame.current = requestAnimationFrame(tick)
  }, [onComplete, stop])

  if (!isTouch) {
    return (
      <button
        type="button"
        aria-label={ariaLabel}
        onClick={onComplete}
        className={`relative overflow-hidden ${className}`}
      >
        {children}
      </button>
    )
  }

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      // touch-action/user-select guards keep the browser from stealing the
      // pointer stream with scrolling or a selection callout mid-hold.
      className={`hold-target relative overflow-hidden ${className}`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        startedAt.current = performance.now()
        frame.current = requestAnimationFrame(tick)
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 bg-blue/15 transition-none"
        style={{ width: `${progress * 100}%` }}
      />
      <span className="relative">{children}</span>
      {progress > 0 && (
        <span className="sr-only" role="status">
          Keep holding to confirm
        </span>
      )}
    </button>
  )
}

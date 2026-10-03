import { useCallback, useEffect, useImperativeHandle, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent, Ref } from 'react'
import {
  INK_COLOUR,
  addPoint,
  exportPlan,
  fitInk,
  hasInk,
  inkBounds,
  inkToSave,
  outlineOf,
  pathOf,
  strokesFile,
  toInkPoint,
} from '#/lib/signature/ink'
import type {
  Ink,
  InkPoint,
  ScreenBox,
  Size,
  Stroke,
  StrokesFile,
} from '#/lib/signature/ink'

export type SignaturePadHandle = {
  /** Takes everything off the pad. */
  clear: () => void
  /** Takes off the last stroke. */
  undo: () => void
  /**
   * The signature as it is saved: a PNG cut to its ink, drawn again from the
   * strokes at least 1,200 pixels across, dark ink on a transparent ground,
   * and the strokes it was drawn from (`strokesFile`) — both from the same
   * ink. Null when there is nothing on the pad to call a signature.
   */
  save: () => Promise<{ png: Blob; strokes: StrokesFile } | null>
}

/**
 * Where a signature is drawn.
 *
 * The pen is kept as strokes rather than pixels (`#/lib/signature/ink`), and
 * the canvas is only ever a picture of them: drawn again whenever anything
 * changes, at the screen's own resolution, from outlines whose width follows
 * the speed of the pen. That is what makes the line smooth instead of a chain
 * of straight segments, keeps it under the finger at any size, survives the
 * pad changing shape as the phone turns, and lets the saved image be cut to
 * the ink and drawn large.
 *
 * `turned` says the pad is drawn a quarter turn round (`SigningScreen` on a
 * phone held upright). The canvas turns with it, so the ink is always in the
 * pad's own frame; only a pointer has to be read the other way round.
 */
export function SignaturePad({
  ref,
  label,
  turned,
  onChange,
}: {
  ref?: Ref<SignaturePadHandle>
  /** Names the pad: "{label} — sign here". */
  label: string
  turned: boolean
  /**
   * What the pad holds, each time that may have changed: `signed`, a stroke
   * that moved; `marked`, anything at all, a tap included, which is what
   * Undo and Clear have to take away.
   */
  onChange: (state: { signed: boolean; marked: boolean }) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const ink = useRef<Ink>([])
  /** The stroke the pen is drawing, if it is down. */
  const drawing = useRef<{
    stroke: Stroke
    pointerId: number
    pointerType: string
    box: ScreenBox
  } | null>(null)
  const size = useRef<Size>({ width: 0, height: 0 })
  const paths = useRef(new WeakMap<Stroke, Path2D>())
  const frame = useRef<number | null>(null)
  const reported = useRef({ signed: false, marked: false })
  const turnedRef = useRef(turned)
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    turnedRef.current = turned
    onChangeRef.current = onChange
  })

  const draw = useCallback(() => {
    frame.current = null
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const ratio = canvas.width / Math.max(size.current.width, 1)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.fillStyle = INK_COLOUR
    const current = drawing.current?.stroke
    for (const stroke of ink.current) {
      if (stroke === current) {
        // Still being drawn: its end is not tapered yet, and it changes on
        // every move, so it is not worth keeping.
        ctx.fill(new Path2D(pathOf(outlineOf(stroke, { done: false }))))
        continue
      }
      let path = paths.current.get(stroke)
      if (!path) {
        path = new Path2D(pathOf(outlineOf(stroke)))
        paths.current.set(stroke, path)
      }
      ctx.fill(path)
    }
  }, [])

  const schedule = useCallback(() => {
    if (frame.current === null) frame.current = requestAnimationFrame(draw)
  }, [draw])

  /** Says what the pad holds, when that has changed. */
  const report = useCallback(() => {
    const now = { signed: hasInk(ink.current), marked: ink.current.length > 0 }
    if (
      now.signed === reported.current.signed &&
      now.marked === reported.current.marked
    ) {
      return
    }
    reported.current = now
    onChangeRef.current(now)
  }, [])

  /**
   * The bitmap at the screen's resolution, sized whenever the pad is — on
   * mounting, and as the phone turns or the browser's bars come and go. The
   * box measured is the canvas's own, before any turn, which is the pad's
   * frame. Sizing a canvas clears it, so the ink is drawn again, kept on the
   * pad (`fitInk`). A stroke being drawn goes on in its new place, read
   * against where the pad is on the screen now.
   */
  const fit = useCallback(
    (canvas: HTMLCanvasElement) => {
      const next = { width: canvas.clientWidth, height: canvas.clientHeight }
      if (next.width === 0 || next.height === 0) return
      const ratio = window.devicePixelRatio || 1
      canvas.width = Math.round(next.width * ratio)
      canvas.height = Math.round(next.height * ratio)
      const before = ink.current
      ink.current = fitInk(before, next)
      size.current = next
      const pen = drawing.current
      if (pen) {
        pen.stroke = ink.current[before.indexOf(pen.stroke)] ?? pen.stroke
        pen.box = canvas.getBoundingClientRect()
      }
      draw()
    },
    [draw],
  )

  const observer = useRef<ResizeObserver | null>(null)
  const setCanvas = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      observer.current?.disconnect()
      observer.current = null
      canvasRef.current = canvas
      if (!canvas) return
      fit(canvas)
      if (typeof ResizeObserver === 'undefined') return
      observer.current = new ResizeObserver(() => {
        if (canvasRef.current) fit(canvasRef.current)
      })
      observer.current.observe(canvas)
    },
    [fit],
  )

  useEffect(
    () => () => {
      observer.current?.disconnect()
      if (frame.current !== null) cancelAnimationFrame(frame.current)
    },
    [],
  )

  useImperativeHandle(
    ref,
    () => ({
      clear() {
        drawing.current = null
        ink.current = []
        schedule()
        report()
      },
      undo() {
        if (drawing.current) return
        ink.current = ink.current.slice(0, -1)
        schedule()
        report()
      },
      async save() {
        // A stray tap far from the signature is left on the pad, not saved.
        const strokes = inkToSave(ink.current)
        const kept = strokesFile(strokes, size.current)
        const bounds = inkBounds(strokes)
        if (!bounds || !hasInk(strokes)) return null
        const plan = exportPlan(bounds)
        const out = document.createElement('canvas')
        out.width = plan.width
        out.height = plan.height
        const ctx = out.getContext('2d')
        if (!ctx) return null
        // The same outlines, scaled: a vector drawn again at the size it is
        // saved at, not the screen's pixels enlarged.
        ctx.setTransform(plan.scale, 0, 0, plan.scale, plan.dx, plan.dy)
        ctx.fillStyle = INK_COLOUR
        for (const stroke of strokes) {
          ctx.fill(new Path2D(pathOf(outlineOf(stroke))))
        }
        const png = await new Promise<Blob | null>((resolve) =>
          out.toBlob(resolve, 'image/png'),
        )
        return png ? { png, strokes: kept } : null
      },
    }),
    [schedule, report],
  )

  function pointOf(
    event: { clientX: number; clientY: number; timeStamp: number },
    box: ScreenBox,
  ): InkPoint {
    return toInkPoint(
      event.clientX,
      event.clientY,
      box,
      turnedRef.current,
      event.timeStamp,
    )
  }

  function start(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const pen = drawing.current
    if (pen) {
      // One pen at a time, but not whichever touched first: a finger that has
      // not moved — the thumb gripping a phone on its side — gives way to the
      // one that comes down to sign, and a hand gives way to a stylus.
      const resting = pen.stroke.length <= 1
      const stylus = event.pointerType === 'pen' && pen.pointerType !== 'pen'
      if (!resting && !stylus) return
      ink.current = ink.current.filter((stroke) => stroke !== pen.stroke)
      try {
        event.currentTarget.releasePointerCapture(pen.pointerId)
      } catch {
        /* already released */
      }
      drawing.current = null
    }
    const box = event.currentTarget.getBoundingClientRect()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* capture is an enhancement: the stroke still draws without it */
    }
    const stroke: Stroke = []
    addPoint(stroke, pointOf(event, box))
    drawing.current = {
      stroke,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      box,
    }
    ink.current = [...ink.current, stroke]
    schedule()
    report()
  }

  function move(event: ReactPointerEvent<HTMLCanvasElement>) {
    const pen = drawing.current
    if (!pen || event.pointerId !== pen.pointerId) return
    // Every sample since the last frame, where the browser keeps them
    // (Safari since iOS 18.2): a quick stroke is otherwise a few corners.
    const native = event.nativeEvent
    const samples =
      'getCoalescedEvents' in native ? native.getCoalescedEvents() : []
    let added = false
    for (const sample of samples.length > 0 ? samples : [native]) {
      added = addPoint(pen.stroke, pointOf(sample, pen.box)) || added
    }
    if (!added) return
    schedule()
    // Done comes alive as the first stroke moves, not when it ends.
    if (!reported.current.signed) report()
  }

  function end(event: ReactPointerEvent<HTMLCanvasElement>) {
    const pen = drawing.current
    if (!pen || event.pointerId !== pen.pointerId) return
    drawing.current = null
    schedule()
    report()
  }

  return (
    <canvas
      ref={setCanvas}
      role="img"
      aria-label={`${label} — sign here`}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      // `touch-none`: the browser would otherwise scroll or zoom instead of
      // drawing. `select-none` and no callout: a slow first stroke on an
      // iPhone is otherwise a long press, which selects and raises the copy
      // menu over the pad.
      className="absolute inset-0 h-full w-full touch-none select-none [-webkit-touch-callout:none]"
    />
  )
}

/**
 * The pointer-position and stroke-painting math shared by every hand-rolled
 * canvas drawing surface in this app (`AnnotationEditor.tsx` for photos,
 * `AnnotationOverlay.tsx` for PDF pages). Genuinely identical code in both —
 * not parameterized behaviour — so it lives here once rather than being
 * copied. The surrounding state machine (dirty/save/undo/clear, what "the
 * background" is) stays duplicated in each component, since that part
 * actually differs between them.
 */

export type Point = { x: number; y: number }

/** Pointer position in the canvas's own bitmap pixel space, not CSS pixels —
 * the two differ whenever the canvas is displayed at a different size than
 * its `width`/`height` attributes (see `SignaturePad.tsx`'s comment on this
 * exact distinction). */
export function positionOf(e: React.PointerEvent<HTMLCanvasElement>): Point {
  const rect = e.currentTarget.getBoundingClientRect()
  return {
    x: ((e.clientX - rect.left) / rect.width) * e.currentTarget.width,
    y: ((e.clientY - rect.top) / rect.height) * e.currentTarget.height,
  }
}

export function drawStroke(
  ctx: CanvasRenderingContext2D,
  stroke: Array<Point>,
): void {
  if (stroke.length < 2) return
  ctx.beginPath()
  ctx.moveTo(stroke[0].x, stroke[0].y)
  for (const point of stroke.slice(1)) ctx.lineTo(point.x, point.y)
  ctx.stroke()
}

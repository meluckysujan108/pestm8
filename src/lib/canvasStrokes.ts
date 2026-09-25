/**
 * The pointer-position and stroke-painting math for the app's hand-rolled
 * canvas drawing surface (`AnnotationEditor.tsx`, marking up a photo). It was
 * shared with the old PDF viewer's per-page canvas until report markup moved
 * into the in-app viewer (`#/components/pdf`), which draws its marks itself.
 * Still its own module: the math is not the editor's state machine
 * (dirty/save/undo/clear, what "the background" is), and reads better apart.
 */

export type Point = { x: number; y: number }

/** Pointer position in the canvas's own bitmap pixel space, not CSS pixels —
 * the two differ whenever the canvas is displayed at a different size than
 * its `width`/`height` attributes (see `SignSheet.tsx`'s comment on this
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

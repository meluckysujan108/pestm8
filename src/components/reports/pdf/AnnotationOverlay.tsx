import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { PenLine, RotateCcw, Trash2, X } from 'lucide-react'
import { drawStroke, positionOf } from '#/lib/canvasStrokes'
import { api } from '../../../../convex/_generated/api'
import type { Point } from '#/lib/canvasStrokes'
import type { Id } from '../../../../convex/_generated/dataModel'

/**
 * A transparent canvas over one rendered PDF page — non-destructive markup,
 * never a change to the PDF itself (see `convex/reportAnnotations.ts` for
 * why this isn't gated by the report's finalised/editable status the way
 * every other report mutation is).
 *
 * Only captures pointer input while "Markup" mode is on. The rest of the
 * time it's `pointer-events-none`, so scrolling and pinch-zoom on the page
 * underneath work normally — a technician looking at a report shouldn't
 * have to fight an invisible drawing surface just to scroll it.
 */
export function AnnotationOverlay({
  businessId,
  reportId,
  page,
  width,
  height,
}: {
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
  page: number
  width: number
  height: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const current = useRef<Array<Point> | null>(null)
  const [drawing, setDrawing] = useState(false)

  const { data: strokes } = useQuery(
    convexQuery(api.reportAnnotations.listAnnotations, {
      businessId,
      reportId,
      page,
    }),
  )

  const convexAdd = useConvexMutation(api.reportAnnotations.addStroke)
  const add = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      reportId: Id<'reports'>
      page: number
      points: Array<Point>
    }) => convexAdd(args),
  })
  const convexUndo = useConvexMutation(api.reportAnnotations.undoLastStroke)
  const undo = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      reportId: Id<'reports'>
      page: number
    }) => convexUndo(args),
  })
  const convexClear = useConvexMutation(api.reportAnnotations.clearMyStrokes)
  const clear = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      reportId: Id<'reports'>
      page: number
    }) => convexClear(args),
  })

  const stored = strokes ?? []

  function redraw() {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.strokeStyle = '#ff3b30'
    ctx.lineWidth = 3
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const stroke of stored) {
      drawStroke(
        ctx,
        stroke.points.map((p) => ({
          x: p.x * canvas.width,
          y: p.y * canvas.height,
        })),
      )
    }
  }

  // Every stored-stroke change or resize (zoom) redraws from scratch — cheap
  // enough at this resolution, and it's what keeps undo/clear simple.
  useEffect(redraw, [stored, width, height])

  function start(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing) return
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* capture is an enhancement, not a requirement */
    }
    current.current = [positionOf(e)]
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!current.current) return
    current.current.push(positionOf(e))
    const ctx = canvasRef.current?.getContext('2d')
    if (ctx) {
      ctx.strokeStyle = '#ff3b30'
      ctx.lineWidth = 3
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      drawStroke(ctx, current.current)
    }
  }

  async function end() {
    const stroke = current.current
    current.current = null
    if (!stroke || stroke.length < 2) return
    const canvas = canvasRef.current
    if (!canvas) return
    await add.mutateAsync({
      businessId,
      reportId,
      page,
      points: stroke.map((p) => ({
        x: p.x / canvas.width,
        y: p.y / canvas.height,
      })),
    })
  }

  return (
    <>
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        role="img"
        aria-label="PDF page markup"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={() => void end()}
        onPointerCancel={() => void end()}
        className={`absolute inset-0 size-full ${drawing ? 'touch-none' : 'pointer-events-none'}`}
      />

      <div className="absolute bottom-2 right-2 flex gap-2">
        {drawing && (
          <>
            <button
              type="button"
              disabled={stored.length === 0}
              onClick={() =>
                void undo.mutateAsync({ businessId, reportId, page })
              }
              aria-label="Undo last stroke"
              className="flex size-9 items-center justify-center rounded-full bg-black/60 text-white transition active:scale-[.95] disabled:opacity-30"
            >
              <RotateCcw size={15} strokeWidth={2} />
            </button>
            <button
              type="button"
              disabled={stored.length === 0}
              onClick={() =>
                void clear.mutateAsync({ businessId, reportId, page })
              }
              aria-label="Clear my markup on this page"
              className="flex size-9 items-center justify-center rounded-full bg-black/60 text-white transition active:scale-[.95] disabled:opacity-30"
            >
              <Trash2 size={15} strokeWidth={2} />
            </button>
          </>
        )}
        <button
          type="button"
          onClick={() => setDrawing((d) => !d)}
          aria-pressed={drawing}
          aria-label={drawing ? 'Stop markup' : 'Markup this page'}
          className={`flex size-9 items-center justify-center rounded-full transition active:scale-[.95] ${
            drawing ? 'bg-red text-white' : 'bg-black/60 text-white'
          }`}
        >
          {drawing ? (
            <X size={15} strokeWidth={2.2} />
          ) : (
            <PenLine size={15} strokeWidth={2} />
          )}
        </button>
      </div>
    </>
  )
}

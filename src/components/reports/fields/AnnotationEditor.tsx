import { useEffect, useRef, useState } from 'react'
import { Check, RotateCcw, Trash2, X } from 'lucide-react'
import { drawStroke, positionOf } from '#/lib/canvasStrokes'
import type { Point } from '#/lib/canvasStrokes'

/**
 * A hand-rolled canvas annotator — freehand red pen over a loaded photo, no
 * library. Per the plan's Phase 7 note, Konva (~150 KB gzipped) was
 * evaluated and skipped: this needs the same pointer-event canvas
 * `SignaturePad.tsx` already established, just drawing over an image instead
 * of a blank background.
 *
 * The whole canvas is redrawn (image + every stroke so far) on every change
 * rather than keeping a separate overlay layer — simpler to reason about,
 * and undo/clear become "drop a stroke, redraw" instead of needing their own
 * pixel-level logic.
 */
export function AnnotationEditor({
  imageUrl,
  onSave,
  onCancel,
}: {
  imageUrl: string
  onSave: (blob: Blob) => void | Promise<void>
  onCancel: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const strokes = useRef<Array<Array<Point>>>([])
  const current = useRef<Array<Point> | null>(null)
  const [dirty, setDirty] = useState(false)
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      if (cancelled) return
      imgRef.current = img
      const canvas = canvasRef.current
      if (!canvas) return
      // A display-sized canvas, not the source resolution — this is a mark-up
      // for "look here", not a second copy of the evidence at full fidelity.
      const maxWidth = Math.min(img.naturalWidth, 640)
      const scale = maxWidth / img.naturalWidth
      canvas.width = maxWidth
      canvas.height = Math.round(img.naturalHeight * scale)
      redraw()
      setReady(true)
    }
    img.onerror = () => setFailed(true)
    img.src = imageUrl
    return () => {
      cancelled = true
    }
  }, [imageUrl])

  function redraw() {
    const canvas = canvasRef.current
    const img = imgRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !img || !ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    ctx.strokeStyle = '#ff3b30'
    ctx.lineWidth = 3
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const stroke of strokes.current) {
      drawStroke(ctx, stroke)
    }
  }

  function start(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!ready) return
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

  function end() {
    if (!current.current) return
    if (current.current.length > 1) {
      strokes.current.push(current.current)
      setDirty(true)
    }
    current.current = null
  }

  function undo() {
    strokes.current.pop()
    setDirty(strokes.current.length > 0)
    redraw()
  }

  function clear() {
    strokes.current = []
    setDirty(false)
    redraw()
  }

  async function save() {
    const canvas = canvasRef.current
    if (!canvas) return
    setSaving(true)
    setFailed(false)
    try {
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', 0.9),
      )
      if (!blob) throw new Error('could not read the annotation')
      await onSave(blob)
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/90 p-4">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onCancel}
          aria-label="Cancel annotation"
          className="flex size-10 items-center justify-center rounded-full bg-white/10 text-white"
        >
          <X size={18} strokeWidth={2} />
        </button>
        <span className="text-caption text-white/70">
          Draw to mark up the photo
        </span>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || saving || !ready}
          aria-label="Save annotation"
          className="flex size-10 items-center justify-center rounded-full bg-white/10 text-white disabled:opacity-30"
        >
          <Check size={18} strokeWidth={2.4} />
        </button>
      </div>

      <div className="flex flex-1 items-center justify-center overflow-hidden py-4">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label="Photo annotation canvas"
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          className="max-h-full max-w-full touch-none rounded-xl bg-surface-3"
        />
      </div>

      <div className="flex justify-center gap-3">
        <button
          type="button"
          onClick={undo}
          disabled={strokes.current.length === 0}
          className="flex items-center gap-1.5 rounded-full bg-white/10 px-4 py-2 text-caption font-semibold text-white disabled:opacity-30"
        >
          <RotateCcw size={14} strokeWidth={2} />
          Undo
        </button>
        <button
          type="button"
          onClick={clear}
          disabled={!dirty}
          className="flex items-center gap-1.5 rounded-full bg-white/10 px-4 py-2 text-caption font-semibold text-white disabled:opacity-30"
        >
          <Trash2 size={14} strokeWidth={2} />
          Clear
        </button>
      </div>

      {failed && (
        <p
          role="alert"
          className="mt-2 text-center text-caption text-amber-ink"
        >
          Could not save the annotation. Check your connection and try again.
        </p>
      )}
    </div>
  )
}

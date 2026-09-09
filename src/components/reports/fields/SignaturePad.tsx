import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { RotateCcw } from 'lucide-react'
import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'

/**
 * A drawn signature, on a plain canvas with pointer events — no library.
 *
 * The image is uploaded to storage the moment the pen lifts, exactly like a
 * photo, and never enters the draft blob: `data` is replaced wholesale on every
 * save, which has already cost this codebase its photos once
 * (convex/schema.ts:146). Only `{ signedAt }` goes into `data`.
 */
export function SignaturePad({
  businessId,
  reportId,
  slot,
  label,
  signedAt,
  onSigned,
}: {
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
  slot: string
  label: string
  signedAt?: number
  onSigned: (signedAt: number | undefined) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const dirty = useRef(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const { data: urls } = useQuery(
    convexQuery(api.reports.signatureUrls, { businessId, reportId }),
  )
  const existing = (urls as Record<string, string> | undefined)?.[slot]

  const getUploadUrl = useConvexMutation(api.reports.generateUploadUrl)
  const convexAttach = useConvexMutation(api.reports.attachSignature)
  const attach = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      reportId: Id<'reports'>
      storageId: Id<'_storage'>
      slot: string
    }) => convexAttach(args),
  })

  // A canvas laid out by CSS still has its default 300x150 bitmap, so strokes
  // land offset from the pen. Size the bitmap to the box, allowing for density.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ratio = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvas.width = rect.width * ratio
    canvas.height = rect.height * ratio
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(ratio, ratio)
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = '#1C1C1E'
  }, [])

  function positionOf(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function start(e: React.PointerEvent<HTMLCanvasElement>) {
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    // Keeps the stroke following a finger that slides off the box mid-signature.
    // Not worth failing the whole signature over if the browser refuses the
    // capture — the stroke still draws, it just stops at the edge.
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* capture is an enhancement, not a requirement */
    }
    drawing.current = true
    const { x, y } = positionOf(e)
    ctx.beginPath()
    ctx.moveTo(x, y)
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    const { x, y } = positionOf(e)
    ctx.lineTo(x, y)
    ctx.stroke()
    dirty.current = true
  }

  async function end() {
    if (!drawing.current) return
    drawing.current = false
    if (!dirty.current) return

    const canvas = canvasRef.current
    if (!canvas) return

    setBusy(true)
    setFailed(false)
    try {
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/png'),
      )
      if (!blob) throw new Error('could not read the signature')

      const uploadUrl = await getUploadUrl({ businessId })
      const res = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: blob,
      })
      if (!res.ok) throw new Error('upload failed')
      const { storageId } = (await res.json()) as { storageId: string }

      await attach.mutateAsync({
        businessId,
        reportId,
        storageId: storageId as Id<'_storage'>,
        slot,
      })
      onSigned(Date.now())
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  function clear() {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    dirty.current = false
    // The stored image is left in place until a new one replaces it; clearing
    // the pad is "start again", not "revoke what was signed".
    onSigned(undefined)
  }

  return (
    <span className="flex flex-col gap-1.5">
      {existing && !dirty.current && (
        <img
          src={existing}
          alt={label}
          className="h-24 w-full rounded-xl border border-hairline bg-surface object-contain"
        />
      )}

      <canvas
        ref={canvasRef}
        role="img"
        aria-label={
          signedAt ? `${label} — signed, sign again` : `${label} — sign here`
        }
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={() => void end()}
        onPointerCancel={() => void end()}
        // Without this the browser scrolls the page instead of drawing.
        className="h-32 w-full touch-none rounded-xl border border-dashed border-hairline bg-surface-3"
      />

      <span className="flex items-center justify-between gap-2">
        <span className="text-caption text-muted">
          {busy ? 'Saving signature…' : signedAt ? 'Signed' : 'Sign above'}
        </span>
        <button
          type="button"
          onClick={clear}
          className="flex items-center gap-1.5 text-caption font-semibold text-blue"
        >
          <RotateCcw size={13} strokeWidth={2} />
          Clear
        </button>
      </span>

      {failed && (
        <span role="alert" className="text-caption text-amber-ink">
          Could not save the signature. Check your connection and sign again.
        </span>
      )}
    </span>
  )
}

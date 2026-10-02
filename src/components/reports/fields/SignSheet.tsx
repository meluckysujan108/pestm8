import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { PenLine, RotateCcw } from 'lucide-react'
import { Sheet, SheetLock } from '#/components/primitives/Sheet'
import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'
import {
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
} from '#/components/primitives/buttons'
import { FIELD } from '#/components/forms/FormField'

/** The pad's bitmap at the screen's own resolution, and its pen. */
function setUpPad(canvas: HTMLCanvasElement) {
  const ratio = window.devicePixelRatio || 1
  const rect = canvas.getBoundingClientRect()
  canvas.width = Math.round(rect.width * ratio)
  canvas.height = Math.round(rect.height * ratio)
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.scale(ratio, ratio)
  ctx.lineWidth = 2.2
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  // --ink, light: the pad is paper in both themes.
  ctx.strokeStyle = '#1C1C1E'
}

/**
 * Signing, as its own screen.
 *
 * Three things were wrong with signing inline on the form. The pad uploaded on
 * every pen lift, so a five-stroke signature was five uploads and five writes,
 * any of which could half-fail. A 128px strip between other questions is not
 * something anyone signs their name on. And handing the phone to a client left
 * them looking at the whole form, editable, with the statement they were
 * agreeing to somewhere above the fold.
 *
 * So: a sheet that shows the statement, a pad worth signing on, and one Done
 * that commits exactly once — one upload, one mutation, and only if the pen
 * actually touched the pad.
 */
export function SignSheet({
  open,
  onClose,
  businessId,
  reportId,
  slot,
  label,
  statement,
  askName,
  /** Whose signature this is, for the "use my saved one" offer. */
  ownSignature,
  onSigned,
}: {
  open: boolean
  onClose: () => void
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
  slot: string
  label: string
  /** The words being agreed to, frozen with the signature. */
  statement?: string
  /** Client signatures are signed by a person who must say who they are. */
  askName?: boolean
  ownSignature: boolean
  onSigned: (signedAt: number) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const [drawn, setDrawn] = useState(false)
  const [name, setName] = useState('')
  const [keepMine, setKeepMine] = useState(true)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const { data: saved } = useQuery({
    ...convexQuery(api.reports.mySavedSignature, { businessId }),
    // Only ever offered for the signer's own slot: applying someone else's
    // saved signature is forgery with extra steps, however convenient.
    enabled: open && ownSignature,
  })

  const getUploadUrl = useConvexMutation(api.reports.generateUploadUrl)
  const convexAttach = useConvexMutation(api.reports.attachSignature)
  const attach = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      reportId: Id<'reports'>
      storageId: Id<'_storage'>
      slot: string
      signedBy?: string
      statement?: string
      method?: 'drawn' | 'saved'
      saveForMember?: boolean
    }) => convexAttach(args),
  })

  // Every opening starts blank, reset as it happens rather than in an effect:
  // the sheet closed and opened again is the same component, and a pad that
  // still thought it held a stroke offered Done on an empty pad — and, held
  // by the lock below, asked whether to discard nothing.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setDrawn(false)
      setFailed(false)
    }
  }

  // A canvas laid out by CSS keeps its default 300x150 bitmap, stretched to
  // the box: strokes landed below and beside the pen, soft-edged, and past
  // the bitmap's edge not at all. Sized when the element itself arrives — the
  // sheet mounts its body a render or two after `open` flips, so an effect on
  // `open` alone found no canvas and never sized one — and again on an opening
  // that finds it still there. Sizing a canvas also clears it.
  const padRef = useCallback((canvas: HTMLCanvasElement | null) => {
    canvasRef.current = canvas
    if (canvas) setUpPad(canvas)
  }, [])
  useEffect(() => {
    if (open && canvasRef.current) setUpPad(canvasRef.current)
  }, [open])

  function positionOf(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  function start(event: React.PointerEvent<HTMLCanvasElement>) {
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* capture is an enhancement: the stroke still draws without it */
    }
    drawing.current = true
    const { x, y } = positionOf(event)
    ctx.beginPath()
    ctx.moveTo(x, y)
  }

  function move(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    const { x, y } = positionOf(event)
    ctx.lineTo(x, y)
    ctx.stroke()
    if (!drawn) setDrawn(true)
  }

  function clear() {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    setDrawn(false)
  }

  async function commit(storageId: Id<'_storage'>, method: 'drawn' | 'saved') {
    await attach.mutateAsync({
      businessId,
      reportId,
      storageId,
      slot,
      method,
      ...(name.trim() ? { signedBy: name.trim() } : {}),
      ...(statement ? { statement } : {}),
      // Saving it is the signer's own choice, and only ever their own.
      ...(method === 'drawn' && ownSignature && keepMine
        ? { saveForMember: true }
        : {}),
    })
    onSigned(Date.now())
    onClose()
  }

  async function done() {
    const canvas = canvasRef.current
    if (!canvas || !drawn) return

    setBusy(true)
    setFailed(false)
    try {
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/png'),
      )
      if (!blob) throw new Error('could not read the signature')

      // One upload, one write — the whole reason this is a sheet with a Done
      // rather than a pad that commits on every pen lift.
      const uploadUrl = await getUploadUrl({ businessId })
      const res = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: blob,
      })
      if (!res.ok) throw new Error('upload failed')
      const { storageId } = (await res.json()) as { storageId: Id<'_storage'> }

      await commit(storageId, 'drawn')
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  async function useSaved() {
    if (!saved) return
    setBusy(true)
    setFailed(false)
    try {
      await commit(saved.storageId, 'saved')
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      open={open}
      // Not while a signature is being saved: it will be attached whatever
      // happens to the sheet, so closing would only hide that it had been.
      onClose={() => {
        if (!busy) onClose()
      }}
      title={label}
      footer={
        <div className="flex gap-2">
          <button
            type="button"
            onClick={clear}
            className={`${SECONDARY_BUTTON} flex items-center gap-1.5 px-4`}
          >
            <RotateCcw size={15} strokeWidth={2} />
            Clear
          </button>
          <button
            type="button"
            // Nothing drawn is not a signature, and a disabled Done says so
            // more honestly than accepting a blank image would.
            disabled={
              !drawn || busy || (askName === true && name.trim() === '')
            }
            onClick={() => void done()}
            className={`${PRIMARY_BUTTON} flex-1`}
          >
            {busy ? 'Saving…' : 'Done'}
          </button>
        </div>
      }
    >
      {/* Locked from the moment it opens: a stroke that starts downward is
          otherwise the drag that closes the sheet, and a signature half
          drawn goes with it. With a stroke on the pad, ✕ and Back ask before
          throwing it away — but not while it is being saved, when there is
          nothing left to throw away. Done and "Use my saved signature" close
          through `onClose` itself, which asks nothing. */}
      <SheetLock changed={drawn && !busy} />
      {statement && (
        <p className="rounded-xl border border-hairline bg-surface px-3.5 py-3 text-body text-ink-2">
          {statement}
        </p>
      )}

      {askName && (
        <label className="mt-3 flex flex-col gap-1.5">
          <span className="section-label">Name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="name"
            placeholder="Who is signing"
            className={FIELD}
          />
        </label>
      )}

      <canvas
        ref={padRef}
        role="img"
        aria-label={`${label} — sign here`}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={() => (drawing.current = false)}
        onPointerCancel={() => (drawing.current = false)}
        // Never the start of a drag, even if the lock above were lifted: the
        // pad is the one place in a sheet where a finger moving down means
        // ink, not "close".
        data-vaul-no-drag
        // `touch-none`: without it the browser scrolls the page instead of
        // drawing. `select-none` and no callout: a slow first stroke on an
        // iPhone is otherwise a long press, which selects the hint below and
        // raises the copy menu over the pad.
        // Paper, not surface: the ink is dark in both themes (it is printed
        // on white), and on dark mode's #1c1c1e surface it could not be seen.
        className="mt-3 h-56 w-full touch-none select-none rounded-xl border border-dashed border-hairline bg-paper [-webkit-touch-callout:none]"
      />
      <p className="mt-1.5 text-caption text-muted">
        {drawn
          ? 'Tap Done to attach this signature.'
          : 'Sign above with a finger or a stylus.'}
      </p>

      {/* One slot, one height (the button's 48px), whatever is in it. The
          sheet rises from the bottom and is as tall as what it holds, so
          anything below the pad that comes or goes moves the pad: the saved
          signature landing after the sheet opened, or — worse — the first
          stroke swapping the button for the checkbox, which jumped the pad
          out from under the pen mid-signature. With neither to show, the
          space is held empty. */}
      {ownSignature && (
        <div className="mt-3 h-12">
          {drawn ? (
            <label className="flex h-full items-center gap-2.5 text-body text-ink-2">
              <input
                type="checkbox"
                checked={keepMine}
                onChange={(event) => setKeepMine(event.target.checked)}
                className="size-4 accent-red"
              />
              Save this as my signature
            </label>
          ) : (
            saved && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void useSaved()}
                className={`${SECONDARY_BUTTON} flex w-full items-center justify-center gap-2`}
              >
                <PenLine size={16} strokeWidth={2} />
                Use my saved signature
              </button>
            )
          )}
        </div>
      )}

      {failed && (
        <p role="alert" className="mt-3 text-caption text-amber-ink">
          Could not save the signature. Check your signal and tap Done again.
        </p>
      )}
    </Sheet>
  )
}

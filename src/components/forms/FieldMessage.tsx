import { useEffect, useState } from 'react'
import { Check, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'

export type FieldMessageTone = 'error' | 'warning' | 'status' | 'ok'

/** A one-tap fix offered beside the message: "Use 0412 345 678". */
export type FieldFix = { label: string; onApply: () => void }

/**
 * Colours are the -ink tokens, not the bright ones: text-red on the canvas
 * fails contrast, and text-muted is 2.8:1 — unreadable in sunlight on a
 * doorstep, which is where these get read.
 */
const TONE: Record<FieldMessageTone, string> = {
  error: 'text-red-ink',
  warning: 'text-amber-ink',
  status: 'text-grey-ink',
  ok: 'text-green-ink',
}

/**
 * The line under a field: why it will not save (error), what looks wrong but
 * may be right (warning), what a check is doing (status), or that it came
 * back fine (ok). Give it an `id` and put that in the input's
 * aria-describedby, so a screen reader reads it with the field.
 *
 * An error is announced when it appears, once. A field's error sentence can
 * change with every keystroke while it is being put right ("Add the part
 * after the @" → "Add the rest of the address…"), and a live region reads
 * every change out; after the first announcement it is plain text, still read
 * with the field through aria-describedby.
 *
 * Renders beside the input, never inside a <label>: there it would become
 * part of the field's name, and the fix button would be inside the label too.
 */
export function FieldMessage({
  id,
  tone,
  children,
  fix,
  className = 'mt-1.5',
}: {
  id?: string
  tone: FieldMessageTone
  children: ReactNode
  fix?: FieldFix
  className?: string
}) {
  const [announced, setAnnounced] = useState(false)
  useEffect(() => {
    if (tone !== 'error') return
    // Long enough for the insertion to have been queued for reading.
    const done = setTimeout(() => setAnnounced(true), 1000)
    return () => clearTimeout(done)
  }, [tone])

  const role =
    tone === 'error'
      ? announced
        ? undefined
        : 'alert'
      : tone === 'status'
        ? 'status'
        : undefined

  return (
    <div
      id={id}
      role={role}
      className={`${className} flex flex-wrap items-center gap-x-2 text-caption ${TONE[tone]}`}
    >
      <p className="flex min-w-0 items-start gap-1.5">
        {tone === 'warning' && (
          <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        )}
        {tone === 'ok' && (
          <Check aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        )}
        <span className="min-w-0">{children}</span>
      </p>
      {fix && <FixButton fix={fix} />}
    </div>
  )
}

/**
 * The fix, after the sentence. A full 44 pt tall so a thumb finds it; the
 * line it sits on grows to match, which is the price of it being tappable
 * at a door.
 */
export function FixButton({ fix }: { fix: FieldFix }) {
  return (
    <button
      type="button"
      onClick={fix.onApply}
      className="inline-flex min-h-11 items-center font-semibold text-blue-ink underline underline-offset-2"
    >
      {fix.label}
    </button>
  )
}

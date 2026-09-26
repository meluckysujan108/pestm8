import { useEffect, useRef, useState } from 'react'
import { FileWarning, LoaderCircle, Lock } from 'lucide-react'
import type { LoadProgress } from './types'
import {
  LINK_BUTTON_COMPACT,
  NEUTRAL_BUTTON_COMPACT,
  SECONDARY_BUTTON_COMPACT,
} from '#/components/primitives/buttons'
import { FIELD_COMPACT } from '#/components/forms/FormField'

/**
 * What the viewer shows before there are pages to show: the download, a
 * password, or a failure — each centred on the backdrop, between the bars,
 * with Done always there to leave.
 */

export function LoadingState({ progress }: { progress: LoadProgress | null }) {
  const total = progress?.total ?? 0
  const fraction =
    progress && total > 0 ? Math.min(1, progress.loaded / total) : null
  const percent = fraction === null ? null : Math.round(fraction * 100)
  // Circumference of the ring below (r = 15).
  const ring = 2 * Math.PI * 15

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center">
      {fraction === null ? (
        <LoaderCircle
          aria-hidden
          size={30}
          strokeWidth={1.7}
          className="animate-spin text-muted"
        />
      ) : (
        <svg
          role="progressbar"
          aria-label="Downloading PDF"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? 0}
          width={36}
          height={36}
          viewBox="0 0 36 36"
          className="-rotate-90"
        >
          <circle
            cx={18}
            cy={18}
            r={15}
            fill="none"
            strokeWidth={3}
            className="stroke-fill-track"
          />
          <circle
            cx={18}
            cy={18}
            r={15}
            fill="none"
            strokeWidth={3}
            strokeLinecap="round"
            strokeDasharray={ring}
            strokeDashoffset={ring * (1 - fraction)}
            className="stroke-blue transition-[stroke-dashoffset] duration-200"
          />
        </svg>
      )}
      <p role="status" className="text-body text-muted">
        Loading PDF…
        {/* The ring above carries the number for a screen reader; said here
            too, a live region would read out every percent. */}
        {percent !== null && <span aria-hidden> {percent}%</span>}
      </p>
    </div>
  )
}

/**
 * An encrypted PDF's password, asked for in the viewer itself.
 *
 * The form stays mounted from the first ask until the document opens: while
 * pdf.js tries a password it is only marked `checking`, and a wrong one comes
 * back to the same field, emptied, with the keyboard still up. Nothing here
 * can raise the keyboard again once it has gone — iOS raises it only for a
 * focus that happens inside a tap, and the answer arrives from pdf.js's
 * worker — so the whole design is not letting it go: the field is never
 * unmounted or disabled, and a tap on Open does not take focus from it.
 */
export function PasswordState({
  wrong,
  checking,
  onSubmit,
  onCancel,
}: {
  wrong: boolean
  checking: boolean
  onSubmit: (password: string) => void
  onCancel: () => void
}) {
  const [password, setPassword] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Refused: empty the field for the next try, as iOS does with a wrong
  // passcode. Adjusted while rendering, so the refusal and the empty field
  // appear together.
  const [wasChecking, setWasChecking] = useState(checking)
  if (checking !== wasChecking) {
    setWasChecking(checking)
    if (!checking && wrong) setPassword('')
  }
  // And keep focus in it — a no-op while the keyboard is still up there,
  // which is the case this is for; on a desktop, where a click can have
  // moved focus, it puts the caret back.
  useEffect(() => {
    if (!checking && wrong) inputRef.current?.focus()
  }, [checking, wrong])

  const rejected = wrong && !checking
  return (
    <div className="absolute inset-0 flex items-center justify-center px-6">
      <form
        className="flex w-full max-w-xs flex-col items-center gap-3 text-center"
        aria-busy={checking || undefined}
        onSubmit={(event) => {
          event.preventDefault()
          if (password && !checking) onSubmit(password)
        }}
      >
        <Lock aria-hidden size={30} strokeWidth={1.7} className="text-muted" />
        <h3 className="text-row-title text-ink">This PDF is locked</h3>
        <p className="text-caption text-muted">
          Enter its password to open it.
        </p>
        <input
          ref={inputRef}
          type="password"
          // Not a password for this app, so no password manager offers one.
          autoComplete="off"
          aria-label="PDF password"
          aria-invalid={rejected || undefined}
          aria-describedby={rejected ? 'pdf-password-wrong' : undefined}
          // The first ask arrives from pdf.js, not a tap, so on an iPhone
          // this shows the caret without the keyboard; one tap on the field
          // brings it. Everywhere else it is ready to type into.
          autoFocus
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className={`${FIELD_COMPACT} w-full focus-visible:ring-2 focus-visible:ring-blue`}
        />
        {rejected && (
          <p
            id="pdf-password-wrong"
            role="alert"
            className="text-caption font-semibold text-red-ink"
          >
            Wrong password. Try again.
          </p>
        )}
        <div className="mt-1 flex w-full gap-2">
          <button
            type="button"
            onClick={onCancel}
            className={`${SECONDARY_BUTTON_COMPACT} flex-1 active:opacity-60`}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!password || checking}
            // Pressing Open must not move focus out of the field: on Android
            // that closes the keyboard, and a wrong password would then have
            // no keyboard to type the next one on.
            onMouseDown={(event) => event.preventDefault()}
            className={`${NEUTRAL_BUTTON_COMPACT} flex flex-1 items-center justify-center gap-2`}
          >
            {checking && (
              <LoaderCircle aria-hidden size={16} className="animate-spin" />
            )}
            {checking ? 'Checking…' : 'Open'}
          </button>
        </div>
      </form>
    </div>
  )
}

export function ErrorState({
  reason,
  detail,
  onRetry,
}: {
  reason: 'download' | 'damaged'
  /** The source's own words for what went wrong (`plainWords`). */
  detail: string | null
  onRetry: () => void
}) {
  return (
    <div
      role="alert"
      className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-8 text-center"
    >
      <FileWarning
        aria-hidden
        size={32}
        strokeWidth={1.7}
        className="mb-1 text-muted"
      />
      <h3 className="text-row-title text-ink">Could not open this PDF</h3>
      <p className="max-w-xs text-caption text-muted">
        {detail ??
          (reason === 'download'
            ? 'It didn’t download. Check your signal and try again.'
            : 'The file may be damaged, or not a PDF.')}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className={`${LINK_BUTTON_COMPACT} mt-3 px-5 shadow-elevation active:opacity-60`}
      >
        Try again
      </button>
    </div>
  )
}

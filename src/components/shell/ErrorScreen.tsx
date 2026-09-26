import { useState } from 'react'
import { Link, useRouter } from '@tanstack/react-router'
import { RotateCcw, WifiOff } from 'lucide-react'
import type { ErrorComponentProps } from '@tanstack/react-router'
import { LINK_BUTTON, PRIMARY_BUTTON } from '#/components/primitives/buttons'
import { isOffline } from '#/lib/online'

/**
 * The router's error screen for everything the special cases in router.tsx
 * do not claim: a page that could not load, drawn as the app draws things
 * rather than as the router's developer default ("Something went wrong!" and
 * a red box of the raw error). It says what to do — try again, or start from
 * the top — and keeps the raw message behind "Details" for whoever is asked
 * to look into it.
 *
 * "Try again" goes through `router.invalidate()`, not `reset()`: a plain
 * reset only re-renders, and a failed loader's match throws the same error
 * again (SignInSettling has the same note).
 */
export function ErrorScreen({ error }: ErrorComponentProps) {
  const router = useRouter()
  const [retrying, setRetrying] = useState(false)
  // Read once, on the render that failed: "no signal" is the likeliest cause
  // in the field, and the one with the clearest advice.
  const [offline] = useState(isOffline)
  const message = error instanceof Error ? error.message : String(error)

  return (
    // `data-error-screen` is how the e2e suite spots this screen, including
    // one that flashes and recovers (e2e/signInHandover.spec.ts).
    <div data-error-screen className="mx-auto w-full max-w-[460px] px-4 pt-6">
      <div
        role="alert"
        className="rounded-2xl border border-hairline bg-surface px-4 py-8 text-center shadow-elevation"
      >
        {offline && (
          <WifiOff
            aria-hidden
            size={28}
            strokeWidth={1.7}
            className="mx-auto mb-3 text-muted"
          />
        )}
        <p className="text-row-title text-ink">
          {offline ? 'You’re offline' : 'This screen didn’t load'}
        </p>
        <p className="mt-1 text-body text-muted">
          {offline
            ? 'Check your signal, then try again.'
            : 'Try again. If it keeps happening, start from the top.'}
        </p>
        <div className="mt-5 flex flex-col gap-2">
          <button
            type="button"
            disabled={retrying}
            onClick={() => {
              setRetrying(true)
              void router.invalidate().finally(() => setRetrying(false))
            }}
            className={`${PRIMARY_BUTTON} flex items-center justify-center gap-2`}
          >
            <RotateCcw size={17} strokeWidth={2} aria-hidden />
            {retrying ? 'Trying…' : 'Try again'}
          </button>
          <Link
            to="/"
            className={`${LINK_BUTTON} flex items-center justify-center`}
          >
            Start from the top
          </Link>
        </div>
      </div>
      {message && (
        <details className="mt-3 px-1">
          <summary className="inline-flex min-h-11 cursor-pointer items-center text-caption text-muted">
            Details
          </summary>
          <p className="select-text break-words font-mono text-[12px] text-muted">
            {message}
          </p>
        </details>
      )}
    </div>
  )
}

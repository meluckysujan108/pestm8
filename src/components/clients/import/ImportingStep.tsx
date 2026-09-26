import { LoaderCircle } from 'lucide-react'
import { FormAlert } from '#/components/forms/FormAlert'
import { useHydrated } from '#/lib/useHydrated'
import { PRIMARY_BUTTON, ProgressBar, SECONDARY_BUTTON } from './ui'
import type { ErrorCopy } from '#/components/forms/describeError'
import type { RunState } from './useImportRun'

const STOPPED_COPY: ErrorCopy = {
  IMPORT_UNDONE:
    'This import was undone from another screen, so the rest wasn’t sent.',
  NO_ACCESS:
    'Your access no longer covers importing clients, so the rest wasn’t sent. Ask the business owner.',
  NOT_FOUND: 'This import isn’t there any more, so the rest wasn’t sent.',
  // One of the refusals useImportRun won't try again, so not "paused".
  BATCH_TOO_LARGE:
    'PestM8 turned a batch down as too big, so the rest wasn’t sent. Split the file and import each part.',
  offline:
    'This device is offline, so the import is paused. Try again when you have signal.',
  default: 'The connection dropped, so the import is paused.',
}

/**
 * Step four: sending, a batch at a time, with a count that moves. On a
 * failure it stops where it was and says so; Try again carries on from
 * there, and Stop here settles for what has gone in.
 */
export function ImportingStep({
  state,
  onRetry,
  onFinish,
}: {
  state: RunState
  onRetry: () => void
  onFinish: () => void
}) {
  const hydrated = useHydrated()
  const { sent, total } = state
  const count = `${sent.toLocaleString('en-AU')} of ${total.toLocaleString('en-AU')}`

  if (state.status === 'failed') {
    return (
      <div className="mx-auto mt-10 max-w-md">
        <h2 className="text-sheet-title text-ink">
          {state.retryable ? 'The import is paused' : 'The import stopped'}
        </h2>
        <p className="mt-1.5 text-body text-muted">
          {sent > 0
            ? `${count} clients went in before it stopped.`
            : 'None of the clients had gone in yet.'}
        </p>
        <div className="mt-4">
          <ProgressBar label="Imported" done={sent} total={total} />
        </div>
        <FormAlert error={state.error} copy={STOPPED_COPY} className="mt-4" />
        {state.retryable && (
          <p className="mt-3 text-caption text-muted">
            Nothing is sent twice: Try again carries on from the first client
            that didn’t go in.
          </p>
        )}
        <div className="mt-5 flex flex-col gap-2">
          {state.retryable && (
            <button
              type="button"
              onClick={onRetry}
              disabled={!hydrated}
              className={PRIMARY_BUTTON}
            >
              Try again
            </button>
          )}
          <button
            type="button"
            onClick={onFinish}
            disabled={!hydrated}
            className={state.retryable ? SECONDARY_BUTTON : PRIMARY_BUTTON}
          >
            {state.retryable ? 'Stop here' : 'See what went in'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      role="status"
      className="mx-auto mt-16 flex max-w-md flex-col items-center text-center"
    >
      <LoaderCircle
        aria-hidden
        size={28}
        className="animate-spin text-muted motion-reduce:animate-none"
      />
      <p className="mt-4 text-row-title text-ink">Importing… {count}</p>
      <p className="mt-1 text-caption text-muted">
        Keep this page open until it’s done.
      </p>
      <div className="mt-5 w-full">
        <ProgressBar label="Importing" done={sent} total={total} />
      </div>
    </div>
  )
}

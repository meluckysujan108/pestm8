import { LoaderCircle } from 'lucide-react'
import { FormAlert } from '#/components/forms/FormAlert'
import {
  NEUTRAL_BUTTON,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
} from '#/components/primitives/buttons'
import { useHydrated } from '#/lib/useHydrated'
import { ProgressBar, STEP_HEADING, STEP_HEADING_CLASS } from './ui'
import type { ReactNode } from 'react'
import type { ErrorCopy } from '#/components/forms/describeError'
import type { RunState } from './useImportRun'

const STOPPED_COPY: ErrorCopy = {
  IMPORT_UNDONE:
    'This import was undone from another screen, so the rest wasn’t sent.',
  NO_ACCESS:
    'Your access no longer covers importing clients, so the rest wasn’t sent. Ask the business owner.',
  NOT_FOUND: 'This import isn’t there any more, so the rest wasn’t sent.',
  // Another import's undo, from another screen: batches wait for it
  // (convex/clientImports.ts `refuseWhileUndoing`), so this one is paused,
  // not stopped. Refused at the start instead, nothing has gone in, and the
  // page goes back to its review (`refusedBeforeStart`).
  UNDO_IN_PROGRESS:
    'An earlier import is still being undone. Once it’s finished, Try again carries on from here.',
  // One of the refusals useImportRun won't try again, so not "paused".
  BATCH_TOO_LARGE:
    'PestM8 turned a batch down as too big, so the rest wasn’t sent. Split the file and import each part.',
  offline:
    'This device is offline, so the import is paused. Try again when you have signal.',
  // Not the connection: a dropped one holds a batch and sends it again
  // itself, and never lands here. What does is the server turning a batch
  // down, most often once and for a moment, sometimes every time.
  default:
    'PestM8 couldn’t take the last few clients, so the import is paused. Try again — if it stops at the same place, choose Stop here and the rest will be in the download.',
}

/**
 * Step four: sending, a batch at a time, with a count that moves. On a
 * failure it stops where it was and says so; Try again carries on from
 * there, and Stop here settles for what has gone in.
 */
export function ImportingStep({
  state,
  wait,
  onRetry,
  onFinish,
}: {
  state: RunState
  /** Another import's undo, still running: said under the alert — with
   * Carry on undoing, when it has stopped — and Try again waits for it,
   * since until it's done every batch is turned down (UNDO_IN_PROGRESS). */
  wait?: ReactNode
  onRetry: () => void
  onFinish: () => void
}) {
  const hydrated = useHydrated()
  const { sent, total } = state
  const count = `${sent.toLocaleString('en-AU')} of ${total.toLocaleString('en-AU')}`

  if (state.status === 'failed') {
    return (
      <div className="mt-10">
        <h2
          {...STEP_HEADING}
          className={`text-sheet-title text-ink ${STEP_HEADING_CLASS}`}
        >
          {state.retryable ? 'The import is paused' : 'The import stopped'}
        </h2>
        <p className="mt-1.5 text-body text-muted">
          {sent > 0
            ? `${count} clients went in before it stopped.`
            : 'None of the clients had gone in yet.'}
        </p>
        <div className="mt-4 max-w-md">
          <ProgressBar label="Imported" done={sent} total={total} />
        </div>
        <FormAlert error={state.error} copy={STOPPED_COPY} className="mt-4" />
        {state.retryable && wait && <div className="mt-3">{wait}</div>}
        {state.retryable && (
          <p className="mt-3 text-caption text-muted">
            Nothing is sent twice: Try again carries on from the first client
            that didn’t go in.
          </p>
        )}
        <div className="mt-5 flex flex-col gap-2">
          {/* Try again sends the rest, so it is red. Stop here and See what
              went in save nothing: grey beside Try again, ink on their own. */}
          {state.retryable && (
            <button
              type="button"
              onClick={onRetry}
              disabled={!hydrated || Boolean(wait)}
              className={PRIMARY_BUTTON}
            >
              Try again
            </button>
          )}
          <button
            type="button"
            onClick={onFinish}
            disabled={!hydrated}
            className={state.retryable ? SECONDARY_BUTTON : NEUTRAL_BUTTON}
          >
            {state.retryable ? 'Stop here' : 'See what went in'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div role="status" className="mt-16 flex flex-col items-center text-center">
      <LoaderCircle
        aria-hidden
        size={28}
        className="animate-spin text-muted motion-reduce:animate-none"
      />
      {/* Where focus goes after Import and Try again (`focusStepHeading`):
          the button that had it has gone. */}
      <h2
        {...STEP_HEADING}
        className={`mt-4 text-row-title text-ink ${STEP_HEADING_CLASS}`}
      >
        Importing… {count}
      </h2>
      <p className="mt-1 text-caption text-muted">
        Keep this page open until it’s done.
      </p>
      <div className="mt-5 w-full max-w-md">
        <ProgressBar label="Importing" done={sent} total={total} />
      </div>
    </div>
  )
}

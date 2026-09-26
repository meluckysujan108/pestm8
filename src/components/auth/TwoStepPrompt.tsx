import { useSyncExternalStore } from 'react'
import { ShieldCheck } from 'lucide-react'
import {
  TWO_STEP_PATH,
  isTwoStepNeeded,
  subscribeTwoStepNeeded,
  twoStepHref,
} from '#/lib/twoStep'
import { NEUTRAL_BUTTON } from '#/components/primitives/buttons'

/**
 * What someone already inside the app sees when two-step sign-in becomes
 * compulsory under them — the release going live mid-shift, or the owner
 * resetting it — instead of being thrown out of the page.
 *
 * It used to be a `location.replace` to /two-step on the first refusal. That
 * lost whatever was on screen: a job sheet half filled in, a note being
 * typed, the address of the job they were driving to — and left them without
 * it until they had installed an authenticator app on whatever signal they
 * had. It also only ever fired for a refusal that came back from a fetch; a
 * refusal PUSHED to a live query (every query on screen, the moment the
 * server starts refusing) never reached that handler, so the page simply went
 * stale without a word.
 *
 * Now the page stays as it was — the server refuses everything new, so
 * nothing more can be read or saved, but what is showing stays readable — and
 * this card sits over the bottom of it until they tap through. Not
 * dismissible: there is nothing the app can do for them until it is set up.
 */
export function TwoStepPromptHost() {
  const needed = useSyncExternalStore(
    subscribeTwoStepNeeded,
    isTwoStepNeeded,
    () => false,
  )
  if (!needed) return null
  if (
    typeof window !== 'undefined' &&
    window.location.pathname === TWO_STEP_PATH
  ) {
    return null
  }
  return (
    <div className="fixed inset-x-4 bottom-[calc(16px+env(safe-area-inset-bottom))] z-50 mx-auto max-w-[420px] lg:inset-x-auto lg:right-4">
      <TwoStepNeededCard />
    </div>
  )
}

/**
 * The card itself — also what a page shows when it could not load at all for
 * the same reason (the router's error component).
 */
export function TwoStepNeededCard() {
  return (
    <div
      role="alert"
      className="rounded-2xl border border-hairline bg-surface p-4 shadow-elevation"
    >
      <div className="flex items-start gap-3">
        <ShieldCheck
          aria-hidden
          size={22}
          strokeWidth={1.7}
          className="mt-0.5 shrink-0 text-blue"
        />
        <div className="min-w-0">
          <p className="text-body font-semibold text-ink">
            Set up two-step sign-in to carry on
          </p>
          <p className="mt-1 text-caption text-muted">
            PestM8 now asks for a code from an authenticator app when you sign
            in. Nothing new can load or save until it’s set up. What’s on this
            screen stays readable until you go — copy anything you typed first.
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={() => {
          window.location.assign(
            twoStepHref(window.location.pathname + window.location.search),
          )
        }}
        className={`${NEUTRAL_BUTTON} mt-3 w-full`}
      >
        Set up now
      </button>
    </div>
  )
}

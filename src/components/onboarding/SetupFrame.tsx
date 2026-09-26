import { createContext, useContext, useEffect, useState } from 'react'
import { ChevronLeft } from 'lucide-react'
import { useHydrated } from '#/lib/useHydrated'
import type { ReactNode } from 'react'
import { PRIMARY_BUTTON } from '#/components/primitives/buttons'

/** The steps with a place on the progress bar, in order. Ready has none. */
export const SETUP_STEPS = ['business', 'brand', 'licence', 'team'] as const
export type SetupStep = (typeof SETUP_STEPS)[number] | 'ready'

/**
 * The way out of set-up altogether, from any step after the first — given by
 * the route, which knows the business. Without it an owner who wants the
 * schedule now would be sent back into set-up at every launch.
 */
export const FinishLaterContext = createContext<(() => void) | null>(null)

/**
 * The step on screen before this one. Each step is its own component, so
 * the frame mounts afresh every time and cannot remember it; this does, on
 * the client only (the server has no "before"), so a step knows which side
 * to come in from and whether its progress segment has just been reached.
 */
let shownBefore: number | null = null

/**
 * One screen of set-up: a question, what it changes, and the way on.
 *
 * Deliberately not the app's shell — no dock, no sidebar: there is nothing
 * to go to yet, and every step is one decision on its own screen. The step
 * slides in from the side it came from (Back from the left), and not at all
 * for anyone who has asked their phone for less motion.
 */
export function SetupFrame({
  step,
  title,
  lede,
  onBack,
  aside,
  hero,
  children,
}: {
  step: SetupStep
  title: string
  lede?: ReactNode
  /** Absent on the first step and the last. */
  onBack?: () => void
  /** Top right: "Add later", "Skip". */
  aside?: ReactNode
  /** Above the title — the finish's tick. */
  hero?: ReactNode
  children: ReactNode
}) {
  const hydrated = useHydrated()
  const finishLater = useContext(FinishLaterContext)
  const index = stepIndex(step)
  const ready = index === SETUP_STEPS.length

  // Read once, as this step mounts: where it came from.
  const [from] = useState(() =>
    typeof window === 'undefined' ? null : shownBefore,
  )
  useEffect(() => {
    shownBefore = index
  }, [index])
  const back = from !== null && index < from
  // The segment just reached fills in; one already passed is simply full.
  const [grown, setGrown] = useState(from === null || from >= index)
  useEffect(() => {
    if (grown) return
    const frame = requestAnimationFrame(() => setGrown(true))
    return () => cancelAnimationFrame(frame)
  }, [grown])

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[460px] flex-col px-5 pb-[calc(24px+env(safe-area-inset-bottom))] pt-[calc(8px+env(safe-area-inset-top))]">
      <div className="flex h-11 items-center justify-between">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            disabled={!hydrated}
            aria-label="Back"
            className="-ml-2.5 flex size-11 items-center justify-center rounded-full text-blue transition active:bg-surface-3 disabled:opacity-40"
          >
            <ChevronLeft size={28} strokeWidth={2} />
          </button>
        ) : (
          <span />
        )}
        {aside}
      </div>

      {!ready && (
        <div
          role="progressbar"
          aria-label="Set-up"
          aria-valuemin={1}
          aria-valuemax={SETUP_STEPS.length}
          aria-valuenow={index + 1}
          aria-valuetext={`Step ${index + 1} of ${SETUP_STEPS.length}`}
          className="mt-1 flex gap-1.5"
        >
          {SETUP_STEPS.map((s, i) => (
            <span
              key={s}
              className="h-1 flex-1 overflow-hidden rounded-full bg-surface-3"
            >
              <span
                className={`block h-full rounded-full bg-red transition-[width] duration-500 ease-out motion-reduce:transition-none ${i < index || (i === index && grown) ? 'w-full' : 'w-0'}`}
              />
            </span>
          ))}
        </div>
      )}

      <div
        className={`mt-7 flex flex-1 flex-col duration-300 motion-reduce:animate-none ${from === null ? '' : `animate-in fade-in ${back ? 'slide-in-from-left-6' : 'slide-in-from-right-6'}`}`}
      >
        {hero}
        {!ready && (
          <p className="section-label mb-2">
            Step {index + 1} of {SETUP_STEPS.length}
          </p>
        )}
        <h1 className="text-page-title text-ink">{title}</h1>
        {lede && <p className="mt-2 text-body text-muted">{lede}</p>}
        {children}
        {finishLater && (step === 'brand' || step === 'licence') && (
          <button
            type="button"
            onClick={finishLater}
            disabled={!hydrated}
            className="mx-auto mt-3 min-h-11 px-3 text-[15px] text-muted transition active:opacity-60 disabled:opacity-40"
          >
            Finish setting up later
          </button>
        )}
      </div>
    </main>
  )
}

/** Where a step sits: 0–3 on the bar, and one past the end for Ready. */
function stepIndex(step: SetupStep): number {
  const i = SETUP_STEPS.indexOf(step as (typeof SETUP_STEPS)[number])
  return i === -1 ? SETUP_STEPS.length : i
}

/** The way on — the one red button a step has. */
export function ContinueButton({
  pending,
  disabled,
  children = 'Continue',
  pendingLabel = 'Saving…',
}: {
  pending: boolean
  disabled?: boolean
  children?: ReactNode
  pendingLabel?: string
}) {
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className={`${PRIMARY_BUTTON} mt-8 w-full shrink-0`}
    >
      {pending ? pendingLabel : children}
    </button>
  )
}

/** "Add later", "Skip" — top right, quieter than Continue. Waits for
 * hydration like every control: a tap before it is silently lost. */
export function AsideButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}) {
  const hydrated = useHydrated()
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || !hydrated}
      className="-mr-2 min-h-11 rounded-full px-2 text-[17px] text-blue transition active:opacity-60 disabled:opacity-40"
    >
      {children}
    </button>
  )
}

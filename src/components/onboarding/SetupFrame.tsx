import { useRef } from 'react'
import { ChevronLeft } from 'lucide-react'
import type { ReactNode } from 'react'

/** The steps with a place on the progress bar, in order. Ready has none. */
export const SETUP_STEPS = ['business', 'brand', 'licence', 'team'] as const
export type SetupStep = (typeof SETUP_STEPS)[number] | 'ready'

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
  /** Top right: "Add later", "Finish later". */
  aside?: ReactNode
  /** Above the title — the finish's tick. */
  hero?: ReactNode
  children: ReactNode
}) {
  const index = SETUP_STEPS.indexOf(step as (typeof SETUP_STEPS)[number])
  // Which way the step came in, read off the one before it. A ref, not state:
  // it only has to be right for the render that shows the new step.
  const last = useRef(index)
  const back = index !== -1 && last.current !== -1 && index < last.current
  last.current = index

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[460px] flex-col px-5 pb-[calc(24px+env(safe-area-inset-bottom))] pt-[calc(8px+env(safe-area-inset-top))]">
      <div className="flex h-11 items-center justify-between">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            aria-label="Back"
            className="-ml-2.5 flex size-11 items-center justify-center rounded-full text-blue transition active:bg-surface-3"
          >
            <ChevronLeft size={28} strokeWidth={2} />
          </button>
        ) : (
          <span />
        )}
        {aside}
      </div>

      {index !== -1 && (
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
                className={`block h-full rounded-full bg-red transition-[width] duration-500 ease-out motion-reduce:transition-none ${i <= index ? 'w-full' : 'w-0'}`}
              />
            </span>
          ))}
        </div>
      )}

      <div
        key={step}
        className={`mt-7 flex flex-1 flex-col duration-300 animate-in fade-in motion-reduce:animate-none ${back ? 'slide-in-from-left-6' : 'slide-in-from-right-6'}`}
      >
        {hero}
        {index !== -1 && (
          <p className="section-label mb-2">
            Step {index + 1} of {SETUP_STEPS.length}
          </p>
        )}
        <h1 className="text-page-title text-ink">{title}</h1>
        {lede && <p className="mt-2 text-body text-muted">{lede}</p>}
        {children}
      </div>
    </main>
  )
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
      className="mt-8 h-12 w-full shrink-0 rounded-xl bg-red text-[17px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
    >
      {pending ? pendingLabel : children}
    </button>
  )
}

/** "Add later", "Finish later" — top right, quieter than Continue. */
export function AsideButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="-mr-2 min-h-11 rounded-full px-2 text-[17px] text-blue transition active:opacity-60 disabled:opacity-40"
    >
      {children}
    </button>
  )
}

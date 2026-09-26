import { Check } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * The pieces every step of "Bring your clients across" is laid out with, so
 * the four screens read as one flow: the same column, the same heading, the
 * same bar pinned to the bottom with the way on.
 */

export const PRIMARY_BUTTON =
  'inline-flex h-12 items-center justify-center rounded-xl bg-red px-5 text-[17px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50'

export const SECONDARY_BUTTON =
  'inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-surface-2 px-4 text-[17px] font-semibold text-blue transition active:scale-[.975] disabled:opacity-50'

/** A card's own small actions — Edit, Leave out — quieter than the page's. */
export const SMALL_BUTTON =
  'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg bg-surface-2 px-3 text-[14px] font-semibold text-blue transition active:scale-[.97] disabled:opacity-50'

/** "1 client", "212 clients", "1,240 sites". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-AU')} ${n === 1 ? one : many}`
}

/** The column every step sits in: wide enough for a laptop's review, and
 * never wider, so a line of a card is read in one sweep. */
export function ImportBody({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[760px] px-4 pb-8 pt-5">
      {children}
    </div>
  )
}

export function StepHeading({
  title,
  lede,
  children,
}: {
  title: string
  lede?: ReactNode
  /** Beside the lede: the "Looks like a Jobber export" chip. */
  children?: ReactNode
}) {
  return (
    <div className="mt-5">
      <h2 className="text-sheet-title text-ink">{title}</h2>
      {children}
      {lede && <p className="mt-1.5 text-body text-muted">{lede}</p>}
    </div>
  )
}

const STEPS = [
  { key: 'choose', label: 'Your file' },
  { key: 'match', label: 'Match columns' },
  { key: 'review', label: 'Review' },
] as const

export type StepKey = (typeof STEPS)[number]['key']

/**
 * Where the person is in the three steps before anything is saved. Just
 * words and a tick: a numbered wizard would promise more steps than there
 * are, and the one thing that matters — nothing is saved yet — is said by
 * the lede.
 */
export function Stepper({ current }: { current: StepKey }) {
  const at = STEPS.findIndex((s) => s.key === current)
  return (
    <ol className="flex items-center gap-2 text-[13px] font-semibold">
      {STEPS.map((step, i) => {
        const done = i < at
        const here = i === at
        return (
          <li
            key={step.key}
            aria-current={here ? 'step' : undefined}
            className="flex min-w-0 items-center gap-2"
          >
            {i > 0 && (
              <span aria-hidden className="h-px w-3 shrink-0 bg-hairline" />
            )}
            <span
              aria-hidden
              className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] ${
                done
                  ? 'bg-green text-white'
                  : here
                    ? 'bg-ink text-canvas'
                    : 'bg-surface-3 text-muted'
              }`}
            >
              {done ? <Check size={12} strokeWidth={3} /> : i + 1}
            </span>
            <span
              className={`truncate ${here ? 'text-ink' : 'text-muted'} ${here ? '' : 'max-sm:sr-only'}`}
            >
              {step.label}
              {done && <span className="sr-only"> (done)</span>}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/**
 * The step's way on, pinned where the thumb is: above the phone's dock, and
 * at the foot of the window on a laptop, which has none. The same place
 * Settings pins its Save (`SaveBar`), for the same reason — a long list's
 * button is never a scroll away.
 */
export function BottomBar({ children }: { children: ReactNode }) {
  return (
    <div className="sticky bottom-[calc(55px+env(safe-area-inset-bottom))] z-20 -mx-4 mt-6 border-t border-hairline bg-canvas/90 px-4 py-3 backdrop-blur lg:bottom-0">
      {children}
    </div>
  )
}

/** A tick that draws itself once, as set-up's last step does (the keyframes
 * are set-up's, in styles.css). Still, for anyone who asked for less motion. */
export function DrawnCheck() {
  return (
    <div
      aria-hidden
      className="flex size-14 items-center justify-center rounded-full bg-green-bg motion-safe:animate-[setup-pop_420ms_cubic-bezier(.2,.9,.3,1.3)_both]"
    >
      <svg viewBox="0 0 24 24" className="size-8 text-green-ink" fill="none">
        <path
          d="M5 12.5l4.2 4.2L19 7"
          stroke="currentColor"
          strokeWidth={2.6}
          strokeLinecap="round"
          strokeLinejoin="round"
          pathLength={1}
          className="[stroke-dasharray:1] motion-safe:[stroke-dashoffset:1] motion-safe:animate-[setup-draw_480ms_ease-out_220ms_forwards]"
        />
      </svg>
    </div>
  )
}

/** A thin bar that fills: "Checking addresses…", "Importing…". */
export function ProgressBar({
  label,
  done,
  total,
}: {
  label: string
  done: number
  total: number
}) {
  const share = total === 0 ? 0 : Math.min(1, done / total)
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3"
    >
      <div
        className="h-full rounded-full bg-green transition-[width] duration-300 ease-out motion-reduce:transition-none"
        style={{ width: `${share * 100}%` }}
      />
    </div>
  )
}

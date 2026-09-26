import { HomeScreenCard } from './HomeScreenCard'
import { ReportPreview } from './ReportPreview'
import { SetupFrame } from './SetupFrame'
import type { BusinessRecord } from '#/components/settings/BusinessSection'

/**
 * The end of set-up: what it made, the Home Screen, and the first real job.
 *
 * The preview is the whole report top as it now stands — the payoff for the
 * steps before it — and the one red button goes straight to booking a job,
 * because a booked job is where the app starts being used.
 */
export function ReadyStep({
  business,
  onBook,
  onSchedule,
}: {
  business: BusinessRecord
  onBook: () => void
  onSchedule: () => void
}) {
  return (
    <SetupFrame
      step="ready"
      title={`${business.name} is ready`}
      lede="Here’s how the top of your reports will look."
      hero={<DrawnCheck />}
    >
      <ReportPreview
        className="mt-5"
        name={business.name}
        logoUrl={business.logoUrl}
        email={business.email}
        phone={business.phone}
        abn={business.abn}
        state={business.state}
        licenceNumber={business.membership.licenceNumber}
        focus={null}
      />

      <div className="mt-5">
        <HomeScreenCard />
      </div>

      <button
        type="button"
        onClick={onBook}
        className="mt-8 h-12 w-full shrink-0 rounded-xl bg-red text-[17px] font-semibold text-white shadow-red transition active:scale-[.975]"
      >
        Book your first job
      </button>
      <button
        type="button"
        onClick={onSchedule}
        className="mt-2 min-h-11 w-full text-[17px] text-blue transition active:opacity-60"
      >
        Go to the schedule
      </button>
    </SetupFrame>
  )
}

/** A tick that draws itself once — the only flourish set-up allows itself.
 * Still, and simply drawn, for anyone who has asked for less motion. */
function DrawnCheck() {
  return (
    <div
      aria-hidden
      className="mb-5 flex size-14 items-center justify-center rounded-full bg-green-bg motion-safe:animate-[setup-pop_420ms_cubic-bezier(.2,.9,.3,1.3)_both]"
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

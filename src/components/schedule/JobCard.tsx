import { CalendarClock, Repeat } from 'lucide-react'
import { formatDuration, formatJobMoney, formatTime } from '#/lib/format'
import { StatusPill } from '#/components/primitives/StatusPill'
import { ContactButtons } from '#/components/primitives/ContactButtons'
import { cardActionsFor, isOverdueProjection } from '#/lib/jobCardActions'
import { mapsUrl } from '#/lib/maps'
import { OVERDUE_CHIP } from '#/lib/statusColours'
import { WeatherStrip } from './WeatherStrip'
import type { JobStatus } from '#/components/primitives/StatusPill'
import type { WeatherCell } from '#/lib/weather'

export type JobRow = {
  _id: string
  jobNumber?: number
  jobType: string
  price: number
  scheduledAt: number
  durationMinutes: number
  status: JobStatus
  addressLine?: string
  suburb: string
  postcode?: string
  clientName: string
  /** Absent from a backend older than the card's Call — then there is no
   * Call, rather than a broken one. */
  clientPhone?: string
  assigneeColour: string
  assigneeName?: string
  assignedMembershipId: string
  recurrenceId?: string
}

/** "9:30am – 11:00am · 1 hr" — the span, not just the start. */
function timeRange(job: JobRow, timezone: string): string {
  const end = job.scheduledAt + job.durationMinutes * 60_000
  return `${formatTime(job.scheduledAt, timezone)} – ${formatTime(end, timezone)} · ${formatDuration(job.durationMinutes)}`
}

/** A label on the left, its value right-aligned against it. */
function Row({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <span className="flex items-center justify-between gap-3 py-[3px]">
      <span className="shrink-0 text-caption text-muted">{label}</span>
      <span className="min-w-0 truncate text-right text-caption font-semibold text-ink-2">
        {children}
      </span>
    </span>
  )
}

export function JobCard({
  job,
  weather = { status: 'outOfWindow' },
  timezone,
  travel,
  onOpen,
  hideTechnician = false,
  hideActions = false,
}: {
  job: JobRow
  /** The day's forecast where there is one. The Job tab lists work across
   * months, where a per-row forecast neither exists nor is the point, so it
   * renders without one. */
  weather?: WeatherCell
  timezone: string
  /** Hop from the previous job in the day, e.g. "≈ 8 km → Morley". */
  travel?: string | null
  onOpen: (jobId: string) => void
  /** The Schedule. Its side strip is already the technician's colour, and a
   * day is scanned for where and when, not who — in every view mode, not
   * only "Just my jobs" as before. The Job tab and the Recurring Job view
   * keep the name: a list across months without an assignee is less use. */
  hideTechnician?: boolean
  /** The Recurring Job view. Its cards are projections nobody has
   * committed to — no one to ring about them as arranged work, nowhere to
   * drive — so it offers no Call or Map at all, even on one whose day has
   * come. Everywhere else the job's own status decides (`cardActionsFor`). */
  hideActions?: boolean
}) {
  /**
   * The card is a frame, not a button. Opening the job is one button inside
   * it, holding everything that describes the job, so anything else that
   * acts — a call, a map — can sit beside it as a real control rather than
   * nested inside another (invalid HTML, and the outer click swallows the
   * inner one). The frame shrinks when that button is pressed, as the whole
   * card did when it was the button.
   *
   * The button runs to the frame's left edge, under the colour rail: the rail
   * is drawn over it and lets presses through, so the rail and the space
   * beside it still open the job, as they did when the card was one button.
   */
  const shell =
    'relative flex h-full w-full flex-col rounded-2xl border border-hairline bg-surface shadow-elevation transition has-[.job-card-open:active]:scale-[.99]'

  /**
   * "19 Sep" when this is a projected visit whose day has passed, otherwise
   * null. Derived here rather than sent by the server: the card already knows
   * the tenant's timezone, and the answer changes at midnight without anything
   * having to re-query.
   */
  const now = Date.now()
  const overdueSince = isOverdueProjection(job, timezone, now)
    ? new Intl.DateTimeFormat('en-AU', {
        timeZone: timezone,
        day: 'numeric',
        month: 'short',
      }).format(new Date(job.scheduledAt))
    : null

  // What sits beside the open button: Call and Map on committed work, a
  // call to book a projection whose day has come, nothing otherwise. Worked
  // out here as well as inside ContactButtons so a card with nothing to
  // offer renders no empty row.
  const actions = hideActions ? 'none' : cardActionsFor(job, timezone, now)
  const phone = job.clientPhone || undefined
  const offersCall = actions !== 'none' && phone !== undefined
  const offersMap = actions === 'visit' && mapsUrl(job) !== null

  return (
    <div className={shell}>
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 w-1.5 rounded-l-2xl"
        style={{ backgroundColor: job.assigneeColour }}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <button
          type="button"
          onClick={() => onOpen(job._id)}
          className="job-card-open flex min-w-0 flex-1 flex-col gap-3 rounded-2xl p-4 pl-6 text-left"
        >
          <span className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2">
              {job.jobNumber !== undefined && (
                <span className="shrink-0 font-mono text-caption font-bold tabular-nums text-muted">
                  #{job.jobNumber}
                </span>
              )}
              <StatusPill status={job.status} />
              {job.recurrenceId !== undefined && (
                <Repeat
                  size={13}
                  strokeWidth={1.7}
                  role="img"
                  aria-label="Recurring job"
                  // Not blue: blue is Invoiced now (src/lib/statusColours.ts),
                  // and this marks a series, not a status.
                  className="shrink-0 text-ink-2"
                />
              )}
            </span>
            <span className="shrink-0 font-mono text-caption tabular-nums text-muted">
              {formatTime(job.scheduledAt, timezone)}
            </span>
          </span>

          {/* A projection carried forward from a day nobody opened. Its time and
              date are no longer today's, so the card has to say which day it was
              due or it reads as work scheduled for now. Ink, not a hue: see
              `--overdue` in styles.css. */}
          {overdueSince !== null && (
            <span
              className={`inline-flex items-center gap-1.5 self-start rounded-full px-2.5 py-1 text-[12px] font-semibold ${OVERDUE_CHIP}`}
            >
              <CalendarClock size={13} strokeWidth={2} aria-hidden />
              Overdue since {overdueSince}
            </span>
          )}

          <span className="block min-w-0">
            <span className="block truncate text-sheet-title text-ink">
              {job.clientName}
            </span>
            {/* The suburb alone, as the table row shows it: a day is scanned
                for where. The street address rides with the Map button, and
                the detail sheet prints it in full. */}
            <span className="mt-0.5 block truncate text-caption text-muted">
              {job.suburb}
            </span>
          </span>

          <span className="block border-t border-hairline-2 pt-1.5">
            <Row label="Service">{job.jobType}</Row>
            <Row label="Time">{timeRange(job, timezone)}</Row>
            {/* Off the Schedule's cards, where the rail's colour says whose job
                it is — which a screen reader cannot see, so it still says. */}
            {job.assigneeName && hideTechnician && (
              <span className="sr-only">Technician: {job.assigneeName}</span>
            )}
            {job.assigneeName && !hideTechnician && (
              <Row label="Technician">
                <span className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: job.assigneeColour }}
                  />
                  {job.assigneeName}
                </span>
              </Row>
            )}
          </span>

          <WeatherStrip cell={weather} />

          <span className="mt-auto flex items-end justify-between gap-2 border-t border-hairline-2 pt-3">
            <span className="min-w-0 truncate text-caption text-muted">
              {travel ?? ''}
            </span>
            <span className="shrink-0 text-metric-sm leading-none text-ink">
              {formatJobMoney(job)}
            </span>
          </span>
        </button>

        {(offersCall || offersMap) && (
          <div className="px-4 pb-4 pl-6">
            <ContactButtons
              name={job.clientName}
              phone={phone}
              address={job}
              show={actions === 'visit' ? ['call', 'map'] : ['call']}
              callToBook={actions === 'book'}
              variant="card"
            />
          </div>
        )}
      </div>
    </div>
  )
}

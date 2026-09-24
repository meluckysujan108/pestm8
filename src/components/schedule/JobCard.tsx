import { CalendarClock, Repeat } from 'lucide-react'
import { formatJobDate, formatJobMoney, formatTimeRange } from '#/lib/format'
import { StatusPill } from '#/components/primitives/StatusPill'
import {
  ContactButtons,
  MapHoldButton,
} from '#/components/primitives/ContactButtons'
import {
  cardActionsFor,
  cardButtonsFor,
  isOverdueProjection,
} from '#/lib/jobCardActions'
import { mapsUrl } from '#/lib/maps'
import { describeInterval } from '../../../convex/lib/recurrence'
import { dayKeyOf } from '../../../convex/lib/dates'
import { OVERDUE_CHIP } from '#/lib/statusColours'
import { WeatherStrip } from './WeatherStrip'
import type { JobStatus } from '#/components/primitives/StatusPill'
import type { WeatherCell } from '#/lib/weather'
import type { Interval } from '../../../convex/lib/recurrence'

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
  /** The property's state, so its suburb is found in the right one. Absent
   * from a backend older than it; the business's state stands in. */
  propertyState?: string
  clientName: string
  /** Absent from a backend older than the card's Call — then there is no
   * Call, rather than a broken one. */
  clientPhone?: string
  /** Absent from a backend older than the card's Email — then no Email. */
  clientEmail?: string
  assigneeColour: string
  assigneeName?: string
  assignedMembershipId: string
  recurrenceId?: string
  /** How often the visit's series repeats, while it runs. Absent for a
   * one-off, a stopped series, and on a backend older than the indicator. */
  repeats?: Interval
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
  dayShown,
}: {
  job: JobRow
  /** The forecast for the job's suburb, where there is one — within the
   * next two weeks. It is for the job's own day on the Job tab and the
   * Recurring Job view, and for the day on screen on the Schedule, which
   * includes an overdue visit carried forward to today. Without one
   * (further out, or not asked for) the card draws no strip. */
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
  /**
   * The day the page is showing, when it shows one (the Schedule's day
   * key). The card then leaves out its Date row, since the heading says it —
   * unless the job is on another day, as a visit carried forward from a day
   * nobody opened is. Omitted (the Job tab, the Recurring Job view, lists
   * that span weeks) the card always says its date.
   */
  dayShown?: string
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
   * Whether this is a projected visit whose day has passed. Derived here
   * rather than sent by the server: the card already knows the tenant's
   * timezone, and the answer changes at midnight without anything having to
   * re-query. The day it was due is in the Date row, which such a card
   * always has.
   */
  const now = Date.now()
  const overdue = isOverdueProjection(job, timezone, now)

  // The day the job is booked for, in the tenant's zone. Compared with the
  // page's own day as two keys — no clock — so the server render and the
  // phone always agree on whether the row shows.
  const jobDay = dayKeyOf(job.scheduledAt, timezone)
  const showDate = dayShown === undefined || jobDay !== dayShown

  // What sits beside the open button (cardActionsFor, cardButtonsFor): on
  // committed work, Call, Text and Email along the bottom and the Map in the
  // corner; on a projection whose day has come, the three to book it;
  // otherwise nothing. Worked out here as well as inside ContactButtons so a
  // card with nothing to offer renders no empty row.
  const buttons = cardButtonsFor(
    hideActions ? 'none' : cardActionsFor(job, timezone, now),
  )
  const phone = job.clientPhone || undefined
  const email = job.clientEmail || undefined
  const offersContact =
    buttons.contact && (phone !== undefined || email !== undefined)
  // Never beside the "Overdue" chip: that marks a projection, and a
  // projection has no Map. So the corner can sit at a fixed height below.
  const offersMap = buttons.map && mapsUrl(job) !== null

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
          {/* A fixed height, so the corner Map below lines up with the suburb
              whatever the row holds. */}
          <span className="flex h-7 items-center justify-between gap-2">
            {/* Keeps its width: on a narrow card the indicator gives way, and
                truncates, rather than the status pill running over it. */}
            <span className="flex shrink-0 items-center gap-2">
              {job.jobNumber !== undefined && (
                <span className="shrink-0 font-mono text-caption font-bold tabular-nums text-muted">
                  #{job.jobNumber}
                </span>
              )}
              <StatusPill status={job.status} />
            </span>
            {/* Where the start time was: the time is in the Time row below,
                and the corner says instead whether this comes round again.
                Ink, not a hue — blue is Invoiced, and this marks a series,
                not a status. */}
            {job.repeats !== undefined && (
              <span className="inline-flex min-w-0 items-center gap-1 text-caption font-semibold text-ink-2">
                <Repeat
                  size={13}
                  strokeWidth={1.8}
                  aria-hidden
                  className="shrink-0"
                />
                <span className="truncate">
                  {describeInterval(job.repeats)}
                </span>
              </span>
            )}
          </span>

          {/* A projection carried forward from a day nobody opened. Its time and
              date are no longer today's: the chip says so, and the Date row
              (always shown for it, since its day is not the page's) says
              which day it was due. Ink, not a hue: see `--overdue` in
              styles.css. */}
          {overdue && (
            <span
              className={`inline-flex items-center gap-1.5 self-start rounded-full px-2.5 py-1 text-[12px] font-semibold ${OVERDUE_CHIP}`}
            >
              <CalendarClock size={13} strokeWidth={2} aria-hidden />
              Overdue
            </span>
          )}

          {/* Room on the right for the corner Map, which sits over this. */}
          <span className={`block min-w-0 ${offersMap ? 'pr-24' : ''}`}>
            <span className="block truncate text-sheet-title text-ink">
              {job.clientName}
            </span>
            {/* The suburb alone: a day is scanned for where. The street
                address rides with the Map, and the detail sheet prints it in
                full. */}
            <span className="mt-0.5 block truncate text-caption text-muted">
              {job.suburb}
            </span>
          </span>

          <span className="block border-t border-hairline-2 pt-1.5">
            <Row label="Service">{job.jobType}</Row>
            {showDate && (
              <Row label="Date">
                <time dateTime={jobDay}>
                  {formatJobDate(jobDay, dayKeyOf(now, timezone))}
                </time>
              </Row>
            )}
            <Row label="Time">
              {formatTimeRange(job.scheduledAt, job.durationMinutes, timezone)}
            </Row>
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

        {/* The Map, top right beside the name and suburb. A sibling laid over
            the open button, never inside it: a button in a button is invalid,
            and the outer one would swallow the hold. The spacer is the header
            row's fixed height, so it lands level with the name block. Here in the
            markup, between the two, so focus meets it where the eye does. */}
        {offersMap && (
          <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col gap-3 p-4 pl-6">
            <span aria-hidden className="h-7" />
            <div className="flex justify-end">
              <span className="pointer-events-auto">
                <MapHoldButton address={job} />
              </span>
            </div>
          </div>
        )}

        {offersContact && (
          <div className="px-4 pb-4 pl-6">
            {buttons.toBook && (
              <p className="mb-2 text-caption text-muted">
                Not booked yet — contact to book
              </p>
            )}
            <ContactButtons
              name={job.clientName}
              phone={phone}
              email={email}
              show={['call', 'text', 'email']}
              toBook={buttons.toBook}
              variant="card"
            />
          </div>
        )}
      </div>
    </div>
  )
}

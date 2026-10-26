import { useEffect, useRef, useState } from 'react'
import { Drawer } from 'vaul'
import { Repeat, WifiOff } from 'lucide-react'
import { SHEET_BODY } from '#/components/primitives/Sheet'
import { ContactButtons } from '#/components/primitives/ContactButtons'
import { DetailRow, DetailRows } from '#/components/primitives/DetailRow'
import { StatusPill } from '#/components/primitives/StatusPill'
import { personLabel } from '#/lib/assignees'
import { logConnection } from '#/lib/connectionLog'
import {
  formatJobDate,
  formatJobMoney,
  formatTimeRange,
  formatUpdated,
} from '#/lib/format'
import { cardActionsFor, cardButtonsFor } from '#/lib/jobCardActions'
import { mapsUrl } from '#/lib/maps'
import { keeper } from '#/lib/offline/keeper'
import {
  KEPT_JOB_WAIT_MS,
  NOT_KEPT_JOB,
  dayOfBusiness,
  keptJobInset,
  keptJobState,
} from '#/lib/offline/keptJob'
import {
  useKeeperReads,
  useLineDown,
  useWaitedOut,
} from '#/lib/offline/useKept'
import { dayKeyOf } from '../../../convex/lib/dates'
import { describeInterval } from '../../../convex/lib/recurrence'
import { contactToCall } from '../../../convex/lib/siteContact'
import type { ReactNode } from 'react'
import type { FunctionReturnType } from 'convex/server'
import type { ContactAction } from '#/components/primitives/ContactButtons'
import type { DayRow, LineDown } from '#/lib/offline/keeper'
import type { KeptJobState } from '#/lib/offline/keptJob'
import type { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'

type Roster = FunctionReturnType<typeof api.memberships.listForBusiness>

/** The job as a day lists it, and how old that is. */
export type KeptJobDay = { row: DayRow; asOf: number }

/**
 * Whether the job sheet shows the job from its day (`keptJobState`), and
 * the day's row to show it from. Looked for once the line is down, or once
 * PestM8 has been asked for KEPT_JOB_WAIT_MS with no answer; looked for
 * again whenever the keeper may read differently (a day arriving, the
 * phone's copy read), and each second while a live day is all that keeps the
 * placeholder up, while the sheet is still waiting. Only a day of this
 * business (`dayOfBusiness`): `keeper.findDayRow` takes a day in memory
 * first, then the phone's copy as it would answer for this person, business
 * and view.
 *
 * `waiting`: `jobs.get` has neither answered nor been refused. Once it has,
 * the sheet is the live one, and this says `waiting` (nothing to show).
 */
export function useKeptJob(
  businessId: Id<'businesses'>,
  jobId: Id<'jobs'>,
  waiting: boolean,
): { state: KeptJobState; day: KeptJobDay | null; down: LineDown | null } {
  const down = useLineDown()
  const waitedOut = useWaitedOut(waiting, down, KEPT_JOB_WAIT_MS)
  // Latched once shown, so a line that comes back before the answer does
  // doesn't put the placeholder back over a job already on screen.
  const [shown, setShown] = useState(false)

  const looking = waiting && (down !== null || waitedOut || shown)
  const found = looking
    ? dayOfBusiness(keeper.findDayRow(jobId), businessId)
    : null
  const state = looking
    ? keptJobState({
        down,
        waitedOut,
        shown,
        found: found !== null,
        live: found?.live === true,
        copyRead: keeper.copyRead(),
      })
    : 'waiting'
  useEffect(() => {
    if (state === 'kept') setShown(true)
  }, [state])
  useKeeperReads(
    waiting,
    looking && state === 'waiting' && found?.live === true,
  )

  // For the phone's connection notes: a job asked for that the phone
  // doesn't keep, once for each sheet opened.
  const noted = useRef(false)
  useEffect(() => {
    if (state !== 'not-kept' || noted.current) return
    noted.current = true
    logConnection('kept-not-here', { what: 'job' })
  }, [state])

  return {
    state,
    day: found ? { row: found.row, asOf: found.asOf } : null,
    down,
  }
}

/**
 * A job opened with no answer from PestM8, shown read-only from the day
 * that lists it (`useKeptJob`), in place of the job sheet until PestM8
 * answers. What a technician needs at the door: its status, when, the
 * client, the address with Map, Call and Text, the work order, the note, and
 * who is going. Call and Text follow the job card's rules (`cardActionsFor`,
 * `contactToCall`), so the sheet rings whoever the card does.
 *
 * Typed from `jobs.listDay`'s row rather than `jobs.get`'s: a change to the
 * day's fields shows here as a type error, not as a sheet missing a line.
 * The rest of the live sheet (notes, reports, photos, history, editing)
 * needs PestM8, and comes back with it.
 */
export function KeptJobView({
  job,
  asOf,
  down,
  timezone,
  roster,
}: {
  job: DayRow
  /** When the day was last known right (`keeper.findDayRow`). */
  asOf: number
  down: LineDown | null
  timezone: string
  /** The team, for who is going by name, as the live sheet names them. */
  roster: Roster | undefined
}) {
  // Drawn only in the browser, after a wait or with the line down, so the
  // phone's clock gives today here.
  const now = Date.now()
  const todayKey = dayKeyOf(now, timezone)
  const jobDay = dayKeyOf(job.scheduledAt, timezone)

  const buttons = cardButtonsFor(cardActionsFor(job, timezone, now))
  const callee = contactToCall({
    clientKind: job.clientKind,
    clientName: job.clientName,
    clientPhone: job.clientPhone,
    siteContactName: job.siteContactName,
    siteContactPhone: job.siteContactPhone,
    contactPersonName: job.contactPersonName,
    contactPersonPhone: job.contactPersonPhone,
  })
  const offersCall = buttons.contact && callee.phone !== undefined
  const offersMap = buttons.map && mapsUrl(job) !== null
  const show: Array<ContactAction> = [
    ...(offersCall ? (['call', 'text'] as const) : []),
    ...(offersMap ? (['map'] as const) : []),
  ]

  // The lead, then anyone also going, named from the roster as the live
  // sheet names them, else as the day lists them.
  const nameOf = (membershipId: string, listed: string) => {
    if (roster === undefined) return listed || 'No longer on the team'
    const person = roster.find((member) => member._id === membershipId)
    return person ? personLabel(person) : 'No longer on the team'
  }
  const people = [
    {
      _id: job.assignedMembershipId,
      colour: job.assigneeColour,
      name: nameOf(job.assignedMembershipId, job.assigneeName),
    },
    ...job.alsoGoing.map((person) => ({
      _id: person._id,
      colour: person.colour,
      name: nameOf(person._id, person.name),
    })),
  ]

  return (
    <div className={`${SHEET_BODY} pt-3`}>
      {job.jobNumber !== undefined && (
        <p className="section-label mb-0.5">Job #{job.jobNumber}</p>
      )}
      <Drawer.Title className="text-sheet-title text-ink">
        {job.jobType}
      </Drawer.Title>

      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusPill status={job.status} />
        <span className="text-body text-muted">
          <span className="whitespace-nowrap">
            {formatJobDate(jobDay, todayKey)}
          </span>{' '}
          <span className="whitespace-nowrap">
            · {formatTimeRange(job.scheduledAt, job.durationMinutes, timezone)}
          </span>
        </span>
      </div>

      <div className="mt-2 flex min-h-5 flex-wrap items-center gap-x-3 gap-y-1 text-caption text-ink-2">
        {people.map((person, i) => (
          <span key={person._id} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: person.colour }}
            />
            <span className="sr-only">
              {i === 0
                ? people.length > 1
                  ? 'Technicians: '
                  : 'Technician: '
                : i === people.length - 1
                  ? 'and '
                  : ', '}
            </span>
            <span>{person.name}</span>
          </span>
        ))}
        {job.repeats && (
          <span className="flex items-center gap-1">
            <Repeat
              aria-hidden
              size={13}
              strokeWidth={2}
              className="text-muted"
            />
            {describeInterval(job.repeats)}
          </span>
        )}
      </div>

      {/* Why it can't be changed, where the live sheet says why a job
          can't be: the Products sheet's line. */}
      <p className="mt-3 flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2 text-caption text-ink-2">
        <WifiOff
          aria-hidden
          size={14}
          strokeWidth={2}
          className="mt-0.5 shrink-0"
        />
        {keptJobInset(down, formatUpdated(asOf, timezone, todayKey))}
      </p>

      <Section label="Property">
        <p className="min-w-0 text-row-title text-ink">{job.clientName}</p>
        <p className="text-body text-ink-2">{job.addressLine}</p>
        <p className="text-body text-muted">
          {job.suburb} {job.propertyState} {job.postcode}
        </p>
        {/* Who to ask for, as the card's Contact line says it. */}
        {callee.askFor && (
          <p className="mt-2 text-caption">
            <span className="text-muted">Contact</span>{' '}
            <span className="font-semibold text-ink-2">{callee.askFor}</span>
          </p>
        )}
        {show.length > 0 && (
          <div className="mt-3">
            {buttons.toBook && offersCall && (
              <p className="mb-2 text-caption text-muted">
                Not booked yet — contact to book
              </p>
            )}
            <ContactButtons
              name={callee.name}
              phone={callee.phone}
              address={job}
              show={show}
              toBook={buttons.toBook}
            />
          </div>
        )}
      </Section>

      {job.notePreview && (
        <Section label="Note">
          <p className="whitespace-pre-wrap text-body text-ink-2 [overflow-wrap:anywhere]">
            {job.notePreview}
          </p>
        </Section>
      )}

      <Section label="Details" flush>
        <DetailRows>
          <DetailRow label="Price" value={formatJobMoney(job)} />
          {/* As the live sheet: a business client without one is said so. */}
          {(job.workOrder !== undefined || job.clientKind === 'business') && (
            <DetailRow
              label="Work order"
              value={
                job.workOrder !== undefined ? (
                  <span className="select-text">{job.workOrder}</span>
                ) : (
                  <span className="font-normal text-muted">None recorded</span>
                )
              }
            />
          )}
        </DetailRows>
      </Section>
    </div>
  )
}

/**
 * A job opened with the line down that no day the phone holds lists: said
 * in the sheet's place, rather than a placeholder waiting for good. The
 * live sheet takes its place once PestM8 answers.
 */
export function NotKeptJob() {
  return (
    <div className="px-4 py-10">
      <Drawer.Title className="text-sheet-title text-ink">Job</Drawer.Title>
      <p className="mt-1 text-body text-ink-2">{NOT_KEPT_JOB}</p>
    </div>
  )
}

/** A section of the sheet, as the live sheet draws one. */
function Section({
  label,
  children,
  flush = false,
}: {
  label: string
  children: ReactNode
  /** Rows that run to the card's edges, each padding itself. */
  flush?: boolean
}) {
  return (
    <section className="mt-6">
      <h3 className="section-label mb-2">{label}</h3>
      <div
        className={`overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation ${flush ? '' : 'p-3.5'}`}
      >
        {children}
      </div>
    </section>
  )
}

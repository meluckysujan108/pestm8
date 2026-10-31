import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Drawer } from 'vaul'
import { ChevronDown, Pencil, Repeat, WifiOff } from 'lucide-react'
import { ContactButtons } from '#/components/primitives/ContactButtons'
import { DetailRow, DetailRows } from '#/components/primitives/DetailRow'
import { StatusPill } from '#/components/primitives/StatusPill'
import { personLabel } from '#/lib/assignees'
import { logConnection } from '#/lib/connectionLog'
import {
  formatDuration,
  formatJobDate,
  formatJobMoney,
  formatTime,
  formatUpdated,
} from '#/lib/format'
import { cardActionsFor, cardButtonsFor } from '#/lib/jobCardActions'
import { mapsUrl } from '#/lib/maps'
import { keeper } from '#/lib/offline/keeper'
import { useShowsKept } from '#/lib/offline/keptOnScreen'
import {
  INVOICED_LOCKED,
  KEPT_JOB_WAIT_MS,
  NOT_KEPT_JOB,
  SOMEONE_ELSES_JOB,
  dayOfBusiness,
  keptClientNumber,
  keptJobInset,
  keptJobReadOnly,
  keptJobState,
} from '#/lib/offline/keptJob'
import {
  useKeeperReads,
  useLineDown,
  useWaitedOut,
} from '#/lib/offline/useKept'
import { rq } from '#/lib/routeQueries'
import { dayKeyOf } from '../../../convex/lib/dates'
import { describeInterval } from '../../../convex/lib/recurrence'
import { siteContactOf } from '../../../convex/lib/siteContact'
import type { ReactNode } from 'react'
import type { FunctionReturnType } from 'convex/server'
import type { Access } from '#/lib/access'
import type { Directory } from '#/lib/directory'
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
 * `head`: what the live sheet's head and Property card would show that the
 * day's row doesn't say, read from memory or the phone's copy as the job
 * first shows, and kept while it does, so nothing in it is put in under a
 * thumb later: whether the job is someone else's (`keptJobReadOnly`, from
 * the access and the roster), and the client's number (`keptClientNumber`,
 * from the client list).
 */
export function useKeptJob(
  businessId: Id<'businesses'>,
  jobId: Id<'jobs'>,
  waiting: boolean,
): {
  state: KeptJobState
  day: KeptJobDay | null
  down: LineDown | null
  head: KeptJobHead
} {
  const queryClient = useQueryClient()
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
  const [head, setHead] = useState<KeptJobHead | null>(null)
  const nextHead =
    head === null && state === 'kept' && found !== null
      ? {
          readOnly: keptJobReadOnly(
            queryClient.getQueryData<Access>(rq.access(businessId).queryKey),
            keeper.answerOnPhone(rq.roster(businessId).queryKey) as
              Roster | undefined,
            found.row,
          ),
          clientNumber: keptClientNumber(
            keeper.answerOnPhone(rq.directory(businessId).queryKey) as
              Directory | undefined,
            found.row.propertyId,
          ),
        }
      : head
  if (nextHead !== head) setHead(nextHead)
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
    head: nextHead ?? NO_HEAD,
  }
}

/** What the live sheet's head would show that the day's row doesn't say
 * (`useKeptJob`). */
export type KeptJobHead = {
  /** The live sheet would say the job is someone else's: no Edit, no status
   * menu, and `SOMEONE_ELSES_JOB` under the status. */
  readOnly: boolean
  /** The client's number, beside their name on the Property card. */
  clientNumber: number | undefined
}

const NO_HEAD: KeptJobHead = { readOnly: false, clientNumber: undefined }

/**
 * A job opened with no answer from PestM8, shown read-only from the day
 * that lists it (`useKeptJob`), in place of the job sheet until PestM8
 * answers. What a technician needs at the door: its status, when, the
 * client, the address, who to call, the work order, the note, and who is
 * going.
 *
 * Drawn in the sheet's own scrolling body, the one the live sheet is drawn
 * in (JobDetailSheet.tsx, `useHandOverBody`), which keeps its scroll and its
 * height when the live sheet takes this one's place. Down to the end of the
 * Property card it is laid out as the live sheet is, line for line: Edit's
 * row and the status menu's chevron, unseen, where the live sheet would
 * have them (`head.readOnly`); the client's number beside their name; its
 * site contact, contact person and the client's own Call, Text and Email,
 * as the live sheet lists them. The line saying why comes after it, and the
 * Map, which the live sheet doesn't have, at the card's foot (where the card
 * has one: `cardActionsFor`). So when PestM8 answers, each Call is where it
 * was, under the thumb that may be on it.
 *
 * Typed from `jobs.listDay`'s row rather than `jobs.get`'s: a change to the
 * day's fields shows here as a type error, not as a sheet missing a line.
 * The rest of the live sheet (notes, reports, photos, history, editing)
 * needs PestM8, and comes back with it.
 *
 * Its line says why, so the sheet's own can't-reach notice gives way to it
 * while it shows, but for a change waiting to save
 * (lib/offline/keptOnScreen.ts): on a line that looks up too, where the
 * line says "Could not reach PestM8 — …" itself, and Try again is on the
 * page's banner behind the sheet.
 */
export function KeptJobView({
  job,
  asOf,
  down,
  timezone,
  roster,
  head = NO_HEAD,
  outbox,
}: {
  job: DayRow
  /** When the day was last known right (`keeper.findDayRow`). */
  asOf: number
  down: LineDown | null
  timezone: string
  /** The team, for who is going by name, as the live sheet names them. */
  roster: Roster | undefined
  /** What the live sheet's head would show that the day doesn't say
   * (`useKeptJob`). */
  head?: KeptJobHead
  /**
   * A booking on this phone, not sent yet (lib/outbox/), drawn from its own
   * row (`outboxRow`): its chip in the status pill's place, and what it
   * says of itself (where it is, why it hasn't gone, or why it needs a
   * look) in the kept copy's line's. That line says nothing of the line,
   * so the sheet's can't-reach notice stays.
   */
  outbox?: { chip: ReactNode; inset: ReactNode }
}) {
  useShowsKept(outbox === undefined)
  const { readOnly, clientNumber } = head
  // Drawn only in the browser, after a wait or with the line down, so the
  // phone's clock gives today here.
  const now = Date.now()
  const todayKey = dayKeyOf(now, timezone)
  const jobDay = dayKeyOf(job.scheduledAt, timezone)

  const offersMap =
    cardButtonsFor(cardActionsFor(job, timezone, now)).map &&
    mapsUrl(job) !== null
  // Who the live sheet lists under the property, from the day's row: the
  // site's own contact, the client's contact person, and the client's own
  // line, captioned only beside another Call (JobDetailSheet.tsx).
  const siteContact = siteContactOf({
    clientKind: job.clientKind,
    siteContactName: job.siteContactName,
    siteContactPhone: job.siteContactPhone,
  })
  const contactPerson = job.contactPersonName
    ? {
        name: job.contactPersonName,
        phone: job.contactPersonPhone || undefined,
      }
    : null
  const clientPhone = job.clientPhone || undefined
  const clientEmail = job.clientEmail || undefined
  const captionOffice =
    (siteContact !== null || Boolean(contactPerson?.phone)) &&
    Boolean(clientPhone || clientEmail)

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
    <>
      {/* In the row the live sheet shares with Edit, which holds its place
          unseen where the live sheet would have it: a job too old for a
          number has nothing else in the row. */}
      <div className="flex items-center justify-between gap-2">
        {job.jobNumber !== undefined && (
          <p className="section-label mb-0.5">Job #{job.jobNumber}</p>
        )}
        {!readOnly && job.status !== 'invoiced' && <UnseenEdit />}
      </div>
      <Drawer.Title className="text-sheet-title text-ink">
        {job.jobType}
      </Drawer.Title>

      <div className="mt-2 flex items-center gap-2">
        {/* As wide as the live sheet's status menu where it has one, so the
            date beside it wraps where the live one does. */}
        {outbox ? (
          <UnseenMenu>{outbox.chip}</UnseenMenu>
        ) : readOnly ? (
          <StatusPill status={job.status} />
        ) : (
          <UnseenMenu>
            <StatusPill status={job.status} />
          </UnseenMenu>
        )}
        <span className="text-body text-muted">
          <span className="whitespace-nowrap">
            {formatJobDate(jobDay, todayKey)}
          </span>{' '}
          <span className="whitespace-nowrap">
            · {formatTime(job.scheduledAt, timezone)}
          </span>{' '}
          <span className="whitespace-nowrap">
            · {formatDuration(job.durationMinutes)}
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

      {readOnly && (
        <p className="mt-3 rounded-xl border border-amber-line bg-amber-bg px-3 py-2.5 text-caption text-amber-ink">
          {SOMEONE_ELSES_JOB}
        </p>
      )}
      {job.status === 'invoiced' && (
        <p className="mt-3 rounded-xl border border-hairline bg-surface-2 px-3 py-2.5 text-caption text-ink-2">
          {INVOICED_LOCKED}
        </p>
      )}

      <Section label="Property">
        {/* Beside the client's number, as on the live sheet, so a long name
            wraps where it does there. */}
        <div className="flex items-baseline justify-between gap-2">
          <p className="min-w-0 text-row-title text-ink">{job.clientName}</p>
          {clientNumber !== undefined && (
            <span className="shrink-0 text-caption tabular-nums text-muted">
              Client #{clientNumber}
            </span>
          )}
        </div>
        <p className="text-body text-ink-2">{job.addressLine}</p>
        <p className="text-body text-muted">
          {job.suburb} {job.propertyState} {job.postcode}
        </p>

        {siteContact && (
          <div className="mt-3 border-t border-hairline-2 pt-3">
            <h4 className="section-label mb-1">Site contact</h4>
            {siteContact.name && (
              <p className="text-body text-ink">{siteContact.name}</p>
            )}
            {siteContact.phone && (
              <>
                <p className="text-caption text-muted">{siteContact.phone}</p>
                <div className="mt-2">
                  <ContactButtons
                    name={siteContact.name ?? 'site contact'}
                    phone={siteContact.phone}
                    show={['call', 'text']}
                  />
                </div>
              </>
            )}
          </div>
        )}

        {contactPerson && (
          <div className="mt-3 border-t border-hairline-2 pt-3">
            <h4 className="section-label mb-1">Contact person</h4>
            <p className="text-body text-ink">{contactPerson.name}</p>
            {contactPerson.phone && (
              <>
                <p className="text-caption text-muted">{contactPerson.phone}</p>
                <div className="mt-2">
                  <ContactButtons
                    name={contactPerson.name}
                    phone={contactPerson.phone}
                    show={['call', 'text']}
                  />
                </div>
              </>
            )}
          </div>
        )}

        {(clientPhone || clientEmail) && (
          <div
            className={
              captionOffice ? 'mt-3 border-t border-hairline-2 pt-3' : 'mt-3'
            }
          >
            {captionOffice && (
              <h4 className="section-label mb-1">Head office</h4>
            )}
            <ContactButtons
              name={job.clientName}
              phone={clientPhone}
              email={clientEmail}
            />
          </div>
        )}

        {offersMap && (
          <div className="mt-3">
            <ContactButtons
              name={job.addressLine}
              address={job}
              show={['map']}
            />
          </div>
        )}
      </Section>

      {/* Why it can't be changed, under who to call: everything above it
          stays where the live sheet has it. */}
      {outbox ? (
        outbox.inset
      ) : (
        <p className="mt-3 flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2 text-caption text-ink-2">
          <WifiOff
            aria-hidden
            size={14}
            strokeWidth={2}
            className="mt-0.5 shrink-0"
          />
          {keptJobInset(down, formatUpdated(asOf, timezone, todayKey))}
        </p>
      )}

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
    </>
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

/**
 * The live sheet's Edit, unseen and unheard: its row keeps the height it has
 * there. Exported for the client sheet, whose head is the same.
 */
export function UnseenEdit() {
  return (
    <span
      aria-hidden
      className="invisible mr-8 flex items-center gap-1 text-caption font-semibold"
    >
      <Pencil size={13} strokeWidth={2} />
      Edit
    </span>
  )
}

/**
 * A status pill as wide as the live sheet's menu for it (`StatusPillButton`:
 * the pill and its chevron), the chevron unseen: nothing here opens it.
 */
export function UnseenMenu({ children }: { children: ReactNode }) {
  return (
    <span className="flex items-center gap-1">
      {children}
      <ChevronDown
        aria-hidden
        size={14}
        strokeWidth={2.2}
        className="invisible"
      />
    </span>
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

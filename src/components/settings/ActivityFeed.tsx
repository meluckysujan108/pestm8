import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import {
  EmptyState,
  LoadFailed,
  NoMatches,
} from '#/components/primitives/EmptyState'
import { FilterButton, FilterPeople } from '#/components/primitives/FilterSheet'
import { LoadMore } from '#/components/primitives/LoadMore'
import { Bone, RowPending } from '#/components/shell/Pending'
import { SettingsGroup } from '#/components/settings/ui'
import { formatTime, todayKey } from '#/lib/format'
import {
  activityDayLabel,
  activityWords,
  feedCaption,
  feedEndLine,
  feedJobLine,
  feedNothingBy,
} from '#/lib/jobActivity'
import {
  ACTIVITY_PAGE,
  activityFeedArgs,
  activityFeedStart,
  activityFirstPage,
  rq,
} from '#/lib/routeQueries'
import { usePagedList } from '#/lib/usePagedList'
import { useHydrated } from '#/lib/useHydrated'
import { dayKeyOf } from '../../../convex/lib/dates'
import type { FeedPerson } from '#/lib/jobActivity'
import type { FeedEntry } from '../../../convex/jobActivity'
import type { Id } from '../../../convex/_generated/dataModel'

type Day = { key: string; label: string; lines: Array<FeedEntry> }

/**
 * Settings → Activity: every change to every job in the business, newest
 * first, a day at a time (`jobActivity.feed`, owner only).
 *
 * Each line is the job's own Activity line, word for word (`activityWords`),
 * under the job it is about, so this page and a job's sheet never tell the
 * same change two ways. A line opens its job's sheet over the list; one
 * whose job is in the Recycle bin, or gone for good, says so instead.
 *
 * Read a page at a time as the end comes near (`LoadMore`), and narrowed to
 * one person's changes from the filter icon — whoever made the change, not
 * whose account it was made in.
 */
export function ActivityFeed({
  businessId,
  businessSlug,
  timezone,
  viewerId,
  staffId,
  onStaff,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  timezone: string
  /** The reader's own membership: narrowed to it, the page says "you". */
  viewerId: string
  /** Whose changes, from the page's address (`?staff=`); all when unset. */
  staffId: string | undefined
  onStaff: (next: string | undefined) => void
}) {
  // Today as the page opened, for the day headings and each job's date.
  const [today] = useState(() => todayKey(timezone))
  const { data: members = [] } = useQuery(rq.roster(businessId))
  // Cheap, and wanted only at the foot, but asked for with the list so the
  // foot never arrives a beat after the last page does.
  const { data: start } = useQuery(activityFeedStart(businessId))

  const paged = usePagedList({
    query: api.jobActivity.feed,
    args: activityFeedArgs(businessId, staffId),
    first: activityFirstPage(businessId, staffId),
    pageSize: ACTIVITY_PAGE,
  })

  // Whose changes, named as the lines name them: from a line once there is
  // one (a member since removed is still named there), else from the team,
  // and "you" for the reader.
  const person: FeedPerson | null =
    staffId === undefined
      ? null
      : (paged.rows.at(0)?.by ?? {
          name:
            members.find((member) => member._id === staffId)?.name || 'Someone',
          you: staffId === viewerId,
        })

  const days: Array<Day> = []
  for (const line of paged.rows) {
    const key = dayKeyOf(line.at, timezone)
    const last = days.at(-1)
    if (last?.key === key) last.lines.push(line)
    else days.push({ key, label: activityDayLabel(key, today), lines: [line] })
  }

  return (
    <>
      <div className="mb-4 flex min-h-9 items-center justify-between gap-3 px-1">
        <p className="min-w-0 text-caption text-muted">{feedCaption(person)}</p>
        <ActivityFilterButton
          members={members}
          staffId={staffId}
          onStaff={onStaff}
        />
      </div>

      {paged.error ? (
        <LoadFailed what="the activity" onRetry={paged.retry} />
      ) : paged.loading ? (
        <ActivityPending />
      ) : paged.empty ? (
        person === null ? (
          <EmptyState
            title="No changes yet"
            body="Every change to a job shows here: who made it, when, and what it was before."
          />
        ) : (
          <NoMatches
            hint={feedNothingBy(person)}
            clearLabel="Clear filters"
            onClear={() => onStaff(undefined)}
          />
        )
      ) : (
        <>
          {days.map((day) => (
            <SettingsGroup key={day.key} title={day.label}>
              <ul className="divide-y divide-hairline">
                {day.lines.map((line) => (
                  <FeedLine
                    key={line._id}
                    line={line}
                    businessSlug={businessSlug}
                    staffId={staffId}
                    timezone={timezone}
                    today={today}
                  />
                ))}
              </ul>
            </SettingsGroup>
          ))}
          {/* The next page may open a day of its own, so it is waited for
              after the days rather than inside one; LoadMore says it is
              coming. */}
          {paged.loadingMore && <PendingCard className="mt-6" />}
          <LoadMore
            canLoadMore={paged.canLoadMore}
            loading={paged.loadingMore}
            onLoadMore={paged.loadMore}
            noun="changes"
            shown={paged.rows.length}
            resetKey={staffId ?? ''}
          />
          {paged.done && start !== undefined && (
            <p className="mt-3 px-1 text-caption text-muted">
              {feedEndLine(start.recordedSince, person, timezone, today)}
            </p>
          )}
        </>
      )}
    </>
  )
}

/** A line: who and when, the job it is about, then what they did to it. */
function FeedLine({
  line,
  businessSlug,
  staffId,
  timezone,
  today,
}: {
  line: FeedEntry
  businessSlug: string
  staffId: string | undefined
  timezone: string
  today: string
}) {
  const words = activityWords(line, timezone, today)
  const body = (
    <span className="min-w-0 flex-1">
      <span className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 text-body font-semibold text-ink">
          {words.who}
        </span>
        <span className="shrink-0 text-caption text-muted">
          {formatTime(line.at, timezone)}
        </span>
      </span>
      <span className="mt-0.5 block text-caption text-grey-ink">
        {feedJobLine(line.job, timezone, today)}
        {line.job.state === 'binned' && ' · In the Recycle bin'}
      </span>
      {words.lines.map((text, index) => (
        <span key={index} className="mt-0.5 block text-body text-ink">
          {text}
        </span>
      ))}
    </span>
  )

  if (line.job.state !== 'open') {
    return <li className="flex px-3.5 py-3">{body}</li>
  }
  return (
    <li>
      <Link
        to="/$businessSlug/settings/activity"
        params={{ businessSlug }}
        search={{
          ...(staffId !== undefined && { staff: staffId }),
          jobId: line.jobId,
        }}
        // Opening a job and closing it change the address in place, without
        // dropping the reader back at the top of the list.
        replace
        resetScroll={false}
        className="flex w-full items-center gap-2 px-3.5 py-3 text-left outline-none transition focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue active:bg-surface-2"
      >
        {body}
        <ChevronRight
          aria-hidden
          size={17}
          strokeWidth={2.2}
          className="shrink-0 text-muted-2"
        />
      </Link>
    </li>
  )
}

/**
 * Whose changes: everyone's, or one person's (`?staff=`). Only the team as
 * it is now is offered; someone since removed is still named on their lines.
 */
function ActivityFilterButton({
  members,
  staffId,
  onStaff,
}: {
  members: ReadonlyArray<{ _id: string; name: string; colour?: string }>
  staffId: string | undefined
  onStaff: (next: string | undefined) => void
}) {
  const hydrated = useHydrated()
  return (
    <FilterButton
      title="Filters"
      on={staffId === undefined ? 0 : 1}
      disabled={!hydrated}
      onClear={() => onStaff(undefined)}
    >
      <FilterPeople
        label="Changed by"
        value={staffId ?? 'all'}
        people={members.map((member) => ({
          membershipId: member._id,
          name: member.name,
          colour: member.colour,
        }))}
        onChange={(id) => onStaff(id === 'all' ? undefined : id)}
      />
    </FilterButton>
  )
}

/** The first page loading: a day's heading and a card of lines. */
function ActivityPending() {
  return (
    <div role="status">
      <span className="sr-only">Loading activity</span>
      <div aria-hidden className="mb-2 flex h-[16.5px] items-center px-1">
        <Bone className="h-[11px] w-20" />
      </div>
      <PendingCard rows={4} />
    </div>
  )
}

/** A card of lines loading, silent: whoever asked is told elsewhere. */
function PendingCard({
  rows = 2,
  className = '',
}: {
  rows?: number
  className?: string
}) {
  return (
    <div
      aria-hidden
      className={`divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation ${className}`}
    >
      {Array.from({ length: rows }, (_, i) => (
        <RowPending key={i} announce={false} />
      ))}
    </div>
  )
}

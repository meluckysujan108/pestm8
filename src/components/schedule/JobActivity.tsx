import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import { LoadFailed } from '#/components/primitives/EmptyState'
import { RowPending } from '#/components/shell/Pending'
import { formatUpdated, todayKey } from '#/lib/format'
import { activityWords, earlierLine, originLine } from '#/lib/jobActivity'
import { useHydrated } from '#/lib/useHydrated'
import type { ReactNode } from 'react'
import type { Id } from '../../../convex/_generated/dataModel'

/** How many lines draw before "Show all". */
const FIRST = 4

type Line = { key: string; who: string; when: string; lines: Array<string> }

/**
 * Who changed this job, and how: the latest few changes, newest first, and
 * the rest a tap away. Last on the sheet — the answer to "who moved this?",
 * not something read on the way in.
 *
 * Everyone who can open the job reads it (`jobActivity.list`); someone who
 * can't see prices reads that the price changed, not to what. A job booked
 * before the business's history began says so under its oldest line, so a
 * short history is never taken for the whole story.
 */
export function JobActivitySection({
  businessId,
  jobId,
  timezone,
}: {
  businessId: Id<'businesses'>
  jobId: Id<'jobs'>
  timezone: string
}) {
  const query = useQuery(
    convexQuery(api.jobActivity.list, { businessId, jobId }),
  )
  const [showAll, setShowAll] = useState(false)
  const hydrated = useHydrated()
  const listId = useId()
  // Today as the sheet opened, for "9:42am" against "Mon 24 Nov, 9:42am".
  const [today] = useState(() => todayKey(timezone))

  const data = query.data
  if (data === undefined) {
    return (
      <ActivityCard>
        {query.isError ? (
          <div className="p-2">
            <LoadFailed
              what="this job’s activity"
              onRetry={() => void query.refetch()}
            />
          </div>
        ) : (
          <RowPending label="Loading activity" />
        )}
      </ActivityCard>
    )
  }
  // Gone, or not this person's to open: the sheet says so itself.
  if (data === null) return null

  const lines: Array<Line> = data.entries.map((entry) => ({
    key: entry._id,
    when: formatUpdated(entry.at, timezone, today),
    ...activityWords(entry, timezone, today),
  }))
  if (data.origin) {
    const origin = originLine(data.origin, timezone, today)
    lines.push({
      key: 'origin',
      who: origin.line,
      when: origin.when,
      lines: [],
    })
  }
  const shown = showAll ? lines : lines.slice(0, FIRST)
  const hidden = lines.length - shown.length

  return (
    <ActivityCard
      action={
        lines.length > FIRST && (
          <button
            type="button"
            aria-expanded={showAll}
            aria-controls={listId}
            disabled={!hydrated}
            onClick={() => setShowAll((open) => !open)}
            className="relative tap-target text-caption font-semibold text-blue disabled:opacity-50"
          >
            {showAll
              ? 'Show fewer'
              : // Past the last fifty, "all" would be a promise it can't keep.
                `Show ${data.more ? 'latest' : 'all'} ${lines.length}`}
          </button>
        )
      }
    >
      <ul id={listId} className="divide-y divide-hairline-2">
        {shown.map((line) => (
          <li key={line.key} className="px-3.5 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 text-body font-semibold text-ink">
                {line.who}
              </span>
              <span className="shrink-0 text-caption text-muted">
                {line.when}
              </span>
            </div>
            {line.lines.map((text, index) => (
              <p key={index} className="mt-0.5 text-body text-ink">
                {text}
              </p>
            ))}
          </li>
        ))}
      </ul>
      {/* Under the oldest line, once it shows: where the history begins. */}
      {hidden === 0 && (data.more || data.bookedBefore) && (
        <p className="border-t border-hairline-2 px-3.5 py-3 text-caption text-muted">
          {data.more
            ? `Showing the latest ${data.entries.length} changes.`
            : earlierLine(data.recordedSince, timezone, today)}
        </p>
      )}
    </ActivityCard>
  )
}

function ActivityCard({
  action,
  children,
}: {
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="mt-6">
      <div className="mb-2 flex min-h-5 items-center justify-between gap-2">
        <h3 className="section-label">Activity</h3>
        {action}
      </div>
      <div className="overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation">
        {children}
      </div>
    </section>
  )
}

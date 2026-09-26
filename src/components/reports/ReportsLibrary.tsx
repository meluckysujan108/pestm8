import { useEffect, useState } from 'react'
import { REPORT_PILL } from '#/lib/statusColours'
import { Link } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { usePaginatedQuery } from 'convex/react'
import { Clock, Lock, RotateCcw, Trash2 } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import {
  EMPTY_ACTION_CLASS,
  EmptyState,
} from '#/components/primitives/EmptyState'
import { SearchBox } from '#/components/primitives/SearchBox'
import { ListPending } from '#/components/shell/Pending'
import { REPORTS_PAGE, reportsFirstPage, rq } from '#/lib/routeQueries'
import { Segmented } from '#/components/primitives/Segmented'
import { ConfirmDialog } from '#/components/settings/ConfirmDialog'
import { FormAlert } from '#/components/forms/FormAlert'
import { describeError } from '#/components/forms/describeError'
import { useHydrated } from '#/lib/useHydrated'
import type { Id } from '../../../convex/_generated/dataModel'
import { SECONDARY_BUTTON_COMPACT } from '#/components/primitives/buttons'

/**
 * Every report this business has made, a page at a time.
 *
 * The list used to be one query that collected the whole business and then
 * did two document reads per row, with the segments, the counts and the
 * "search" all computed in the component from that one payload. That works
 * until a business has a few years of reports, and it cannot be paginated
 * without breaking the search — a substring test can only match what has
 * already been fetched.
 *
 * So the server does the paging and the matching, and this draws rows.
 */

const SEGMENTS = [
  { value: 'all' as const, label: 'All' },
  { value: 'draft' as const, label: 'Draft' },
  { value: 'finalised' as const, label: 'Finalised' },
  { value: 'sent' as const, label: 'Sent' },
  { value: 'trash' as const, label: 'Deleted' },
]

export type Segment = (typeof SEGMENTS)[number]['value']

type Row = {
  _id: Id<'reports'>
  status: string
  emailedAt?: number
  legalBasis: string
  clientName: string
  suburb: string
  templateName: string
}

/** The warmed first page has to ask for the same number of rows, or the list
 *  grows or shrinks the moment the paginator takes over. */
const PAGE_SIZE = REPORTS_PAGE

export function ReportsLibrary({
  businessId,
  businessSlug,
  segment,
  query,
  onSegment,
  onQuery,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  segment: Segment
  query: string
  onSegment: (segment: Segment) => void
  onQuery: (term: string) => void
}) {
  // The list is server-rendered; a tab tapped before hydration would do
  // nothing, so the tabs wait until they work.
  const hydrated = useHydrated()
  const searching = query.trim() !== ''

  const paged = usePaginatedQuery(
    api.reports.list,
    searching ? 'skip' : { businessId, filter: segment },
    { initialNumItems: PAGE_SIZE },
  )

  /**
   * The same first page, asked for as a plain query so it lands in the cache.
   *
   * The paginator mints a new pagination id on every mount and unsubscribes
   * on unmount, so nothing it fetched is ever reused: coming back to this
   * list waited on its first page again, every time. This copy is warmed by
   * the route's loader and read until the paginator has caught up, which it
   * does within one round trip.
   */
  const first = useQuery(
    searching
      ? convexQuery(api.reports.list, 'skip')
      : reportsFirstPage(businessId, segment),
  )
  const cold = !searching && paged.status === 'LoadingFirstPage'

  const { data: found } = useQuery({
    // 'skip' rather than `enabled`: a disabled query still holds its Convex
    // subscription open, and this one is per typed term.
    ...(searching
      ? convexQuery(api.reports.search, {
          businessId,
          term: query,
          // Searching inside a segment means searching that segment: a search
          // that quietly changed which tab you were on would be a worse search.
          filter: segment,
        })
      : convexQuery(api.reports.search, 'skip')),
    // Every term typed would otherwise keep a live subscription for the
    // cache's lifetime; a search is worth re-running.
    gcTime: 60_000,
  })

  const pageRows = cold ? (first.data?.page ?? []) : paged.results
  const rows: Array<Row> = searching ? (found ?? []) : pageRows

  /**
   * A page can come back empty with more still behind it.
   *
   * Visibility is applied after the page is drawn — a subcontractor sees only
   * their own reports — so a business whose newest twenty-five belong to
   * somebody else yields an empty first page. Left alone that reads as "No
   * reports yet" under a rail that says there are forty. Asking for the next
   * page is the only way to know, and it stops as soon as one row survives or
   * the list runs out.
   */
  useEffect(() => {
    if (searching) return
    if (paged.results.length === 0 && paged.status === 'CanLoadMore') {
      paged.loadMore(PAGE_SIZE)
    }
  }, [searching, paged])

  const loading = searching
    ? found === undefined
    : // `isDone` matters: a first page can come back empty with more behind
      // it, and calling that "no reports yet" would be a lie (see above).
      (cold &&
        (first.data === undefined ||
          (first.data.page.length === 0 && !first.data.isDone))) ||
      (pageRows.length === 0 &&
        (paged.status === 'CanLoadMore' || paged.status === 'LoadingMore'))

  return (
    <>
      <StaleDrafts
        businessId={businessId}
        businessSlug={businessSlug}
        onShowDrafts={() => onSegment('draft')}
      />

      <div className="flex gap-2 px-4 pt-3">
        <SearchBox
          value={query}
          onChange={onQuery}
          label="Search reports"
          placeholder="Client, street, form or #number"
        />
      </div>

      <div className="px-4 pt-3">
        <Segmented
          label="Report status"
          disabled={!hydrated}
          value={segment}
          options={SEGMENTS}
          onChange={onSegment}
        />
      </div>

      <section className="px-4 pb-6 pt-4">
        {loading ? (
          <ListPending label="Loading reports" count={3} />
        ) : rows.length === 0 ? (
          <EmptyState
            title={emptyTitle(segment, searching)}
            body={emptyBody(segment, searching)}
            action={
              // Only the true empty — every report, no search — has
              // nothing to do but start one.
              segment === 'all' &&
              !searching && (
                <Link
                  to="/$businessSlug/reports/new"
                  params={{ businessSlug }}
                  className={EMPTY_ACTION_CLASS}
                >
                  Start a report
                </Link>
              )
            }
          />
        ) : (
          <div className="flex flex-col gap-2.5">
            {rows.map((row) => (
              <ReportRow
                key={row._id}
                businessId={businessId}
                businessSlug={businessSlug}
                row={row}
                inTrash={segment === 'trash'}
              />
            ))}
          </div>
        )}

        {/* Only while paging: a search returns everything it found at once. */}
        {!searching && paged.status === 'CanLoadMore' && (
          <button
            type="button"
            onClick={() => paged.loadMore(PAGE_SIZE)}
            className={`${SECONDARY_BUTTON_COMPACT} mt-3 w-full`}
          >
            Show more
          </button>
        )}
        {!searching && paged.status === 'LoadingMore' && (
          <ListPending
            label="Loading more reports"
            count={2}
            className="mt-3"
          />
        )}
      </section>
    </>
  )
}

/**
 * Says when reports have been left unfinished.
 *
 * WA's Pesticides Regulations give an operator two business days to make the
 * record, and a half-filled report from last week is one nobody remembers the
 * detail of. There is no notification channel in this app to nudge through, so
 * the nudge is the library saying so where somebody is already looking — once,
 * quietly, with a way straight to them.
 */
function StaleDrafts({
  businessId,
  businessSlug,
  onShowDrafts,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  onShowDrafts: () => void
}) {
  const { data } = useQuery(rq.staleDrafts(businessId))
  if (!data || data.count === 0) return null

  return (
    <div className="mx-4 mt-4 flex items-center gap-2.5 rounded-2xl border border-amber-line bg-amber-bg px-3.5 py-3">
      <Clock size={16} strokeWidth={2} className="shrink-0 text-amber-ink" />
      <p className="min-w-0 flex-1 text-caption text-amber-ink">
        {data.count === 1
          ? 'A report has been left unfinished for over four days.'
          : `${data.count} reports have been left unfinished for over four days.`}
      </p>
      {data.oldest && data.count === 1 ? (
        <Link
          to="/$businessSlug/reports/$reportId"
          params={{ businessSlug, reportId: data.oldest }}
          className="shrink-0 text-caption font-semibold text-amber-ink underline"
        >
          Open
        </Link>
      ) : (
        <button
          type="button"
          onClick={onShowDrafts}
          className="shrink-0 text-caption font-semibold text-amber-ink underline"
        >
          Show
        </button>
      )}
    </div>
  )
}

function emptyTitle(segment: Segment, searching: boolean): string {
  if (searching) return 'No matches'
  if (segment === 'trash') return 'Nothing deleted'
  if (segment === 'draft') return 'No drafts'
  return 'No reports yet'
}

function emptyBody(segment: Segment, searching: boolean): string {
  if (searching)
    return 'Try a client, a street, a form name or a report number.'
  if (segment === 'trash') {
    return 'Deleted drafts wait here for 30 days. Finalised reports are never deleted.'
  }
  if (segment === 'sent')
    return 'Reports you have emailed to a client show up here.'
  if (segment === 'finalised') return 'Reports you have locked show up here.'
  if (segment === 'draft')
    return 'Reports you are still filling in show up here.'
  return 'Start one here, or from a job.'
}

function ReportRow({
  businessId,
  businessSlug,
  row,
  inTrash,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  row: Row
  inTrash: boolean
}) {
  const bucket =
    row.status === 'draft' ? 'draft' : row.emailedAt ? 'sent' : 'finalised'

  const body = (
    <>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-row-title text-ink">{row.templateName}</span>
        <span className="shrink-0 text-caption text-muted">
          {row.legalBasis}
        </span>
      </div>
      <p className="mt-0.5 text-body text-ink-2">{row.clientName}</p>
      <p className="mt-0.5 text-caption text-muted">{row.suburb}</p>
      <span
        className={`mt-2 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-semibold ${REPORT_PILL[bucket]}`}
      >
        {bucket !== 'draft' && <Lock size={11} strokeWidth={2.4} />}
        {bucket === 'sent'
          ? 'Sent'
          : bucket === 'finalised'
            ? 'Finalised'
            : 'Draft'}
      </span>
    </>
  )

  if (inTrash) {
    // Not a link: a deleted draft opens nowhere, and a row that navigates to a
    // dead end is worse than one that does not move.
    return (
      <div className="rounded-2xl border border-hairline bg-surface p-3.5 shadow-elevation">
        {body}
        <TrashActions businessId={businessId} row={row} />
      </div>
    )
  }

  return (
    <div className="relative">
      <Link
        to="/$businessSlug/reports/$reportId"
        params={{ businessSlug, reportId: row._id }}
        className="block rounded-2xl border border-hairline bg-surface p-3.5 shadow-elevation transition active:scale-[.99]"
      >
        {body}
      </Link>
      {/* Drafts only. A finalised report is a record the business is required
          to keep, so there is deliberately no way to delete one. */}
      {row.status === 'draft' && (
        <DeleteDraft businessId={businessId} row={row} />
      )}
    </div>
  )
}

function DeleteDraft({
  businessId,
  row,
}: {
  businessId: Id<'businesses'>
  row: Row
}) {
  const hydrated = useHydrated()
  const [confirming, setConfirming] = useState(false)
  const convexDelete = useConvexMutation(api.reports.softDelete)
  const remove = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      reportId: Id<'reports'>
    }) => convexDelete(args),
    onSuccess: () => setConfirming(false),
  })

  return (
    <>
      <button
        type="button"
        aria-label={`Delete the ${row.templateName} draft for ${row.clientName}`}
        disabled={!hydrated}
        onClick={() => {
          remove.reset()
          setConfirming(true)
        }}
        // Bottom right, beside the status pill rather than over the standard
        // the report was written to: at the top it sat on "AS 4349.3-2010".
        className="tap-target absolute bottom-2 right-2 flex size-9 items-center justify-center rounded-full text-muted transition active:scale-[.95] disabled:opacity-50"
      >
        <Trash2 size={16} strokeWidth={2} />
      </button>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Delete this draft?"
        body={`${row.templateName} for ${row.clientName}${row.suburb ? `, ${row.suburb}` : ''}. It waits in Deleted for 30 days, with its photos, then it is gone.`}
        confirm="Delete draft"
        cancel="Keep draft"
        closeOnConfirm={false}
        pending={remove.isPending}
        pendingLabel="Deleting…"
        error={
          remove.isError
            ? describeError(remove.error, {
                default:
                  'Could not delete the draft. Check your signal and try again.',
              })
            : null
        }
        onConfirm={() => remove.mutate({ businessId, reportId: row._id })}
      />
    </>
  )
}

function TrashActions({
  businessId,
  row,
}: {
  businessId: Id<'businesses'>
  row: Row
}) {
  const hydrated = useHydrated()
  const [confirming, setConfirming] = useState(false)
  const convexRestore = useConvexMutation(api.reports.restore)
  const convexRemove = useConvexMutation(api.reports.remove)
  const restore = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      reportId: Id<'reports'>
    }) => convexRestore(args),
  })
  const forever = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      reportId: Id<'reports'>
    }) => convexRemove(args),
    onSuccess: () => setConfirming(false),
  })

  return (
    <>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={!hydrated || restore.isPending}
          onClick={() => restore.mutate({ businessId, reportId: row._id })}
          className={`${SECONDARY_BUTTON_COMPACT} flex flex-1 items-center justify-center gap-1.5`}
        >
          <RotateCcw size={15} strokeWidth={2} />
          {restore.isPending ? 'Restoring…' : 'Restore'}
        </button>
        <button
          type="button"
          disabled={!hydrated}
          onClick={() => {
            forever.reset()
            setConfirming(true)
          }}
          // A grey button with its word in red: SECONDARY_BUTTON_COMPACT's
          // shape, which cannot take a second text colour.
          className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-fill-secondary text-body font-semibold text-red outline-none transition focus-visible:ring-2 focus-visible:ring-blue active:scale-[.975] disabled:opacity-50"
        >
          <Trash2 size={15} strokeWidth={2} />
          Delete now
        </button>
      </div>
      <FormAlert
        className="mt-2"
        error={restore.isError ? restore.error : null}
        copy={{
          default:
            'Could not restore the draft. Check your signal and try again.',
        }}
      />

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Delete this draft for good?"
        body="The draft and its photos are gone, and it can’t be undone. Those photos are evidence that somebody stood somewhere and took them."
        confirm="Delete for good"
        cancel="Keep it"
        closeOnConfirm={false}
        pending={forever.isPending}
        pendingLabel="Deleting…"
        error={
          forever.isError
            ? describeError(forever.error, {
                default:
                  'Could not delete the draft. Check your signal and try again.',
              })
            : null
        }
        onConfirm={() => forever.mutate({ businessId, reportId: row._id })}
      />
    </>
  )
}

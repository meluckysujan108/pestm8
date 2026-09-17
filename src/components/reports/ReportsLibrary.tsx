import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { usePaginatedQuery } from 'convex/react'
import { Lock, RotateCcw, Trash2 } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { EmptyState } from '#/components/primitives/EmptyState'
import { SearchBox } from '#/components/primitives/SearchBox'
import { Segmented } from '#/components/primitives/Segmented'
import { Sheet } from '#/components/primitives/Sheet'
import { useHydrated } from '#/lib/useHydrated'
import type { Id } from '../../../convex/_generated/dataModel'

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

const PAGE_SIZE = 25

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

  const { data: found } = useQuery({
    ...convexQuery(api.reports.search, {
      businessId,
      term: query,
      // Searching inside a segment means searching that segment: a search
      // that quietly changed which tab you were on would be a worse search.
      filter: segment,
    }),
    enabled: searching,
  })

  const rows: Array<Row> = searching ? (found ?? []) : paged.results

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
    : paged.status === 'LoadingFirstPage' ||
      (paged.results.length === 0 && paged.status === 'LoadingMore')

  return (
    <>
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
          <p className="py-8 text-center text-caption text-muted">Loading…</p>
        ) : rows.length === 0 ? (
          <EmptyState
            title={emptyTitle(segment, searching)}
            body={emptyBody(segment, searching)}
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
            className="mt-3 h-11 w-full rounded-xl bg-surface-2 text-[15px] font-semibold text-ink"
          >
            Show more
          </button>
        )}
        {!searching && paged.status === 'LoadingMore' && (
          <p className="mt-3 text-center text-caption text-muted">Loading…</p>
        )}
      </section>
    </>
  )
}

function emptyTitle(segment: Segment, searching: boolean): string {
  if (searching) return 'No matches'
  if (segment === 'trash') return 'Nothing deleted'
  if (segment === 'draft') return 'No drafts'
  return 'No reports yet'
}

function emptyBody(segment: Segment, searching: boolean): string {
  if (searching) return 'Try a client, a street, a form name or a report number.'
  if (segment === 'trash') {
    return 'Deleted drafts wait here for 30 days. Finalised reports are never deleted.'
  }
  if (segment === 'sent') return 'Reports you have emailed to a client show up here.'
  if (segment === 'finalised') return 'Reports you have locked show up here.'
  if (segment === 'draft') return 'Reports you are still filling in show up here.'
  return 'Start one from a job, or with the + button.'
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
        <span className="shrink-0 text-caption text-muted">{row.legalBasis}</span>
      </div>
      <p className="mt-0.5 text-body text-ink-2">{row.clientName}</p>
      <p className="mt-0.5 text-caption text-muted">{row.suburb}</p>
      <span
        className={`mt-2 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-semibold ${
          bucket === 'sent'
            ? 'bg-blue/12 text-blue'
            : bucket === 'finalised'
              ? 'bg-green/12 text-green'
              : 'border border-amber-line bg-amber-bg text-amber-ink'
        }`}
      >
        {bucket !== 'draft' && <Lock size={11} strokeWidth={2.4} />}
        {bucket === 'sent' ? 'Sent' : bucket === 'finalised' ? 'Finalised' : 'Draft'}
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
      {row.status === 'draft' && <DeleteDraft businessId={businessId} row={row} />}
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
  const [confirming, setConfirming] = useState(false)
  const convexDelete = useConvexMutation(api.reports.softDelete)
  const remove = useMutation({
    mutationFn: (args: { businessId: Id<'businesses'>; reportId: Id<'reports'> }) =>
      convexDelete(args),
    onSuccess: () => setConfirming(false),
  })

  return (
    <>
      <button
        type="button"
        aria-label={`Delete the ${row.templateName} draft for ${row.clientName}`}
        onClick={() => setConfirming(true)}
        // Bottom right, beside the status pill rather than over the standard
        // the report was written to: at the top it sat on "AS 4349.3-2010".
        className="absolute bottom-2 right-2 flex size-9 items-center justify-center rounded-full text-muted transition active:scale-[.95]"
      >
        <Trash2 size={16} strokeWidth={1.8} />
      </button>

      <Sheet
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Delete this draft?"
        description="It waits in Deleted for 30 days, with its photos, then it is gone."
        footer={
          <button
            type="button"
            disabled={remove.isPending}
            onClick={() => remove.mutate({ businessId, reportId: row._id })}
            className="h-12 w-full rounded-xl bg-red text-[17px] font-semibold text-white shadow-red disabled:opacity-50"
          >
            {remove.isPending ? 'Deleting…' : 'Delete draft'}
          </button>
        }
      >
        <p className="text-body text-ink-2">
          {row.templateName} for {row.clientName}
          {row.suburb ? `, ${row.suburb}` : ''}.
        </p>
      </Sheet>
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
  const [confirming, setConfirming] = useState(false)
  const convexRestore = useConvexMutation(api.reports.restore)
  const convexRemove = useConvexMutation(api.reports.remove)
  const restore = useMutation({
    mutationFn: (args: { businessId: Id<'businesses'>; reportId: Id<'reports'> }) =>
      convexRestore(args),
  })
  const forever = useMutation({
    mutationFn: (args: { businessId: Id<'businesses'>; reportId: Id<'reports'> }) =>
      convexRemove(args),
    onSuccess: () => setConfirming(false),
  })

  return (
    <>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={restore.isPending}
          onClick={() => restore.mutate({ businessId, reportId: row._id })}
          className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl bg-surface-2 text-[15px] font-semibold text-ink disabled:opacity-50"
        >
          <RotateCcw size={15} strokeWidth={2} />
          Restore
        </button>
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl bg-surface-2 text-[15px] font-semibold text-red"
        >
          <Trash2 size={15} strokeWidth={2} />
          Delete now
        </button>
      </div>

      <Sheet
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Delete permanently?"
        description="The draft and its photos are gone. This cannot be undone."
        footer={
          <button
            type="button"
            disabled={forever.isPending}
            onClick={() => forever.mutate({ businessId, reportId: row._id })}
            className="h-12 w-full rounded-xl bg-red text-[17px] font-semibold text-white shadow-red disabled:opacity-50"
          >
            {forever.isPending ? 'Deleting…' : 'Delete permanently'}
          </button>
        }
      >
        <p className="text-body text-ink-2">
          The photos attached to this draft are evidence that somebody stood
          somewhere and took them. Once this is gone, so are they.
        </p>
      </Sheet>
    </>
  )
}

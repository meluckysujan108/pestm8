import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { LayoutTemplate, Plus } from 'lucide-react'
import { z } from 'zod'
import { PageHeader } from '#/components/shell/PageHeader'
import { ReportsLibrary } from '#/components/reports/ReportsLibrary'
import type { Segment } from '#/components/reports/ReportsLibrary'
import { useCan } from '#/lib/access'
import { reportsFirstPage, rq, searchParam, warm } from '#/lib/routeQueries'

const SEGMENTS = ['all', 'draft', 'finalised', 'sent', 'trash'] as const

export const Route = createFileRoute('/$businessSlug/reports/')({
  validateSearch: z.object({
    q: z.string().optional(),
    seg: z.enum(SEGMENTS).optional(),
  }),
  // The count the header reads and the first page of the list, together. No
  // `loaderDeps`: that would make every segment tap a new match, and a new
  // match gets the route's placeholder instead of the list it is filtering.
  loader: ({ context: { queryClient, business }, location }) => {
    const segment = (searchParam(location, 'seg') ?? 'all') as Segment
    const searching = (searchParam(location, 'q') ?? '') !== ''
    // The banner above the list, asked for in the same round but not waited
    // on: it renders nothing at all when there is nothing to say.
    void warm(queryClient, rq.staleDrafts(business._id))
    return warm(
      queryClient,
      rq.reportCounts(business._id),
      ...(searching ? [] : [reportsFirstPage(business._id, segment)]),
    )
  },
  component: ReportsPage,
})

function ReportsPage() {
  const { business } = Route.useRouteContext()
  const canManageTemplates = useCan('templates.manage')
  const { q, seg } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const segment: Segment = seg ?? 'all'

  // Counted rather than paginated: a badge that says twelve has to have looked
  // at all twelve. Suspense-loaded because the header reads it.
  const { data: counts } = useSuspenseQuery(rq.reportCounts(business._id))

  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        kicker={`${counts.all}${counts.capped ? '+' : ''} ${counts.all === 1 ? 'report' : 'reports'}`}
        title="Reports"
        action={
          <>
            {canManageTemplates && (
              <Link
                to="/$businessSlug/reports/templates"
                params={{ businessSlug: business.slug }}
                aria-label="Manage templates"
                className="relative tap-target flex size-9 items-center justify-center rounded-full bg-surface-2 text-ink-2 transition active:scale-[.95]"
              >
                <LayoutTemplate size={18} strokeWidth={1.7} />
              </Link>
            )}
            <Link
              to="/$businessSlug/reports/new"
              params={{ businessSlug: business.slug }}
              aria-label="New report"
              className="relative tap-target flex size-9 items-center justify-center rounded-full bg-red-fill text-white shadow-red transition active:scale-[.95]"
            >
              <Plus size={20} strokeWidth={2} />
            </Link>
          </>
        }
      />

      <div className="grid grid-cols-3 gap-2.5 px-4 pt-4">
        <Card label="Draft" value={counts.draft} />
        <Card label="Finalised" value={counts.finalised} />
        <Card label="Sent" value={counts.sent} />
      </div>

      <ReportsLibrary
        businessId={business._id}
        businessSlug={business.slug}
        segment={segment}
        query={q ?? ''}
        onSegment={(value) =>
          navigate({
            search: (prev) => ({
              ...prev,
              seg: value === 'all' ? undefined : value,
            }),
            replace: true,
          })
        }
        onQuery={(term) =>
          navigate({
            search: (prev) => ({ ...prev, q: term || undefined }),
            replace: true,
          })
        }
      />
    </>
  )
}

function Card({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-hairline bg-surface p-3.5 shadow-elevation">
      <p className="section-label mb-1">{label}</p>
      <p className="text-metric text-ink">{value}</p>
    </div>
  )
}

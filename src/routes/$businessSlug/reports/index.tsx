import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { LayoutTemplate, Plus } from 'lucide-react'
import { z } from 'zod'
import { PageHeader } from '#/components/shell/PageHeader'
import { ReportsLibrary } from '#/components/reports/ReportsLibrary'
import type { Segment } from '#/components/reports/ReportsLibrary'
import { useAccess, useCan } from '#/lib/access'
import { listsEverythingOf } from '#/lib/jobListView'
import { reportsFirstPage, rq, searchParam, warm } from '#/lib/routeQueries'
import { HEADER_ADD_BUTTON } from '#/components/primitives/buttons'

const SEGMENTS = ['all', 'draft', 'finalised', 'sent', 'trash'] as const

export const Route = createFileRoute('/$businessSlug/reports/')({
  validateSearch: z.object({
    q: z.string().optional(),
    seg: z.enum(SEGMENTS).optional(),
    // The Form and Technician filters behind the icon beside the search: a
    // built-in form's key or a custom form's id, and whoever wrote it. The
    // server reads a value it cannot place as matching nothing.
    form: z.string().optional(),
    staff: z.string().optional(),
  }),
  // The count the header reads and the first page of the list, together. No
  // `loaderDeps`: that would make every segment tap a new match, and a new
  // match gets the route's placeholder instead of the list it is filtering.
  loader: async ({ context: { queryClient, business }, location }) => {
    const segment = (searchParam(location, 'seg') ?? 'all') as Segment
    const searching = (searchParam(location, 'q') ?? '') !== ''
    const form = searchParam(location, 'form') || undefined
    const staff = searchParam(location, 'staff') || undefined
    // The banner above the list, asked for in the same round but not waited
    // on: it renders nothing at all when there is nothing to say.
    void warm(queryClient, rq.staleDrafts(business._id))
    // Whether a person in the address applies follows the view, which the
    // layout has asked for already: read back only when one is there.
    const access = staff
      ? await queryClient
          .ensureQueryData(rq.access(business._id))
          .catch(() => undefined)
      : undefined
    return warm(
      queryClient,
      rq.reportCounts(business._id),
      ...(searching
        ? []
        : [
            reportsFirstPage(business._id, segment, {
              form,
              staffId: appliedPerson(listsEverythingOf(access), staff),
            }),
          ]),
    )
  },
  component: ReportsPage,
})

function ReportsPage() {
  const { business } = Route.useRouteContext()
  const canManageTemplates = useCan('templates.manage')
  const { q, seg, form, staff } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const segment: Segment = seg ?? 'all'
  const staffId = appliedPerson(listsEverythingOf(useAccess()), staff)

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
              className={HEADER_ADD_BUTTON}
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
        narrow={{ form: form || undefined, staffId }}
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
        onNarrow={(next) =>
          navigate({
            search: (prev) => ({
              ...prev,
              form: next.form,
              staff: next.staffId,
            }),
            replace: true,
          })
        }
      />
    </>
  )
}

/**
 * A person from the address, where the library is everyone's: a narrower
 * one (a subcontractor's, the owner's "Just my jobs") is one person's
 * already, and its filter offers no one.
 */
function appliedPerson(
  listsEverything: boolean | undefined,
  staff: string | undefined,
): string | undefined {
  return listsEverything === true && staff ? staff : undefined
}

function Card({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-hairline bg-surface p-3.5 shadow-elevation">
      <p className="section-label mb-1">{label}</p>
      <p className="text-metric text-ink">{value}</p>
    </div>
  )
}

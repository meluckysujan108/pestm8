import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { PageHeader } from '#/components/shell/PageHeader'
import { BackLink } from '#/components/settings/ui'
import { UninvoicedView } from '#/components/analytics/UninvoicedView'
import { uninvoicedArgs } from '#/lib/analyticsView'
import { todayKey } from '#/lib/format'
import {
  loaderWaitMs,
  rq,
  searchParam,
  settleInBrowser,
  warm,
} from '#/lib/routeQueries'

/**
 * Analytics → Awaiting invoice: finished work not yet invoiced, by how long
 * it has waited. A page, not a sheet: it is somewhere you go and work down,
 * opening one job after another (design-system.md, Sheets or pages?).
 */
export const Route = createFileRoute('/$businessSlug/analytics/uninvoiced')({
  // The service and person chosen on Analytics come along, so the total
  // here is the one that was tapped.
  validateSearch: z.object({
    staff: z.string().optional(),
    service: z.string().optional(),
  }),
  loader: ({ context: { queryClient, business }, location }) =>
    settleInBrowser(
      loaderWaitMs(),
      warm(
        queryClient,
        rq.analyticsUninvoiced(
          uninvoicedArgs(
            business._id,
            {
              staff: searchParam(location, 'staff') || undefined,
              service: searchParam(location, 'service') || undefined,
            },
            todayKey(business.timezone),
          ),
        ),
      ),
    ),
  component: UninvoicedPage,
})

function UninvoicedPage() {
  const { business } = Route.useRouteContext()
  const search = Route.useSearch()
  const today = todayKey(business.timezone)
  const report = useQuery(
    rq.analyticsUninvoiced(uninvoicedArgs(business._id, search, today)),
  )

  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        back={
          <BackLink
            to="/$businessSlug/analytics"
            params={{ businessSlug: business.slug }}
            search={{ staff: search.staff, service: search.service }}
          >
            Analytics
          </BackLink>
        }
        title="Awaiting invoice"
      />
      <UninvoicedView
        businessSlug={business.slug}
        today={today}
        report={report.data ?? undefined}
        narrowed={search.staff !== undefined || search.service !== undefined}
        failed={report.isError}
        onRetry={() => void report.refetch()}
      />
    </>
  )
}

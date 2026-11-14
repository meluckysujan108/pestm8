import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { PageHeader } from '#/components/shell/PageHeader'
import { PaymentsView } from '#/components/payments/PaymentsView'
import { JobDetailSheet } from '#/components/schedule/JobDetailSheet'
import { useCan } from '#/lib/access'
import { rq, searchParam, warm } from '#/lib/routeQueries'
import type { PaymentsTab } from '#/lib/payments'
import { dayKeyOf } from '../../../convex/lib/dates'

const TABS = ['owing', 'toBill', 'paid'] as const satisfies Array<PaymentsTab>
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/

export const Route = createFileRoute('/$businessSlug/payments')({
  // In the address like every view and filter (§5): Owing is the default and
  // is left out, as this month is.
  validateSearch: z.object({
    tab: z.enum(TABS).optional().catch(undefined),
    month: z.string().regex(MONTH).optional().catch(undefined),
    jobId: z.string().optional(),
  }),
  // The totals wait; the tab's list is asked for once they are in and not
  // waited on, as Analytics does its charts: asked for together, Convex
  // answers both at once, so the totals would wait on the slower list.
  loader: ({ context: { queryClient, business }, location }) => {
    const tab = TABS.find((one) => one === searchParam(location, 'tab'))
    const thisMonth = dayKeyOf(Date.now(), business.timezone).slice(0, 7)
    const totals = warm(
      queryClient,
      rq.paymentsSummary(business._id, thisMonth),
    )
    if (typeof window !== 'undefined') {
      const month = searchParam(location, 'month')
      void totals
        .then(() =>
          warm(
            queryClient,
            tab === 'paid'
              ? rq.paymentsPaidIn(
                  business._id,
                  typeof month === 'string' && MONTH.test(month)
                    ? month
                    : thisMonth,
                )
              : rq.paymentsOutstanding(business._id, tab ?? 'owing'),
          ),
        )
        .catch(() => {})
    }
    return totals
  },
  component: PaymentsPage,
})

function PaymentsPage() {
  const { business } = Route.useRouteContext()
  const { tab = 'owing', month, jobId } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const canDispatch = useCan('jobs.dispatch')
  const canManageClients = useCan('clients.manage')

  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        kicker={business.name}
        title="Payments"
      />

      <PaymentsView
        business={business}
        tab={tab}
        month={month}
        onTab={(next) =>
          navigate({
            search: (prev) => ({
              ...prev,
              tab: next === 'owing' ? undefined : next,
            }),
            replace: true,
          })
        }
        onMonth={(next) =>
          navigate({
            search: (prev) => ({ ...prev, month: next }),
            replace: true,
            resetScroll: false,
          })
        }
        // Opening a job and closing it change the address in place, without
        // dropping the reader back at the top of a list they had scrolled.
        onOpenJob={(id) =>
          navigate({
            search: (prev) => ({ ...prev, jobId: id }),
            replace: true,
            resetScroll: false,
          })
        }
      />

      <JobDetailSheet
        businessId={business._id}
        businessSlug={business.slug}
        timezone={business.timezone}
        jobId={jobId ?? null}
        canReassign={canDispatch}
        canDelete={canManageClients}
        onClose={() =>
          navigate({
            search: (prev) => ({ ...prev, jobId: undefined }),
            replace: true,
            resetScroll: false,
          })
        }
      />
    </>
  )
}

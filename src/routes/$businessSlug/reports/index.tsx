import { createFileRoute, Link } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { Lock, Plus } from 'lucide-react'
import { api } from '../../../../convex/_generated/api'
import { PageHeader } from '#/components/shell/PageHeader'
import { EmptyState } from '#/components/primitives/EmptyState'
import { getTemplate } from '#/lib/reportTemplates'
import type { TemplateId } from '#/lib/reportTemplates'

export const Route = createFileRoute('/$businessSlug/reports/')({
  component: ReportsPage,
})

function ReportsPage() {
  const { business } = Route.useRouteContext()
  const { data: reports } = useSuspenseQuery(
    convexQuery(api.reports.listForBusiness, { businessId: business._id }),
  )

  return (
    <>
      <PageHeader
        kicker={`${reports.length} ${reports.length === 1 ? 'report' : 'reports'}`}
        title="Reports"
        action={
          <Link
            to="/$businessSlug/reports/new"
            params={{ businessSlug: business.slug }}
            aria-label="New report"
            className="flex size-9 items-center justify-center rounded-full bg-red text-white shadow-red transition active:scale-[.95]"
          >
            <Plus size={20} strokeWidth={2} />
          </Link>
        }
      />

      <section className="px-4 pt-4 pb-6">
        {reports.length === 0 ? (
          <EmptyState
            title="No reports yet"
            body="Create a treatment record, inspection or certificate."
          />
        ) : (
          <div className="flex flex-col gap-2.5">
            {reports.map((r) => {
              const template = getTemplate(r.template as TemplateId)
              return (
                <Link
                  key={r._id}
                  to="/$businessSlug/reports/$reportId"
                  params={{ businessSlug: business.slug, reportId: r._id }}
                  className="rounded-2xl border border-hairline bg-surface p-3.5 shadow-elevation transition active:scale-[.99]"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-row-title text-ink">
                      {template.name}
                    </span>
                    <span className="shrink-0 text-caption text-muted">
                      {r.legalBasis}
                    </span>
                  </div>
                  <p className="mt-0.5 text-body text-ink-2">{r.clientName}</p>
                  <p className="mt-0.5 text-caption text-muted">{r.suburb}</p>
                  <span
                    className={`mt-2 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-semibold ${
                      r.status === 'finalised'
                        ? 'bg-green/12 text-green'
                        : 'bg-amber-bg text-amber-ink border border-amber-line'
                    }`}
                  >
                    {r.status === 'finalised' && (
                      <Lock size={11} strokeWidth={2.4} />
                    )}
                    {r.status === 'finalised' ? 'Finalised' : 'Draft'}
                  </span>
                </Link>
              )
            })}
          </div>
        )}
      </section>
    </>
  )
}

import { useMemo } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { Lock, Plus, Search } from 'lucide-react'
import { z } from 'zod'
import { api } from '../../../../convex/_generated/api'
import { PageHeader } from '#/components/shell/PageHeader'
import { EmptyState } from '#/components/primitives/EmptyState'
import { Segmented } from '#/components/primitives/Segmented'
import { getTemplate } from '#/lib/reportTemplates'

const SEGMENTS = [
  { value: 'all' as const, label: 'All' },
  { value: 'draft' as const, label: 'Draft' },
  { value: 'finalised' as const, label: 'Finalised' },
  { value: 'sent' as const, label: 'Sent' },
]
type Seg = (typeof SEGMENTS)[number]['value']

export const Route = createFileRoute('/$businessSlug/reports/')({
  validateSearch: z.object({
    q: z.string().optional(),
    seg: z.enum(['all', 'draft', 'finalised', 'sent']).optional(),
  }),
  component: ReportsPage,
})

function ReportsPage() {
  const { business } = Route.useRouteContext()
  const { q, seg } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const active = seg ?? 'all'

  const { data: reports } = useSuspenseQuery(
    convexQuery(api.reports.listForBusiness, { businessId: business._id }),
  )

  // "Sent" is finalised-and-emailed, "Finalised" is finalised-and-not-yet —
  // mutually exclusive buckets, not a third status value (a finalised report
  // can be emailed zero, one, or many times; `emailedAt` tracks that
  // independently of `status`).
  const bucketOf = (r: (typeof reports)[number]): Exclude<Seg, 'all'> =>
    r.status === 'draft' ? 'draft' : r.emailedAt ? 'sent' : 'finalised'

  const counts = useMemo(() => {
    const c = { draft: 0, finalised: 0, sent: 0 }
    for (const r of reports) c[bucketOf(r)]++
    return c
  }, [reports])

  const filtered = useMemo(() => {
    const query = q?.trim().toLowerCase()
    return reports.filter((r) => {
      if (active !== 'all' && bucketOf(r) !== active) return false
      if (!query) return true
      const template = getTemplate(r.template)
      return (
        r.clientName.toLowerCase().includes(query) ||
        r.suburb.toLowerCase().includes(query) ||
        template.name.toLowerCase().includes(query)
      )
    })
  }, [reports, active, q])

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

      <div className="grid grid-cols-3 gap-2.5 px-4 pt-4">
        <Card label="Draft" value={counts.draft} />
        <Card label="Finalised" value={counts.finalised} />
        <Card label="Sent" value={counts.sent} />
      </div>

      <div className="px-4 pt-3">
        <label className="flex items-center gap-2 rounded-xl bg-surface-3 px-3">
          <Search size={17} strokeWidth={1.7} className="text-muted" />
          <span className="sr-only">Search reports</span>
          <input
            value={q ?? ''}
            onChange={(e) =>
              navigate({
                search: (prev) => ({ ...prev, q: e.target.value || undefined }),
                replace: true,
              })
            }
            placeholder="Search by client, suburb or form"
            className="h-11 flex-1 bg-transparent text-[16px] text-ink outline-none"
          />
        </label>
      </div>

      <div className="px-4 pt-3">
        <Segmented
          label="Report status"
          value={active}
          options={SEGMENTS}
          onChange={(value) =>
            navigate({
              search: (prev) => ({
                ...prev,
                seg: value === 'all' ? undefined : value,
              }),
              replace: true,
            })
          }
        />
      </div>

      <section className="px-4 pt-4 pb-6">
        {filtered.length === 0 ? (
          <EmptyState
            title={q || active !== 'all' ? 'No matches' : 'No reports yet'}
            body={
              q || active !== 'all'
                ? 'Try a different search or status.'
                : 'Create a treatment record, inspection or certificate.'
            }
          />
        ) : (
          <div className="flex flex-col gap-2.5">
            {filtered.map((r) => {
              const template = getTemplate(r.template)
              const bucket = bucketOf(r)
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
                      bucket === 'sent'
                        ? 'bg-blue/12 text-blue'
                        : bucket === 'finalised'
                          ? 'bg-green/12 text-green'
                          : 'border border-amber-line bg-amber-bg text-amber-ink'
                    }`}
                  >
                    {bucket !== 'draft' && <Lock size={11} strokeWidth={2.4} />}
                    {bucket === 'sent'
                      ? 'Sent'
                      : bucket === 'finalised'
                        ? 'Finalised'
                        : 'Draft'}
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

function Card({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-hairline bg-surface p-3.5 shadow-elevation">
      <p className="section-label mb-1">{label}</p>
      <p className="text-metric text-ink">{value}</p>
    </div>
  )
}

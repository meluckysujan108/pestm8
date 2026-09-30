import { Link, useNavigate } from '@tanstack/react-router'
import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { Plus } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { CREATABLE_TEMPLATES } from '#/lib/reportTemplates'
import { suggestTemplates } from '#/lib/reportTemplates/suggest'
import { useHydrated } from '#/lib/useHydrated'
import type { ReactNode } from 'react'
import type { TemplateId } from '#/lib/reportTemplates'
import type { Id } from '../../../convex/_generated/dataModel'
import {
  NEUTRAL_BUTTON_COMPACT,
  SECONDARY_BUTTON_COMPACT,
} from '#/components/primitives/buttons'
import { RowPending } from '#/components/shell/Pending'
import { LoadFailed } from '#/components/primitives/EmptyState'
import { ReportLine } from './ReportRows'
import type { InlineReport } from './ReportRows'

export type { InlineReport } from './ReportRows'

/**
 * Reports, shown inside a job sheet or a client sheet.
 *
 * There were two of these: one written inside `JobDetailSheet` and one inside
 * `ClientSheet`, with the same row copy-pasted and quietly diverging. The job
 * one collapsed loading into empty, so a property whose reports had not
 * arrived yet looked like a property with none; the client one returned
 * `null` when empty, so a client with no reports got no heading, no sentence
 * and no way to start one.
 *
 * Presentational, in the shape `InlineNotes` established: the caller owns the
 * query and the create mutation, and this draws a section. Three states, and
 * they are three: loading is not empty, and empty is not absent.
 */

export function InlineReportsSection({
  businessSlug,
  timezone,
  label,
  reports,
  empty,
  failed = false,
  onRetry,
  action,
  footer,
}: {
  businessSlug: string
  timezone: string
  label: string
  /** `undefined` while the query is out — which is not the same as none. */
  reports: Array<InlineReport> | undefined
  empty: string
  /** The query failed: say so, rather than loading for good. */
  failed?: boolean
  /** Asks again — the query's `refetch`. */
  onRetry?: () => void
  /** What to start one with, where the surface offers that. */
  action?: ReactNode
  /** More of the same card below the action: a job's photos. */
  footer?: ReactNode
}) {
  return (
    <section className="mt-6">
      <h3 className="section-label mb-2">{label}</h3>
      <div className="overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation">
        {reports === undefined && failed ? (
          <div className="p-2">
            <LoadFailed what="the reports" onRetry={onRetry} />
          </div>
        ) : reports === undefined ? (
          <RowPending label="Loading reports" />
        ) : reports.length === 0 ? (
          <p className="px-3.5 py-3 text-body text-muted">{empty}</p>
        ) : (
          <div className="divide-y divide-hairline">
            {reports.map((report) => (
              <ReportLine
                key={report._id}
                businessSlug={businessSlug}
                report={report}
                timezone={timezone}
              />
            ))}
          </div>
        )}
        {action && (
          <div className="border-t border-hairline p-2.5">{action}</div>
        )}
        {footer}
      </div>
    </section>
  )
}

/**
 * Starting the report this job produces, in one tap.
 *
 * A termite inspection produces a Timber Pest Inspection; a general pest job
 * a Service Report. Offering that directly skips the picker entirely, and the
 * picker stays one tap away for the times the guess is wrong. A job for both
 * offers both, in the order its services are listed.
 */
export function StartReportButtons({
  businessId,
  businessSlug,
  propertyId,
  jobId,
  jobType,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  propertyId: Id<'properties'>
  jobId: Id<'jobs'>
  jobType: string
}) {
  const navigate = useNavigate()
  const hydrated = useHydrated()
  const convexCreate = useConvexMutation(api.reports.create)
  const create = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      propertyId: Id<'properties'>
      jobId: Id<'jobs'>
      template: TemplateId
      legalBasis: string
      data: unknown
      // This build shows a suggestion as one and asks for it to be confirmed.
    }) => convexCreate({ ...args, suggestions: true }),
    onSuccess: (reportId: Id<'reports'>) =>
      navigate({
        to: '/$businessSlug/reports/$reportId',
        params: { businessSlug, reportId },
      }),
  })

  const suggested = suggestTemplates(jobType).flatMap(
    (id) => CREATABLE_TEMPLATES.find((template) => template.id === id) ?? [],
  )

  if (suggested.length === 0) {
    return (
      <Link
        to="/$businessSlug/reports/new"
        params={{ businessSlug }}
        search={{ propertyId, jobId }}
        className={`${SECONDARY_BUTTON_COMPACT} flex w-full items-center justify-center gap-2`}
      >
        <Plus size={16} strokeWidth={2.2} />
        New report
      </Link>
    )
  }

  const start = (template: (typeof suggested)[number], width: string) => (
    <button
      key={template.id}
      type="button"
      disabled={create.isPending || !hydrated}
      onClick={() =>
        create.mutate({
          businessId,
          propertyId,
          jobId,
          template: template.id as TemplateId,
          legalBasis: template.legalBasis,
          // Seeded on the server from the job and the client record; an
          // empty object is the caller saying it has nothing to add.
          data: {},
        })
      }
      className={`${NEUTRAL_BUTTON_COMPACT} flex items-center justify-center gap-2 ${width}`}
    >
      <Plus size={16} strokeWidth={2.2} />
      {create.isPending && create.variables.template === template.id
        ? 'Starting…'
        : `Start ${template.shortName}`}
    </button>
  )
  const other = (className: string) => (
    <Link
      to="/$businessSlug/reports/new"
      params={{ businessSlug }}
      search={{ propertyId, jobId }}
      className={`${SECONDARY_BUTTON_COMPACT} flex items-center justify-center ${className}`}
    >
      Other…
    </Link>
  )

  // One form, as it has always been: the form and Other… side by side.
  if (suggested.length === 1) {
    return (
      <div className="flex gap-2">
        {start(suggested[0], 'flex-1')}
        {other('px-3')}
      </div>
    )
  }

  // One for each form the job's services produce, then Other… under them.
  return (
    <div className="flex flex-col gap-2">
      {suggested.map((template) => start(template, 'w-full'))}
      {other('w-full')}
    </div>
  )
}

/**
 * A way out of a bounded section and into the library, carrying the client's
 * name so the search lands on their reports rather than on everything.
 */
export function SeeAllReports({
  businessSlug,
  term,
}: {
  businessSlug: string
  term: string
}) {
  return (
    <Link
      to="/$businessSlug/reports"
      params={{ businessSlug }}
      search={{ q: term }}
      className="flex h-11 w-full items-center justify-center rounded-xl text-body font-semibold text-blue"
    >
      See all in Reports
    </Link>
  )
}

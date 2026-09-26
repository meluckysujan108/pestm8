import { Link, useNavigate } from '@tanstack/react-router'
import { REPORT_PILL } from '#/lib/statusColours'
import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { Lock, Plus } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { CREATABLE_TEMPLATES } from '#/lib/reportTemplates'
import { suggestTemplate } from '#/lib/reportTemplates/suggest'
import { useHydrated } from '#/lib/useHydrated'
import type { ReactNode } from 'react'
import type { TemplateId } from '#/lib/reportTemplates'
import type { Id } from '../../../convex/_generated/dataModel'
import {
  NEUTRAL_BUTTON_COMPACT,
  SECONDARY_BUTTON_COMPACT,
} from '#/components/primitives/buttons'
import { RowPending } from '#/components/shell/Pending'

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

export type InlineReport = {
  _id: Id<'reports'>
  status: string
  emailedAt?: number
  finalisedAt?: number
  createdAt: number
  legalBasis: string
  templateName: string
  jobId?: Id<'jobs'>
}

export function InlineReportsSection({
  businessSlug,
  timezone,
  label,
  reports,
  empty,
  action,
}: {
  businessSlug: string
  timezone: string
  label: string
  /** `undefined` while the query is out — which is not the same as none. */
  reports: Array<InlineReport> | undefined
  empty: string
  /** What to start one with, where the surface offers that. */
  action?: ReactNode
}) {
  return (
    <section className="mt-6">
      <h3 className="section-label mb-2">{label}</h3>
      <div className="overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation">
        {reports === undefined ? (
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
      </div>
    </section>
  )
}

function ReportLine({
  businessSlug,
  report,
  timezone,
}: {
  businessSlug: string
  report: InlineReport
  timezone: string
}) {
  const bucket =
    report.status === 'draft'
      ? 'draft'
      : report.emailedAt
        ? 'sent'
        : 'finalised'

  return (
    <Link
      to="/$businessSlug/reports/$reportId"
      params={{ businessSlug, reportId: report._id }}
      className="flex items-center justify-between gap-2 px-3.5 py-2.5"
    >
      <span className="min-w-0">
        {/* The form's own name. The row used to lead with the legal basis,
            so three different documents all read "APVMA · AEPMA". */}
        <span className="block truncate text-body text-ink">
          {report.templateName}
        </span>
        <span className="text-caption text-muted">
          {new Intl.DateTimeFormat('en-AU', {
            timeZone: timezone,
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          }).format(new Date(report.finalisedAt ?? report.createdAt))}
          {' · '}
          {report.legalBasis}
        </span>
      </span>
      <span
        className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${REPORT_PILL[bucket]}`}
      >
        {bucket !== 'draft' && <Lock size={10} strokeWidth={2.4} />}
        {bucket === 'sent'
          ? 'Sent'
          : bucket === 'finalised'
            ? 'Finalised'
            : 'Draft'}
      </span>
    </Link>
  )
}

/**
 * Starting the report this job produces, in one tap.
 *
 * A termite inspection produces a Timber Pest Inspection; a general pest job
 * a Service Report. Offering that directly skips the picker entirely, and the
 * picker stays one tap away for the times the guess is wrong.
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

  const suggestedId = suggestTemplate(jobType)
  const suggested = suggestedId
    ? CREATABLE_TEMPLATES.find((template) => template.id === suggestedId)
    : undefined

  if (!suggested) {
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

  return (
    <div className="flex gap-2">
      <button
        type="button"
        disabled={create.isPending || !hydrated}
        onClick={() =>
          create.mutate({
            businessId,
            propertyId,
            jobId,
            template: suggested.id as TemplateId,
            legalBasis: suggested.legalBasis,
            // Seeded on the server from the job and the client record; an
            // empty object is the caller saying it has nothing to add.
            data: {},
          })
        }
        className={`${NEUTRAL_BUTTON_COMPACT} flex flex-1 items-center justify-center gap-2`}
      >
        <Plus size={16} strokeWidth={2.2} />
        {create.isPending ? 'Starting…' : `Start ${suggested.shortName}`}
      </button>
      <Link
        to="/$businessSlug/reports/new"
        params={{ businessSlug }}
        search={{ propertyId, jobId }}
        className={`${SECONDARY_BUTTON_COMPACT} flex items-center justify-center px-3`}
      >
        Other…
      </Link>
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

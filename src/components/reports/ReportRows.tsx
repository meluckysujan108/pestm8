import { Link } from '@tanstack/react-router'
import { ChevronRight, FileText, Lock } from 'lucide-react'
import { REPORT_PILL } from '#/lib/statusColours'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * A report as a line in a list, and as a chip under the visit it came from.
 *
 * Kept apart from `InlineReports`, which carries every report template to
 * start one with: a job's history shows reports on the Schedule's own sheet,
 * and importing them from there would put the templates in the chunk the
 * Schedule hydrates from (see `JobDetailSheet`'s lazy imports).
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

type Bucket = 'draft' | 'finalised' | 'sent'

function bucketOf(report: InlineReport): Bucket {
  return report.status === 'draft'
    ? 'draft'
    : report.emailedAt
      ? 'sent'
      : 'finalised'
}

/** Draft, Finalised or Sent, with a lock once it is no longer a draft. */
export function ReportStatusPill({ report }: { report: InlineReport }) {
  const bucket = bucketOf(report)
  return (
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
  )
}

/** A report in a section's list: its form, its date and standard, its state. */
export function ReportLine({
  businessSlug,
  report,
  timezone,
}: {
  businessSlug: string
  report: InlineReport
  timezone: string
}) {
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
      <ReportStatusPill report={report} />
    </Link>
  )
}

/**
 * A visit's report, under the visit: the form and its state, a tap from the
 * report itself. The visit's own row already says when.
 */
export function ReportChip({
  businessSlug,
  report,
}: {
  businessSlug: string
  report: InlineReport
}) {
  return (
    <Link
      to="/$businessSlug/reports/$reportId"
      params={{ businessSlug, reportId: report._id }}
      className="flex min-h-11 items-center gap-2 rounded-lg bg-surface-2 px-2.5 transition active:scale-[.99]"
    >
      <FileText
        aria-hidden
        size={14}
        strokeWidth={2}
        className="shrink-0 text-muted"
      />
      <span className="min-w-0 flex-1 truncate text-caption text-ink-2">
        {report.templateName}
      </span>
      <ReportStatusPill report={report} />
      <ChevronRight
        aria-hidden
        size={14}
        strokeWidth={2.2}
        className="shrink-0 text-muted-2"
      />
    </Link>
  )
}

import { createFileRoute, notFound, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { restartingReports } from '#/lib/restartingReports'
import { useSuspenseQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { api } from '../../../../convex/_generated/api'
import { ReportBuilder } from '#/components/reports/ReportBuilder'
import { ReportDocument } from '#/components/reports/ReportDocument'
import { documentIdentity } from '#/lib/reportTemplates/documentModel'
import { ReportActionBar } from '#/components/reports/ReportActionBar'
import { resolveReportTemplate } from '#/lib/reportTemplates/resolve'
import type { Id } from '../../../../convex/_generated/dataModel'

export const Route = createFileRoute('/$businessSlug/reports/$reportId')({
  /**
   * Which section is open, by the template's own section id. In the URL so the
   * phone's back gesture leaves a section rather than the report, and so a
   * refresh mid-job comes back to the same screen.
   */
  validateSearch: z.object({ s: z.string().optional() }),
  // Without a loader the page suspends while it renders, and on an in-app
  // navigation that suspension blanks the whole app shell until the report
  // arrives. "Start again" navigates to a report no query has seen yet, so it
  // showed an empty screen for a second or more. Loading first keeps the
  // current screen up until the report is ready.
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(
      convexQuery(api.reports.get, {
        businessId: context.business._id,
        reportId: params.reportId as Id<'reports'>,
      }),
    ),
  component: ReportPage,
})

function ReportPage() {
  const { business } = Route.useRouteContext()
  const { reportId } = Route.useParams()
  const { s: section } = Route.useSearch()
  const navigate = useNavigate()

  const { data: report } = useSuspenseQuery(
    convexQuery(api.reports.get, {
      businessId: business._id,
      reportId: reportId as Id<'reports'>,
    }),
  )

  // Mid-"Start again": the old draft is gone and the new one is a navigation
  // away. Render nothing rather than flash Not Found.
  if (!report && restartingReports.has(reportId)) return null
  if (!report) throw notFound()

  // One route, two faces: a draft is a form, a finalised report is a document.
  // The status is the single source of that truth, so a locked report has no
  // editable rendering to fall back to.
  if (report.status === 'finalised') {
    const template = resolveReportTemplate({
      template: report.template,
      templateVersion: report.templateVersion,
      customTemplate: report.customTemplate,
      // The finalised branch names the downloaded file. Resolving from the
      // live module here would give a client a file named after wording their
      // document does not contain.
      templateSnapshot: report.templateSnapshot,
    })
    return (
      <ReportActionBar
        businessId={business._id}
        reportId={report._id}
        pdfUrl={report.pdfUrl ?? null}
        fileName={
          documentIdentity({
            template,
            property: report.property,
            businessName: report.businessName,
            finalisedAt: report.finalisedAt,
          }).fileName
        }
      >
        <ReportDocument report={report} businessId={business._id} />
      </ReportActionBar>
    )
  }

  if (!report.canEdit) {
    return <ReportDocument report={report} businessId={business._id} />
  }

  return (
    <ReportBuilder
      // Keyed by revision: the builder seeds its answers once, so switching a
      // draft to a newer form must remount it rather than let the old
      // revision's in-memory answers autosave back over the migrated ones.
      key={`${report._id}:${report.templateVersion ?? 1}`}
      businessId={business._id}
      reportId={report._id}
      template={report.template}
      templateVersion={report.templateVersion}
      optionSets={report.optionSets}
      prefill={report.prefill}
      section={section}
      onSection={(next) =>
        navigate({
          to: '/$businessSlug/reports/$reportId',
          params: { businessSlug: business.slug, reportId: report._id },
          search: (prev) => ({ ...prev, s: next }),
        })
      }
      roster={report.roster}
      context={report.context}
      upgrade={report.upgrade}
      onRestarted={(newReportId) =>
        navigate({
          to: '/$businessSlug/reports/$reportId',
          params: { businessSlug: business.slug, reportId: newReportId },
        })
      }
      customTemplate={report.customTemplate}
      initialData={(report.data ?? {}) as Record<string, unknown>}
      property={report.property}
      businessName={report.businessName}
      authorLicence={report.author?.licenceNumber}
      onFinalised={() =>
        navigate({
          to: '/$businessSlug/reports/$reportId',
          params: { businessSlug: business.slug, reportId },
        })
      }
    />
  )
}

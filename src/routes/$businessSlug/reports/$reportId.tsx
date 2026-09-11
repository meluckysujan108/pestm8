import { createFileRoute, notFound, useNavigate } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { api } from '../../../../convex/_generated/api'
import { ReportBuilder } from '#/components/reports/ReportBuilder'
import {
  ReportDocument,
  pdfFileName,
} from '#/components/reports/ReportDocument'
import { ReportActionBar } from '#/components/reports/ReportActionBar'
import { resolveReportTemplate } from '#/lib/reportTemplates/resolve'
import type { Id } from '../../../../convex/_generated/dataModel'

export const Route = createFileRoute('/$businessSlug/reports/$reportId')({
  component: ReportPage,
})

function ReportPage() {
  const { business } = Route.useRouteContext()
  const { reportId } = Route.useParams()
  const navigate = useNavigate()

  const { data: report } = useSuspenseQuery(
    convexQuery(api.reports.get, {
      businessId: business._id,
      reportId: reportId as Id<'reports'>,
    }),
  )

  if (!report) throw notFound()

  // One route, two faces: a draft is a form, a finalised report is a document.
  // The status is the single source of that truth, so a locked report has no
  // editable rendering to fall back to.
  if (report.status === 'finalised') {
    const template = resolveReportTemplate({
      template: report.template,
      customTemplate: report.customTemplate,
    })
    return (
      <ReportActionBar
        businessId={business._id}
        reportId={report._id}
        pdfUrl={report.pdfUrl ?? null}
        fileName={pdfFileName(template.shortName, report.property?.addressLine)}
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
      businessId={business._id}
      reportId={report._id}
      template={report.template}
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

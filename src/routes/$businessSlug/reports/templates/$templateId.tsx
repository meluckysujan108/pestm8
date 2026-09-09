import { createFileRoute, notFound } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { api } from '../../../../../convex/_generated/api'
import { PageHeader } from '#/components/shell/PageHeader'
import { EmptyState } from '#/components/primitives/EmptyState'
import { TemplateEditor } from '#/components/reportTemplates/TemplateEditor'
import type { Id } from '../../../../../convex/_generated/dataModel'
import type { SectionDef } from '#/lib/reportTemplates'

export const Route = createFileRoute('/$businessSlug/reports/templates/$templateId')({
  component: TemplateDetailPage,
})

function TemplateDetailPage() {
  const { business, membership } = Route.useRouteContext()
  const { templateId } = Route.useParams()

  const { data: template } = useSuspenseQuery(
    convexQuery(api.customTemplates.get, {
      businessId: business._id,
      templateId: templateId as Id<'customReportTemplates'>,
    }),
  )

  if (membership.role !== 'owner') {
    return (
      <>
        <PageHeader kicker="Templates" title="Template" />
        <div className="px-4 pt-4 pb-6">
          <EmptyState
            title="Owners only"
            body="Ask a business owner to view or edit report templates."
          />
        </div>
      </>
    )
  }

  if (!template) throw notFound()

  return (
    <>
      <PageHeader kicker="Templates" title={template.name} />

      {template.archivedAt && (
        <div className="px-4 pt-4">
          <p className="rounded-xl border border-amber-line bg-amber-bg px-3 py-2 text-caption text-amber-ink">
            This template is archived — it no longer appears when starting a
            new report, but any report already using it is unaffected.
          </p>
        </div>
      )}

      <TemplateEditor
        key={template._id}
        businessId={business._id}
        templateId={template._id}
        initial={{
          name: template.name,
          shortName: template.shortName,
          legalBasis: template.legalBasis,
          blurb: template.blurb,
          sections: template.sections as Array<SectionDef>,
          boilerplate: template.boilerplate,
        }}
      />
    </>
  )
}

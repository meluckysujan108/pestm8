import { useState } from 'react'
import { createFileRoute, notFound } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { api } from '../../../../../convex/_generated/api'
import { PageHeader } from '#/components/shell/PageHeader'
import { EmptyState } from '#/components/primitives/EmptyState'
import { TemplateEditor } from '#/components/reportTemplates/TemplateEditor'
import type { Id } from '../../../../../convex/_generated/dataModel'
import type { SectionDef } from '#/lib/reportTemplates'
import { useCan } from '#/lib/access'

export const Route = createFileRoute('/$businessSlug/reports/templates/$templateId')({
  component: TemplateDetailPage,
})

function TemplateDetailPage() {
  const { business } = Route.useRouteContext()
  const canManageTemplates = useCan('templates.manage')
  const { templateId } = Route.useParams()

  // Bumped when a draft is discarded, to remount the editor on what is now
  // the published form.
  const [reloads, setReloads] = useState(0)

  const { data: template } = useSuspenseQuery(
    convexQuery(api.customTemplates.get, {
      businessId: business._id,
      templateId: templateId as Id<'customReportTemplates'>,
    }),
  )

  if (!canManageTemplates) {
    return (
      <>
        <PageHeader
          businessId={business._id}
          businessSlug={business.slug}
          kicker="Templates"
          title="Template"
        />
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

  // The owner picks up where they left off: an unissued edit if there is one,
  // otherwise the form the business is currently handing out.
  const editing = {
    version: `${template.publishedVersion}:${reloads}`,
    draft: {
      name: template.draft?.name ?? template.name,
      shortName: template.draft?.shortName ?? template.shortName,
      legalBasis: template.draft?.legalBasis ?? template.legalBasis,
      blurb: template.draft?.blurb ?? template.blurb,
      sections: (template.draft?.sections ?? template.sections) as Array<SectionDef>,
      boilerplate: template.draft?.boilerplate ?? template.boilerplate,
    },
  }

  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        kicker="Templates"
        title={template.name}
      />

      {template.hasUnpublishedChanges && (
        <div className="px-4 pt-4">
          <p className="rounded-xl border border-hairline bg-surface px-3 py-2 text-caption text-muted">
            You have changes nobody has been given yet. Your team is still
            filling in version {template.publishedVersion}.
          </p>
        </div>
      )}

      {template.archivedAt && (
        <div className="px-4 pt-4">
          <p className="rounded-xl border border-amber-line bg-amber-bg px-3 py-2 text-caption text-amber-ink">
            This template is archived — it no longer appears when starting a
            new report, but any report already using it is unaffected.
          </p>
        </div>
      )}

      <TemplateEditor
        // Re-keyed on the version so discarding a draft remounts the editor on
        // the published form rather than leaving the abandoned edit on screen.
        key={`${template._id}:${editing.version}`}
        businessId={business._id}
        templateId={template._id}
        initial={editing.draft}
        publishedVersion={template.publishedVersion}
        hasUnpublishedChanges={template.hasUnpublishedChanges}
        onDiscarded={() => setReloads((n) => n + 1)}
      />
    </>
  )
}

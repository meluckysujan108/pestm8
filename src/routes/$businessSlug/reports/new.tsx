import { useEffect, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { z } from 'zod'
import { api } from '../../../../convex/_generated/api'
import { PageHeader } from '#/components/shell/PageHeader'
import { EmptyState } from '#/components/primitives/EmptyState'
import { TEMPLATE_LIST } from '#/lib/reportTemplates'
import type { TemplateId } from '#/lib/reportTemplates'
import type { Id } from '../../../../convex/_generated/dataModel'
import { useHydrated } from '#/lib/useHydrated'

export const Route = createFileRoute('/$businessSlug/reports/new')({
  // Arriving from a job's detail sheet ($businessSlug/schedule via
  // JobDetailSheet.tsx) carries both — the property is already decided by
  // the job, and jobId links the new report back to it.
  validateSearch: z.object({
    propertyId: z.string().optional(),
    jobId: z.string().optional(),
  }),
  component: NewReportPage,
})

function NewReportPage() {
  const { business } = Route.useRouteContext()
  const search = Route.useSearch()
  const hydrated = useHydrated()

  const navigate = useNavigate()
  const [propertyId, setPropertyId] = useState('')

  const { data: properties } = useSuspenseQuery(
    convexQuery(api.properties.list, { businessId: business._id }),
  )
  const { data: customTemplates } = useSuspenseQuery(
    convexQuery(api.customTemplates.list, { businessId: business._id }),
  )
  // Archiving only removes a template from this picker — a report already
  // using it keeps working, per `customReportTemplates`'s own schema comment.
  const activeCustomTemplates = customTemplates.filter((t) => !t.archivedAt)

  // A property id arriving from a job is only trusted once it actually
  // matches one of this business's properties — a stale or tampered link
  // just falls back to the ordinary picker instead of silently misfiring.
  const lockedProperty = properties.find((p) => p._id === search.propertyId)
  const jobId = lockedProperty ? search.jobId : undefined

  useEffect(() => {
    if (propertyId) return
    if (lockedProperty) setPropertyId(lockedProperty._id)
    else if (properties.length > 0) setPropertyId(properties[0]._id)
  }, [properties, propertyId, lockedProperty])

  const convexCreate = useConvexMutation(api.reports.create)
  const create = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      propertyId: Id<'properties'>
      jobId?: Id<'jobs'>
      template: TemplateId | 'custom'
      customTemplateId?: Id<'customReportTemplates'>
      legalBasis: string
      data: unknown
    }) => convexCreate(args),
    onSuccess: (reportId) =>
      navigate({
        to: '/$businessSlug/reports/$reportId',
        params: { businessSlug: business.slug, reportId },
      }),
  })

  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        kicker="New"
        title="Choose a template"
      />

      <div className="px-4 pt-4 pb-6">
        {properties.length === 0 ? (
          <EmptyState
            title="No properties yet"
            body="Add a client property first — a report is always about an address."
          />
        ) : (
          <>
            {lockedProperty ? (
              <div className="flex flex-col gap-1.5">
                <span className="section-label">Property</span>
                <div className="rounded-xl bg-surface-3 px-3.5 py-3">
                  <p className="text-[16px] text-ink">
                    {lockedProperty.client?.name}
                  </p>
                  <p className="text-body text-muted">
                    {lockedProperty.addressLine}, {lockedProperty.suburb}
                  </p>
                </div>
              </div>
            ) : (
              <label className="flex flex-col gap-1.5">
                <span className="section-label">Property</span>
                <select
                  value={propertyId}
                  onChange={(e) => setPropertyId(e.target.value)}
                  className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
                >
                  {properties.map((p) => (
                    <option key={p._id} value={p._id}>
                      {p.client?.name} — {p.addressLine}, {p.suburb}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <div className="mt-5 flex flex-col gap-2.5">
              {TEMPLATE_LIST.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  disabled={create.isPending || !hydrated}
                  onClick={() =>
                    create.mutate({
                      businessId: business._id,
                      propertyId: propertyId as Id<'properties'>,
                      jobId: jobId as Id<'jobs'> | undefined,
                      template: template.id,
                      legalBasis: template.legalBasis,
                      data: {},
                    })
                  }
                  className="rounded-2xl border border-hairline bg-surface p-4 text-left shadow-elevation transition active:scale-[.99] disabled:opacity-50"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-row-title text-ink">
                      {template.name}
                    </span>
                    {/* The legal basis is the point of the product, so it is a
                        first-class label rather than fine print. */}
                    <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-muted">
                      {template.legalBasis}
                    </span>
                  </div>
                  <p className="mt-1 text-body text-muted">{template.blurb}</p>
                </button>
              ))}
            </div>

            {activeCustomTemplates.length > 0 && (
              <>
                <p className="section-label mt-6 mb-2">Custom</p>
                <div className="flex flex-col gap-2.5">
                  {activeCustomTemplates.map((template) => (
                    <button
                      key={template._id}
                      type="button"
                      disabled={create.isPending || !hydrated}
                      onClick={() =>
                        create.mutate({
                          businessId: business._id,
                          propertyId: propertyId as Id<'properties'>,
                          jobId: jobId as Id<'jobs'> | undefined,
                          template: 'custom',
                          customTemplateId: template._id,
                          legalBasis: template.legalBasis,
                          data: {},
                        })
                      }
                      className="rounded-2xl border border-hairline bg-surface p-4 text-left shadow-elevation transition active:scale-[.99] disabled:opacity-50"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-row-title text-ink">
                          {template.name}
                        </span>
                        <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-muted">
                          {template.legalBasis}
                        </span>
                      </div>
                      <p className="mt-1 text-body text-muted">
                        {template.blurb}
                      </p>
                    </button>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </>
  )
}

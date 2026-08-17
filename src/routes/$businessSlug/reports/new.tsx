import { useEffect, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { api } from '../../../../convex/_generated/api'
import { PageHeader } from '#/components/shell/PageHeader'
import { EmptyState } from '#/components/primitives/EmptyState'
import { TEMPLATE_LIST } from '#/lib/reportTemplates'
import type { TemplateId } from '#/lib/reportTemplates'
import type { Id } from '../../../../convex/_generated/dataModel'

export const Route = createFileRoute('/$businessSlug/reports/new')({
  component: NewReportPage,
})

function NewReportPage() {
  const { business } = Route.useRouteContext()
  const navigate = useNavigate()
  const [propertyId, setPropertyId] = useState('')
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => setHydrated(true), [])

  const { data: properties } = useSuspenseQuery(
    convexQuery(api.properties.list, { businessId: business._id }),
  )

  useEffect(() => {
    if (!propertyId && properties.length > 0) setPropertyId(properties[0]._id)
  }, [properties, propertyId])

  const convexCreate = useConvexMutation(api.reports.create)
  const create = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      propertyId: Id<'properties'>
      template: TemplateId
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
      <PageHeader kicker="New" title="Choose a template" />

      <div className="px-4 pt-4 pb-6">
        {properties.length === 0 ? (
          <EmptyState
            title="No properties yet"
            body="Add a client property first — a report is always about an address."
          />
        ) : (
          <>
            <label className="flex flex-col gap-1.5">
              <span className="section-label">Property</span>
              <select
                value={propertyId}
                onChange={(e) => setPropertyId(e.target.value)}
                className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
              >
                {properties.map((p) => (
                  <option key={p._id} value={p._id}>
                    {p.clientName} — {p.addressLine}, {p.suburb}
                  </option>
                ))}
              </select>
            </label>

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
          </>
        )}
      </div>
    </>
  )
}

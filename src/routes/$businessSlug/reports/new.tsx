import { useEffect, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { z } from 'zod'
import { api } from '../../../../convex/_generated/api'
import { PageHeader } from '#/components/shell/PageHeader'
import { NewPropertySheet } from '#/components/clients/NewPropertySheet'
import {
  EmptyState,
  EmptyStateButton,
} from '#/components/primitives/EmptyState'
import { CREATABLE_TEMPLATES } from '#/lib/reportTemplates'
import { suggestReports } from '#/lib/reportTemplates/suggest'
import { useJobTypes } from '#/lib/useJobTypes'
import type { TemplateId } from '#/lib/reportTemplates'
import type { Id } from '../../../../convex/_generated/dataModel'
import { useHydrated } from '#/lib/useHydrated'
import { FIELD } from '#/components/forms/FormField'
import { formatJobDate, formatTime } from '#/lib/format'
import { visitChoices } from '#/lib/jobHistory'
import { useBusinessDay } from '#/lib/useBusinessDay'
import { dayKeyOf } from '../../../../convex/lib/dates'
import { FormAlert } from '#/components/forms/FormAlert'

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
  // Straight from "No properties yet": the client and address, here, and
  // then the picker below with it chosen.
  const [newClientOpen, setNewClientOpen] = useState(false)

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
  const linkedProperty = properties.find((p) => p._id === search.propertyId)
  const linkedJobId = linkedProperty ? search.jobId : undefined
  // Arriving from a job, the app already knows what the visit was for, so the
  // form that visit produces goes first and says why it is there. A suggestion
  // only: every form stays on the list, in the same order, underneath.
  const { data: job } = useQuery({
    ...convexQuery(api.jobs.get, {
      businessId: business._id,
      jobId: (linkedJobId ?? '') as Id<'jobs'>,
    }),
    enabled: Boolean(linkedJobId),
  })
  // The link is only as good as the job: one moved to another address since
  // the link was made is filed at the address it is at now, and one gone
  // (deleted, or never this business's) falls back to asking.
  const jobGone = linkedJobId !== undefined && job === null
  const lockedProperty =
    job && job.propertyId !== linkedProperty?._id
      ? properties.find((p) => p._id === job.propertyId)
      : jobGone
        ? undefined
        : linkedProperty
  const lockedJobId = lockedProperty ? linkedJobId : undefined

  // Started here rather than from a job: which visit is it for? Asked
  // before a form is chosen, because a report's visit is set as it is made —
  // its date, technician and forecast come from the visit — and is never
  // changed afterwards. "Not for a visit" is always an answer.
  const timezone = business.timezone
  const day = useBusinessDay(timezone)
  const { data: visits } = useQuery(
    convexQuery(
      api.properties.jobHistory,
      lockedJobId === undefined && propertyId
        ? {
            businessId: business._id,
            propertyId: propertyId as Id<'properties'>,
          }
        : 'skip',
    ),
  )
  const choices = visits
    ? visitChoices(visits, day)
    : undefined
  // Chosen per property: another property's visit is not this one's.
  const [choice, setChoice] = useState<{
    propertyId: string
    visitId: string
  } | null>(null)
  const visitId =
    choice?.propertyId === propertyId
      ? choice.visitId
      : // Today's one visit there, when there is exactly one: the report is
        // almost always for it.
        choices?.today.length === 1
        ? choices.today[0]._id
        : ''
  const chosenVisit = [...(choices?.today ?? []), ...(choices?.past ?? [])].find(
    (v) => v._id === visitId,
  )
  const jobId = lockedJobId ?? chosenVisit?._id
  // Until the visits are in, a tap would file the report under no visit
  // before the person could say which.
  const visitsPending =
    lockedJobId === undefined && propertyId !== '' && visits === undefined
  const visitLabel = (visit: {
    scheduledAt: number
    jobType: string
    jobNumber?: number
  }) =>
    [
      dayKeyOf(visit.scheduledAt, timezone) === day.key
        ? `Today ${formatTime(visit.scheduledAt, timezone)}`
        : formatJobDate(dayKeyOf(visit.scheduledAt, timezone), day.key),
      visit.jobType,
      visit.jobNumber !== undefined ? `#${visit.jobNumber}` : undefined,
    ]
      .filter(Boolean)
      .join(' · ')

  // A job for several services suggests a form for each (a general pest
  // service with a termite inspection: a Service Report and a Timber Pest
  // Inspection), first service first, each saying which services it is for.
  const jobTypes = useJobTypes(business._id)
  const visitType = job?.jobType ?? chosenVisit?.jobType
  // Only from the business's own list (Settings → Job types): the built-in
  // nine standing in for it could put the wrong form first.
  const suggestions =
    visitType && jobTypes.loaded
      ? suggestReports(visitType, jobTypes.entries)
      : []
  const suggestionFor = (templateId: string) =>
    suggestions.find((suggestion) => suggestion.templateId === templateId)
  const templates = [
    ...suggestions.flatMap(
      (suggestion) =>
        CREATABLE_TEMPLATES.find(
          (template) => template.id === suggestion.templateId,
        ) ?? [],
    ),
    ...CREATABLE_TEMPLATES.filter((template) => !suggestionFor(template.id)),
  ]

  useEffect(() => {
    if (lockedProperty) {
      if (propertyId !== lockedProperty._id) setPropertyId(lockedProperty._id)
      return
    }
    if (propertyId) return
    if (properties.length > 0) setPropertyId(properties[0]._id)
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
      // This build shows a suggestion as one and asks for it to be confirmed.
    }) => convexCreate({ ...args, suggestions: true }),
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
            body="Add a client first — a report is always about an address."
            action={
              <EmptyStateButton
                onClick={() => setNewClientOpen(true)}
                disabled={!hydrated}
              >
                Add a client
              </EmptyStateButton>
            }
          />
        ) : (
          <>
            {lockedProperty ? (
              <div className="flex flex-col gap-1.5">
                <span className="section-label">Property</span>
                <div className="rounded-xl bg-surface-3 px-3.5 py-3">
                  <p className="text-[16px] text-ink">{lockedProperty.client?.name}</p>
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
                  className={`${FIELD} w-full`}
                >
                  {properties.map((p) => (
                    <option key={p._id} value={p._id}>
                      {p.client?.name} — {p.addressLine}, {p.suburb}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {lockedJobId === undefined &&
              choices &&
              choices.today.length + choices.past.length > 0 && (
                <label className="mt-4 flex flex-col gap-1.5">
                  <span className="section-label">Visit</span>
                  <select
                    value={visitId}
                    disabled={!hydrated}
                    onChange={(e) =>
                      setChoice({ propertyId, visitId: e.target.value })
                    }
                    className={`${FIELD} w-full`}
                  >
                    <option value="">Not for a visit</option>
                    {choices.today.length > 0 && (
                      <optgroup label="Today">
                        {choices.today.map((visit) => (
                          <option key={visit._id} value={visit._id}>
                            {visitLabel(visit)}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {choices.past.length > 0 && (
                      <optgroup label="Earlier">
                        {choices.past.map((visit) => (
                          <option key={visit._id} value={visit._id}>
                            {visitLabel(visit)}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                  <span className="text-caption text-muted">
                    The report takes its date, technician and weather from
                    the visit.
                  </span>
                </label>
              )}

            <div className="mt-5 flex flex-col gap-2.5">
              {templates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  disabled={create.isPending || !hydrated || visitsPending}
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
                  {suggestionFor(template.id) && (
                    <p className="mt-1 text-caption font-semibold text-ink">
                      Suggested for{' '}
                      {suggestionFor(template.id)?.services.join(', ')}
                    </p>
                  )}
                  <p className="mt-1 text-body text-muted">{template.blurb}</p>
                </button>
              ))}
            </div>

            {/* Said where the tap was: a refusal used to re-enable the
                button and nothing more. */}
            <FormAlert
              className="mt-3"
              error={create.isError ? create.error : null}
              copy={{
                NOT_FOUND:
                  'Could not start the report: that visit or address has changed. Choose the visit again.',
                TEMPLATE_ARCHIVED:
                  'Could not start the report: that template has been archived.',
                offline:
                  'Could not start the report: this device is offline. Try again when you have signal.',
                default:
                  'Could not start the report. Check your signal and try again.',
              }}
            />

            {activeCustomTemplates.length > 0 && (
              <>
                <h2 className="section-label mt-6 mb-2">Custom</h2>
                <div className="flex flex-col gap-2.5">
                  {activeCustomTemplates.map((template) => (
                    <button
                      key={template._id}
                      type="button"
                      disabled={
                        create.isPending || !hydrated || visitsPending
                      }
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
                      <p className="mt-1 text-body text-muted">{template.blurb}</p>
                    </button>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>

      <NewPropertySheet
        businessId={business._id}
        open={newClientOpen}
        onClose={() => setNewClientOpen(false)}
      />
    </>
  )
}

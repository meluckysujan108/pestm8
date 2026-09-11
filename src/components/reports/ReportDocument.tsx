import { useQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { Lock } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { BoilerplateBlock } from './BoilerplateBlock'
import { DurableNoticePreview } from './DurableNoticePreview'
import { durableNoticeText, fieldsOf, sectionsOf } from '#/lib/reportTemplates'
import { present } from '#/lib/reportTemplates/present'
import { visibleSections } from '#/lib/reportTemplates/visibility'
import { resolveReportTemplate } from '#/lib/reportTemplates/resolve'
import type { Presented } from '#/lib/reportTemplates/present'
import type { ReportTemplate, TemplateId } from '#/lib/reportTemplates'
import type { CustomTemplateShape } from '#/lib/reportTemplates/resolve'
import type { Id } from '../../../convex/_generated/dataModel'

type ReportDoc = {
  _id: Id<'reports'>
  template: TemplateId | 'custom'
  customTemplate?: CustomTemplateShape | null
  legalBasis: string
  status: string
  finalisedAt?: number
  data: unknown
  businessName: string
  property: {
    client: { name: string } | null
    addressLine: string
    suburb: string
    state: string
    postcode: string
  } | null
  author?: { licenceNumber?: string } | null
  pdfUrl?: string | null
}

/** The rendered document a client actually receives. */
export function ReportDocument({
  report,
  businessId,
}: {
  report: ReportDoc
  businessId: Id<'businesses'>
}) {
  const template = resolveReportTemplate({
    template: report.template,
    customTemplate: report.customTemplate,
  })
  const data = (report.data ?? {}) as Record<string, unknown>
  const finalised = report.status === 'finalised'

  const noticeText =
    report.template === 'termiteManagementCert' && report.property
      ? durableNoticeText({
          businessName: report.businessName,
          licenceNumber: report.author?.licenceNumber,
          systemType: String(data.systemType ?? '—'),
          product: String(data.product ?? '—'),
          apvmaNumber: String(data.apvmaNumber ?? '—'),
          installDate: String(data.installDate ?? '—'),
          lifeExpectancy: String(data.lifeExpectancy ?? '—'),
          reinspectionInterval: String(data.reinspectionInterval ?? '—'),
          addressLine: report.property.addressLine,
          suburb: report.property.suburb,
        })
      : null

  return (
    <article className="px-4 pt-4 pb-8">
      <p className="section-label">{report.legalBasis}</p>
      <h1 className="mt-1 text-page-title text-ink">{template.name}</h1>

      <span
        className={`mt-2 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-semibold ${
          finalised
            ? 'bg-green/12 text-green'
            : 'border border-amber-line bg-amber-bg text-amber-ink'
        }`}
      >
        {finalised && <Lock size={11} strokeWidth={2.4} />}
        {finalised ? 'Finalised and locked' : 'Draft — read only'}
      </span>

      {report.property && (
        <section className="mt-6">
          <h2 className="section-label mb-2">Property</h2>
          <div className="rounded-2xl border border-hairline bg-surface p-3.5 shadow-elevation">
            <p className="text-row-title text-ink">
              {report.property.client?.name}
            </p>
            {/* Legal documents carry the full street address, always. */}
            <p className="text-body text-ink-2">
              {report.property.addressLine}
            </p>
            <p className="text-body text-muted">
              {report.property.suburb} {report.property.state}{' '}
              {report.property.postcode}
            </p>
          </div>
        </section>
      )}

      {visibleSections(sectionsOf(template), data).map((section) => (
        <section key={section.title} className="mt-6">
          <h2 className="section-label mb-2">
            {section.number ? `${section.number}. ` : ''}
            {section.title}
          </h2>
          {section.preamble && (
            <p className="mb-2 text-caption text-muted">{section.preamble}</p>
          )}
          <dl className="divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation">
            {section.fields
              .map((field) => ({
                field,
                shown: present(field, data[field.key]),
              }))
              // `omit` covers the kinds that belong to another section — photos
              // have their own gallery below, and a bare labelled row here would
              // read as a field the technician forgot to fill in.
              .filter(({ shown }) => shown.kind !== 'omit')
              .map(({ field, shown }) => (
                <div key={field.key} className="px-3.5 py-3">
                  <dt className="section-label">{field.label}</dt>
                  <dd className="mt-1 text-body text-ink">
                    <FieldValue shown={shown} />
                  </dd>
                </div>
              ))}
          </dl>
        </section>
      ))}

      <ReportPhotos businessId={businessId} reportId={report._id} />
      <ReportGallery
        businessId={businessId}
        reportId={report._id}
        template={template}
      />

      {noticeText && <DurableNoticePreview text={noticeText} />}

      <BoilerplateBlock text={template.boilerplate} />

      {finalised && report.finalisedAt && (
        <p className="mt-4 text-caption text-muted">
          Finalised{' '}
          {new Intl.DateTimeFormat('en-AU', {
            dateStyle: 'long',
            timeStyle: 'short',
          }).format(new Date(report.finalisedAt))}
          . This document can no longer be edited.
        </p>
      )}
    </article>
  )
}

/**
 * Photos are part of the evidence, so a finished report has to show them
 * rather than only referencing that some exist.
 */
function ReportPhotos({
  businessId,
  reportId,
}: {
  businessId: Id<'businesses'>
  reportId: string
}) {
  const { data: urls } = useQuery(
    convexQuery(api.reports.photoUrls, {
      businessId,
      reportId: reportId as Id<'reports'>,
    }),
  )

  const entries = Object.entries((urls as Record<string, string>) ?? {})
  if (entries.length === 0) return null

  return (
    <section className="mt-6">
      <h2 className="section-label mb-2">Photos</h2>
      <div className="grid grid-cols-2 gap-2">
        {entries.map(([slot, url]) => (
          <figure
            key={slot}
            className="overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation"
          >
            <img src={url} alt={slot} className="h-32 w-full object-cover" />
            <figcaption className="px-2.5 py-1.5 text-caption text-muted">
              {slot}
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  )
}

/**
 * `gallery` fields, grouped and labelled by which field they belong to — a
 * report can have more than one (a cover photo and a general set), and a
 * client reading the finished document needs to know which is which.
 */
function ReportGallery({
  businessId,
  reportId,
  template,
}: {
  businessId: Id<'businesses'>
  reportId: string
  template: ReportTemplate
}) {
  const { data } = useQuery(
    convexQuery(api.reports.galleryPhotos, {
      businessId,
      reportId: reportId as Id<'reports'>,
    }),
  )

  const photos = data ?? []
  if (photos.length === 0) return null

  const labelFor = new Map(
    fieldsOf(template)
      .filter((field) => field.kind === 'gallery')
      .map((field) => [field.key, field.label] as const),
  )

  const byField = new Map<string, typeof photos>()
  for (const photo of photos) {
    const group = byField.get(photo.fieldKey) ?? []
    group.push(photo)
    byField.set(photo.fieldKey, group)
  }

  return (
    <>
      {[...byField.entries()].map(([fieldKey, group]) => (
        <section key={fieldKey} className="mt-6">
          <h2 className="section-label mb-2">
            {labelFor.get(fieldKey) ?? 'Photos'}
          </h2>
          <div className="grid grid-cols-2 gap-2">
            {group.map((photo) => (
              <figure
                key={photo._id}
                className="overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation"
              >
                {photo.url && (
                  <img
                    src={photo.url}
                    alt={photo.caption || labelFor.get(fieldKey) || 'Photo'}
                    className="h-32 w-full object-cover"
                  />
                )}
                {(photo.caption || photo.isCover) && (
                  <figcaption className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-caption text-muted">
                    <span className="truncate">{photo.caption}</span>
                    {photo.isCover && (
                      <span className="shrink-0 font-semibold text-amber-ink">
                        Cover
                      </span>
                    )}
                  </figcaption>
                )}
              </figure>
            ))}
          </div>
        </section>
      ))}
    </>
  )
}

/** Named so a client can tell two reports apart in their downloads folder. */
export function pdfFileName(shortName: string, addressLine?: string): string {
  const place = (addressLine ?? 'report')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${shortName.toLowerCase()}-${place}.pdf`
}

/**
 * Paints what `present()` decided. It knows the four shapes a value can take,
 * never the field kinds behind them — so a new kind reaches the document
 * without this component changing.
 */
function FieldValue({ shown }: { shown: Presented }) {
  switch (shown.kind) {
    case 'omit':
      return null

    case 'blank':
      return <span className="text-muted">—</span>

    case 'pairs':
      return (
        <span className="flex flex-col gap-1">
          {shown.pairs.map((pair) => (
            <span key={pair.label} className="flex justify-between gap-3">
              <span>{pair.label}</span>
              <span
                className={
                  pair.tone === 'warn' ? 'text-amber-ink' : 'text-ink-2'
                }
              >
                {pair.value}
              </span>
            </span>
          ))}
        </span>
      )

    case 'grid':
      return (
        <span className="-mx-1 block overflow-x-auto">
          <table className="w-full text-left text-caption">
            <thead>
              <tr className="border-b border-hairline">
                {shown.columns.map((column) => (
                  <th
                    key={column}
                    className="px-1 pb-1 font-semibold text-muted"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.rows.map((row, i) => (
                <tr
                  key={i}
                  className="border-b border-hairline-2 last:border-0"
                >
                  {row.map((cell, j) => (
                    <td key={j} className="px-1 py-1.5 align-top text-ink-2">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </span>
      )

    case 'text':
      return (
        <span className={shown.preserveWhitespace ? 'whitespace-pre-wrap' : ''}>
          {shown.text}
        </span>
      )

    default: {
      // Without this, a new `Presented` variant renders as nothing at all —
      // silently dropping a field off a signed document. Fail at build instead.
      const _exhaustive: never = shown
      void _exhaustive
      return null
    }
  }
}

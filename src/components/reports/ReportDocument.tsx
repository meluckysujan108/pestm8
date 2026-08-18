import { useQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { Lock } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { DownloadPdfButton } from './DownloadPdfButton'
import { BoilerplateBlock } from './BoilerplateBlock'
import { DurableNoticePreview } from './DurableNoticePreview'
import { durableNoticeText, getTemplate } from '#/lib/reportTemplates'
import type { AreaResult, FieldDef, TemplateId } from '#/lib/reportTemplates'
import type { Id } from '../../../convex/_generated/dataModel'

type ReportDoc = {
  _id: string
  template: string
  legalBasis: string
  status: string
  finalisedAt?: number
  data: unknown
  businessName: string
  property: {
    clientName: string
    addressLine: string
    suburb: string
    state: string
    postcode: string
  } | null
  author?: { licenceNumber?: string } | null
}

/** The rendered document a client actually receives. */
export function ReportDocument({
  report,
  businessId,
}: {
  report: ReportDoc
  businessId: Id<'businesses'>
}) {
  const template = getTemplate(report.template as TemplateId)
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
              {report.property.clientName}
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

      <section className="mt-6">
        <h2 className="section-label mb-2">Details</h2>
        <dl className="divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation">
          {template.fields
            .filter((f) => f.kind !== 'photos')
            .map((field) => (
              <div key={field.key} className="px-3.5 py-3">
                <dt className="section-label">{field.label}</dt>
                <dd className="mt-1 text-body text-ink">
                  <FieldValue field={field} value={data[field.key]} />
                </dd>
              </div>
            ))}
        </dl>
      </section>

      <ReportPhotos businessId={businessId} reportId={report._id} />

      {noticeText && <DurableNoticePreview text={noticeText} />}

      <BoilerplateBlock text={template.boilerplate} />

      {/* Export only from a locked document: a PDF of a draft would circulate
          as though it were the finished record. */}
      {finalised && (
        <DownloadPdfButton
          fileName={pdfFileName(
            template.shortName,
            report.property?.addressLine,
          )}
          report={{
            template: report.template,
            legalBasis: report.legalBasis,
            finalisedAt: report.finalisedAt,
            data,
            businessName: report.businessName,
            property: report.property,
            licenceNumber: report.author?.licenceNumber,
          }}
        />
      )}

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

/** Named so a client can tell two reports apart in their downloads folder. */
function pdfFileName(shortName: string, addressLine?: string): string {
  const place = (addressLine ?? 'report')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${shortName.toLowerCase()}-${place}.pdf`
}

function FieldValue({ field, value }: { field: FieldDef; value: unknown }) {
  if (value === undefined || value === '' || value === null) {
    return <span className="text-muted">—</span>
  }

  // Stored values are codes; the document must read as prose. "chemical" and
  // "12" mean nothing to a client or an inspector — "Chemical soil barrier"
  // and "12 months" are the actual content of the certificate.
  if (field.kind === 'select') {
    const option = field.options.find((o) => o.value === String(value))
    return <span>{option?.label ?? String(value)}</span>
  }

  if (field.kind === 'chips' && Array.isArray(value)) {
    const labels = value.map(
      (v) => field.options.find((o) => o.value === v)?.label ?? String(v),
    )
    return <span>{labels.join(', ')}</span>
  }

  if (field.kind === 'areas' && typeof value === 'object') {
    const areas = value as Record<string, AreaResult>
    return (
      <span className="flex flex-col gap-1">
        {/* Template order, not storage order — Convex returns object keys
            sorted, which would list the areas alphabetically. */}
        {field.rows.map((row) => {
          const result = areas[row] ?? { status: 'inspected' as const }
          return (
            <span key={row} className="flex justify-between gap-3">
              <span>{row}</span>
              <span
                className={
                  result.status === 'inspected'
                    ? 'text-ink-2'
                    : 'text-amber-ink'
                }
              >
                {result.status === 'inspected'
                  ? 'Inspected'
                  : `No access — ${result.reason}`}
              </span>
            </span>
          )
        })}
      </span>
    )
  }

  return <span className="whitespace-pre-wrap">{String(value)}</span>
}

import { useQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { Lock } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { BoilerplateBlock } from './BoilerplateBlock'
import { DurableNoticePreview } from './DurableNoticePreview'
import { RichTextView } from './RichText'
import {
  coverFieldKeys,
  durableNoticeText,
  fieldsOf,
  coverPhotoOf,
  printHeadingOf,
  printedGalleryKeys,
  printsDurableNotice,
  sectionRuns,
  sectionsOf,
} from '#/lib/reportTemplates'
import { present } from '#/lib/reportTemplates/present'
import { visibleSections } from '#/lib/reportTemplates/visibility'
import { resolveReportTemplate } from '#/lib/reportTemplates/resolve'
import type { PresentContext, Presented } from '#/lib/reportTemplates/present'
import type {
  FieldDef,
  ReportTemplate,
  StaticBlockField,
  TemplateId,
} from '#/lib/reportTemplates'
import type { CustomTemplateShape } from '#/lib/reportTemplates/resolve'
import type { OptionSetOverrides } from '#/lib/reportTemplates/optionSets'
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
  templateVersion?: number
  /** The frozen wording, once this report is signed. See `reports.get`. */
  templateSnapshot?: CustomTemplateShape | null
  optionSets?: OptionSetOverrides | null
  /** The records this document prints from without asking. */
  context?: PresentContext | null
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
    templateVersion: report.templateVersion,
    customTemplate: report.customTemplate,
    templateSnapshot: report.templateSnapshot,
    // Only a draft carries these; a finalised report's lists are frozen.
    optionSets: report.optionSets,
  })
  const data = (report.data ?? {}) as Record<string, unknown>
  // The answers ride along so a row bound to a member field can see who was
  // chosen there.
  const context = report.context ? { ...report.context, answers: data } : undefined
  const finalised = report.status === 'finalised'

  const noticeText =
    printsDurableNotice(template) && report.property
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
      <CoverPhoto
        businessId={businessId}
        reportId={report._id}
        template={template}
        answers={data}
      />
      {template.print?.headings?.length ? (
        // The form's own header lines stand in for the app's picker name, which
        // would otherwise repeat the title directly above them.
        <h1 className="sr-only">{template.name}</h1>
      ) : (
        <h1 className="mt-1 text-page-title text-ink">{template.name}</h1>
      )}
      {/* The form's own header lines and standards reference, verbatim. */}
      {template.print?.headings?.map((line) => (
        <p key={line} className="mt-1 text-subhead font-semibold text-ink">
          {line}
        </p>
      ))}
      {template.print?.standardsLine && (
        <p className="mt-1 text-caption text-muted">
          {template.print.standardsLine}
        </p>
      )}

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

      {/* A verbatim form prints the client and site in its own first section;
          this card would repeat them. */}
      {report.property && !template.print && (
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
          {/* The heading the client received. This is the finished document,
              not the form — the builder keeps showing the section's own title
              so a technician can find where they are. */}
          {printHeadingOf(section) !== null && (
            <h2 className="section-label mb-2">
              {/* A form that prints its headings unnumbered keeps its numbers
                  on screen only. */}
              {section.number && template.print?.numbering !== 'unnumbered'
                ? `${section.number}. `
                : ''}
              {printHeadingOf(section)}
            </h2>
          )}
          {section.preamble && (
            <p className="mb-2 text-caption text-muted">{section.preamble}</p>
          )}
          {sectionRuns(section.fields, {
            allFields: fieldsOf(template),
            data,
            inlineGalleries: Boolean(template.print),
          }).map((run, runIndex) =>
            run.type === 'block' ? (
              <StaticBlockView key={run.field.key} field={run.field} />
            ) : run.type === 'gallery' ? (
              <GalleryGroup
                key={run.field.key}
                businessId={businessId}
                reportId={report._id}
                fieldKey={run.field.key}
                label={run.field.label}
              />
            ) : (
              <SectionRows
                key={`rows-${runIndex}`}
                fields={run.fields}
                data={data}
                context={context}
                sectionHeading={printHeadingOf(section)}
                // A draft shows the dash so the technician can see what is
                // still open; the signed document leaves it out.
                omitEmpty={finalised && template.print?.omitEmpty === true}
              />
            ),
          )}
        </section>
      ))}

      <ReportPhotos businessId={businessId} reportId={report._id} />
      <ReportGallery
        businessId={businessId}
        reportId={report._id}
        template={template}
        data={data}
      />

      {noticeText && <DurableNoticePreview text={noticeText} />}

      <BoilerplateBlock
        text={template.boilerplate}
        terms={template.terms}
        heading={template.print?.termsHeading}
      />

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
/**
 * One photo set, shown inside its section on a verbatim form. Shares its query
 * with every other set on the page, so a Timber report's seven sets are one
 * subscription, not seven.
 */
function GalleryGroup({
  businessId,
  reportId,
  fieldKey,
  label,
}: {
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
  fieldKey: string
  label: string
}) {
  const { data } = useQuery(
    convexQuery(api.reports.galleryPhotos, { businessId, reportId }),
  )
  const photos = (data ?? []).filter((photo) => photo.fieldKey === fieldKey)
  if (photos.length === 0) return null
  return (
    <div className="mt-3">
      <p className="section-label mb-2">{label}</p>
      <div className="grid grid-cols-2 gap-2">
        {photos.map((photo) => (
          <figure
            key={photo._id}
            className="overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation"
          >
            {photo.url && (
              <img
                src={photo.url}
                alt={photo.caption || label}
                className="h-32 w-full object-cover"
              />
            )}
            {photo.caption && (
              <figcaption className="truncate px-2.5 py-1.5 text-caption text-muted">
                {photo.caption}
              </figcaption>
            )}
          </figure>
        ))}
      </div>
    </div>
  )
}

/**
 * The front-page photo a `cover` field holds, at the top of the document as it
 * opens the PDF. Without it the photo the technician took for the front page
 * appears nowhere on screen.
 */
function CoverPhoto({
  businessId,
  reportId,
  template,
  answers,
}: {
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
  template: ReportTemplate
  answers: Record<string, unknown>
}) {
  const { data } = useQuery(
    convexQuery(api.reports.galleryPhotos, { businessId, reportId }),
  )
  const cover = coverPhotoOf(
    template,
    data ?? [],
    printedGalleryKeys(sectionsOf(template), answers),
  )
  if (!cover?.url) return null
  return (
    <img
      src={cover.url}
      alt={cover.caption || 'Front page photo'}
      className="mt-4 aspect-[4/3] w-full rounded-2xl border border-hairline bg-surface object-contain"
    />
  )
}

function ReportGallery({
  businessId,
  reportId,
  template,
  data: answers,
}: {
  businessId: Id<'businesses'>
  reportId: string
  template: ReportTemplate
  data: Record<string, unknown>
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

  // A cover photo opens the document. Printing it again down here, captioned
  // "Cover", is the same image twice for the client and one more thing for the
  // technician to wonder about.
  const coverKeys = coverFieldKeys(template)
  // Only photo sets whose question is showing; a verbatim form has already
  // shown its sets inside their sections.
  const printable = printedGalleryKeys(sectionsOf(template), answers)
  const inline = Boolean(template.print)

  const byField = new Map<string, typeof photos>()
  for (const photo of photos) {
    if (coverKeys.has(photo.fieldKey)) continue
    if (inline && labelFor.has(photo.fieldKey)) continue
    if (labelFor.has(photo.fieldKey) && !printable.has(photo.fieldKey)) continue
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
 * One card of answers. Nothing here knows a field kind — `present()` decided
 * that already — so this is only the framing a run of values shares.
 */
function SectionRows({
  fields,
  data,
  context,
  sectionHeading,
  omitEmpty = false,
}: {
  fields: Array<FieldDef>
  data: Record<string, unknown>
  context?: PresentContext
  sectionHeading?: string | null
  omitEmpty?: boolean
}) {
  const rows = fields
    .map((field) => ({ field, shown: present(field, data[field.key], context) }))
    // `omit` covers the kinds that belong to another section — photos have
    // their own gallery below, and a bare labelled row here would read as a
    // field the technician forgot to fill in.
    .filter(({ shown }) => shown.kind !== 'omit')
    .filter(({ shown }) => !(omitEmpty && shown.kind === 'blank'))

  // A section can be all notes and photos. An empty card is a card that says
  // the technician skipped something.
  if (rows.length === 0) return null

  return (
    <dl className="mt-2 divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation first:mt-0">
      {rows.map(({ field, shown }) => (
        <div key={field.key} className="px-3.5 py-3">
          {/* A table whose caption is the section heading itself (the treatment
              grid) is not captioned twice. */}
          {/* Also when there is nothing in it yet: an unanswered table in a read-only
              draft is still captioned by the heading right above it. */}
          {!(
            (shown.kind === 'grid' || shown.kind === 'blank') &&
            field.kind === 'repeater' &&
            field.label === sectionHeading
          ) && (
            <dt className="section-label">{field.label}</dt>
          )}
          <dd className="mt-1 text-body text-ink">
            <FieldValue shown={shown} />
          </dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * A note or a sub-heading: printed content that asks nothing. Full width, and
 * without the field label — that label is the author's name for the block, not
 * something the client should ever read.
 */
function StaticBlockView({ field }: { field: StaticBlockField }) {
  if (field.kind === 'heading') {
    return (
      <div className="mt-4 first:mt-0">
        <h3 className="text-body font-semibold text-ink">{field.text}</h3>
        {field.note && (
          <p className="mt-0.5 text-caption text-muted">{field.note}</p>
        )}
      </div>
    )
  }

  const tone = field.tone ?? 'note'
  return (
    <div
      className={`mt-3 rounded-2xl border px-3.5 py-3 first:mt-0 ${
        tone === 'important'
          ? 'border-red/30 bg-red/5'
          : tone === 'warning'
            ? 'border-amber/30 bg-amber/5'
            : 'border-hairline bg-surface-2'
      }`}
    >
      {field.heading && (
        <p className="text-subhead font-semibold text-ink">
          {tone === 'important' ? `IMPORTANT: ${field.heading}` : field.heading}
        </p>
      )}
      <RichTextView
        doc={field.body}
        className={`text-body text-ink-2 ${tone === 'statement' ? 'italic' : ''}`}
      />
    </div>
  )
}

/**
 * Paints what `present()` decided. It knows the shapes a value can take, never
 * the field kinds behind them — so a new kind reaches the document without this
 * component changing.
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
                  <th key={column} className="px-1 pb-1 font-semibold text-muted">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.rows.map((row, i) => (
                <tr key={i} className="border-b border-hairline-2 last:border-0">
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

    case 'lines':
      return (
        <span className="flex flex-col">
          {shown.lines.map((line, i) => (
            <span key={i}>{line}</span>
          ))}
        </span>
      )

    case 'rich':
      return <RichTextView doc={shown.doc} />

    case 'image':
      return (
        <span className="flex flex-col gap-1">
          <img
            src={shown.url}
            alt={shown.caption ?? ''}
            className="h-24 w-auto max-w-full rounded-xl border border-hairline bg-surface object-contain"
          />
          {shown.caption && (
            <span className="text-caption text-muted">{shown.caption}</span>
          )}
        </span>
      )

    case 'text':
      return (
        <span
          className={[
            shown.preserveWhitespace ? 'whitespace-pre-wrap' : '',
            shown.tone === 'warn' ? 'text-amber-ink' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
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

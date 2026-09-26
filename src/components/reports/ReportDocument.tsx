import { useQuery } from '@tanstack/react-query'
import { REPORT_PILL } from '#/lib/statusColours'
import { convexQuery } from '@convex-dev/react-query'
import { Lock } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { DurableNoticePreview } from './DurableNoticePreview'
import { RichTextView } from './RichText'
import { buildReportModel } from '#/lib/reportTemplates/documentModel'
import { resolveReportTemplate } from '#/lib/reportTemplates/resolve'
import type {
  DocBar,
  DocBlock,
  DocPhoto,
  DocRow,
  DocSection,
  ReportModel,
} from '#/lib/reportTemplates/documentModel'
import type { PresentContext, Presented } from '#/lib/reportTemplates/present'
import type { TemplateId } from '#/lib/reportTemplates'
import type { CustomTemplateShape } from '#/lib/reportTemplates/resolve'
import type { OptionSetOverrides } from '#/lib/reportTemplates/optionSets'
import type { TemplateSettings } from '#/lib/reportTemplates/settings'
import type { Id } from '../../../convex/_generated/dataModel'
import { useBusinessTimezone } from '#/lib/useBusinessTimezone'
import { dateTimeFormat } from '../../../convex/lib/dates'

/**
 * The finished document, on screen.
 *
 * The twin of `pdf/ReportPdf.tsx`, and deliberately a twin only in the paint:
 * both read one `buildReportModel()`, so what prints, under which heading, in
 * what order and with what value is decided once. This file used to decide all
 * of that for itself, seven hundred lines of it, beside seven hundred more
 * doing the same thing for the PDF — and the drift between them is invisible
 * until a client reads a PDF that disagrees with the screen it was approved on.
 */

type ReportDoc = {
  _id: Id<'reports'>
  template: TemplateId | 'custom'
  customTemplate?: CustomTemplateShape | null
  legalBasis: string
  status: string
  finalisedAt?: number
  reportNumber?: number
  /** Which issue of that number this is — amendments, not resubmissions. */
  version?: number
  data: unknown
  businessName: string
  business?: {
    tradingName?: string
    brandName?: string
    website?: string
    phone?: string
    email?: string
    logoUrl?: string | null
    licenceNumber?: string
  } | null
  property: {
    client: { name: string } | null
    addressLine: string
    suburb: string
    state: string
    postcode: string
  } | null
  author?: { name?: string; licenceNumber?: string } | null
  pdfUrl?: string | null
  templateVersion?: number
  /** The frozen wording, once this report is signed. See `reports.get`. */
  templateSnapshot?: CustomTemplateShape | null
  optionSets?: OptionSetOverrides | null
  settings?: TemplateSettings | null
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
  const timezone = useBusinessTimezone()
  const template = resolveReportTemplate({
    template: report.template,
    templateVersion: report.templateVersion,
    customTemplate: report.customTemplate,
    templateSnapshot: report.templateSnapshot,
    // Only a draft carries these; a finalised report's lists and its chrome
    // were frozen with its wording.
    optionSets: report.optionSets,
    settings: report.settings,
  })

  // Photos live in their own table rather than in the answers, so the document
  // has to ask for them. One subscription each, shared by every set on the
  // page: a Timber report has seven.
  const { data: galleryPhotos } = useQuery(
    convexQuery(api.reports.galleryPhotos, {
      businessId,
      reportId: report._id,
    }),
  )
  const { data: slotPhotos } = useQuery(
    convexQuery(api.reports.photoUrls, { businessId, reportId: report._id }),
  )

  const finalised = report.status === 'finalised'
  const model = buildReportModel({
    template,
    data: (report.data ?? {}) as Record<string, unknown>,
    context: report.context,
    business: {
      name: report.businessName,
      tradingName: report.business?.tradingName,
      brandName: report.business?.brandName,
      website: report.business?.website,
      phone: report.business?.phone,
      email: report.business?.email,
      logoUrl: report.business?.logoUrl,
      licenceNumber: report.business?.licenceNumber,
    },
    property: report.property,
    slotPhotos: slotPhotos as Record<string, string> | undefined,
    galleryPhotos,
    submittedBy: report.author?.name,
    finalisedAt: report.finalisedAt,
    reportNumber: report.reportNumber,
    version: report.version,
    finalised,
    licenceNumber: report.author?.licenceNumber,
  })

  return (
    // Pinned light in both themes. What this shows must match what
    // reports/pdf/* prints on white paper, so it does not follow the app.
    // data-theme re-declares the light palette for this subtree — the same
    // rule that themes the document root; see src/styles.css.
    <article data-theme="light" className="bg-canvas px-4 pb-8 pt-4 text-ink">
      <p className="section-label">{report.legalBasis}</p>

      {model.cover?.photo && (
        <img
          src={model.cover.photo.url}
          alt={model.cover.photo.caption || 'Front page photo'}
          className="mt-3 w-full rounded-2xl border border-hairline bg-surface object-cover"
          style={{ aspectRatio: '16 / 7' }}
        />
      )}

      {model.headings.length > 0 ? (
        <>
          {/* The form's own header lines stand in for the app's picker name,
              which would otherwise print the title twice. */}
          <h1 className="sr-only">{template.name}</h1>
          {model.headings.map((line) => (
            <p key={line} className="mt-1 text-row-title text-ink">
              {line}
            </p>
          ))}
        </>
      ) : (
        <h1 className="mt-1 text-page-title text-ink">{template.name}</h1>
      )}
      {model.standardsLine && (
        <p className="mt-1 text-caption text-muted">{model.standardsLine}</p>
      )}

      <span
        className={`mt-2 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-semibold ${finalised ? REPORT_PILL.finalised : REPORT_PILL.draft}`}
      >
        {finalised && <Lock size={11} strokeWidth={2.4} />}
        {finalised ? 'Finalised and locked' : 'Draft — read only'}
      </span>

      {model.titleBand && (
        // The PDF's title band, drawn as it prints (brand red).
        // eslint-disable-next-line no-restricted-syntax -- mirrors the PDF
        <div className="mt-4 flex items-stretch overflow-hidden rounded-xl bg-red text-white">
          <p className="flex-1 px-3 py-2 text-body font-semibold">
            {model.titleBand.text}
          </p>
          {model.titleBand.date && (
            <p className="border-l border-white/40 px-3 py-2 text-body font-semibold">
              {model.titleBand.date}
            </p>
          )}
        </div>
      )}

      {model.sections.map((section) => (
        <Section key={section.key} section={section} />
      ))}

      {model.photoGroups.map((group) => (
        <section key={group.key} className="mt-6">
          <h2 className="section-label mb-2">{group.label}</h2>
          <PhotoGrid photos={group.photos} label={group.label} />
        </section>
      ))}

      {model.notice && <DurableNoticePreview text={model.notice} />}

      {model.terms && (
        <section className="mt-6">
          <h2 className="section-label mb-2">
            {model.terms.heading ?? 'Standard terms — not editable'}
          </h2>
          <div className="rounded-2xl border border-hairline bg-surface-2 px-3.5 py-3">
            <RichTextView
              doc={model.terms.doc}
              className="text-body text-ink-2"
            />
          </div>
        </section>
      )}

      {model.legacyTerms.length > 0 && (
        <section className="mt-6">
          <h2 className="section-label mb-2">Standard terms — not editable</h2>
          <div className="rounded-2xl border border-hairline bg-surface-2 px-3.5 py-3">
            {model.legacyTerms.map((paragraph, index) => (
              <p key={index} className="mb-2 text-body text-ink-2 last:mb-0">
                {paragraph}
              </p>
            ))}
          </div>
        </section>
      )}

      {/* The same provenance the printed footer carries, so the screen and the
          file a client keeps identify the document the same way. */}
      {finalised && report.finalisedAt && (
        <p className="mt-6 text-caption text-muted">
          {model.footer.submittedBy
            ? `Submitted by: ${model.footer.submittedBy}`
            : `Finalised ${dateTimeFormat('en-AU', { dateStyle: 'long', timeZone: timezone }).format(new Date(report.finalisedAt))}`}
          {model.footer.submissionId !== undefined &&
            ` · Submission ID: ${model.footer.submissionId}`}
          {` · Version: ${model.footer.version}`}
          <br />
          This document can no longer be edited.
        </p>
      )}
    </article>
  )
}

function Section({ section }: { section: DocSection }) {
  return (
    <section className="mt-6">
      {/* The heading the client received. This is the finished document, not
          the form — the builder keeps showing the section's own title so a
          technician can find where they are. */}
      {section.heading !== null && (
        <h2 className="section-label mb-2">
          {section.number !== undefined ? `${section.number}. ` : ''}
          {section.heading}
        </h2>
      )}
      {section.preamble && (
        <p className="mb-2 text-caption text-muted">{section.preamble}</p>
      )}
      {section.blocks.map((block) => (
        <Block key={block.key} block={block} />
      ))}
    </section>
  )
}

const BAR_CLASS: Record<DocBar, string> = {
  good: 'bg-green',
  warn: 'bg-amber-ink',
  danger: 'bg-red',
}

function Block({ block }: { block: DocBlock }) {
  switch (block.type) {
    case 'rows':
      return (
        <dl className="mt-2 divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation first:mt-0">
          {block.rows.map((row) => (
            <Row key={row.key} row={row} />
          ))}
        </dl>
      )

    case 'heading':
      return (
        <div className="mt-4 first:mt-0">
          <h3 className="text-body font-semibold text-red">{block.text}</h3>
          {block.note && (
            <p className="mt-0.5 text-caption text-muted">{block.note}</p>
          )}
        </div>
      )

    case 'note': {
      const tone = block.tone
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
          {block.heading && (
            <p className="text-body font-semibold text-ink">
              {tone === 'important'
                ? `IMPORTANT: ${block.heading}`
                : block.heading}
            </p>
          )}
          <RichTextView
            doc={block.doc}
            className={`text-body text-ink-2 ${tone === 'statement' ? 'italic' : ''}`}
          />
        </div>
      )
    }

    case 'table':
      return (
        <div className="mt-2 overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation first:mt-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-caption">
              <thead>
                {/* eslint-disable-next-line no-restricted-syntax -- mirrors the PDF's table header */}
                <tr className="bg-red text-white">
                  {block.columns.map((column) => (
                    <th
                      key={column.label}
                      className="px-2.5 py-2 font-semibold"
                      style={{ width: `${column.width}%` }}
                    >
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, index) => (
                  <tr
                    key={index}
                    className="border-b border-hairline-2 last:border-0"
                  >
                    {row.map((cell, cellIndex) => (
                      <td
                        key={cellIndex}
                        className="px-2.5 py-2 align-top text-ink-2"
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )

    case 'photos':
      return (
        <div className="mt-3">
          <h3 className="section-label mb-2">{block.label}</h3>
          <PhotoGrid photos={block.photos} label={block.label} />
        </div>
      )

    default: {
      // Without this a new block renders as nothing at all, silently dropping
      // part of a signed document. Fail at build instead.
      const _exhaustive: never = block
      void _exhaustive
      return null
    }
  }
}

function Row({ row }: { row: DocRow }) {
  return (
    <div className="flex gap-2.5 px-3.5 py-3">
      {/* The same bar the printed document carries beside an answer that
          reports a state. */}
      {row.bar && (
        <span
          className={`mt-0.5 w-1 shrink-0 self-stretch rounded-full ${BAR_CLASS[row.bar]}`}
        />
      )}
      <div className="min-w-0 flex-1">
        <dt className="section-label">{row.label}</dt>
        <dd className="mt-1 text-body text-ink">
          <FieldValue shown={row.shown} />
        </dd>
      </div>
    </div>
  )
}

/** The photo's own aspect, for the browser to reserve space with. */
function aspectOf(photo: DocPhoto) {
  return photo.width && photo.height
    ? { aspectRatio: `${photo.width} / ${photo.height}` }
    : undefined
}

function PhotoGrid({
  photos,
  label,
}: {
  photos: Array<DocPhoto>
  label: string
}) {
  if (photos.length === 0) return null
  return (
    <div className="grid grid-cols-2 gap-2">
      {photos.map((photo) => (
        <figure
          key={photo.key}
          className="overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation"
        >
          <img
            src={photo.url}
            alt={photo.caption || label}
            // Its own shape where the app knows it, capped so one portrait
            // photo cannot fill the screen. Evidence is never centre-cropped:
            // the crop can remove the thing the photo was taken to show. A
            // photo with no recorded dimensions keeps the old fixed box rather
            // than having a shape guessed for it.
            style={aspectOf(photo)}
            className={
              photo.width && photo.height
                ? 'max-h-64 w-full bg-surface-2 object-contain'
                : 'h-32 w-full object-cover'
            }
          />
          {photo.caption && (
            <figcaption className="truncate px-2.5 py-1.5 text-caption text-muted">
              {photo.caption}
            </figcaption>
          )}
        </figure>
      ))}
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

    // Lifted out of the row flow by `buildReportModel` — a repeater becomes
    // its own table block — so this cannot be reached from a value cell.
    case 'grid':
      return null

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

export type { ReportModel }

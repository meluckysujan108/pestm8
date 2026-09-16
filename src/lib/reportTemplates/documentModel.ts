import { isFlagged } from './choices'
import {
  coverFieldKeys,
  coverPhotoOf,
  durableNoticeText,
  fieldsOf,
  printHeadingOf,
  printedGalleryKeys,
  printsDurableNotice,
  sectionRuns,
  sectionsOf,
} from './index'
import { present } from './present'
import { visibleSections } from './visibility'
import type { PresentContext, Presented } from './present'
import type { FieldDef, ReportTemplate, RichDoc } from './types'

/**
 * The finished document, as a value.
 *
 * Two painters draw this report — `ReportDocument` in the browser and
 * `ReportPdf` in a Convex Node action — and each of them used to decide for
 * itself which sections print, under which heading, whether an unanswered row
 * is omitted, where the photos go, which photo is the cover and what the
 * footer says. Around seven hundred lines each, agreeing by hand. The drift
 * that causes is invisible until a client reads a PDF that disagrees with the
 * screen it was approved on, which on a compliance record is the whole problem.
 *
 * So every rule lives here and the painters only paint. `present()` already
 * owns what a single ANSWER reads as; this owns what a DOCUMENT is made of.
 * It is pure, holds no React and no DOM, and takes its records as plain data,
 * so the PDF action, the browser and a vitest all build the identical model.
 */

/** A photo as the report's own table holds it, before the document places it. */
export type GalleryPhotoInput = {
  fieldKey: string
  caption?: string
  order: number
  isCover: boolean
  url: string | null
  width?: number
  height?: number
}

export type DocPhoto = {
  key: string
  url: string
  caption?: string
  /** As uploaded. Absent on photos taken before the app recorded it. */
  width?: number
  height?: number
}

/**
 * The coloured bar the source form draws beside an answer that reports a
 * state: green for a safety check that passed, amber for one that did not,
 * red for the one question the form makes a gate.
 */
export type DocBar = 'good' | 'warn' | 'danger'

export type DocRow = {
  key: string
  label: string
  shown: Presented
  bar?: DocBar
}

export type DocBlock =
  /** A run of labelled answers, drawn as one table. */
  | { type: 'rows'; key: string; rows: Array<DocRow> }
  /** A sub-heading inside a section, with the form's own note under it. */
  | { type: 'heading'; key: string; text: string; note?: string }
  | {
      type: 'note'
      key: string
      heading?: string
      tone: 'note' | 'important' | 'warning' | 'statement'
      doc: RichDoc
    }
  /** A repeater, drawn under column headings rather than as one long cell. */
  | {
      type: 'table'
      key: string
      label: string
      columns: Array<{ label: string; width: number }>
      rows: Array<Array<string>>
    }
  | { type: 'photos'; key: string; label: string; photos: Array<DocPhoto> }

export type DocSection = {
  key: string
  number?: number
  /** `null` when the form prints no heading here — see `printHeadingOf`. */
  heading: string | null
  preamble?: string
  blocks: Array<DocBlock>
}

export type DocumentIdentity = {
  /** The PDF's own Title metadata, and what a viewer names its tab. */
  title: string
  /** What the file is called when it lands in someone's Downloads. */
  fileName: string
  subject: string
}

export type ReportModel = {
  identity: DocumentIdentity
  cover: {
    title: string
    subtitle?: string
    address?: string
    date?: string
    photo?: DocPhoto
  } | null
  /** Repeated at the top of every page: the mark, then who issued this. */
  header: { logoUrl?: string; lines: Array<string> }
  /** The red band the Service Report carries above its first section. */
  titleBand: { text: string; date?: string } | null
  /** The AS forms' own header lines, printed instead of a title band. */
  headings: Array<string>
  standardsLine?: string
  sections: Array<DocSection>
  /** Photo sets a form does not place itself, printed after the sections. */
  photoGroups: Array<{ key: string; label: string; photos: Array<DocPhoto> }>
  /** The app's optional durable-notice extra, when a template opts in. */
  notice: string | null
  terms: { heading?: string; doc: RichDoc; onItsOwnPage: boolean } | null
  /** A v1 template's single prose block, split into paragraphs. */
  legacyTerms: Array<string>
  footer: {
    formName: string
    /** `Submitted by: Terence @ 11:35:53 28 Aug 2026`, the form's own label. */
    submittedBy?: string
    submissionId?: number
    version: number
  }
}

export type ReportRecord = {
  template: ReportTemplate
  data: Record<string, unknown>
  /** The records the document prints from and never asks about. */
  context?: PresentContext | null
  business: {
    name: string
    tradingName?: string
    /** The name the title band uses, which is a brand, not a legal entity. */
    brandName?: string
    website?: string
    phone?: string
    email?: string
    logoUrl?: string | null
    licenceNumber?: string
  }
  property?: {
    client?: { name: string } | null
    addressLine: string
    suburb: string
    state: string
    postcode: string
  } | null
  /** Fixed named slots — the legacy `photos` field kind. */
  slotPhotos?: Record<string, string>
  galleryPhotos?: Array<GalleryPhotoInput>
  /** Who pressed Finalise, which is not always who the form names. */
  submittedBy?: string
  finalisedAt?: number
  reportNumber?: number
  /** Amendments, not resubmissions — see `docs/reports/fidelity.md`. */
  version?: number
  finalised: boolean
  /** The licence printed under a v1 template's business block. */
  licenceNumber?: string
}

export function buildReportModel(record: ReportRecord): ReportModel {
  const { template, data, property } = record
  const print = template.print
  const context = record.context
    ? { ...record.context, answers: data }
    : undefined

  const galleryPhotos = (record.galleryPhotos ?? []).filter(
    (photo): photo is PrintablePhoto => typeof photo.url === 'string',
  )
  const printable = printedGalleryKeys(sectionsOf(template), data)
  const coverKeys = coverFieldKeys(template)
  const coverPhoto = coverPhotoOf(template, galleryPhotos, printable)

  // Photo sets belong inside their section on a verbatim form: the Timber
  // report's borer photos are evidence for the Wood Borers finding, and five
  // of its sets are labelled only "Photos" — gathered at the end they could
  // not be told apart.
  const inlineGalleries = Boolean(print)

  // The day the document is about. A report is nearly always locked on the
  // day of the visit, but "nearly always" is not a thing to print on a record:
  // the form asks for the date, so the form's answer is the date.
  const visible = visibleSections(sectionsOf(template), data)
  const askedFields = visible.flatMap((section) => section.fields)
  const documentDate =
    firstDateAnswer(askedFields, data) ??
    (record.finalisedAt !== undefined ? shortDate(record.finalisedAt) : undefined)
  const documentYear =
    yearOfAnswer(askedFields, data) ??
    (record.finalisedAt !== undefined ? yearOf(record.finalisedAt) : undefined)

  const sections = visible
    .map(
    (section, index): DocSection => ({
      key: section.id ?? `${index}-${section.title}`,
      number:
        section.number !== undefined && print?.numbering !== 'unnumbered'
          ? section.number
          : undefined,
      heading: printHeadingOf(section),
      preamble: section.preamble,
      blocks: sectionRuns(section.fields, {
        allFields: fieldsOf(template),
        data,
        inlineGalleries,
      }).flatMap((run, runIndex): Array<DocBlock> => {
        if (run.type === 'block') {
          return run.field.kind === 'heading'
            ? [
                {
                  type: 'heading',
                  key: run.field.key,
                  text: run.field.text,
                  note: run.field.note,
                },
              ]
            : [
                {
                  type: 'note',
                  key: run.field.key,
                  heading: run.field.heading,
                  tone: run.field.tone ?? 'note',
                  doc: run.field.body,
                },
              ]
        }

        if (run.type === 'gallery') {
          const photos = photosOf(galleryPhotos, run.field.key)
          return photos.length === 0
            ? []
            : [
                {
                  type: 'photos',
                  key: run.field.key,
                  label: run.field.label,
                  photos,
                },
              ]
        }

        return blocksForFields(run.fields, `${section.title}-${runIndex}`, {
          data,
          context,
          omitEmpty: record.finalised && print?.omitEmpty === true,
        })
      }),
    }),
    )
    .map((section) => ({ ...section, blocks: withoutDanglingHeadings(section.blocks) }))
    // A heading over nothing is the same failure as a labelled em dash: on a
    // signed document it says the form asked something and reports no answer.
    // Rule 8 removes the answers; this removes what is left standing over
    // them. A section of pure prose — a statement, a set of terms — keeps its
    // heading, because the prose IS its content.
    .filter((section) => section.blocks.length > 0)

  return {
    identity: documentIdentity({
      template,
      property,
      businessName: record.business.name,
      finalisedAt: record.finalisedAt,
    }),

    cover: print?.cover
      ? {
          title: print.cover.title,
          subtitle: print.cover.subtitle,
          address: property ? fullAddress(property) : undefined,
          // The vendor's cover carries no date. A document a client files for
          // years should say when the visit was without being opened.
          date: documentDate,
          photo: coverPhoto
            ? {
                key: coverPhoto.fieldKey,
                url: coverPhoto.url,
                caption: coverPhoto.caption,
                width: coverPhoto.width,
                height: coverPhoto.height,
              }
            : undefined,
        }
      : null,

    header: {
      logoUrl: record.business.logoUrl ?? undefined,
      lines: [
        record.business.tradingName ?? record.business.name,
        record.business.email,
        record.business.website,
        record.business.phone,
      ].filter((line): line is string => Boolean(line)),
    },

    // Only a form that carries no header lines of its own: the AS forms print
    // their own titles, and a band above them would say the same thing twice.
    titleBand:
      print && !print.headings?.length
        ? {
            text: `${record.business.brandName ?? record.business.tradingName ?? record.business.name} ${print.formName}${
              documentYear !== undefined ? ` for ${documentYear}` : ''
            }`,
            date: documentDate,
          }
        : null,

    headings: print?.headings ?? [],
    standardsLine: print?.standardsLine,
    sections,

    photoGroups: inlineGalleries
      ? []
      : trailingPhotoGroups(template, record, galleryPhotos, coverKeys, printable),

    notice:
      printsDurableNotice(template) && property
        ? durableNoticeText({
            businessName: record.business.name,
            licenceNumber: record.licenceNumber,
            systemType: String(data.systemType ?? '—'),
            product: String(data.product ?? '—'),
            apvmaNumber: String(data.apvmaNumber ?? '—'),
            installDate: String(data.installDate ?? '—'),
            lifeExpectancy: String(data.lifeExpectancy ?? '—'),
            reinspectionInterval: String(data.reinspectionInterval ?? '—'),
            addressLine: property.addressLine,
            suburb: property.suburb,
          })
        : null,

    terms: template.terms
      ? {
          heading: print?.termsHeading,
          doc: template.terms,
          onItsOwnPage: print?.termsBreak === true,
        }
      : null,
    legacyTerms:
      !template.terms && template.boilerplate.trim() !== ''
        ? template.boilerplate.split('\n\n')
        : [],

    footer: {
      formName: print?.formName ?? template.name,
      submittedBy:
        record.submittedBy && record.finalisedAt
          ? `${record.submittedBy} @ ${stamp(record.finalisedAt)}`
          : record.submittedBy,
      submissionId: record.reportNumber,
      version: record.version ?? 1,
    },
  }
}

/**
 * How this document names itself — in a PDF's metadata, in a viewer's tab, and
 * as a file in someone's Downloads folder.
 *
 * One function because those three used to be three: the PDF's `<Document
 * title>`, the download button's filename and the email's attachment name each
 * built their own string, so the same report arrived as "Pest Service Report",
 * "service-30-sloan-drive.pdf" and something else again in the inbox.
 */
export function documentIdentity({
  template,
  property,
  businessName,
  finalisedAt,
}: {
  template: ReportTemplate
  property?: { addressLine: string; suburb: string } | null
  businessName: string
  finalisedAt?: number
}): DocumentIdentity {
  const place = property ? `${property.addressLine}, ${property.suburb}` : ''
  const day = finalisedAt ? dayKey(finalisedAt) : undefined
  const name = template.print?.formName ?? template.name

  return {
    title: place ? `${name} — ${place}` : name,
    subject: `${name} issued by ${businessName}`,
    fileName: [slug(template.shortName || name), slug(place), day]
      .filter(Boolean)
      .join('-')
      .concat('.pdf'),
  }
}

/**
 * Drops a sub-heading with nothing under it.
 *
 * "Installer Details" over an empty space happens whenever every field beneath
 * it was unanswered and rule 8 took them out — which on a certificate that
 * named no installer is most of them.
 */
function withoutDanglingHeadings(blocks: Array<DocBlock>): Array<DocBlock> {
  return blocks.filter((block, index) => {
    if (block.type !== 'heading') return true
    // Something has to follow it, and that something has to be content — a
    // heading straight after another heading leaves the first one empty too.
    if (index === blocks.length - 1) return false
    return blocks[index + 1].type !== 'heading'
  })
}

/**
 * A run of answers, split where a repeater interrupts it.
 *
 * A repeating table is not a row in a key/value list — it has its own column
 * headings and its own width — so it becomes its own block rather than being
 * squeezed into the value column beside a label.
 */
function blocksForFields(
  fields: Array<FieldDef>,
  keyPrefix: string,
  {
    data,
    context,
    omitEmpty,
  }: {
    data: Record<string, unknown>
    context?: PresentContext
    omitEmpty: boolean
  },
): Array<DocBlock> {
  const blocks: Array<DocBlock> = []

  for (const field of fields) {
    const shown = present(field, data[field.key], context)
    if (shown.kind === 'omit') continue
    // Rule 8: the signed document omits what was never answered; a draft shows
    // the em dash so the technician can see what is still open.
    if (omitEmpty && shown.kind === 'blank') continue

    if (shown.kind === 'grid') {
      blocks.push({
        type: 'table',
        key: field.key,
        label: field.label,
        columns: columnsOf(field, shown.columns),
        rows: shown.rows,
      })
      continue
    }

    const row: DocRow = {
      key: field.key,
      label: field.label,
      shown,
      bar: barFor(field, data[field.key]),
    }
    const last = blocks.at(-1)
    if (last?.type === 'rows') last.rows.push(row)
    else blocks.push({ type: 'rows', key: `${keyPrefix}-${field.key}`, rows: [row] })
  }

  return blocks
}

/**
 * The share of the table each column takes.
 *
 * Declared on the cell where the template knows what goes in it — a product
 * and its active ingredient need more room than a quantity — and split evenly
 * otherwise, which is what a business-authored repeater gets.
 */
function columnsOf(
  field: FieldDef,
  labels: Array<string>,
): Array<{ label: string; width: number }> {
  const cells = field.kind === 'repeater' ? field.columns : []
  const declared = cells.map((cell) => cell.width)
  const total = declared.reduce((sum: number, w) => sum + (w ?? 0), 0)
  return labels.map((label, index) => ({
    label,
    width: total > 0 ? ((declared[index] ?? 0) / total) * 100 : 100 / labels.length,
  }))
}

/**
 * Whether an answer reports a state worth marking, and which.
 *
 * Derived from the flags the template already carries rather than a second
 * presentation-only declaration, so a business that adds a safety check gets
 * the bar by saying which answer is the bad one — the same thing it already
 * says to make the quick "Yes to all" and the conducive-condition guidance
 * work.
 */
function barFor(field: FieldDef, value: unknown): DocBar | undefined {
  const declares =
    (field.kind === 'toggle' && field.flaggedValue !== undefined) ||
    ((field.kind === 'select' ||
      field.kind === 'radio' ||
      field.kind === 'chips' ||
      field.kind === 'checks') &&
      (field.flaggedValues ?? []).length > 0)
  if (!declares) return undefined
  if (value === undefined || value === null || value === '') return undefined
  if (!isFlagged(field, value)) return 'good'
  // The one question the form makes a gate reads differently from the rest: a
  // missing spill kit is a note, "not safe to commence work" is the headline.
  return field.semantic === 'safetyGate' ? 'danger' : 'warn'
}

function photosOf(
  photos: Array<PrintablePhoto>,
  fieldKey: string,
): Array<DocPhoto> {
  return photos
    .filter((photo) => photo.fieldKey === fieldKey)
    .sort((a, b) => a.order - b.order)
    .map((photo) => ({
      key: `${photo.fieldKey}-${photo.order}`,
      url: photo.url,
      caption: photo.caption,
      width: photo.width,
      height: photo.height,
    }))
}

/**
 * Photo sets a form does not place itself, printed after the sections: the
 * legacy named slots, and galleries on a template with no verbatim print spec.
 */
function trailingPhotoGroups(
  template: ReportTemplate,
  record: ReportRecord,
  galleryPhotos: Array<PrintablePhoto>,
  coverKeys: Set<string>,
  printable: Set<string>,
): ReportModel['photoGroups'] {
  const groups: ReportModel['photoGroups'] = []

  const slots = Object.entries(record.slotPhotos ?? {})
  if (slots.length > 0) {
    groups.push({
      key: 'slots',
      label: 'Photos',
      photos: slots.map(([slot, url]) => ({ key: slot, url, caption: slot })),
    })
  }

  const labels = new Map(
    fieldsOf(template)
      .filter((field) => field.kind === 'gallery')
      .map((field) => [field.key, field.label] as const),
  )

  const byField = new Map<string, Array<DocPhoto>>()
  for (const photo of galleryPhotos) {
    // The cover has its own page; printing it again in the grid sends the
    // client the same photo twice.
    if (coverKeys.has(photo.fieldKey)) continue
    // A key no field declares — a field since removed — still prints, as it
    // always has. Only a gallery the answers hide is left out.
    if (labels.has(photo.fieldKey) && !printable.has(photo.fieldKey)) continue
    const group = byField.get(photo.fieldKey) ?? []
    group.push({
      key: `${photo.fieldKey}-${photo.order}`,
      url: photo.url,
      caption: photo.caption,
      width: photo.width,
      height: photo.height,
    })
    byField.set(photo.fieldKey, group)
  }

  for (const [fieldKey, photos] of byField) {
    groups.push({ key: fieldKey, label: labels.get(fieldKey) ?? 'Photos', photos })
  }

  return groups
}

/** A photo that survived the "has a URL" filter, so its url is a string. */
type PrintablePhoto = GalleryPhotoInput & { url: string }

/**
 * The first date the form actually asked for — `Date:` on the Service Report,
 * `Inspection Date`, `Installation Date` — already formatted the way the
 * header band prints it.
 */
function firstDateAnswer(
  fields: Array<FieldDef>,
  data: Record<string, unknown>,
): string | undefined {
  for (const field of fields) {
    if (field.kind !== 'date') continue
    const value = data[field.key]
    if (typeof value !== 'string' || value === '') continue
    const [year, month, day] = value.split('-').map(Number)
    if (!year || !month || !day) continue
    return shortDate(Date.UTC(year, month - 1, day))
  }
  return undefined
}

function yearOfAnswer(
  fields: Array<FieldDef>,
  data: Record<string, unknown>,
): number | undefined {
  for (const field of fields) {
    if (field.kind !== 'date') continue
    const value = data[field.key]
    if (typeof value === 'string' && /^\d{4}-/.test(value)) return Number(value.slice(0, 4))
  }
  return undefined
}

function fullAddress(property: {
  addressLine: string
  suburb: string
  state: string
  postcode: string
}): string {
  return `${property.addressLine}, ${property.suburb} ${property.state} ${property.postcode}`
}

/** `28 Aug 2026` — the form's own date format, in the header band and cover. */
function shortDate(at: number): string {
  return new Intl.DateTimeFormat('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    // A plain calendar date is constructed as UTC and must be read back as
    // UTC, or a morning date shifts to the day before.
    timeZone: 'UTC',
  }).format(new Date(at))
}

function yearOf(at: number): number {
  return new Date(at).getFullYear()
}

/** `11:35:53 28 Aug 2026` — the footer's stamp, verbatim to the second. */
function stamp(at: number): string {
  const when = new Date(at)
  const time = new Intl.DateTimeFormat('en-AU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(when)
  return `${time} ${shortDate(at)}`
}

function dayKey(at: number): string {
  const when = new Date(at)
  const month = String(when.getMonth() + 1).padStart(2, '0')
  const day = String(when.getDate()).padStart(2, '0')
  return `${when.getFullYear()}-${month}-${day}`
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

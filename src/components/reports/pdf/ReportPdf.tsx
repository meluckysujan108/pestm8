import { Document, Font, Image, Page, StyleSheet, Text, View } from '@react-pdf/renderer'
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
} from '../../../lib/reportTemplates'
import { present } from '../../../lib/reportTemplates/present'
import { visibleSections } from '../../../lib/reportTemplates/visibility'
import { resolveReportTemplate } from '../../../lib/reportTemplates/resolve'
import { PdfFooter, PdfHeader } from './layout'
import { RichTextPdf } from './RichTextPdf'
import type {
  PresentContext,
  Presented,
} from '../../../lib/reportTemplates/present'
import type {
  FieldDef,
  ReportTemplate,
  StaticBlockField,
  TemplateId,
} from '../../../lib/reportTemplates'
import type {
  CustomTemplateShape,
  TemplateSnapshotShape,
} from '../../../lib/reportTemplates/resolve'

/**
 * Hyphenation off, everywhere. Nothing in these documents is justified, so a
 * ragged right edge costs nothing — and react-pdf's default splits words the
 * source forms print whole ("prop- erty", "In- spection"), along with product
 * names and addresses a reader may need to copy exactly. Registered once, at
 * module scope, because react-pdf's font registry is global to the process.
 */
Font.registerHyphenationCallback((word) => [word])

export type PdfGalleryPhoto = {
  fieldKey: string
  caption?: string
  order: number
  isCover: boolean
  url: string | null
}

export type PdfReport = {
  template: TemplateId | 'custom'
  customTemplate?: CustomTemplateShape | null
  templateVersion?: number
  /** The frozen wording this report was signed against, if it has been. */
  templateSnapshot?: TemplateSnapshotShape | null
  /** The records this document prints from without asking. */
  context?: PresentContext | null
  legalBasis: string
  finalisedAt?: number
  data: Record<string, unknown>
  businessName: string
  business?: {
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
  licenceNumber?: string
  /** Fixed named slots, e.g. the legacy `photos` field kind. */
  photos?: Record<string, string>
  /** Open-ended `gallery` fields, grouped by field key at render time. */
  galleryPhotos?: Array<PdfGalleryPhoto>
}

/**
 * One PDF component per template would duplicate the field walk three times.
 * The templates already describe their own fields, so the document renders
 * from the same definitions the builder and on-screen document use — three
 * outputs that cannot drift apart.
 */
const styles = StyleSheet.create({
  page: {
    paddingTop: 42,
    paddingBottom: 56,
    paddingHorizontal: 44,
    fontSize: 10,
    color: '#1C1C1E',
    fontFamily: 'Helvetica',
  },
  // `lineHeight` deliberately lives here, not on `page` above: setting it at
  // the Page level breaks `fixed` + `position: absolute` layout in this
  // @react-pdf/renderer version — the footer silently renders nothing at all
  // (confirmed by bisection; not documented upstream). Scoping it to a body
  // wrapper keeps the visual line spacing without the header/footer, which
  // are direct Page children outside this wrapper, inheriting it.
  body: { lineHeight: 1.5 },
  legalBasis: {
    fontSize: 8,
    letterSpacing: 1.2,
    color: '#8E8E93',
    fontFamily: 'Helvetica-Bold',
  },
  title: { fontSize: 20, marginTop: 4, fontFamily: 'Helvetica-Bold' },
  company: { fontSize: 10, color: '#3A3A3C', marginTop: 2 },
  rule: { borderBottomWidth: 1, borderBottomColor: '#E5E5EA', marginTop: 14 },
  sectionLabel: {
    fontSize: 8,
    letterSpacing: 1.2,
    color: '#8E8E93',
    marginTop: 18,
    marginBottom: 6,
    fontFamily: 'Helvetica-Bold',
  },
  row: {
    flexDirection: 'row',
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#F2F2F7',
  },
  key: { width: '38%', color: '#8E8E93' },
  value: { width: '62%' },
  areaRow: { flexDirection: 'row', paddingVertical: 2 },
  gridHead: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E5EA',
    paddingBottom: 3,
  },
  gridRow: {
    flexDirection: 'row',
    paddingVertical: 3,
    borderBottomWidth: 1,
    borderBottomColor: '#F2F2F7',
  },
  gridCell: { flex: 1, paddingRight: 6, fontSize: 8.5 },
  noAccess: { color: '#B26B00' },
  mono: {
    fontFamily: 'Courier',
    fontSize: 9,
    lineHeight: 1.45,
    padding: 10,
    borderWidth: 1,
    borderColor: '#E5E5EA',
  },
  boilerplate: { fontSize: 8.5, color: '#3A3A3C', marginBottom: 6 },
  coverPhoto: { width: '100%', height: 200, objectFit: 'cover', marginTop: 12 },
  coverCaption: { fontSize: 8, color: '#8E8E93', marginTop: 3 },
  photoGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  photoTile: { width: '48%' },
  photoImage: {
    width: '100%',
    height: 110,
    objectFit: 'cover',
    borderRadius: 4,
  },
  photoCaption: { fontSize: 7.5, color: '#8E8E93', marginTop: 2 },
  signatureImage: {
    width: 160,
    height: 56,
    objectFit: 'contain',
    marginBottom: 2,
  },
  staticHeading: {
    fontSize: 10.5,
    fontFamily: 'Helvetica-Bold',
    marginTop: 10,
    marginBottom: 3,
  },
  staticHeadingNote: { fontSize: 8, color: '#8E8E93', marginBottom: 3 },
  galleryLabel: { marginTop: 8, marginBottom: 2 },
  printHeading: { fontSize: 11, fontFamily: 'Helvetica-Bold', marginTop: 3 },
  standardsLine: { fontSize: 8.5, color: '#3A3A3C', marginTop: 2 },
  coverPage: { padding: 0, backgroundColor: '#FFFFFF' },
  coverPageImage: { width: '100%', height: '78%', objectFit: 'contain' },
  coverPageCaption: { paddingHorizontal: 44, paddingTop: 18 },
  coverPageTitle: { fontSize: 26, fontFamily: 'Helvetica-Bold', color: '#1C1C1E' },
  coverPageAddress: { fontSize: 11, color: '#3A3A3C', marginTop: 4 },
})

export function ReportPdf({ report }: { report: PdfReport }) {
  const context = report.context
    ? { ...report.context, answers: report.data }
    : undefined
  const template = resolveReportTemplate({
    template: report.template,
    templateVersion: report.templateVersion,
    customTemplate: report.customTemplate,
    templateSnapshot: report.templateSnapshot,
  })
  const { data, property } = report

  const noticeText =
    printsDurableNotice(template) && property
      ? durableNoticeText({
          businessName: report.businessName,
          licenceNumber: report.licenceNumber,
          systemType: String(data.systemType ?? '—'),
          product: String(data.product ?? '—'),
          apvmaNumber: String(data.apvmaNumber ?? '—'),
          installDate: String(data.installDate ?? '—'),
          lifeExpectancy: String(data.lifeExpectancy ?? '—'),
          reinspectionInterval: String(data.reinspectionInterval ?? '—'),
          addressLine: property.addressLine,
          suburb: property.suburb,
        })
      : null

  const galleryPhotos = report.galleryPhotos ?? []
  // The front page, declared by a `cover` field. Separate from the legacy
  // `isCover` flag below, which a multi-photo gallery can still set and which
  // still prints inline where it always has — changing that would rewrite what
  // reports finalised years ago look like.
  const printablePhotos = printedGalleryKeys(sectionsOf(template), data)
  const coverPage = coverPhotoOf(template, galleryPhotos, printablePhotos)
  // The legacy starred-photo cover belongs only to a form with no cover field
  // of its own — on one that has, a star in some other gallery means nothing —
  // and never to a gallery the answers have hidden.
  const declaredGalleries = new Set(
    fieldsOf(template)
      .filter((field) => field.kind === 'gallery')
      .map((field) => field.key),
  )
  const cover =
    coverFieldKeys(template).size > 0
      ? undefined
      : galleryPhotos.find(
          (p) =>
            p.isCover &&
            p.url &&
            (!declaredGalleries.has(p.fieldKey) ||
              printablePhotos.has(p.fieldKey)),
        )

  return (
    <Document
      title={`${template.name} — ${property?.addressLine ?? ''}`}
      author={report.businessName}
    >
      {coverPage?.url && (
        // Its own page, landscape, and `contain` rather than `cover`: the
        // source form asks for a landscape shot, and evidence is never
        // centre-cropped to fit a band. No header or footer — a title page
        // carries neither.
        <Page size="A4" orientation="landscape" style={styles.coverPage}>
          <Image src={coverPage.url} style={styles.coverPageImage} />
          <View style={styles.coverPageCaption}>
            <Text style={styles.coverPageTitle}>{template.name}</Text>
            {property && (
              <Text style={styles.coverPageAddress}>
                {property.addressLine}, {property.suburb} {property.state}{' '}
                {property.postcode}
              </Text>
            )}
          </View>
        </Page>
      )}

      <Page size="A4" style={styles.page}>
        <PdfHeader
          logoUrl={report.business?.logoUrl}
          licenceNumber={report.business?.licenceNumber ?? report.licenceNumber}
        />

        <View style={styles.body}>
          <Text style={styles.legalBasis}>
            {template.legalBasis.toUpperCase()}
          </Text>
          {/* A form with its own header lines prints those; the app's picker
              name above them would print the title twice. */}
          {!template.print?.headings?.length && (
            <Text style={styles.title}>{template.name}</Text>
          )}
          {/* The form's own header lines and standards reference, verbatim. */}
          {template.print?.headings?.map((line) => (
            <Text key={line} style={styles.printHeading}>
              {line}
            </Text>
          ))}
          {template.print?.standardsLine && (
            <Text style={styles.standardsLine}>
              {template.print.standardsLine}
            </Text>
          )}
          <Text style={styles.company}>{report.businessName}</Text>
          {report.licenceNumber && (
            <Text style={styles.company}>Licence {report.licenceNumber}</Text>
          )}
          <View style={styles.rule} />

          {/* A verbatim form prints the client and site in its own first
              section, in its own words; this app-invented block would print
              them twice. */}
          {property && !template.print && (
            <>
              <Text style={styles.sectionLabel}>PROPERTY</Text>
              <Text>{property.client?.name}</Text>
              {/* Legal documents carry the full street address, always (§2.3). */}
              <Text>{property.addressLine}</Text>
              <Text>
                {property.suburb} {property.state} {property.postcode}
              </Text>
            </>
          )}

          {cover && cover.url && (
            <View wrap={false}>
              <Image src={cover.url} style={styles.coverPhoto} />
              {cover.caption && (
                <Text style={styles.coverCaption}>{cover.caption}</Text>
              )}
            </View>
          )}

          {visibleSections(sectionsOf(template), data).map((section) => {
            // The heading the client received, which is not always the heading
            // the technician filled the section in under — and is sometimes
            // nothing at all, under a title band that already says it.
            const heading = printHeadingOf(section)
            return (
              <View key={section.title}>
                {heading !== null && (
                  <Text style={styles.sectionLabel}>
                    {section.number &&
                    template.print?.numbering !== 'unnumbered'
                      ? `${section.number}. `
                      : ''}
                    {/* A verbatim form prints the heading the client received,
                        in its own case ("Risk Assessment"); the v1 layout
                        shouted every heading. */}
                    {template.print ? heading : heading.toUpperCase()}
                  </Text>
                )}
                {section.preamble && (
                  <Text style={styles.boilerplate}>{section.preamble}</Text>
                )}
                {sectionRuns(section.fields, {
                  allFields: fieldsOf(template),
                  data,
                  inlineGalleries: Boolean(template.print),
                }).map((run, runIndex) =>
                  run.type === 'block' ? (
                    <StaticBlockRow key={run.field.key} field={run.field} />
                  ) : run.type === 'gallery' ? (
                    <GalleryPdf
                      key={run.field.key}
                      label={run.field.label}
                      photos={(report.galleryPhotos ?? []).filter(
                        (photo) => photo.fieldKey === run.field.key && photo.url,
                      )}
                    />
                  ) : (
                    <View key={`rows-${runIndex}`}>
                      {run.fields
                        .map((field) => ({
                          field,
                          shown: present(field, data[field.key], context),
                        }))
                        .filter(({ shown }) => shown.kind !== 'omit')
                        // Every PDF is of a signed report.
                        .filter(
                          ({ shown }) =>
                            !(template.print?.omitEmpty && shown.kind === 'blank'),
                        )
                        .map(({ field, shown }) => (
                          <FieldRow
                            key={field.key}
                            field={field}
                            shown={shown}
                            captioned={field.label !== heading}
                          />
                        ))}
                    </View>
                  ),
                )}
              </View>
            )
          })}

          {noticeText && (
            <>
              <Text style={styles.sectionLabel}>DURABLE NOTICE</Text>
              <Text style={styles.mono}>{noticeText}</Text>
              <Text style={{ marginTop: 6, fontSize: 8.5, color: '#B26B00' }}>
                This notice must be physically fixed to the building, usually
                inside the meter box.
              </Text>
            </>
          )}

          <PhotosSection template={template} report={report} />

          {template.terms ? (
            <>
              <Text style={styles.sectionLabel}>
                {(template.print?.termsHeading ?? 'Standard terms').toUpperCase()}
              </Text>
              <RichTextPdf doc={template.terms} />
            </>
          ) : (
            // A v1 template's single block. Skipped when empty rather than
            // printing a heading over nothing, which reads as missing terms.
            template.boilerplate.trim() !== '' && (
              <>
                <Text style={styles.sectionLabel}>STANDARD TERMS</Text>
                {template.boilerplate.split('\n\n').map((paragraph, i) => (
                  <Text key={i} style={styles.boilerplate}>
                    {paragraph}
                  </Text>
                ))}
              </>
            )
          )}
        </View>

        <PdfFooter
          formId={`${report.businessName} · ${template.name}`}
          timestamp={
            report.finalisedAt
              ? `Finalised ${new Date(report.finalisedAt).toLocaleDateString('en-AU')}`
              : undefined
          }
        />
      </Page>
    </Document>
  )
}

/**
 * Fixed-slot photos and `gallery` fields, grouped and labelled the same way
 * `ReportDocument.tsx`'s on-screen `ReportPhotos`/`ReportGallery` are — this
 * is the first PDF surface to print them at all.
 */
function PhotosSection({
  template,
  report,
}: {
  template: ReportTemplate
  report: PdfReport
}) {
  const slots = Object.entries(report.photos ?? {})

  const labelFor = new Map(
    fieldsOf(template)
      .filter((field) => field.kind === 'gallery')
      .map((field) => [field.key, field.label] as const),
  )
  // The cover has its own page. Printing it again in the grid, captioned
  // "(cover)", sends the client the same photo twice.
  const coverKeys = coverFieldKeys(template)
  // Only photo sets whose question is showing. A verbatim form has already
  // printed its sets inside their sections.
  const printable = printedGalleryKeys(sectionsOf(template), report.data)
  const inline = Boolean(template.print)

  const byField = new Map<string, Array<PdfGalleryPhoto>>()
  for (const photo of report.galleryPhotos ?? []) {
    if (!photo.url) continue
    if (coverKeys.has(photo.fieldKey)) continue
    if (inline && labelFor.has(photo.fieldKey)) continue
    // A key no field declares (a field since removed) still prints, as it
    // always has; only a gallery the template hides is left out.
    if (labelFor.has(photo.fieldKey) && !printable.has(photo.fieldKey)) continue
    const group = byField.get(photo.fieldKey) ?? []
    group.push(photo)
    byField.set(photo.fieldKey, group)
  }

  if (slots.length === 0 && byField.size === 0) return null

  return (
    <>
      {slots.length > 0 && (
        <View wrap={false}>
          <Text style={styles.sectionLabel}>PHOTOS</Text>
          <View style={styles.photoGrid}>
            {slots.map(([slot, url]) => (
              <View key={slot} style={styles.photoTile}>
                <Image src={url} style={styles.photoImage} />
                <Text style={styles.photoCaption}>{slot}</Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {[...byField.entries()].map(([fieldKey, photos]) => (
        <GalleryPdf
          key={fieldKey}
          label={(labelFor.get(fieldKey) ?? 'Photos').toUpperCase()}
          photos={photos}
          headingStyle="section"
        />
      ))}
    </>
  )
}

/**
 * One photo set. Rows of two, each kept whole, rather than one unbreakable
 * block: a set of twelve photos taller than a page would otherwise be pushed
 * off it and clipped.
 */
function GalleryPdf({
  label,
  photos,
  headingStyle = 'field',
}: {
  label: string
  photos: Array<PdfGalleryPhoto>
  headingStyle?: 'field' | 'section'
}) {
  if (photos.length === 0) return null
  const rows: Array<Array<PdfGalleryPhoto>> = []
  for (let i = 0; i < photos.length; i += 2) rows.push(photos.slice(i, i + 2))
  return (
    <View>
      <Text
        style={headingStyle === 'section' ? styles.sectionLabel : styles.galleryLabel}
        minPresenceAhead={120}
      >
        {label}
      </Text>
      {rows.map((row, r) => (
        <View key={r} style={styles.photoGrid} wrap={false}>
          {row.map((photo, i) => (
            <View key={i} style={styles.photoTile}>
              <Image src={photo.url!} style={styles.photoImage} />
              {(photo.caption || photo.isCover) && (
                <Text style={styles.photoCaption}>
                  {photo.caption}
                  {photo.isCover ? ' (cover)' : ''}
                </Text>
              )}
            </View>
          ))}
        </View>
      ))}
    </View>
  )
}

/**
 * Paints what `present()` decided, in @react-pdf primitives. The label-vs-code
 * rules live in that shared module so this file and the on-screen document
 * cannot disagree about what a finished report says.
 */
/**
 * A note or a sub-heading on the printed page. Full width and label-free: the
 * field label is the author's name for the block, and a warranty clause
 * squeezed into a 62% value column beside it is not the document that was
 * issued.
 *
 * No `wrap={false}`. That is the right idiom for a key/value row, where an
 * orphaned label is the failure; on a clause longer than the remaining page it
 * pushes the whole block to the next page instead of breaking it.
 */
function StaticBlockRow({ field }: { field: StaticBlockField }) {
  if (field.kind === 'heading') {
    return (
      <View>
        <Text style={styles.staticHeading} minPresenceAhead={40}>
          {field.text}
        </Text>
        {field.note && (
          <Text style={styles.staticHeadingNote}>{field.note}</Text>
        )}
      </View>
    )
  }

  const tone = field.tone ?? 'note'
  return (
    <View style={{ marginTop: 6, marginBottom: 4 }}>
      {field.heading && (
        <Text
          style={[
            styles.staticHeading,
            ...(tone === 'important' ? [{ color: '#C8102E' }] : []),
          ]}
        >
          {tone === 'important' ? `IMPORTANT: ${field.heading}` : field.heading}
        </Text>
      )}
      <RichTextPdf doc={field.body} />
    </View>
  )
}

/**
 * Paints what `present()` decided, in @react-pdf primitives.
 *
 * A `switch` with an exhaustiveness guard, mirroring its on-screen twin. It was
 * an if-chain ending in an unguarded fallthrough that read `shown.text`, so a
 * new `Presented` variant would have printed `undefined` on the document that
 * gets signed and emailed. It compiled only by accident — that fallthrough
 * happened to touch a property the new variants lack.
 */
function FieldRow({
  field,
  shown,
  captioned = true,
}: {
  field: FieldDef
  shown: Presented
  /**
   * False when the field's label IS the printed section heading — the treatment
   * grid — so a table is not captioned twice under its own heading.
   */
  captioned?: boolean
}) {
  switch (shown.kind) {
    case 'omit':
      return null

    case 'pairs':
      return (
        <View wrap={false}>
          <Text style={{ marginTop: 8, marginBottom: 2 }}>{field.label}</Text>
          {shown.pairs.map((pair) => (
            <View key={pair.label} style={styles.areaRow}>
              <Text style={styles.key}>{pair.label}</Text>
              <Text
                style={[
                  styles.value,
                  ...(pair.tone === 'warn' ? [styles.noAccess] : []),
                ]}
              >
                {pair.value}
              </Text>
            </View>
          ))}
        </View>
      )

    case 'grid':
      return (
        <View wrap={false}>
          {captioned && (
            <Text style={{ marginTop: 8, marginBottom: 2 }}>{field.label}</Text>
          )}
          <View style={styles.gridHead}>
            {shown.columns.map((column) => (
              <Text key={column} style={styles.gridCell}>
                {column}
              </Text>
            ))}
          </View>
          {shown.rows.map((row, i) => (
            <View key={i} style={styles.gridRow}>
              {row.map((cell, j) => (
                <Text key={j} style={styles.gridCell}>
                  {cell}
                </Text>
              ))}
            </View>
          ))}
        </View>
      )

    // A note is not a labelled row. It spans the page, because a clause
    // squeezed into a 62% value column beside its editor-only name is not the
    // document the client received.
    case 'rich':
      return (
        <View style={{ marginTop: 6, marginBottom: 4 }}>
          <RichTextPdf doc={shown.doc} />
        </View>
      )

    case 'image':
      return (
        <View style={styles.row} wrap={false}>
          <Text style={styles.key}>{field.label}</Text>
          <View style={styles.value}>
            <Image src={shown.url} style={styles.signatureImage} />
            {shown.caption && (
              <Text style={styles.photoCaption}>{shown.caption}</Text>
            )}
          </View>
        </View>
      )

    case 'lines':
      return (
        <View style={styles.row} wrap={false}>
          <Text style={styles.key}>{field.label}</Text>
          <View style={styles.value}>
            {shown.lines.map((line, i) => (
              <Text key={i}>{line}</Text>
            ))}
          </View>
        </View>
      )

    case 'blank':
      return (
        <View style={styles.row} wrap={false}>
          <Text style={styles.key}>{field.label}</Text>
          <Text style={styles.value}>—</Text>
        </View>
      )

    case 'text':
      return (
        <View style={styles.row} wrap={false}>
          <Text style={styles.key}>{field.label}</Text>
          <Text
            style={[
              styles.value,
              ...(shown.tone === 'warn' ? [styles.noAccess] : []),
            ]}
          >
            {shown.text}
          </Text>
        </View>
      )

    default: {
      // Without this a new variant renders as nothing at all, silently
      // dropping a field off a signed document. Fail at build instead.
      const _exhaustive: never = shown
      void _exhaustive
      return null
    }
  }
}

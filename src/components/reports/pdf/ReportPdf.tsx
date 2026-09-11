import { Document, Image, Page, StyleSheet, Text, View } from '@react-pdf/renderer'
import { durableNoticeText, fieldsOf, sectionsOf } from '../../../lib/reportTemplates'
import { present } from '../../../lib/reportTemplates/present'
import { visibleSections } from '../../../lib/reportTemplates/visibility'
import { resolveReportTemplate } from '../../../lib/reportTemplates/resolve'
import { PdfFooter, PdfHeader } from './layout'
import type { Presented } from '../../../lib/reportTemplates/present'
import type { FieldDef, ReportTemplate, TemplateId } from '../../../lib/reportTemplates'
import type { CustomTemplateShape } from '../../../lib/reportTemplates/resolve'

export type PdfGalleryPhoto = {
  fieldKey: string
  caption?: string
  isCover: boolean
  url: string | null
}

export type PdfReport = {
  template: TemplateId | 'custom'
  customTemplate?: CustomTemplateShape | null
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
})

export function ReportPdf({ report }: { report: PdfReport }) {
  const template = resolveReportTemplate({
    template: report.template,
    customTemplate: report.customTemplate,
  })
  const { data, property } = report

  const noticeText =
    report.template === 'termiteManagementCert' && property
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

  const cover = (report.galleryPhotos ?? []).find((p) => p.isCover && p.url)

  return (
    <Document
      title={`${template.name} — ${property?.addressLine ?? ''}`}
      author={report.businessName}
    >
      <Page size="A4" style={styles.page}>
        <PdfHeader
          logoUrl={report.business?.logoUrl}
          licenceNumber={report.business?.licenceNumber ?? report.licenceNumber}
        />

        <View style={styles.body}>
          <Text style={styles.legalBasis}>
            {template.legalBasis.toUpperCase()}
          </Text>
          <Text style={styles.title}>{template.name}</Text>
          <Text style={styles.company}>{report.businessName}</Text>
          {report.licenceNumber && (
            <Text style={styles.company}>Licence {report.licenceNumber}</Text>
          )}
          <View style={styles.rule} />

          {property && (
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

          {visibleSections(sectionsOf(template), data).map((section) => (
            <View key={section.title}>
              <Text style={styles.sectionLabel}>
                {section.number ? `${section.number}. ` : ''}
                {section.title.toUpperCase()}
              </Text>
              {section.preamble && (
                <Text style={styles.boilerplate}>{section.preamble}</Text>
              )}
              {section.fields
                .map((field) => ({
                  field,
                  shown: present(field, data[field.key]),
                }))
                .filter(({ shown }) => shown.kind !== 'omit')
                .map(({ field, shown }) => (
                  <FieldRow key={field.key} field={field} shown={shown} />
                ))}
            </View>
          ))}

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

          <Text style={styles.sectionLabel}>STANDARD TERMS</Text>
          {template.boilerplate.split('\n\n').map((paragraph, i) => (
            <Text key={i} style={styles.boilerplate}>
              {paragraph}
            </Text>
          ))}
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
  const byField = new Map<string, Array<PdfGalleryPhoto>>()
  for (const photo of report.galleryPhotos ?? []) {
    if (!photo.url) continue
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
        <View key={fieldKey} wrap={false}>
          <Text style={styles.sectionLabel}>
            {(labelFor.get(fieldKey) ?? 'Photos').toUpperCase()}
          </Text>
          <View style={styles.photoGrid}>
            {photos.map((photo, i) => (
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
        </View>
      ))}
    </>
  )
}

/**
 * Paints what `present()` decided, in @react-pdf primitives. The label-vs-code
 * rules live in that shared module so this file and the on-screen document
 * cannot disagree about what a finished report says.
 */
function FieldRow({ field, shown }: { field: FieldDef; shown: Presented }) {
  if (shown.kind === 'omit') return null

  if (shown.kind === 'pairs') {
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
  }

  if (shown.kind === 'grid') {
    return (
      <View wrap={false}>
        <Text style={{ marginTop: 8, marginBottom: 2 }}>{field.label}</Text>
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
  }

  return (
    <View style={styles.row} wrap={false}>
      <Text style={styles.key}>{field.label}</Text>
      <Text style={styles.value}>
        {shown.kind === 'blank' ? '—' : shown.text}
      </Text>
    </View>
  )
}

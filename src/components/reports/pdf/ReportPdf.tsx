import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer'
import {
  durableNoticeText,
  getTemplate,
  sectionsOf,
} from '#/lib/reportTemplates'
import { present } from '#/lib/reportTemplates/present'
import { visibleSections } from '#/lib/reportTemplates/visibility'
import type { Presented } from '#/lib/reportTemplates/present'
import type { FieldDef, TemplateId } from '#/lib/reportTemplates'

export type PdfReport = {
  template: string
  legalBasis: string
  finalisedAt?: number
  data: Record<string, unknown>
  businessName: string
  property: {
    clientName: string
    addressLine: string
    suburb: string
    state: string
    postcode: string
  } | null
  licenceNumber?: string
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
    lineHeight: 1.5,
    color: '#1C1C1E',
    fontFamily: 'Helvetica',
  },
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
  footer: {
    marginTop: 22,
    fontSize: 8,
    color: '#8E8E93',
    borderTopWidth: 1,
    borderTopColor: '#E5E5EA',
    paddingTop: 6,
  },
})

export function ReportPdf({ report }: { report: PdfReport }) {
  const template = getTemplate(report.template as TemplateId)
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

  return (
    <Document
      title={`${template.name} — ${property?.addressLine ?? ''}`}
      author={report.businessName}
    >
      <Page size="A4" style={styles.page}>
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
            <Text>{property.clientName}</Text>
            {/* Legal documents carry the full street address, always (§2.3). */}
            <Text>{property.addressLine}</Text>
            <Text>
              {property.suburb} {property.state} {property.postcode}
            </Text>
          </>
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

        <Text style={styles.sectionLabel}>STANDARD TERMS</Text>
        {template.boilerplate.split('\n\n').map((paragraph, i) => (
          <Text key={i} style={styles.boilerplate}>
            {paragraph}
          </Text>
        ))}

        {/* Provenance line, in normal flow.
            Two things this deliberately avoids: `position:absolute` + `fixed`,
            and the `render` callback for page numbers. Both work under Node
            but silently produce nothing in the browser build we generate from,
            which stripped the footer off every exported document without an
            error. Page numbers are omitted rather than emitted as dead code —
            add them back only if generation moves server-side. */}
        <View style={styles.footer}>
          <Text>
            {report.businessName} · {template.name}
            {report.finalisedAt
              ? ` · Finalised ${new Date(report.finalisedAt).toLocaleDateString('en-AU')}`
              : ''}
          </Text>
        </View>
      </Page>
    </Document>
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

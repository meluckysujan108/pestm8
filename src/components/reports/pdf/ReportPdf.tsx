import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer'
import { durableNoticeText, getTemplate } from '#/lib/reportTemplates'
import type { AreaResult, FieldDef, TemplateId } from '#/lib/reportTemplates'

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

        <Text style={styles.sectionLabel}>DETAILS</Text>
        {template.fields
          .filter((f) => f.kind !== 'photos')
          .map((field) => (
            <FieldRow key={field.key} field={field} value={data[field.key]} />
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

function FieldRow({ field, value }: { field: FieldDef; value: unknown }) {
  if (field.kind === 'areas' && value && typeof value === 'object') {
    const areas = value as Record<string, AreaResult>
    return (
      <View wrap={false}>
        <Text style={{ marginTop: 8, marginBottom: 2 }}>{field.label}</Text>
        {/* Order comes from the template, not from storage. Convex returns
            object keys sorted, which would print the areas alphabetically
            instead of in the sequence a technician actually works through. */}
        {field.rows.map((row) => {
          const result = areas[row] ?? { status: 'inspected' }
          return (
            <View key={row} style={styles.areaRow}>
              <Text style={styles.key}>{row}</Text>
              <Text
                style={[
                  styles.value,
                  ...(result.status === 'noAccess' ? [styles.noAccess] : []),
                ]}
              >
                {result.status === 'inspected'
                  ? 'Inspected'
                  : `No access — ${result.reason ?? ''}`}
              </Text>
            </View>
          )
        })}
      </View>
    )
  }

  return (
    <View style={styles.row} wrap={false}>
      <Text style={styles.key}>{field.label}</Text>
      <Text style={styles.value}>{displayValue(field, value)}</Text>
    </View>
  )
}

/** Same rule as the on-screen document: print labels, never storage codes. */
function displayValue(field: FieldDef, value: unknown): string {
  if (value === undefined || value === null || value === '') return '—'

  if (field.kind === 'select') {
    return (
      field.options.find((o) => o.value === String(value))?.label ??
      String(value)
    )
  }
  if (field.kind === 'chips' && Array.isArray(value)) {
    return value
      .map((v) => field.options.find((o) => o.value === v)?.label ?? String(v))
      .join(', ')
  }
  return String(value)
}

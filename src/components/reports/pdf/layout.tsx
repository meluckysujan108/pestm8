import { Image, StyleSheet, Text, View } from '@react-pdf/renderer'

/**
 * `fixed` (repeats on every page at this position) plus `position: absolute`
 * for the footer, and the `render` callback for real page numbers — both
 * silently produce nothing under the browser build `DownloadPdfButton` used
 * to generate from, which is why neither existed before PDF generation moved
 * server-side (see `ReportPdf.tsx`'s history). Safe here: this module is only
 * ever rendered inside the Convex Node action in `convex/reportPdf.tsx`.
 */
const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  logo: { width: 30, height: 30, objectFit: 'contain' },
  logoPlaceholder: { width: 30, height: 30 },
  licence: { fontSize: 8, color: '#8E8E93' },
  footer: {
    position: 'absolute',
    bottom: 24,
    left: 44,
    right: 44,
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: '#E5E5EA',
    paddingTop: 6,
    fontSize: 8,
    color: '#8E8E93',
  },
})

export function PdfHeader({
  logoUrl,
  licenceNumber,
}: {
  logoUrl?: string | null
  licenceNumber?: string
}) {
  if (!logoUrl && !licenceNumber) return null
  return (
    <View style={styles.header} fixed>
      {logoUrl ? (
        <Image src={logoUrl} style={styles.logo} />
      ) : (
        <View style={styles.logoPlaceholder} />
      )}
      <Text style={styles.licence}>
        {licenceNumber ? `Licence ${licenceNumber}` : ''}
      </Text>
    </View>
  )
}

export function PdfFooter({
  formId,
  timestamp,
}: {
  formId: string
  timestamp?: string
}) {
  return (
    <View style={styles.footer} fixed>
      <Text>
        {formId}
        {timestamp ? ` · ${timestamp}` : ''}
      </Text>
      <Text
        render={({ pageNumber, totalPages }) =>
          `Page ${pageNumber} of ${totalPages}`
        }
      />
    </View>
  )
}

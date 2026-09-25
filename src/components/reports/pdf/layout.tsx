import { Image, StyleSheet, Text, View } from '@react-pdf/renderer'
import { COLOURS, FONT, SIZES } from './theme'

/**
 * The chrome every page carries: who issued this document, what it is, and
 * where you are in it.
 *
 * `fixed` (repeats on every page at this position) plus `position: absolute`
 * for the footer, and the `render` callback for real page numbers — all three
 * silently produce nothing under the browser build the app's old Download
 * button used to generate from, which is why none of them existed before PDF
 * generation moved server-side. Safe here: this module is only ever rendered inside the Convex
 * Node action in `convex/reportPdf.tsx`.
 */
const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 14,
  },
  logo: { width: 76, height: 30, objectFit: 'contain', objectPosition: 'left' },
  logoPlaceholder: { width: 76, height: 30 },
  business: { alignItems: 'flex-end' },
  businessName: {
    fontSize: SIZES.caption + 0.5,
    fontFamily: FONT.bold,
    color: COLOURS.ink,
  },
  businessLine: {
    fontSize: SIZES.caption,
    color: COLOURS.ink2,
    marginTop: 1.5,
  },

  band: {
    flexDirection: 'row',
    backgroundColor: COLOURS.red,
    alignItems: 'center',
    marginBottom: 10,
  },
  bandText: {
    flex: 1,
    paddingVertical: 6,
    paddingHorizontal: 10,
    fontSize: SIZES.band,
    fontFamily: FONT.bold,
    color: COLOURS.white,
  },
  // A white hairline, not a gap: the source band is one solid bar with the
  // date fenced off at its right end.
  bandDivider: {
    width: 1.5,
    alignSelf: 'stretch',
    backgroundColor: COLOURS.white,
  },
  bandDate: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    fontSize: SIZES.band,
    fontFamily: FONT.bold,
    color: COLOURS.white,
  },

  footer: {
    position: 'absolute',
    bottom: 22,
    left: SIZES.pageX,
    right: SIZES.pageX,
  },
  footerTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    fontSize: SIZES.caption,
    fontFamily: FONT.bold,
    color: COLOURS.ink,
    paddingBottom: 3,
  },
  footerRule: { height: 1.5, backgroundColor: COLOURS.red },
  footerMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 3,
    fontSize: SIZES.caption - 0.5,
    color: COLOURS.ink2,
  },
})

export function PdfHeader({
  logoUrl,
  lines,
}: {
  logoUrl?: string
  /** Trading name first, then the ways to reach them. */
  lines: Array<string>
}) {
  if (!logoUrl && lines.length === 0) return null
  const [name, ...rest] = lines
  return (
    <View style={styles.header} fixed>
      {logoUrl ? (
        <Image src={logoUrl} style={styles.logo} />
      ) : (
        <View style={styles.logoPlaceholder} />
      )}
      <View style={styles.business}>
        {name && <Text style={styles.businessName}>{name}</Text>}
        {rest.map((line) => (
          <Text key={line} style={styles.businessLine}>
            {line}
          </Text>
        ))}
      </View>
    </View>
  )
}

/**
 * The red band above the first section — the document's own title, in the
 * business's words, beside the day the work was done.
 *
 * Not `fixed`: it belongs to the top of the report, not to every page. The
 * running title lives in the footer, where the source form puts it.
 */
export function PdfTitleBand({ text, date }: { text: string; date?: string }) {
  return (
    <View style={styles.band} wrap={false}>
      <Text style={styles.bandText}>{text}</Text>
      {date && (
        <>
          <View style={styles.bandDivider} />
          <Text style={styles.bandDate}>{date}</Text>
        </>
      )}
    </View>
  )
}

/**
 * Every page's foot: what this document is and which page you hold, over the
 * red rule, with the provenance line under it.
 *
 * `Submitted by:`, `Submission ID:` and `Version:` are the source form's own
 * labels, kept verbatim over PestM8's own values — the submission id is the
 * business's report number and the version counts amendments rather than
 * resubmissions, both recorded in `docs/reports/fidelity.md`. The vendor's
 * "paperless solution by …" line is dropped: the operator's document carries
 * the operator's name.
 */
export function PdfFooter({
  formName,
  submittedBy,
  submissionId,
  version,
}: {
  formName: string
  submittedBy?: string
  /** Absent on a draft, and on documents finalised before the sequence began. */
  submissionId?: number
  version: number
}) {
  return (
    <View style={styles.footer} fixed>
      <View style={styles.footerTop}>
        <Text>{formName}</Text>
        <Text
          render={({ pageNumber, totalPages }) =>
            `Page ${pageNumber} of ${totalPages}`
          }
        />
      </View>
      <View style={styles.footerRule} />
      <View style={styles.footerMeta}>
        <Text>{submittedBy ? `Submitted by: ${submittedBy}` : ''}</Text>
        <Text>{`Version: ${version}`}</Text>
      </View>
      {submissionId !== undefined && (
        <Text
          style={styles.footerMeta}
        >{`Submission ID: ${submissionId}`}</Text>
      )}
    </View>
  )
}

import { Document, Font, Page, StyleSheet, Text, View } from '@react-pdf/renderer'
import { buildReportModel } from '../../../lib/reportTemplates/documentModel'
import { resolveReportTemplate } from '../../../lib/reportTemplates/resolve'
import { CoverPage } from './CoverPage'
import { PdfFooter, PdfHeader, PdfTitleBand } from './layout'
import { GridTable, KeyValueTable, PhotoGrid } from './tables'
import { RichTextPdf } from './RichTextPdf'
import { COLOURS, FONT, SIZES } from './theme'
import type {
  DocBlock,
  DocSection,
  GalleryPhotoInput,
} from '../../../lib/reportTemplates/documentModel'
import type { PresentContext } from '../../../lib/reportTemplates/present'
import type { TemplateId } from '../../../lib/reportTemplates'
import type {
  CustomTemplateShape,
  TemplateSnapshotShape,
} from '../../../lib/reportTemplates/resolve'
import type { TemplateSettings } from '../../../lib/reportTemplates/settings'

/**
 * The document a client receives, painted from `buildReportModel`.
 *
 * This file decides pixels and nothing else. What prints, under which heading,
 * in what order and with what value is all the model's, so the PDF and the
 * on-screen document cannot drift into saying different things about the same
 * signed report — which is exactly what two seven-hundred-line painters
 * agreeing by hand had been doing.
 *
 * Hyphenation off, everywhere. Nothing here is justified, so a ragged right
 * edge costs nothing — and react-pdf's default splits words the source forms
 * print whole ("prop- erty", "In- spection"), along with product names and
 * addresses a reader may need to copy exactly. Registered once, at module
 * scope, because react-pdf's font registry is global to the process.
 */
Font.registerHyphenationCallback((word) => [word])

export type PdfGalleryPhoto = GalleryPhotoInput

export type PdfReport = {
  template: TemplateId | 'custom'
  customTemplate?: CustomTemplateShape | null
  templateVersion?: number
  /** The frozen wording this report was signed against, if it has been. */
  templateSnapshot?: TemplateSnapshotShape | null
  /**
   * The business's own cover wording and signing rule. Only ever set on a
   * DRAFT preview: a finalised report's chrome is inside its snapshot.
   */
  settings?: TemplateSettings | null
  /** The records this document prints from without asking. */
  context?: PresentContext | null
  legalBasis: string
  finalised?: boolean
  finalisedAt?: number
  /** The business's own number for this document, printed as its Submission ID. */
  reportNumber?: number
  /** Amendments, not resubmissions. */
  version?: number
  /** Who pressed Finalise, which is not always who the form names. */
  submittedBy?: string
  data: Record<string, unknown>
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
  licenceNumber?: string
  /** Fixed named slots, e.g. the legacy `photos` field kind. */
  photos?: Record<string, string>
  /** Open-ended `gallery` fields, grouped by field key at render time. */
  galleryPhotos?: Array<PdfGalleryPhoto>
  /** Stamped across every page while this is only a preview of a draft. */
  watermark?: string
}

const styles = StyleSheet.create({
  page: {
    paddingTop: SIZES.pageTop,
    paddingBottom: SIZES.pageBottom,
    paddingHorizontal: SIZES.pageX,
    fontSize: SIZES.body,
    color: COLOURS.ink,
    fontFamily: FONT.regular,
  },
  // `lineHeight` deliberately lives here, not on `page` above: setting it at
  // the Page level breaks `fixed` + `position: absolute` layout in this
  // @react-pdf/renderer version — the footer silently renders nothing at all
  // (confirmed by bisection; not documented upstream). Scoping it to a body
  // wrapper keeps the visual line spacing without the header/footer, which are
  // direct Page children outside this wrapper.
  //
  // `fontSize` has to sit beside `lineHeight` here. A unitless lineHeight
  // resolves against the font size on ITS OWN style object, not the inherited
  // one, and react-pdf's default is 18pt — so `{ lineHeight: 1.4 }` alone set
  // a 25pt leading on 9.5pt text and double-spaced every wrapped paragraph in
  // the document. Measured, not guessed.
  body: { fontSize: SIZES.body, lineHeight: 1.3 },

  printHeading: { fontSize: 13, fontFamily: FONT.bold, marginBottom: 2 },
  standardsLine: { fontSize: SIZES.caption, color: COLOURS.ink2, marginBottom: 10 },

  sectionHeading: {
    fontSize: SIZES.heading,
    color: COLOURS.red,
    marginTop: 18,
    marginBottom: 6,
  },
  preamble: { fontSize: SIZES.caption, color: COLOURS.ink2, marginBottom: 5 },

  subHeading: {
    fontSize: SIZES.subHeading + 0.5,
    fontFamily: FONT.bold,
    color: COLOURS.red,
    marginTop: 12,
    marginBottom: 4,
  },
  subHeadingNote: { fontSize: SIZES.caption, color: COLOURS.muted, marginBottom: 3 },

  note: {
    marginTop: 6,
    marginBottom: 6,
    paddingLeft: 8,
    borderLeftWidth: 1.5,
    borderLeftColor: COLOURS.hairline,
  },
  noteImportant: { borderLeftColor: COLOURS.red },
  noteHeading: { fontSize: SIZES.subHeading, fontFamily: FONT.bold, marginBottom: 2 },
  noteHeadingImportant: { color: COLOURS.red },
  // Helvetica-Oblique is one of the standard 14, so a statement can be set in
  // italic without registering a font.
  statement: { fontFamily: 'Helvetica-Oblique' },

  photosLabel: { fontSize: SIZES.body, marginTop: 8, marginBottom: 4 },
  noticeBox: {
    fontFamily: 'Courier',
    fontSize: 9,
    lineHeight: 1.45,
    padding: 10,
    borderWidth: 1,
    borderColor: COLOURS.hairline,
  },
  noticeHint: { marginTop: 6, fontSize: SIZES.caption, color: COLOURS.amber },
  legacyTerms: { fontSize: SIZES.caption, color: COLOURS.ink2, marginBottom: 6 },

  watermark: {
    position: 'absolute',
    top: '45%',
    left: 0,
    right: 0,
    textAlign: 'center',
    fontSize: 64,
    fontFamily: FONT.bold,
    color: COLOURS.red,
    opacity: 0.12,
    transform: 'rotate(-28deg)',
  },
})

export function ReportPdf({ report }: { report: PdfReport }) {
  const template = resolveReportTemplate({
    template: report.template,
    templateVersion: report.templateVersion,
    customTemplate: report.customTemplate,
    templateSnapshot: report.templateSnapshot,
    settings: report.settings,
  })

  const model = buildReportModel({
    template,
    data: report.data,
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
    slotPhotos: report.photos,
    galleryPhotos: report.galleryPhotos,
    submittedBy: report.submittedBy,
    finalisedAt: report.finalisedAt,
    reportNumber: report.reportNumber,
    version: report.version,
    finalised: report.finalised ?? report.finalisedAt !== undefined,
    licenceNumber: report.licenceNumber,
  })

  return (
    <Document
      title={model.identity.title}
      subject={model.identity.subject}
      author={report.businessName}
      creator="PestM8"
      language="en-AU"
    >
      {model.cover && (
        <CoverPage
          cover={{ ...model.cover, logoUrl: model.header.logoUrl }}
          watermark={report.watermark}
        />
      )}

      <Page size="A4" style={styles.page}>
        {report.watermark && (
          <Text style={styles.watermark} fixed>
            {report.watermark}
          </Text>
        )}

        <PdfHeader logoUrl={model.header.logoUrl} lines={model.header.lines} />

        <View style={styles.body}>
          {model.titleBand && (
            <PdfTitleBand text={model.titleBand.text} date={model.titleBand.date} />
          )}

          {/* The AS forms' own header lines and standards reference, verbatim,
              where a Service Report carries its title band instead. */}
          {model.headings.map((line) => (
            <Text key={line} style={styles.printHeading}>
              {line}
            </Text>
          ))}
          {model.standardsLine && (
            <Text style={styles.standardsLine}>{model.standardsLine}</Text>
          )}

          {model.sections.map((section) => (
            <Section key={section.key} section={section} />
          ))}

          {model.photoGroups.map((group) => (
            <View key={group.key}>
              <Text style={styles.sectionHeading} minPresenceAhead={120}>
                {group.label}
              </Text>
              <PhotoGrid photos={group.photos} />
            </View>
          ))}

          {model.notice && (
            <>
              <Text style={styles.sectionHeading}>Durable Notice</Text>
              <Text style={styles.noticeBox}>{model.notice}</Text>
              <Text style={styles.noticeHint}>
                This notice must be physically fixed to the building, usually
                inside the meter box.
              </Text>
            </>
          )}

          {model.terms && (
            <View break={model.terms.onItsOwnPage}>
              {model.terms.heading && (
                <Text style={styles.sectionHeading}>{model.terms.heading}</Text>
              )}
              <RichTextPdf doc={model.terms.doc} />
            </View>
          )}

          {model.legacyTerms.map((paragraph, index) => (
            <Text key={index} style={styles.legacyTerms}>
              {paragraph}
            </Text>
          ))}
        </View>

        <PdfFooter
          formName={model.footer.formName}
          submittedBy={model.footer.submittedBy}
          submissionId={model.footer.submissionId}
          version={model.footer.version}
        />
      </Page>
    </Document>
  )
}

function Section({ section }: { section: DocSection }) {
  return (
    <View>
      {section.heading !== null && (
        <Text style={styles.sectionHeading} minPresenceAhead={60}>
          {section.number !== undefined ? `${section.number}. ` : ''}
          {section.heading}
        </Text>
      )}
      {section.preamble && <Text style={styles.preamble}>{section.preamble}</Text>}
      {section.blocks.map((block) => (
        <Block key={block.key} block={block} sectionHeading={section.heading} />
      ))}
    </View>
  )
}

function Block({
  block,
  sectionHeading,
}: {
  block: DocBlock
  sectionHeading: string | null
}) {
  switch (block.type) {
    case 'rows':
      return <KeyValueTable rows={block.rows} />

    case 'heading':
      return (
        <View>
          <Text style={styles.subHeading} minPresenceAhead={40}>
            {block.text}
          </Text>
          {block.note && <Text style={styles.subHeadingNote}>{block.note}</Text>}
        </View>
      )

    case 'note': {
      const important = block.tone === 'important'
      return (
        // No `wrap={false}`: that is the right idiom for a key/value row, where
        // an orphaned label is the failure. On a clause longer than the page it
        // pushes the whole block onto the next one instead of breaking it,
        // which is how a warranty comes to start on page 7 of 6.
        <View
          style={[
            styles.note,
            ...(important ? [styles.noteImportant] : []),
            ...(block.tone === 'statement' ? [styles.statement] : []),
          ]}
        >
          {block.heading && (
            <Text
              style={[
                styles.noteHeading,
                ...(important ? [styles.noteHeadingImportant] : []),
              ]}
            >
              {important ? `IMPORTANT: ${block.heading}` : block.heading}
            </Text>
          )}
          <RichTextPdf doc={block.doc} />
        </View>
      )
    }

    case 'table':
      return (
        <GridTable
          label={block.label}
          columns={block.columns}
          rows={block.rows}
          captioned={block.label !== sectionHeading}
        />
      )

    case 'photos':
      return (
        <View>
          <Text style={styles.photosLabel} minPresenceAhead={120}>
            {block.label}
          </Text>
          <PhotoGrid photos={block.photos} />
        </View>
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

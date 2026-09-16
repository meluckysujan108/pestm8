import { Image, StyleSheet, Text, View } from '@react-pdf/renderer'
import { RichTextPdf } from './RichTextPdf'
import { COLOURS, FONT, LABEL_WIDTH, SIZES, VALUE_WIDTH } from './theme'
import type { DocBar, DocPhoto, DocRow } from '../../../lib/reportTemplates/documentModel'

/**
 * The three shapes a printed report is made of: labelled answers, a repeating
 * table, and evidence.
 *
 * Each row is `wrap={false}` — a label orphaned at the foot of one page with
 * its answer on the next is a document that says something it does not mean.
 * Prose is deliberately NOT wrapped that way; see `RichTextPdf`.
 */
const styles = StyleSheet.create({
  table: { borderTopWidth: 0.5, borderTopColor: COLOURS.rowRule },
  row: { flexDirection: 'row', alignItems: 'stretch' },
  label: {
    width: LABEL_WIDTH,
    backgroundColor: COLOURS.labelTint,
    paddingVertical: 3.5,
    paddingHorizontal: 8,
    fontSize: SIZES.body,
    lineHeight: 1.3,
    color: COLOURS.ink,
    borderBottomWidth: 0.5,
    borderBottomColor: COLOURS.rowRule,
    borderBottomStyle: 'dotted',
  },
  value: {
    width: VALUE_WIDTH,
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderBottomColor: COLOURS.rowRule,
    borderBottomStyle: 'dotted',
  },
  valueBody: {
    flex: 1,
    paddingVertical: 3.5,
    paddingHorizontal: 8,
    fontSize: SIZES.body,
    lineHeight: 1.3,
  },
  /** The coloured bar the source draws at the left edge of an answer. */
  bar: { width: SIZES.bar, alignSelf: 'stretch' },
  barSpacer: { width: SIZES.bar },
  warn: { color: COLOURS.amber },
  pairRow: { flexDirection: 'row', paddingVertical: 1 },
  pairLabel: { width: '40%', color: COLOURS.muted, fontSize: SIZES.body - 0.5 },
  pairValue: { width: '60%', fontSize: SIZES.body - 0.5 },
  signature: { width: 150, height: 52, objectFit: 'contain', objectPosition: 'left' },
  signedBy: { fontSize: SIZES.caption, color: COLOURS.muted, marginTop: 2 },

  gridHead: { flexDirection: 'row', backgroundColor: COLOURS.red },
  gridHeadCell: {
    paddingVertical: 4,
    paddingHorizontal: 5,
    fontSize: SIZES.caption,
    lineHeight: 1.25,
    fontFamily: FONT.bold,
    color: COLOURS.white,
    borderRightWidth: 0.5,
    borderRightColor: COLOURS.white,
  },
  gridRow: { flexDirection: 'row' },
  gridCell: {
    paddingVertical: 4,
    paddingHorizontal: 5,
    fontSize: SIZES.caption,
    lineHeight: 1.25,
    color: COLOURS.ink,
    borderWidth: 0.5,
    borderColor: COLOURS.hairline,
  },
  gridLabel: { fontSize: SIZES.body, marginBottom: 3 },

  photoRow: { flexDirection: 'row', marginBottom: 6 },
  photoTile: { paddingRight: 8 },
  photoCaption: { fontSize: SIZES.caption - 0.5, color: COLOURS.muted, marginTop: 2 },
})

const BAR_COLOUR: Record<DocBar, string> = {
  good: COLOURS.green,
  warn: COLOURS.amber,
  danger: COLOURS.red,
}

export function KeyValueTable({ rows }: { rows: Array<DocRow> }) {
  return (
    <View style={styles.table}>
      {rows.map((row) => (
        <View key={row.key} style={styles.row} wrap={false}>
          <Text style={styles.label}>{row.label}</Text>
          <View style={styles.value}>
            {/* The bar and its spacer are the same width, so an answer with a
                bar and one without still start at the same place down the
                column. Without that, a checklist reads as ragged. */}
            {row.bar ? (
              <View style={[styles.bar, { backgroundColor: BAR_COLOUR[row.bar] }]} />
            ) : (
              <View style={styles.barSpacer} />
            )}
            <View style={styles.valueBody}>
              <RowValue row={row} />
            </View>
          </View>
        </View>
      ))}
    </View>
  )
}

/**
 * Paints what `present()` decided, in @react-pdf primitives.
 *
 * A `switch` with an exhaustiveness guard, mirroring its on-screen twin. It
 * was once an if-chain ending in an unguarded fallthrough that read
 * `shown.text`, so a new `Presented` variant would have printed `undefined` on
 * a document that gets signed and emailed.
 */
function RowValue({ row }: { row: DocRow }) {
  const shown = row.shown
  switch (shown.kind) {
    case 'text':
      return (
        <Text style={shown.tone === 'warn' ? styles.warn : undefined}>
          {shown.text}
        </Text>
      )

    case 'blank':
      return <Text style={{ color: COLOURS.muted }}>—</Text>

    case 'lines':
      return (
        <>
          {shown.lines.map((line) => (
            <Text key={line}>{line}</Text>
          ))}
        </>
      )

    case 'pairs':
      return (
        <>
          {shown.pairs.map((pair) => (
            <View key={pair.label} style={styles.pairRow}>
              <Text style={styles.pairLabel}>{pair.label}</Text>
              <Text
                style={[styles.pairValue, ...(pair.tone === 'warn' ? [styles.warn] : [])]}
              >
                {pair.value}
              </Text>
            </View>
          ))}
        </>
      )

    case 'image':
      return (
        <>
          <Image src={shown.url} style={styles.signature} />
          {shown.caption && <Text style={styles.signedBy}>{shown.caption}</Text>}
        </>
      )

    case 'rich':
      return <RichTextPdf doc={shown.doc} />

    // Both are lifted out of the row flow by `buildReportModel` — a grid
    // becomes its own table block, a photo set its own group — so neither can
    // reach a 62% value column.
    case 'grid':
    case 'omit':
      return null

    default: {
      const _exhaustive: never = shown
      void _exhaustive
      return null
    }
  }
}

/**
 * A repeating table under its own column headings — the treatments applied.
 *
 * The header row is `fixed`, so a table long enough to break across pages
 * carries its headings onto the second one rather than leaving a client to
 * guess which column held the product and which the quantity.
 */
export function GridTable({
  label,
  columns,
  rows,
  captioned,
}: {
  label: string
  columns: Array<{ label: string; width: number }>
  rows: Array<Array<string>>
  /** False when the section heading already says this — no caption twice. */
  captioned: boolean
}) {
  return (
    <View>
      {captioned && <Text style={styles.gridLabel}>{label}</Text>}
      <View style={styles.gridHead} fixed>
        {columns.map((column) => (
          <Text
            key={column.label}
            style={[styles.gridHeadCell, { width: `${column.width}%` }]}
          >
            {column.label}
          </Text>
        ))}
      </View>
      {rows.map((row, index) => (
        <View key={index} style={styles.gridRow} wrap={false}>
          {row.map((cell, cellIndex) => (
            <Text
              key={cellIndex}
              style={[
                styles.gridCell,
                { width: `${columns[cellIndex]?.width ?? 100 / row.length}%` },
              ]}
            >
              {cell}
            </Text>
          ))}
        </View>
      ))}
    </View>
  )
}

/**
 * How wide the tiles in a photo set are.
 *
 * Portrait photos go three to a row and landscape photos two. That reads
 * backwards until you work it through: every photo is drawn `contain` inside a
 * height cap, so a portrait in a wide column hits the cap and leaves white
 * space either side of itself, while a landscape in a narrow column prints
 * postage-stamp small. Three columns is also what the source form's own photo
 * pages use, and phone photos of a subfloor are almost always portrait.
 */
const CONTENT_WIDTH_PT = 595.28 - SIZES.pageX * 2
const MAX_TILE_HEIGHT_PT = 240

function columnsFor(photos: Array<DocPhoto>): number {
  const known = photos.filter((photo) => photo.width && photo.height)
  if (known.length === 0) return 3
  const landscape = known.filter((photo) => photo.width! > photo.height!).length
  return landscape > known.length / 2 ? 2 : 3
}

function tileHeight(photo: DocPhoto, columnWidth: number): number {
  // A photo whose dimensions were never recorded keeps a fixed box: guessing a
  // shape for it would be worse than the box.
  if (!photo.width || !photo.height) return 120
  return Math.min(MAX_TILE_HEIGHT_PT, (photo.height / photo.width) * columnWidth)
}

export function PhotoGrid({ photos }: { photos: Array<DocPhoto> }) {
  const columns = columnsFor(photos)
  const columnWidth = CONTENT_WIDTH_PT / columns - 8

  const rows: Array<Array<DocPhoto>> = []
  for (let i = 0; i < photos.length; i += columns) {
    rows.push(photos.slice(i, i + columns))
  }

  return (
    <View>
      {/* Chunked in JS and kept whole a row at a time, rather than one
          unbreakable block: a set of twelve photos taller than a page would
          otherwise be pushed off it and clipped. */}
      {rows.map((row, index) => (
        <View key={index} style={styles.photoRow} wrap={false}>
          {row.map((photo) => (
            <View key={photo.key} style={[styles.photoTile, { width: `${100 / columns}%` }]}>
              <Image
                src={photo.url}
                style={{
                  width: '100%',
                  height: tileHeight(photo, columnWidth),
                  objectFit: 'contain',
                  objectPosition: 'left top',
                }}
              />
              {photo.caption && (
                <Text style={styles.photoCaption}>{photo.caption}</Text>
              )}
            </View>
          ))}
        </View>
      ))}
    </View>
  )
}

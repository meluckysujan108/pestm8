import { StyleSheet, Text, View } from '@react-pdf/renderer'
import type {
  RichBlock,
  RichDoc,
  RichMark,
  RichText as RichTextNode,
} from '../../../lib/reportTemplates'

/**
 * The PDF painter for `RichDoc` — twin of `RichText.tsx` on screen.
 *
 * Two constraints shape every choice here. @react-pdf has no list primitive, so
 * a bullet is a two-column row built by hand. And nothing in this app calls
 * `Font.register`, so only the 14 standard PDF fonts exist: emphasis is
 * `Helvetica-Bold`, matching the convention the rest of the document already
 * uses, rather than a `fontWeight` that would resolve to a family nobody
 * registered.
 *
 * Prose is never wrapped in `wrap={false}`. That is the house idiom for a field
 * row, where an orphaned label is the failure; for a clause longer than the
 * page it has the opposite effect, pushing the whole block rather than breaking
 * it. `orphans`/`widows` do the job that `wrap={false}` cannot.
 */

const styles = StyleSheet.create({
  h1: { fontSize: 11, fontFamily: 'Helvetica-Bold', marginTop: 10, marginBottom: 3 },
  h2: { fontSize: 10, fontFamily: 'Helvetica-Bold', marginTop: 8, marginBottom: 2 },
  h3: { fontSize: 9.5, fontFamily: 'Helvetica-Bold', marginTop: 6, marginBottom: 2 },
  // Matches `boilerplate` in ReportPdf so printed terms and a printed note
  // read as the same voice.
  paragraph: { fontSize: 8.5, color: '#3A3A3C', marginBottom: 4 },
  bold: { fontFamily: 'Helvetica-Bold' },
  redText: { fontFamily: 'Helvetica-Bold', color: '#C8102E' },
  caps: { textTransform: 'uppercase' },
  bulletRow: { flexDirection: 'row', marginBottom: 2 },
  bulletMark: { fontSize: 8.5, color: '#3A3A3C', width: 12 },
  bulletBody: { flex: 1 },
  definition: { marginBottom: 4 },
  term: { fontSize: 8.5, fontFamily: 'Helvetica-Bold', color: '#1C1C1E' },
})

const MARK_STYLE = {
  bold: styles.bold,
  redText: styles.redText,
  caps: styles.caps,
} satisfies Record<RichMark, unknown>

const HEADING_STYLE = { 1: styles.h1, 2: styles.h2, 3: styles.h3 } as const

/** Nested `Text` is @react-pdf's inline-styling primitive — the only one. */
function Inline({ nodes }: { nodes: Array<RichTextNode> }) {
  return (
    <>
      {nodes.map((node, index) => (
        <Text key={index} style={(node.marks ?? []).map((m) => MARK_STYLE[m])}>
          {node.text}
        </Text>
      ))}
    </>
  )
}

function Block({ block }: { block: RichBlock }) {
  switch (block.type) {
    case 'heading':
      return (
        <Text style={HEADING_STYLE[block.level]} minPresenceAhead={40}>
          <Inline nodes={block.content} />
        </Text>
      )

    case 'paragraph':
      return (
        <Text style={styles.paragraph} orphans={2} widows={2}>
          <Inline nodes={block.content} />
        </Text>
      )

    case 'bulletList':
      return (
        <View>
          {block.content.map((item, index) => (
            <View key={index} style={styles.bulletRow}>
              <Text style={styles.bulletMark}>•</Text>
              <View style={styles.bulletBody}>
                <Blocks blocks={item.content} />
              </View>
            </View>
          ))}
        </View>
      )

    case 'definitionList':
      return (
        <View>
          {block.content.map((item, index) => (
            <View key={index} style={styles.definition}>
              <Text style={styles.term}>{item.term}</Text>
              <Blocks blocks={item.content} />
            </View>
          ))}
        </View>
      )

    default: {
      const _exhaustive: never = block
      void _exhaustive
      return null
    }
  }
}

function Blocks({ blocks }: { blocks: Array<RichBlock> }) {
  return (
    <>
      {blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </>
  )
}

export function RichTextPdf({ doc }: { doc: RichDoc }) {
  return (
    <View>
      <Blocks blocks={doc.content} />
    </View>
  )
}

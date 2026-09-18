import {
  Defs,
  Image,
  LinearGradient,
  Page,
  Path,
  Rect,
  StyleSheet,
  Stop,
  Svg,
  Text,
  View,
} from '@react-pdf/renderer'
import { COLOURS, FONT, SIZES } from './theme'
import type { ReportModel } from '../../../lib/reportTemplates/documentModel'

/**
 * The page a client sees first: their own house, the operator's mark, and what
 * this document is.
 *
 * The photo is full-bleed across the top and a white wave cuts across its
 * bottom edge — the source form's own anatomy, and the reason the Service
 * Report asks for "1 Landscape Photo" in the first place. It is drawn with
 * `Svg`/`Path` rather than a raster overlay so it stays sharp at any zoom and
 * costs nothing to fetch.
 *
 * `objectFit: 'cover'` here, and only here: this is a designed band, not
 * evidence. Every other photo in the document is drawn at its own aspect,
 * because cropping a photo of a subfloor can remove the thing it was taken to
 * show.
 */
const styles = StyleSheet.create({
  page: { padding: 0, backgroundColor: COLOURS.white },
  photo: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '46%',
    objectFit: 'cover',
  },
  // No photo: a red panel of the same height, so the page keeps its shape
  // rather than opening on half a sheet of white. Graded rather than flat —
  // half a page of one solid colour reads as a printing fault.
  panel: { position: 'absolute', top: 0, left: 0, right: 0, height: '46%' },
  wave: { position: 'absolute', top: '33%', left: 0, right: 0, height: '17%' },
  logo: {
    position: 'absolute',
    top: '55%',
    left: SIZES.pageX,
    width: 132,
    height: 34,
    objectFit: 'contain',
    objectPosition: 'left',
  },
  block: {
    position: 'absolute',
    top: '64%',
    left: SIZES.pageX,
    right: SIZES.pageX,
  },
  rule: { height: 2, backgroundColor: COLOURS.red },
  title: {
    fontSize: 38,
    fontFamily: FONT.bold,
    color: '#5A5A5F',
    paddingVertical: 12,
  },
  subtitle: {
    fontSize: 12,
    fontFamily: FONT.bold,
    color: COLOURS.ink,
    marginTop: 12,
  },
  address: { fontSize: 11, color: COLOURS.ink2, marginTop: 5 },
  date: { fontSize: 10, color: COLOURS.muted, marginTop: 3 },
  watermark: {
    position: 'absolute',
    top: '62%',
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

export function CoverPage({
  cover,
  watermark,
}: {
  cover: NonNullable<ReportModel['cover']> & { logoUrl?: string }
  /** Stamped here too: "every page" has to include the one people look at. */
  watermark?: string
}) {
  return (
    <Page size="A4" style={styles.page}>
      {cover.photo ? (
        <Image src={cover.photo.url} style={styles.photo} />
      ) : (
        <Svg
          style={styles.panel}
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          <Defs>
            <LinearGradient id="coverPanel" x1="0" y1="0" x2="0.35" y2="1">
              <Stop offset="0" stopColor={COLOURS.red} />
              <Stop offset="1" stopColor="#C8102E" />
            </LinearGradient>
          </Defs>
          <Rect x={0} y={0} width={100} height={100} fill="url(#coverPanel)" />
        </Svg>
      )}

      <Svg style={styles.wave} viewBox="0 0 600 120" preserveAspectRatio="none">
        {/* Fills everything below the crest, so the photo above it keeps its
            own edge and the page below stays white. */}
        <Path
          d="M0,42 C110,0 190,92 300,58 C410,24 495,104 600,62 L600,120 L0,120 Z"
          fill={COLOURS.white}
        />
        {/* The second, trailing curve: a grey line a little below the white
            edge, which is what gives the band its depth on the printed form. */}
        <Path
          d="M0,62 C110,20 190,112 300,78 C410,44 495,124 600,82"
          stroke="#8E8E93"
          strokeWidth={2}
          fill="none"
        />
      </Svg>

      {cover.logoUrl && <Image src={cover.logoUrl} style={styles.logo} />}

      <View style={styles.block}>
        <View style={styles.rule} />
        <Text style={styles.title}>{cover.title}</Text>
        <View style={styles.rule} />
        {cover.subtitle && (
          <Text style={styles.subtitle}>{cover.subtitle}</Text>
        )}
        {cover.address && <Text style={styles.address}>{cover.address}</Text>}
        {/* The vendor's cover carries no date. A document a client files for
            years should say when the visit was without being opened. */}
        {cover.date && <Text style={styles.date}>{cover.date}</Text>}
      </View>

      {watermark && <Text style={styles.watermark}>{watermark}</Text>}
    </Page>
  )
}

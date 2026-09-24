/**
 * Whose mark is whose, by colour: yours in the pen's red, a teammate's in
 * their member colour — unless that colour would pass for the pen's.
 *
 * It would, for the most common team there is. Member colours are dealt in
 * order (`convex/lib/colours.ts`), the owner blue and the second person
 * `#DC2626` — a red a shade deeper than the pen's `--red`. Side by side on a
 * rail the two are different reds; as a 3-pixel line on white paper, on its
 * own, in the sun, they are the same one. Terence would open a report Kevin
 * had marked, see his own red, tap "Clear my marks on page 2" and watch
 * Kevin's marks stay put — correctly, as nobody clears anyone else's — and
 * conclude that Clear is broken, with no way to tell which marks Undo will
 * take. So a teammate's colour that close to the pen's is not used: their
 * marks go in the one neutral colour instead, which never passes for yours.
 *
 * "Close" is measured in OKLab, where equal distances look roughly equally
 * different: `#DC2626` sits 0.08 from the pen's red, the palette's next
 * nearest (pink) 0.13, and grey 0.23. A colour that cannot be read here (a
 * `var(--…)`, a name) is taken as given — the caller chose it knowing the
 * pen is red.
 */

/**
 * The pen's red, `--red` in `src/styles.css`, in the light theme and the
 * dark. Restated here only to measure against — the lines themselves are
 * drawn with the token — and `markupColour.test.ts` reads the stylesheet to
 * keep the two in step.
 */
export const PEN_REDS = ['#ff3b30', '#ff453a'] as const

/** Nearer than this to either pen red, a mark would pass for yours. */
export const PEN_CLASH_DISTANCE = 0.1

type Rgb = readonly [number, number, number]

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/
const NUMBER = String.raw`(\d+(?:\.\d+)?)`
const RGB = new RegExp(
  String.raw`^rgba?\(\s*${NUMBER}[\s,]+${NUMBER}[\s,]+${NUMBER}\s*(?:[,/]\s*[\d.]+%?\s*)?\)$`,
)

/** `#rgb`, `#rrggbb` (alpha ignored, as the paper is opaque) or `rgb()`. */
export function parseColour(value: string): Rgb | null {
  const text = value.trim().toLowerCase()
  const hex = HEX.exec(text)
  if (hex) {
    const digits = hex[1]
    const short = digits.length <= 4
    const channel = (i: number) =>
      parseInt(
        short ? digits[i] + digits[i] : digits.slice(i * 2, i * 2 + 2),
        16,
      )
    return [channel(0), channel(1), channel(2)]
  }
  const rgb = RGB.exec(text)
  if (!rgb) return null
  const channels: Rgb = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  return channels.every((c) => c <= 255) ? channels : null
}

function linear(channel: number): number {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** Björn Ottosson's OKLab, from sRGB. */
function oklab([r8, g8, b8]: Rgb): Rgb {
  const r = linear(r8)
  const g = linear(g8)
  const b = linear(b8)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

/** How different two colours look, in OKLab; null if either is unreadable. */
export function colourDistance(a: string, b: string): number | null {
  const pa = parseColour(a)
  const pb = parseColour(b)
  if (!pa || !pb) return null
  const [la, aa, ba] = oklab(pa)
  const [lb, ab, bb] = oklab(pb)
  return Math.hypot(la - lb, aa - ab, ba - bb)
}

/** Whether a mark in `colour` would pass for one of yours. */
export function passesForPen(colour: string): boolean {
  return PEN_REDS.some((pen) => {
    const distance = colourDistance(colour, pen)
    return distance !== null && distance < PEN_CLASH_DISTANCE
  })
}

const verdicts = new Map<string, string | undefined>()

/**
 * The colour to draw a teammate's mark in: theirs, or undefined for the
 * neutral one — when none is known, or theirs would pass for the pen's.
 * Remembered per colour: a team has a handful, and a page may draw hundreds
 * of marks.
 */
export function teammateColour(colour: string | undefined): string | undefined {
  if (!colour) return undefined
  if (verdicts.has(colour)) return verdicts.get(colour)
  const verdict = passesForPen(colour) ? undefined : colour
  if (verdicts.size > 64) verdicts.clear()
  verdicts.set(colour, verdict)
  return verdict
}

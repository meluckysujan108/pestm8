/**
 * WCAG 2.x contrast between two opaque sRGB colours, as `#rrggbb`.
 *
 * Pure, so the colour tokens can be checked by a unit test with no browser:
 * a palette that silently drops below AA in one theme is exactly the kind of
 * regression nobody sees until they are standing in the sun with it.
 */
function channel(value: number): number {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

export function luminance(hex: string): number {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) throw new Error(`not a #rrggbb colour: ${hex}`)
  const n = parseInt(match[1], 16)
  const r = channel((n >> 16) & 0xff)
  const g = channel((n >> 8) & 0xff)
  const b = channel(n & 0xff)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

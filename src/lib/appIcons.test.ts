// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { describe, expect, test } from 'vitest'
import { APP_MARK_PATH } from '../../convex/lib/accountEmail'
import {
  APP_ICON_LINKS,
  LAUNCH_SCREENS,
  launchScreenHref,
  launchScreenLinks,
} from './appIcons'

/**
 * The icons and launch screens are drawn once by scripts/build-icons.mjs and
 * committed, so nothing at build time notices when they stop matching what
 * links them. These do: a device added to launchScreens.json without its
 * images, an image left behind by one taken off, or a --canvas colour changed
 * without redrawing the screens that are meant to match it.
 */

const REDRAW = 'run `pnpm icons` to redraw them'

function publicFile(href: string): Buffer {
  try {
    return readFileSync(new URL(`../../public${href}`, import.meta.url))
  } catch {
    throw new Error(`public${href} is missing: ${REDRAW}`)
  }
}

interface Png {
  width: number
  height: number
  /** The top-left pixel, as #rrggbb, and its alpha. */
  corner: string
  alpha: number
}

function png(data: Buffer): Png {
  expect(data.subarray(1, 4).toString()).toBe('PNG')
  const colourType = data[25]
  const channels = { 2: 3, 6: 4 }[colourType]
  if (!channels) throw new Error(`Unexpected PNG colour type ${colourType}`)
  const idat: Array<Buffer> = []
  for (let at = 8; at < data.length;) {
    const length = data.readUInt32BE(at)
    if (data.toString('latin1', at + 4, at + 8) === 'IDAT') {
      idat.push(data.subarray(at + 8, at + 8 + length))
    }
    at += 12 + length
  }
  // The first pixel of the first row reads the same under every PNG filter:
  // each one predicts from the pixels left of and above it, and there are
  // none. So it is the byte after the row's filter byte, as stored.
  const pixels = inflateSync(Buffer.concat(idat))
  const hex = (i: number) => pixels[1 + i].toString(16).padStart(2, '0')
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
    corner: `#${hex(0)}${hex(1)}${hex(2)}`,
    alpha: channels === 4 ? pixels[4] : 255,
  }
}

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
function canvas(opener: string): string {
  const start = css.indexOf(opener)
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('\n}', start))
  const value = /--canvas:\s*([^;]+);/.exec(body)?.[1]
  if (start === -1 || !value) throw new Error(`no --canvas in ${opener}`)
  return value.trim().toLowerCase()
}
const CANVAS = {
  light: canvas(":root,\n[data-theme='light'] {"),
  dark: canvas(":root[data-theme='dark'],\n[data-theme='dark'] {"),
}

describe('launch screens', () => {
  const links = launchScreenLinks()

  test('each is an image of exactly the screen its media query names', () => {
    for (const link of links) {
      const [, width, height, ratio, orientation] =
        /device-width: (\d+)px\) and \(device-height: (\d+)px\) and \(-webkit-device-pixel-ratio: (\d)\) and \(orientation: (\w+)\)$/.exec(
          link.media,
        ) ?? []
      const across = Number(width) * Number(ratio)
      const down = Number(height) * Number(ratio)
      const image = png(publicFile(link.href))
      expect([image.width, image.height], `${link.href}: ${REDRAW}`).toEqual(
        orientation === 'portrait' ? [across, down] : [down, across],
      )
    }
  })

  test('each is drawn on the canvas colour of its theme', () => {
    for (const link of links) {
      const theme = link.href.endsWith('-dark.png') ? 'dark' : 'light'
      expect(
        png(publicFile(link.href)).corner,
        `${link.href} is not on --canvas: ${REDRAW}`,
      ).toBe(CANVAS[theme])
    }
  })

  test('the dark screens follow every light one and ask for dark mode', () => {
    const firstDark = links.findIndex((l) => l.href.endsWith('-dark.png'))
    expect(firstDark).toBe(links.length / 2)
    links.forEach((link, i) => {
      const dark = i >= firstDark
      expect(link.href.endsWith(dark ? '-dark.png' : '-light.png')).toBe(true)
      expect(link.media.startsWith('(prefers-color-scheme: dark) and ')).toBe(
        dark,
      )
    })
  })

  test('every screen is listed once, and every image is linked', () => {
    const hrefs = links.map((l) => l.href)
    expect(new Set(hrefs).size).toBe(hrefs.length)
    const files = readdirSync(new URL('../../public/splash', import.meta.url))
    expect(files.map((f) => `/splash/${f}`).sort(), REDRAW).toEqual(
      [...hrefs].sort(),
    )
  })

  test('iPads get a landscape screen and iPhones do not', () => {
    for (const screen of LAUNCH_SCREENS) {
      expect(Boolean(screen.landscape), screen.devices).toBe(
        screen.devices.startsWith('iPad'),
      )
    }
    expect(
      launchScreenHref(
        { width: 820, height: 1180, ratio: 2, devices: 'iPad' },
        'landscape',
        'dark',
      ),
    ).toBe('/splash/2360x1640-dark.png')
  })
})

describe('icons', () => {
  test('the favicon holds 16, 32 and 48 px on transparent', () => {
    const ico = publicFile('/favicon.ico')
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2)]).toEqual([0, 1])
    const sizes = []
    for (let i = 0; i < ico.readUInt16LE(4); i++) {
      const entry = 6 + 16 * i
      const offset = ico.readUInt32LE(entry + 12)
      const image = png(
        ico.subarray(offset, offset + ico.readUInt32LE(entry + 8)),
      )
      expect(image.width).toBe(ico[entry])
      sizes.push(image.width)
    }
    expect(sizes).toEqual([16, 32, 48])
    expect(png(ico.subarray(ico.readUInt32LE(6 + 16 + 12))).alpha).toBe(0)
  })

  test('the Home Screen icon is 180 px and opaque, as iOS needs', () => {
    const image = png(publicFile('/apple-touch-icon.png'))
    expect([image.width, image.height, image.alpha]).toEqual([180, 180, 255])
  })

  test('the head links name files that exist', () => {
    for (const link of APP_ICON_LINKS) {
      expect(publicFile(link.href).length, link.href).toBeGreaterThan(0)
    }
  })
})

describe('manifest', () => {
  const manifest = JSON.parse(
    publicFile('/manifest.webmanifest').toString(),
  ) as {
    background_color: string
    icons: Array<{ src: string; sizes: string; purpose: string }>
  }

  test('its icons are the sizes it says, each for one purpose', () => {
    for (const icon of manifest.icons) {
      const image = png(publicFile(icon.src))
      expect(`${image.width}x${image.height}`, icon.src).toBe(icon.sizes)
      expect(['any', 'maskable'], icon.src).toContain(icon.purpose)
    }
    const purposes = manifest.icons.map((i) => `${i.purpose} ${i.sizes}`)
    expect(purposes).toEqual(
      expect.arrayContaining([
        'any 192x192',
        'any 512x512',
        'maskable 192x192',
        'maskable 512x512',
      ]),
    )
  })

  // Android draws its own launch screen in this colour. It has one colour for
  // both themes (no browser takes a dark one from the manifest yet), so it is
  // the light canvas: the app's default when the phone is in light mode.
  test('its background is the light canvas', () => {
    expect(
      manifest.background_color.toLowerCase(),
      'background_color in public/manifest.webmanifest',
    ).toBe(CANVAS.light)
  })
})

// The password emails head with the app's icon, fetched from the live app by
// its path: renamed or dropped here, every one of them shows a broken image.
describe('the mark the account emails carry', () => {
  test('is one of the icons, opaque, so it reads in light and in dark', () => {
    const mark = png(publicFile(APP_MARK_PATH))
    expect(mark.width).toBe(mark.height)
    expect(mark.width).toBeGreaterThanOrEqual(36 * 3)
    expect(mark.alpha).toBe(255)
  })
})

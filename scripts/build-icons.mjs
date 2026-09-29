/**
 * Draws the app's icons and iOS launch screens from the logo mark.
 *
 * The mark is public/icon.svg: the ant alone, on transparent, traced from the
 * logo as supplied. It is also the favicon a modern browser shows. Every other
 * file is drawn from it here, so none of them can drift from it:
 *
 *   favicon.ico                  16, 32 and 48 px on transparent, for browsers
 *                                that don't take an SVG favicon
 *   apple-touch-icon.png         180 px, the iPhone and iPad Home Screen icon
 *   icon-192.png, icon-512.png   the manifest's `any` icons (desktop installs)
 *   icon-maskable-*.png          the manifest's `maskable` icons, which Android
 *                                crops to its launcher's shape
 *   splash/*.png                 iOS launch screens (src/lib/launchScreens.json)
 *
 * A launch screen is what an iPhone shows between the tap on the Home Screen
 * icon and the app's first paint. iOS takes nothing from the manifest for it:
 * unless a <link rel="apple-touch-startup-image"> names an image of exactly
 * that screen's size, it shows black — the dark flash a Home Screen launch
 * used to open with. Each one here is the Home Screen icon on the canvas
 * colour, light and dark, read from src/styles.css so that the screen after it
 * is the same colour. src/lib/appIcons.ts links them.
 *
 * Run `pnpm icons` after changing the mark, the --canvas tokens or the device
 * list, and commit what it writes: nothing here runs at build time. Chromium
 * draws the SVG — Playwright's, which the e2e suite installs — so the script
 * needs nothing else.
 */
import { chromium } from '@playwright/test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const PUBLIC = resolve('public')
const SPLASH = resolve(PUBLIC, 'splash')

const mark = readFileSync(resolve(PUBLIC, 'icon.svg'), 'utf8')
// Square, so the favicon drawn straight from it fills its square.
if (!/viewBox="0 0 (\d+) \1"/.test(mark)) {
  throw new Error('public/icon.svg needs a square viewBox from 0 0')
}
const markPaths = mark.slice(
  mark.indexOf('>', mark.indexOf('<svg')) + 1,
  mark.lastIndexOf('</svg>'),
)

const screens = JSON.parse(
  readFileSync(resolve('src/lib/launchScreens.json'), 'utf8'),
)

/** A custom property's value in the block that opens with `opener`, as the
 * design system test reads them. */
function token(opener, name) {
  const css = readFileSync(resolve('src/styles.css'), 'utf8')
  const start = css.indexOf(opener)
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('\n}', start))
  const value = new RegExp(`--${name}:\\s*([^;]+);`).exec(body)?.[1]
  if (start === -1 || !value) throw new Error(`No --${name} in ${opener}`)
  return value.trim()
}
const CANVAS = {
  light: token(":root,\n[data-theme='light'] {", 'canvas'),
  dark: token(":root[data-theme='dark'],\n[data-theme='dark'] {", 'canvas'),
}

/** The logo's own background, behind the mark wherever it is an app icon. */
const ICON_BACKGROUND = '#000000'
/** How wide the mark is on the app icon, as a share of the icon: the logo's
 * own proportions, with room left for iOS's rounded corners. */
const ICON_MARK = 0.7
/** How far from the centre a maskable icon's content may reach, as a share of
 * the icon: Android keeps the circle 80% across (a radius of 0.4), and the
 * mark stays a little inside it. Centred as on the other icons, so it is the
 * same icon with more room around it. */
const MASKABLE_RADIUS = 0.38
/** The Home Screen icon's size on a launch screen, in points. */
const LAUNCH_ICON = 120
/** Its corner radius, as a share of its width — near enough the Home Screen's
 * own at this size. */
const LAUNCH_ICON_CORNER = 0.225

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
})
const page = await browser.newPage({ deviceScaleFactor: 1 })

async function draw(svg, width, height, { transparent = false } = {}) {
  await page.setViewportSize({ width, height })
  await page.setContent(
    `<!doctype html><body style="margin:0;background:transparent">${svg}</body>`,
  )
  return page.screenshot({
    type: 'png',
    omitBackground: transparent,
    clip: { x: 0, y: 0, width, height },
  })
}

const svg = (width, height, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="display:block">${body}</svg>`

const fill = (colour) => `<rect width="100%" height="100%" fill="${colour}"/>`

/** The mark, scaled, with its point `at` (in its own viewBox) placed on x, y. */
const place = (x, y, scale, at) =>
  `<g transform="translate(${x - at[0] * scale} ${y - at[1] * scale}) scale(${scale})">${markPaths}</g>`

// Where the mark sits in its viewBox, measured by the browser that draws it:
// its bounding box, and how far its outline reaches from the box's centre.
const { box, reach } = await page.evaluate((source) => {
  document.body.innerHTML = source
  const root = document.querySelector('svg')
  const b = root.getBBox()
  const [cx, cy] = [b.x + b.width / 2, b.y + b.height / 2]
  let farthest = 0
  for (const path of root.querySelectorAll('path')) {
    const length = path.getTotalLength()
    for (let i = 0; i < 4000; i++) {
      const p = path.getPointAtLength((i / 4000) * length)
      farthest = Math.max(farthest, Math.hypot(p.x - cx, p.y - cy))
    }
  }
  return {
    box: { x: b.x, y: b.y, width: b.width, height: b.height },
    reach: farthest,
  }
}, mark)
const boxCentre = [box.x + box.width / 2, box.y + box.height / 2]

const appIcon = (size) =>
  svg(
    size,
    size,
    fill(ICON_BACKGROUND) +
      place(size / 2, size / 2, (ICON_MARK * size) / box.width, boxCentre),
  )

const maskableIcon = (size) =>
  svg(
    size,
    size,
    fill(ICON_BACKGROUND) +
      place(size / 2, size / 2, (MASKABLE_RADIUS * size) / reach, boxCentre),
  )

function launchScreen(width, height, ratio, background) {
  const icon = LAUNCH_ICON * ratio
  const x = (width - icon) / 2
  const y = (height - icon) / 2
  return svg(
    width,
    height,
    fill(background) +
      `<rect x="${x}" y="${y}" width="${icon}" height="${icon}" rx="${icon * LAUNCH_ICON_CORNER}" fill="${ICON_BACKGROUND}"/>` +
      place(width / 2, height / 2, (ICON_MARK * icon) / box.width, boxCentre),
  )
}

/** An .ico holding PNGs, which every browser that still asks for one reads. */
function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length)
  head.writeUInt16LE(1, 2) // type: icon
  head.writeUInt16LE(images.length, 4)
  let offset = head.length
  images.forEach(({ size, png }, i) => {
    const entry = 6 + 16 * i
    head.writeUInt8(size, entry)
    head.writeUInt8(size, entry + 1)
    head.writeUInt16LE(1, entry + 4) // colour planes
    head.writeUInt16LE(32, entry + 6) // bits per pixel
    head.writeUInt32LE(png.length, entry + 8)
    head.writeUInt32LE(offset, entry + 12)
    offset += png.length
  })
  return Buffer.concat([head, ...images.map(({ png }) => png)])
}

const write = (name, data) => {
  writeFileSync(resolve(PUBLIC, name), data)
  console.log(`  ${name}  ${(data.length / 1024).toFixed(1)} KiB`)
}

const favicon = []
for (const size of [16, 32, 48]) {
  const sized = mark.replace(
    '<svg ',
    `<svg width="${size}" height="${size}" style="display:block" `,
  )
  favicon.push({
    size,
    png: await draw(sized, size, size, { transparent: true }),
  })
}
write('favicon.ico', ico(favicon))

write('apple-touch-icon.png', await draw(appIcon(180), 180, 180))
for (const size of [192, 512]) {
  write(`icon-${size}.png`, await draw(appIcon(size), size, size))
  write(`icon-maskable-${size}.png`, await draw(maskableIcon(size), size, size))
}

// Replaced whole, so a device taken off the list takes its images with it.
rmSync(SPLASH, { recursive: true, force: true })
mkdirSync(SPLASH)
for (const { width, height, ratio, landscape } of screens) {
  const sizes = [[width * ratio, height * ratio]]
  if (landscape) sizes.push([height * ratio, width * ratio])
  for (const [w, h] of sizes) {
    for (const theme of ['light', 'dark']) {
      write(
        `splash/${w}x${h}-${theme}.png`,
        await draw(launchScreen(w, h, ratio, CANVAS[theme]), w, h),
      )
    }
  }
}

await browser.close()

/**
 * Copies the files pdf.js fetches at runtime into public/pdfjs/, so the app
 * serves them from its own origin.
 *
 * pdf.js keeps some of what it needs out of its JavaScript and fetches it only
 * when a PDF asks: character maps for CJK text (`cmaps/`), the 14 standard
 * fonts for PDFs that name one without embedding it (`standard_fonts/`),
 * WebAssembly decoders for JPEG 2000 images and ICC colour (`wasm/`), and a
 * CMYK colour profile (`iccs/`). Without them a safety data sheet that uses
 * any of those renders with missing text or blank images. The viewer points
 * pdf.js at them by URL:
 *
 *   cMapUrl: '/pdfjs/cmaps/', cMapPacked: true,
 *   standardFontDataUrl: '/pdfjs/standard_fonts/',
 *   wasmUrl: '/pdfjs/wasm/', iccUrl: '/pdfjs/iccs/'
 *
 * Served from this origin rather than a CDN because a CDN is another host to
 * reach from a roof void, and because `src/sw.ts` caches same-origin
 * `/pdfjs/` requests on first use, so a PDF kept on the phone still renders
 * with no signal. They are NOT precached — about 3 MB that most PDFs never
 * touch — which is why they live under their own path.
 *
 * Copied, not committed (public/pdfjs is in .gitignore): they belong to the
 * installed pdfjs-dist, and must change when it does. The copy is skipped
 * when public/pdfjs/version.json already says what this run would write, so
 * `pnpm dev` pays for it once; a new version replaces the directory whole, so
 * no file from an older one lingers. The marker is written last, so an
 * interrupted copy is redone next time.
 *
 * The marker is also the list src/lib/keptProducts.ts fetches ahead of need
 * once a product is kept (`warm`): the decoders and fonts a page of a kept
 * PDF could ask for, so the service worker has them before the phone goes
 * somewhere with no signal. Which ones, and why, is `WARM` below. A pdf.js
 * upgrade that renames one fails this script rather than leaving kept PDFs
 * quietly without it.
 *
 * Runs before `vite dev` and `vite build` (package.json). Vercel runs
 * `pnpm run build`, so it runs there too.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIRS = ['cmaps', 'standard_fonts', 'wasm', 'iccs']

/**
 * What a kept PDF could need offline, by what the browser can run. Read
 * against how src/components/pdf/pdfjs.ts calls `getDocument`:
 *
 * - `always`: with `useSystemFonts` left at its browser default (true),
 *   pdf.js fetches a standard font only for Symbol and ZapfDingbats — the
 *   tick boxes and bullets a form-like SDS is full of. The Liberation fonts
 *   (~570 KB) would be needed only with `useSystemFonts: false`.
 * - `wasm`: the JPEG 2000 decoder (pictures in some SDS exports), and the
 *   colour-management decoder with the CMYK profile it converts print colours
 *   with (a label's hazard pictograms are usually CMYK).
 * - `nowasm`: a browser with WebAssembly switched off (iOS Lockdown Mode)
 *   cannot use either decoder, and pdf.js imports this JavaScript JPEG 2000
 *   decoder instead; colour falls back to pdf.js's own rougher conversion.
 *
 * About 400 KB either way. Character maps stay on demand: 1.6 MB, and only
 * for CJK text.
 */
const WARM = {
  always: [
    'standard_fonts/FoxitSymbol.pfb',
    'standard_fonts/FoxitDingbats.pfb',
  ],
  wasm: [
    'wasm/openjpeg.wasm',
    'wasm/qcms_bg.wasm',
    'iccs/CGATS001Compat-v2-micro.icc',
  ],
  nowasm: ['wasm/openjpeg_nowasm_fallback.js'],
}

const require = createRequire(import.meta.url)
let packageJson
try {
  packageJson = require.resolve('pdfjs-dist/package.json')
} catch {
  console.error(
    '\n✖ pdfjs-dist is not installed — run `pnpm install` before this step.',
  )
  process.exit(1)
}
const source = dirname(packageJson)
const { version } = JSON.parse(readFileSync(packageJson, 'utf8'))

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dest = join(root, 'public', 'pdfjs')
const marker = join(dest, 'version.json')
const expected = JSON.stringify({ version, dirs: DIRS, warm: WARM })

const current = existsSync(marker) ? readFileSync(marker, 'utf8') : null
if (current === expected && DIRS.every((dir) => existsSync(join(dest, dir)))) {
  console.log(`✓ pdf.js ${version} assets already in public/pdfjs`)
  process.exit(0)
}

const missing = [...DIRS, ...Object.values(WARM).flat()].filter(
  (path) => !existsSync(join(source, path)),
)
if (missing.length > 0) {
  // pdfjs-dist moved something. Failing here is the point: a build that
  // shipped without these would render some PDFs with holes in them and say
  // nothing about it.
  console.error(
    `\n✖ pdfjs-dist ${version} has no ${missing.join(', ')} — check what the viewer asks pdf.js to fetch, and WARM above.`,
  )
  process.exit(1)
}

rmSync(dest, { recursive: true, force: true })
mkdirSync(dest, { recursive: true })
for (const dir of DIRS) {
  cpSync(join(source, dir), join(dest, dir), { recursive: true })
}
writeFileSync(marker, expected)

console.log(
  `✓ Copied pdf.js ${version} assets to public/pdfjs (${DIRS.join(', ')})`,
)

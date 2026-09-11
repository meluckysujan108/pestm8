/**
 * Builds the service worker after Nitro has assembled .output/public.
 *
 * Deliberately a post-build step rather than a Vite plugin. Run inside the
 * plugin pipeline, the precache manifest is computed from whatever happens to
 * be in .output/public at that moment — which is the *previous* build's
 * assets. That ships a worker precaching hashed filenames that no longer
 * exist, which is worse than having no worker at all: the app would install
 * an offline cache that 404s.
 *
 * ARCHITECTURE.md §5.5 requires the build to fail if sw.js is missing, because
 * this whole class of failure is silent.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { build } from 'vite'
import { injectManifest } from '@serwist/build'

// Nitro's output layout depends on which preset it auto-detects: the default
// (local, no deploy-target env vars) preset writes client assets to
// `.output/public`, but Vercel's build environment makes it auto-detect the
// `vercel` preset instead, which writes straight to `.vercel/output/static`
// — a real, previously-unnoticed gap between "builds locally" and "builds on
// Vercel" (this app's actual deploy target), since nothing before this ever
// ran a bare `pnpm run build` under Vercel's own env to catch it.
const CANDIDATE_DIRS = ['.output/public', '.vercel/output/static']
const PUBLIC_DIR = resolve(
  CANDIDATE_DIRS.find((dir) => existsSync(resolve(dir))) ?? CANDIDATE_DIRS[0],
)
const SW_DEST = resolve(PUBLIC_DIR, 'sw.js')

if (!existsSync(PUBLIC_DIR)) {
  console.error(
    `\n✖ Neither ${CANDIDATE_DIRS.join(' nor ')} exists — run the client build before this step.`,
  )
  process.exit(1)
}

// Bundle src/sw.ts on its own: the worker runs outside the app's module graph
// and must be a self-contained classic script.
await build({
  configFile: false,
  logLevel: 'warn',
  build: {
    outDir: PUBLIC_DIR,
    emptyOutDir: false,
    rollupOptions: {
      input: resolve('src/sw.ts'),
      output: { entryFileNames: 'sw.js', format: 'iife' },
    },
  },
})

const { count, size, warnings } = await injectManifest({
  swSrc: SW_DEST,
  swDest: SW_DEST,
  globDirectory: PUBLIC_DIR,
  // `mjs` covers the pdf.js worker `PdfViewer.tsx` self-hosts — without it,
  // that asset silently falls outside the offline precache and the PDF
  // viewer needs a live connection on every device's first use.
  globPatterns: ['**/*.{js,mjs,css,html,ico,png,svg,webmanifest,woff2}'],
  // Skip the worker itself and anything already content-hashed by the router.
  globIgnores: ['sw.js', '**/*.map'],
  injectionPoint: 'self.__SW_MANIFEST',
})

for (const warning of warnings) console.warn('  ', warning)

// The build gate §5.5 asks for. A zero-byte or absent sw.js has shipped from
// this plugin combination before without any error surfacing.
if (!existsSync(SW_DEST) || statSync(SW_DEST).size === 0) {
  console.error(`\n✖ Service worker missing or empty at ${SW_DEST}`)
  process.exit(1)
}

/**
 * Register the worker with Nitro.
 *
 * Nitro bakes a manifest of .output/public into the server bundle at build time
 * — #nitro/virtual/public-assets-data inside index.mjs — and serves only the
 * files that manifest lists. This script necessarily runs *after* Nitro has
 * assembled the build (see the note at the top for why it cannot run earlier),
 * so sw.js is missing from it: requests for /sw.js fall through to the SSR
 * router and 307 to /login. The file is on disk and unreachable at the same
 * time, which is precisely what the existence check above cannot see.
 *
 * Adding the entry after the fact is what is left. The entry shape and the etag
 * algorithm below are Nitro's own, verified by reproducing byte-identical etags
 * for the entries it generated for manifest.webmanifest and both icons. Serving
 * reads `size` for Content-Length, so a stale entry corrupts the response —
 * hence computing it from the bytes just written rather than reusing anything.
 */
const SERVER_ENTRY = resolve('.output/server/index.mjs')
const ANCHOR = 'var public_assets_data_default = {'

const swBytes = readFileSync(SW_DEST)
const swEntry = {
  type: 'text/javascript; charset=utf-8',
  etag: `"${swBytes.length.toString(16)}-${createHash('sha1')
    .update(swBytes)
    .digest('base64')
    .substring(0, 27)}"`,
  mtime: statSync(SW_DEST).mtime.toISOString(),
  size: swBytes.length,
  path: '../public/sw.js',
}

if (!existsSync(SERVER_ENTRY)) {
  console.error(`\n✖ ${SERVER_ENTRY} does not exist — did the Nitro build run?`)
  process.exit(1)
}

let server = readFileSync(SERVER_ENTRY, 'utf8')

// Fail loudly rather than silently shipping an unreachable worker again: if a
// Nitro upgrade renames or restructures this virtual module, that is a build
// break to look at, not something to paper over.
if (!server.includes(ANCHOR)) {
  console.error(
    `\n✖ Could not find Nitro's public asset manifest in ${SERVER_ENTRY}.`,
  )
  console.error(
    '  Expected the virtual module #nitro/virtual/public-assets-data, anchored on',
  )
  console.error(`  "${ANCHOR}".`)
  console.error(
    '\n  Without it /sw.js is not served and the PWA silently does nothing.',
  )
  console.error('  See DEPLOYMENT.md.\n')
  process.exit(1)
}

// Idempotent, so re-running this script against an existing build replaces the
// entry rather than accumulating duplicates.
server = server.replace(/\t*"\/sw\.js": \{[^}]*\},?\n?/, '')
server = server.replace(
  ANCHOR,
  `${ANCHOR}\n\t"/sw.js": ${JSON.stringify(swEntry)},`,
)

writeFileSync(SERVER_ENTRY, server)

if (!readFileSync(SERVER_ENTRY, 'utf8').includes('"/sw.js"')) {
  console.error('\n✖ Failed to register /sw.js in the Nitro asset manifest.')
  process.exit(1)
}

console.log(
  `✓ Service worker written to ${SW_DEST} — ${count} precached files, ${(size / 1024).toFixed(0)} KiB`,
)
console.log('✓ Registered /sw.js in the Nitro public asset manifest')

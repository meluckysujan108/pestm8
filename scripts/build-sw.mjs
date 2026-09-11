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
import { existsSync, statSync } from 'node:fs'
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

console.log(
  `✓ Service worker written to ${SW_DEST} — ${count} precached files, ${(size / 1024).toFixed(0)} KiB`,
)

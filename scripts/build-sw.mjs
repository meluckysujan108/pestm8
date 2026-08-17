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

const PUBLIC_DIR = resolve('.output/public')
const SW_DEST = resolve(PUBLIC_DIR, 'sw.js')

if (!existsSync(PUBLIC_DIR)) {
  console.error(
    `\n✖ ${PUBLIC_DIR} does not exist — run the client build before this step.`,
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
  globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest,woff2}'],
  // Skip the worker itself and anything already content-hashed by the router.
  globIgnores: ['sw.js', '**/*.map'],
  injectionPoint: 'self.__SW_MANIFEST',
})

for (const warning of warnings) console.warn('  ', warning)

// The build gate §5.5 asks for. A zero-byte or absent sw.js has shipped from
// this plugin combination before without any error surfacing.
if (!existsSync(SW_DEST) || statSync(SW_DEST).size === 0) {
  console.error('\n✖ Service worker missing or empty at .output/public/sw.js')
  process.exit(1)
}

console.log(
  `✓ Service worker written to .output/public/sw.js — ${count} precached files, ${(size / 1024).toFixed(0)} KiB`,
)

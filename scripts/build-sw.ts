/**
 * Builds the service worker into Nitro's public directory, as a Vite plugin
 * that runs at the start of Nitro's own server bundle.
 *
 * The timing is the whole point, and it is squeezed from both sides:
 *
 * - Too early and the precache manifest is wrong. Run from the client build
 *   (where a PWA plugin would normally sit), the manifest is computed from
 *   whatever is in the public dir at that moment — the *previous* build's
 *   assets. That ships a worker precaching hashed filenames that no longer
 *   exist, which is worse than having no worker at all: the app would install
 *   an offline cache that 404s.
 *
 * - Too late and the local server cannot see it. Nitro's node-server preset
 *   serves static files from a manifest it bakes into the server bundle. This
 *   used to be a post-build script, so sw.js landed in `.output/public` after
 *   that manifest existed, `/sw.js` fell through to the SSR router, matched
 *   `/$businessSlug`, and redirected to /login. A local production run
 *   silently had no service worker at all. Vercel was unaffected — it serves
 *   `.vercel/output/static` straight off the filesystem — which is why the
 *   gap went unnoticed until a worker bug reached production.
 *
 * Nitro's build order is: client + SSR bundles → copy client assets into the
 * public dir → bundle the `nitro` environment, whose public-asset manifest is
 * generated while that bundle runs. `buildStart` of the `nitro` environment
 * sits exactly in the gap: every fresh asset is in place and the manifest has
 * not been read yet. `scripts/check-sw.mjs` then proves, after the build, that
 * the file is actually served.
 */
import { execSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'vite'
import type { Plugin } from 'vite'
import { injectManifest } from '@serwist/build'
import type { Nitro, NitroModule } from 'nitro/types'

/**
 * The build's short commit. The app shows it in Settings so "which version
 * are you on?" has an answer, and the worker answers a page with it — the
 * page offers "a new version is ready" only when the two differ
 * (src/lib/workerVersion.ts). Both therefore read it from here: were the
 * worker's copy to drift from the app's, every page would be told it was out
 * of date on every launch. Vercel says which commit it is building; a local
 * build asks git; anything else is 'dev'.
 */
export function appVersion(): string {
  const vercel = process.env.VERCEL_GIT_COMMIT_SHA
  if (vercel) return vercel.slice(0, 7)
  try {
    const sha = execSync('git rev-parse --short=7 HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
    return sha || 'dev'
  } catch {
    return 'dev'
  }
}

export async function buildServiceWorker(publicDir: string) {
  const swDest = resolve(publicDir, 'sw.js')

  // Bundle src/sw.ts on its own: the worker runs outside the app's module
  // graph and must be a self-contained classic script.
  await build({
    configFile: false,
    logLevel: 'warn',
    define: { __APP_VERSION__: JSON.stringify(appVersion()) },
    build: {
      outDir: publicDir,
      emptyOutDir: false,
      rollupOptions: {
        input: resolve('src/sw.ts'),
        output: { entryFileNames: 'sw.js', format: 'iife' },
      },
    },
  })

  const { count, size, warnings } = await injectManifest({
    swSrc: swDest,
    swDest,
    globDirectory: publicDir,
    // `mjs` covers the pdf.js worker the in-app PDF viewer self-hosts
    // (`src/components/pdf/pdfjs.ts`, the legacy build's) — without it, that
    // asset silently falls outside the offline precache and the viewer needs
    // a live connection on every device's first use.
    globPatterns: ['**/*.{js,mjs,css,html,ico,png,svg,webmanifest,woff2}'],
    // Skip the worker itself and anything already content-hashed by the router.
    // `pdfjs/` is pdf.js's fetch-when-asked files (scripts/copy-pdfjs-assets.mjs):
    // its no-WebAssembly JPEG 2000 decoder is a 450 KB `.js` the pattern above
    // would otherwise hand every installed phone. src/sw.ts caches that folder
    // on first use instead, and keptProducts warms it once a product is kept.
    globIgnores: ['sw.js', '**/*.map', 'pdfjs/**'],
    injectionPoint: 'self.__SW_MANIFEST',
  })

  for (const warning of warnings) console.warn('  ', warning)

  // The build gate §5.5 asks for. A zero-byte or absent sw.js has shipped from
  // this plugin combination before without any error surfacing.
  if (!existsSync(swDest) || statSync(swDest).size === 0) {
    throw new Error(`Service worker missing or empty at ${swDest}`)
  }

  console.log(
    `✓ Service worker written to ${swDest} — ${count} precached files, ${(size / 1024).toFixed(0)} KiB`,
  )
}

/**
 * The Vite plugin that runs the build, plus the Nitro module it needs to learn
 * where Nitro's preset serves static files from — `.output/public` locally,
 * `.vercel/output/static` on Vercel.
 *
 * A module rather than a `hooks` entry in Nitro's config: config hooks
 * *replace* a preset's hook of the same name instead of running beside it,
 * and the Vercel preset does real work in `build:before`.
 */
export function serviceWorker(): { nitroModule: NitroModule; plugin: Plugin } {
  let nitro: Nitro | undefined
  return {
    nitroModule: {
      name: 'pestm8:service-worker',
      setup: (instance) => {
        nitro = instance
      },
    },
    plugin: {
      name: 'pestm8:service-worker',
      apply: 'build',
      applyToEnvironment: (env) => env.name === 'nitro',
      async buildStart() {
        const publicDir = nitro?.options.output.publicDir
        if (!publicDir || !existsSync(publicDir)) {
          throw new Error(
            `Nitro public dir ${publicDir ?? '(unresolved)'} does not exist — the service worker has nowhere to go.`,
          )
        }
        await buildServiceWorker(publicDir)
      },
    },
  }
}

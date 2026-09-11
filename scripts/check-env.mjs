/**
 * Fails the build when the env vars the client bundle needs are absent.
 *
 * `VITE_` vars reach the client by *inlining at build time*, not by being read
 * at runtime. When VITE_CONVEX_URL is missing, Vite substitutes `undefined`
 * into root-provider.tsx, the optimiser folds the `if (!convexUrl)` guard into
 * an unconditional `throw`, and the build exits 0 having produced a bundle
 * that throws on every page load. Verified in .output/public/assets — the
 * compiled function body was nothing but the throw.
 *
 * That is the same silent-failure shape ARCHITECTURE.md §5.5 asks the service
 * worker to be gated against, so it is gated the same way: loudly, before the
 * artifact exists, rather than as a white screen after deploy.
 *
 * A host that injects these only at runtime will half-work — the server reads
 * process.env and authenticates fine, while the client throws — so this runs
 * at build time deliberately.
 *
 * Resolution goes through Vite's own loadEnv rather than process.env alone, so
 * that a .env.local satisfies this gate exactly when it would satisfy the build
 * it guards. Reading only process.env would reject a correctly configured
 * working copy, since Node does not load .env files on its own.
 */
import { loadEnv } from 'vite'

const env = { ...loadEnv('production', process.cwd(), 'VITE_'), ...process.env }

/** Inlined into the client bundle; absence produces a bundle that throws. */
const BUILD_TIME = [
  [
    'VITE_CONVEX_URL',
    'Convex deployment URL, the .cloud one (https://<name>.convex.cloud)',
  ],
]

/** Read from process.env by the Nitro server at request time. */
const RUNTIME = [
  [
    'VITE_CONVEX_SITE_URL',
    'Same deployment on .site, where the Better Auth HTTP routes are mounted',
  ],
]

const missing = [...BUILD_TIME, ...RUNTIME].filter(([name]) => !env[name])

if (missing.length > 0) {
  console.error('\n✖ Missing required environment variables:\n')
  for (const [name, hint] of missing) console.error(`    ${name}  — ${hint}`)
  console.error(
    '\n  Locally these come from .env.local (see README "Getting started").',
  )
  console.error(
    '  On a host, set them in the build environment — not only at runtime,',
  )
  console.error('  or the client bundle ships with them inlined as undefined.')
  console.error('\n  See DEPLOYMENT.md.\n')
  process.exit(1)
}

console.log('✓ Build environment complete')

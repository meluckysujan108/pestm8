import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

/**
 * The build's short commit, shown in Settings so "which version are you on?"
 * has an answer when someone reports a problem. Vercel says which commit it
 * is building; a local build asks git; anything else is 'dev'.
 */
function appVersion(): string {
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

const config = defineConfig({
  // Read through src/lib/appVersion.ts, which also covers the tests, where
  // nothing defines it.
  define: { __APP_VERSION__: JSON.stringify(appVersion()) },
  // 3000 by default so `npm run dev` and the Playwright baseURL agree, but
  // overridable: a second dev server on the same machine needs its own port,
  // and putting it here rather than in the npm script keeps it working on
  // shells that do not expand ${PORT:-3000}.
  server: { port: Number(process.env.PORT) || 3000 },
  resolve: {
    tsconfigPaths: true,
    // better-auth's React client is served straight from node_modules while
    // React itself comes from .vite/deps. Without this it resolves a second
    // React instance, every hook call throws "Invalid hook call", and the app
    // never hydrates — the page renders but nothing is interactive.
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: ['better-auth/react', '@convex-dev/better-auth/react'],
  },
  // The Better Auth Convex component ships ESM that must be bundled for SSR
  // rather than externalised, or the server build cannot resolve it.
  ssr: { noExternal: ['@convex-dev/better-auth'] },
  plugins: [
    devtools(),
    nitro({ rollupConfig: { external: [/^@sentry\//] } }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})

export default config

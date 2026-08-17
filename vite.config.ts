import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

const config = defineConfig({
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

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// HARNESS_REPO points the harness at another checkout's src (a worktree of
// main, say) to render "before" beside this checkout's "after".
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const repo = process.env.HARNESS_REPO ?? root

export default defineConfig({
  root: here,
  define: {
    __APP_VERSION__: JSON.stringify('harness'),
    'import.meta.env.VITE_CONVEX_URL': JSON.stringify(
      'https://harness.invalid',
    ),
    'import.meta.env.VITE_CONVEX_SITE_URL': JSON.stringify(
      'https://harness.invalid',
    ),
  },
  resolve: {
    alias: { '#': path.join(repo, 'src') },
    dedupe: ['react', 'react-dom'],
  },
  server: {
    port: Number(process.env.PORT) || 5200,
    fs: { allow: [repo, root] },
  },
  plugins: [tailwindcss(), react()],
})

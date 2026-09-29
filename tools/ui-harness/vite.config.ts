import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// HARNESS_REPO points the harness at another checkout's src (a worktree of
// main, say) to render "before" beside this checkout's "after". A relative
// one is from the repo root, as in the README: left relative, Vite would
// resolve the alias below from each importing file instead.
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const repo = path.resolve(root, process.env.HARNESS_REPO ?? '.')

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
    alias: [
      // A server function only the TanStack Start plugin can build: see
      // initialState.stub.ts. Ahead of '#', because the first match wins.
      {
        find: '#/lib/initialState',
        replacement: path.join(here, 'initialState.stub.ts'),
      },
      { find: '#', replacement: path.join(repo, 'src') },
    ],
    dedupe: ['react', 'react-dom'],
  },
  server: {
    port: Number(process.env.PORT) || 5200,
    fs: { allow: [repo, root] },
  },
  plugins: [tailwindcss(), react()],
})

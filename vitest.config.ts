import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'edge-runtime',
    // `.tsx` too: the PDF is a React tree, and the only way to test what a
    // client actually receives is to render one and read the text back.
    include: ['convex/**/*.test.ts', 'src/**/*.test.ts', 'src/**/*.test.tsx'],
    // `convex/auth.ts` reads these at import time; the policy tests never
    // reach the auth component but do import through `lib/access.ts`.
    env: { SITE_URL: 'http://localhost:3000', BETTER_AUTH_SECRET: 'test-only' },
    server: { deps: { inline: ['convex-test'] } },
  },
})

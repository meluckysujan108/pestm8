import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'edge-runtime',
    include: ['convex/**/*.test.ts', 'src/**/*.test.ts'],
    // `convex/auth.ts` reads these at import time; the policy tests never
    // reach the auth component but do import through `lib/access.ts`.
    env: { SITE_URL: 'http://localhost:3000', BETTER_AUTH_SECRET: 'test-only' },
    server: { deps: { inline: ['convex-test'] } },
  },
})

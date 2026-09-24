import { defineConfig, devices } from '@playwright/test'

// Vite loads .env.local for the app, but the test process is a separate Node
// runtime — the fixtures need VITE_CONVEX_URL to reach the deployment.
try {
  process.loadEnvFile('.env.local')
} catch {
  // Falls through to whatever is already in the environment (e.g. CI secrets).
}

export default defineConfig({
  testDir: './e2e',
  // Fails fast when the baseURL is not serving the build — see the file.
  globalSetup: './e2e/globalSetup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  /**
   * Four workers all compile routes on demand through one Vite dev server and
   * share one Convex dev deployment, which made roughly one run in three fail
   * on a different test each time. That is contention, not a defect, but a
   * suite that cries wolf trains you to ignore it — so the parallelism is
   * capped and the assertion timeout allows for a cold route compile.
   */
  workers: process.env.CI ? 2 : 3,
  expect: { timeout: 15_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    /**
     * The suite asserts the light palette — `design-tokens.spec.ts` reads a
     * rendered colour and checks it is dark enough to be text. With no cookie
     * the app follows the OS, so that assertion was only passing because
     * Playwright happens to default to light. Pin it, and keep the dark-mode
     * assertions in `theme.spec.ts`, which opts in per test.
     */
    colorScheme: 'light',
  },
  timeout: 60_000,
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    /**
     * Every spec used to run at 1280 only, which is why the phone layout could
     * drift without anything going red — and the phone is the layout a
     * technician actually uses in the field. Scoped rather than universal: most
     * specs assert backend behaviour through the UI and gain nothing from a
     * second viewport, and each one costs a full sign-up + seed.
     */
    {
      name: 'mobile',
      // iPhone 13's device descriptor defaults to WebKit. Chromium emulates the
      // same viewport, touch and user agent, and keeping one engine means a
      // mobile failure is a layout bug rather than an engine difference — and
      // one browser to install.
      use: { ...devices['iPhone 13'], browserName: 'chromium' },
      testMatch:
        /(shell|schedule|job|jobCard|ownerTechnician|viewMenu|navigation|clientDetails|products)\.spec\.ts/,
    },
  ],
  /**
   * A PRODUCTION build, not `pnpm dev`. The service worker and `__Secure-`
   * cookies only exist in one, and `e2e/globalSetup.ts` refuses to run the
   * suite against the other — so starting a dev server here made the config
   * contradict its own guard, and the suite only ever passed because somebody
   * had a preview running by hand on the same port.
   *
   * `--strictPort` is the load-bearing flag. Without it `vite preview` prints
   * "Port 3000 is in use, trying another one", binds 3001, and leaves whatever
   * was already on 3000 to answer the suite. Fail on a taken port instead.
   *
   * Skipped entirely when `E2E_BASE_URL` is set. That variable means "the
   * build is already being served over there". If :3000 happened to be free,
   * the server block would still run `pnpm build`, which overwrites the
   * `.output` the other port is serving partway through the run. It would
   * also take :3000 away from the session that owns it.
   */
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'pnpm build && npx vite preview --port 3000 --strictPort',
        url: 'http://localhost:3000',
        reuseExistingServer: !process.env.CI,
        timeout: 240_000,
      },
})

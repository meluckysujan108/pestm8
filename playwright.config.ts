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
  },
  timeout: 60_000,
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})

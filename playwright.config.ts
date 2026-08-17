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
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})

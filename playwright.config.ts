import { defineConfig } from '@playwright/test';

// Playwright drives the dashboard end-to-end so I (the assistant) can
// verify UI fixes without asking the user to click around. `pnpm test:e2e`
// runs the full suite headlessly; `pnpm test:e2e --headed` is useful for
// eyeballing.
//
// Tests run serially against a single dev-server-managed page; the sim
// state is per-page so parallel tests would interfere.

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env['CI'],
    timeout: 30_000,
  },
});

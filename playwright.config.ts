import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

// Playwright drives the dashboard end-to-end so I (the assistant) can
// verify UI fixes without asking the user to click around. `pnpm test:e2e`
// runs the full suite headlessly; `pnpm test:e2e --headed` is useful for
// eyeballing.
//
// Tests run serially against a single dev-server-managed page; the sim
// state is per-page so parallel tests would interfere.
//
// Each checkout serves its own dev server so a run never tests another
// worktree's code (ARCHITECTURE.md "Agent worktree isolation"). The port
// comes from E2E_PORT when set, 5173 in CI, and otherwise a port derived
// from this checkout's real path. Vite binds it with --strictPort and the
// existing-server reuse is off, so an occupied port fails the run instead
// of being reused or silently moved.

const E2E_PORT_BASE = 20_000;
const E2E_PORT_SPAN = 10_000;

export function e2ePort(env: NodeJS.ProcessEnv, checkoutRoot: string): number {
  const override = env['E2E_PORT'];
  if (override !== undefined && override !== '') {
    const port = /^\d+$/.test(override) ? Number(override) : NaN;
    if (!(port >= 1 && port <= 65_535)) {
      throw new Error(
        `E2E_PORT must be an integer from 1 to 65535, got ${JSON.stringify(override)}`,
      );
    }
    return port;
  }
  if (env['CI']) return 5173;
  const digest = createHash('sha256').update(checkoutRoot).digest();
  return E2E_PORT_BASE + (digest.readUInt32BE(0) % E2E_PORT_SPAN);
}

const port = e2ePort(process.env, realpathSync(fileURLToPath(new URL('.', import.meta.url))));
const origin = `http://127.0.0.1:${port}`;
// Stderr, once from the runner process, so reporters writing to stdout
// stay parseable. Silent when Vitest imports the config to test it.
if (process.env['TEST_WORKER_INDEX'] === undefined && process.env['VITEST'] === undefined) {
  process.stderr.write(`Browser server: ${origin}\n`);
}

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: origin,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: `scripts/dev.sh --host 127.0.0.1 --port ${port} --strictPort`,
    url: origin,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});

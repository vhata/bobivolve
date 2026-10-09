// Lint and browser tooling must stay inside the checkout that runs it; see
// ARCHITECTURE.md "Agent worktree isolation" and docs/QUALITY.md.

import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import config, { e2ePort } from '../../playwright.config.js';

const root = fileURLToPath(new URL('../..', import.meta.url));

describe('ESLint scope', () => {
  const eslint = new ESLint({ cwd: root });

  it.each([
    '.worktrees/other-agent/sim/rng.ts',
    '.claude/worktrees/other-agent/ui/App.tsx',
    'test-results/run.x/trace.js',
    'playwright-report/index.js',
  ])('ignores %s', async (path) => {
    expect(await eslint.isPathIgnored(path)).toBe(true);
  });

  it('still lints this checkout', async () => {
    expect(await eslint.isPathIgnored('sim/rng.ts')).toBe(false);
  });
});

describe('e2e server port', () => {
  it('uses E2E_PORT when set, even in CI', () => {
    expect(e2ePort({ E2E_PORT: '24567' }, '/a')).toBe(24567);
    expect(e2ePort({ E2E_PORT: '24567', CI: 'true' }, '/a')).toBe(24567);
  });

  it.each(['abc', '0x10', '0', '70000', '12.5', ' 80'])('rejects E2E_PORT=%j', (value) => {
    expect(() => e2ePort({ E2E_PORT: value }, '/a')).toThrow(/E2E_PORT/);
  });

  it('keeps 5173 in CI', () => {
    expect(e2ePort({ CI: 'true' }, '/a')).toBe(5173);
  });

  it('derives a stable per-checkout port locally', () => {
    const a = e2ePort({}, '/repo/.worktrees/a');
    const b = e2ePort({}, '/repo/.worktrees/b');
    expect(e2ePort({}, '/repo/.worktrees/a')).toBe(a);
    expect(a).not.toBe(b);
    for (const port of [a, b]) {
      expect(port).toBeGreaterThanOrEqual(20_000);
      expect(port).toBeLessThan(30_000);
    }
  });
});

describe('Playwright web server', () => {
  const server = config.webServer;
  if (server === undefined || Array.isArray(server)) throw new Error('expected one webServer');
  const port = new URL(config.use?.baseURL ?? '').port;

  it('never reuses a server it did not start', () => {
    expect(server.reuseExistingServer).toBe(false);
  });

  it('binds the tested port strictly', () => {
    expect(server.url).toBe(config.use?.baseURL);
    expect(server.command).toContain(`--port ${port}`);
    expect(server.command).toContain('--strictPort');
    expect(server.command).toContain('--host 127.0.0.1');
  });
});

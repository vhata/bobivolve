import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { SimStoreState } from '../ui/sim-store.js';

test('browser OPFS and visible rewind measurement @diagnostic', async ({ page, browser }) => {
  test.setTimeout(900_000);
  const ticks = Number(process.env['BOBIVOLVE_BENCH_TICKS'] ?? 5000);
  if (!Number.isSafeInteger(ticks) || ticks < 2 || ticks > 100_000)
    throw new Error('benchmark ticks must be 2..100000');
  await page.addInitScript(() => localStorage.setItem('bobivolve:nux-seen', '1'));
  await page.goto('/');
  const fixture: unknown = await page.evaluate(
    async ({ target, workerUrl }) => {
      const worker = new Worker(workerUrl, { type: 'module' });
      try {
        return await new Promise((resolve, reject) => {
          worker.onerror = (e) => reject(new Error(e.message));
          worker.onmessage = (e: MessageEvent<{ result?: unknown; error?: string }>) => {
            if (e.data.error) reject(new Error(e.data.error));
            if (e.data.result) resolve(e.data.result);
          };
          worker.postMessage({ ticks: target });
        });
      } finally {
        worker.terminate();
      }
    },
    { target: ticks, workerUrl: `/@fs/${resolve('test/bench/browser-persistence-worker.ts')}` },
  );
  const reloadStart = Date.now();
  await page.reload();
  await expect(page.locator('.population-panel .panel-meta')).toContainText(`simTick ${ticks}`, {
    timeout: 180_000,
  });
  const reloadVisibleMs = Date.now() - reloadStart;
  const rewind = await page.evaluate(async (target) => {
    const path = '/sim-store.ts';
    const { useSimStore } = (await import(/* @vite-ignore */ path)) as {
      useSimStore: { getState(): SimStoreState };
    };
    const state = useSimStore.getState();
    const transport = state.transport;
    if (transport === null) throw new Error('transport missing');
    let acknowledgedMs = 0;
    const start = performance.now();
    const unsubscribe = transport.onEvent((event) => {
      if (event.kind === 'commandAck' && event.simTick === BigInt(target))
        acknowledgedMs = performance.now() - start;
    });
    state.rewindToTick(BigInt(target));
    try {
      await new Promise<void>((resolve, reject) => {
        function check(): void {
          const current = useSimStore.getState();
          if (current.commandError !== null) {
            reject(new Error(current.commandError));
            return;
          }
          if (
            current.simTick === BigInt(target) &&
            current.pendingCommands.size === 0 &&
            current.lineages.size > 0 &&
            document
              .querySelector('.population-panel .panel-meta')
              ?.textContent?.includes(`simTick ${target}`)
          ) {
            resolve();
            return;
          }
          if (performance.now() - start > 240_000) {
            reject(new Error('rewind exceeded 240 seconds'));
            return;
          }
          requestAnimationFrame(check);
        }
        requestAnimationFrame(check);
      });
      return { target, acknowledgedMs, visibleMs: performance.now() - start };
    } finally {
      unsubscribe();
    }
  }, ticks - 1);
  // Save through the production transport, then compare full serialized state
  // against the fixture's canonical state captured at this same target tick.
  const equivalent = await page.evaluate(async () => {
    const path = '/sim-store.ts';
    const { useSimStore } = (await import(/* @vite-ignore */ path)) as {
      useSimStore: { getState(): SimStoreState };
    };
    const transport = useSimStore.getState().transport;
    if (transport === null) throw new Error('transport missing');
    await new Promise<void>((resolve, reject) => {
      const off = transport.onEvent((event) => {
        if (
          (event.kind === 'commandAck' || event.kind === 'commandError') &&
          event.commandId === 'benchmark-verify'
        ) {
          off();
          if (event.kind === 'commandError') reject(new Error(event.message));
          else resolve();
        }
      });
      transport.send({ kind: 'save', commandId: 'benchmark-verify', slot: 'benchmark-after' });
    });
    const root = await navigator.storage.getDirectory();
    const saves = await (await root.getDirectoryHandle('bobivolve')).getDirectoryHandle('saves');
    const before = await (
      await (await saves.getFileHandle('benchmark-reference.save')).getFile()
    ).text();
    const after = await (
      await (await saves.getFileHandle('benchmark-after.save')).getFile()
    ).text();
    return before === after;
  });
  expect(equivalent).toBe(true);
  const output = process.env['BOBIVOLVE_BENCH_OUTPUT'] ?? 'test-results/browser-persistence.json';
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        browser: browser.version(),
        platform: process.platform,
        arch: process.arch,
        fixture,
        reloadVisibleMs,
        rewind,
        fullStateEquivalent: equivalent,
      },
      null,
      2,
    ) + '\n',
  );
});

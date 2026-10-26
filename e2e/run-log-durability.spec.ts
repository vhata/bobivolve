import { expect, test, type Page } from '@playwright/test';

// The active run must survive a reload that the player did not prepare
// for. The reload tests in dashboard.spec.ts pause first, and Pause has
// always flushed the event log; these cover play that is never paused,
// commands issued while paused, and play that ended in an auto-pause.
//
// Each test waits until the worker has written the relevant entry to
// OPFS before reloading. The page reads the same origin-private storage
// as the worker, so this observes durability directly instead of
// sleeping for the flush interval.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('bobivolve:nux-seen', '1');
  });
});

interface PersistedLog {
  readonly maxTick: number;
  readonly lines: readonly string[];
}

// Read the active run's log as the worker left it in OPFS.
async function readActiveLog(page: Page): Promise<PersistedLog> {
  return page.evaluate(async () => {
    const empty = { maxTick: -1, lines: [] as string[] };
    try {
      const root = await navigator.storage.getDirectory();
      const runs = await (await root.getDirectoryHandle('bobivolve')).getDirectoryHandle('runs');
      let runId = 'default';
      try {
        const marker = await (await runs.getFileHandle('.active')).getFile();
        const text = (await marker.text()).trim();
        if (text !== '') runId = text;
      } catch {
        // No marker yet: the worker uses the default slot.
      }
      const log = await (
        await (await runs.getDirectoryHandle(runId)).getFileHandle('log.ndjson')
      ).getFile();
      const lines = (await log.text()).split('\n').filter((line) => line.trim() !== '');
      let maxTick = -1;
      for (const line of lines) {
        const tick = Number((JSON.parse(line) as { tick: string }).tick);
        if (tick > maxTick) maxTick = tick;
      }
      return { maxTick, lines };
    } catch {
      return empty;
    }
  });
}

function displayedTick(text: string | null): number {
  return Number(text?.match(/simTick (\d+)/)?.[1] ?? Number.NaN);
}

test('reload while running restores the run without a pause', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Seed' }).fill('2026');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  const populationMeta = page.locator('.population-panel .panel-meta');
  await expect(populationMeta).toContainText(/simTick [1-9]\d{2,}/, { timeout: 20_000 });
  const tick = displayedTick(await populationMeta.textContent());
  expect(tick).toBeGreaterThan(0);

  // Never pause: the run's history must reach storage on its own.
  await expect
    .poll(async () => (await readActiveLog(page)).maxTick, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(tick);
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await expect
    .poll(async () => displayedTick(await populationMeta.textContent()))
    .toBeGreaterThanOrEqual(tick);
  await expect(page.locator('.lineage-tree button[aria-pressed]').first()).toBeVisible();
});

test('a command issued while paused survives a reload', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Seed' }).fill('2026');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  const founder = page.locator('.lineage-tree button[aria-pressed]').first();
  await expect(founder).toBeVisible();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveAttribute(
    'data-pending',
    'false',
  );

  // The pause above flushed; this command arrives after it.
  await founder.click();
  await page.getByRole('button', { name: 'Quarantine', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Release quarantine', exact: true })).toBeVisible();
  await expect
    .poll(
      async () =>
        (await readActiveLog(page)).lines.some((line) => line.includes('"kind":"quarantine"')),
      { timeout: 10_000 },
    )
    .toBe(true);

  await page.reload();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await expect(page.locator('.lineage-tree .lineage-quarantine-pip')).toHaveCount(1);
});

test('play that ends in an auto-pause survives a reload', async ({ page }) => {
  await page.goto('/');
  const autoPauseMeta = page.locator('.autopause-panel .panel-meta');
  const populationMeta = page.locator('.population-panel .panel-meta');
  // Settle the bootstrapped slot into a paused run first, so no stale
  // auto-pause can arrive once the trigger below is enabled.
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.locator('.lineage-tree button[aria-pressed]').first()).toBeVisible();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveAttribute(
    'data-pending',
    'false',
  );
  await page.getByRole('checkbox', { name: 'Significant drift', exact: true }).check();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(autoPauseMeta).toHaveText('last: speciation', { timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await expect.poll(() => populationMeta.textContent().then(displayedTick)).toBeGreaterThan(0);
  const pausedTick = displayedTick(await populationMeta.textContent());
  await expect
    .poll(
      async () =>
        (await readActiveLog(page)).lines.some((line) => line.includes('"kind":"autoPaused"')),
      { timeout: 10_000 },
    )
    .toBe(true);
  expect((await readActiveLog(page)).maxTick).toBe(pausedTick);

  await page.reload();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await expect.poll(async () => displayedTick(await populationMeta.textContent())).toBe(pausedTick);
});

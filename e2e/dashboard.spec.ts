import { expect, test } from '@playwright/test';

// Smoke tests for the dashboard. These exercise the UI from a real
// browser, which is the only way to catch worker pacing bugs, OPFS
// behaviour, and React-runtime issues that the vitest unit suite can't.
//
// The first test waits for the founder probe to replicate at least once
// (population > 1), confirming the sim → worker → transport → store →
// React pipeline is end-to-end live.

function readNumeric(text: string): number {
  const match = text.match(/-?\d+(?:[\d_,]*\d)?/);
  if (match === null) return Number.NaN;
  return Number(match[0].replace(/[_,]/g, ''));
}

test('page loads with the header and tagline', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('Bobivolve');
  await expect(page.locator('.bobivolve-tagline')).toContainText('seed');
});

test('the sim runs: population grows past 1', async ({ page }) => {
  await page.goto('/');
  // Auto-start fires at seed=42, speed=4×. Founder is one probe; first
  // replication for seed=42 lands around tick 190 → ~3s at 4× (60 t/s × 4
  // = 240 t/s). Allow generous slack for slow machines and CI.
  await expect
    .poll(
      async () => {
        const text = (await page.locator('.population-total').textContent()) ?? '';
        return readNumeric(text);
      },
      { timeout: 20_000, intervals: [500] },
    )
    .toBeGreaterThan(1);
});

test('pause stops population growth and resets the speed readout', async ({ page }) => {
  await page.goto('/');

  // Wait for some growth so a pause is observable.
  await expect
    .poll(
      async () => {
        const text = (await page.locator('.population-total').textContent()) ?? '';
        return readNumeric(text);
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(2);

  // Click Pause.
  const pauseButton = page.getByRole('button', { name: /^Pause$/ });
  await pauseButton.click();

  // Button text flips to Resume.
  await expect(page.getByRole('button', { name: /^Resume$/ })).toBeVisible();

  // Speed readout should reset to 0 t/s — and STAY there. A stale Tick
  // heartbeat from an in-flight runUntil that completes after the click
  // can otherwise overwrite the zeroed value back to a non-zero reading.
  await expect(page.locator('.controls-panel .panel-meta')).toHaveText(/^0\s*t\/s$/);
  await page.waitForTimeout(750);
  await expect(page.locator('.controls-panel .panel-meta')).toHaveText(/^0\s*t\/s$/);

  // Population should not grow over a one-second window. Allow ±1 for
  // any in-flight tick that completed between the click and the assertion.
  const populationAtPause = readNumeric(
    (await page.locator('.population-total').textContent()) ?? '',
  );
  await page.waitForTimeout(1_000);
  const populationAfterWait = readNumeric(
    (await page.locator('.population-total').textContent()) ?? '',
  );
  expect(populationAfterWait).toBeLessThanOrEqual(populationAtPause + 1);
});

test('1× speed advances slower than 16×', async ({ page }) => {
  await page.goto('/');

  // Wait for some growth so a speed difference is observable.
  await expect
    .poll(
      async () => {
        const text = (await page.locator('.population-total').textContent()) ?? '';
        return readNumeric(text);
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(2);

  // Click 1×. A short window of growth gives a baseline.
  await page.getByRole('button', { name: '1×' }).click();
  await page.waitForTimeout(2_000);
  const popAt1xStart = readNumeric((await page.locator('.population-total').textContent()) ?? '');
  await page.waitForTimeout(2_000);
  const popAt1xEnd = readNumeric((await page.locator('.population-total').textContent()) ?? '');
  const growthAt1x = popAt1xEnd - popAt1xStart;

  // Click 16×. Same window, expect more growth.
  await page.getByRole('button', { name: '16×' }).click();
  await page.waitForTimeout(2_000);
  const popAt16xStart = readNumeric((await page.locator('.population-total').textContent()) ?? '');
  await page.waitForTimeout(2_000);
  const popAt16xEnd = readNumeric((await page.locator('.population-total').textContent()) ?? '');
  const growthAt16x = popAt16xEnd - popAt16xStart;

  // 16× should grow at least as fast as 1× — strictly more in expectation,
  // but allow equality so tiny early-tick jitter doesn't flake.
  expect(growthAt16x).toBeGreaterThanOrEqual(growthAt1x);
});

test('pause actually halts growth at 64× with a busy worker', async ({ page }) => {
  await page.goto('/');
  // Crank speed up so the worker has substantial in-flight work; this
  // is the scenario where pause has historically failed.
  await page.getByRole('button', { name: '64×' }).click();

  // Wait for population to climb meaningfully so growth-vs-no-growth is
  // observable across a 2-second window.
  await expect
    .poll(
      async () => {
        const text = (await page.locator('.population-total').textContent()) ?? '';
        return readNumeric(text);
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(50);

  // Pause.
  await page.getByRole('button', { name: /^Pause$/ }).click();

  // Read population once pause has had a beat to register.
  await page.waitForTimeout(500);
  const popJustAfterPause = readNumeric(
    (await page.locator('.population-total').textContent()) ?? '',
  );

  // Wait long enough for any non-honoured pause to be obvious; at 64×
  // a missed pause would add tens or hundreds of probes per second.
  await page.waitForTimeout(2_000);
  const popLater = readNumeric((await page.locator('.population-total').textContent()) ?? '');

  // Tolerate a handful of in-flight ticks that completed between the
  // click and pause taking effect.
  expect(popLater - popJustAfterPause).toBeLessThanOrEqual(5);
});

test('lineage tree starts with the founder lineage L0', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.lineage-tree')).toContainText('L0');
});

test('probe inspector returns firmware for P0', async ({ page }) => {
  await page.goto('/');
  // P0 exists from tick 0, no need to wait.
  const inspectorPanel = page.locator('.inspector-panel');
  await inspectorPanel.getByRole('button', { name: 'Inspect' }).click();
  await expect(inspectorPanel).toContainText(/replicates/i);
  await expect(inspectorPanel).toContainText(/threshold/);
});

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

test('pause clears the pending indicator within a reasonable window', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '64×' }).click();
  await expect
    .poll(
      async () => {
        const text = (await page.locator('.population-total').textContent()) ?? '';
        return readNumeric(text);
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(50);

  // Click pause. data-pending should be true momentarily, then false
  // once the worker acks. data-stuck should never go true under nominal
  // load — its appearance means the worker took >1s to ack and is the
  // user-visible signal that something is wrong.
  const pauseButton = page.getByRole('button', { name: /^Pause$/ });
  await pauseButton.click();

  // The button text flips to Resume optimistically.
  const resumeButton = page.getByRole('button', { name: /^Resume$/ });
  await expect(resumeButton).toBeVisible();

  // Within a healthy window, the ack arrives and pending clears.
  await expect(resumeButton).toHaveAttribute('data-pending', 'false', { timeout: 1_500 });
});

test('lineage tree starts with the founder lineage L0', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.lineage-tree')).toContainText('L0');
});

test('lineage tree founder row does not duplicate name and id', async ({ page }) => {
  await page.goto('/');
  // The founder lineage's name is currently the same string as its id
  // ("L0"); the row should render it once, not twice. A regression
  // would print "L0 L0" verbatim, so a substring assert is sufficient.
  const rowText = await page.locator('.lineage-tree .lineage-node-row').first().textContent();
  expect(rowText ?? '').not.toMatch(/\bL0\s+L0\b/);
});

test('every panel and control is visibly rendered', async ({ page }) => {
  await page.goto('/');

  // ── header ────────────────────────────────────────────────────────────
  await expect(page.locator('h1')).toBeVisible();
  await expect(page.locator('.bobivolve-tagline')).toBeVisible();

  // ── all panels exist and are visible ──────────────────────────────────
  const panelClasses = [
    '.run-panel',
    '.controls-panel',
    '.autopause-panel',
    '.population-panel',
    '.lineage-tree-panel',
    '.inspector-panel',
    '.timeline-panel',
  ];
  for (const cls of panelClasses) {
    await expect(page.locator(cls), `panel ${cls} should be visible`).toBeVisible();
    // And it should have non-trivial size — anything narrower than 200px
    // or shorter than 60px is almost certainly broken layout, not styled.
    const box = await page.locator(cls).boundingBox();
    expect(box, `panel ${cls} should have a bounding box`).not.toBeNull();
    expect(box?.width ?? 0, `panel ${cls} width`).toBeGreaterThan(200);
    expect(box?.height ?? 0, `panel ${cls} height`).toBeGreaterThan(60);
  }

  // ── RunPanel: seed input + Start + Save + Load ────────────────────────
  await expect(page.locator('.run-panel input[aria-label="Seed"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load' })).toBeVisible();

  // ── ControlsPanel: pause/resume + 4 speed buttons + t/s readout ───────
  await expect(page.getByRole('button', { name: /^(Pause|Resume)$/ })).toBeVisible();
  for (const speed of ['1×', '4×', '16×', '64×']) {
    await expect(page.getByRole('button', { name: speed, exact: true })).toBeVisible();
  }
  await expect(page.locator('.controls-panel .panel-meta')).toBeVisible();

  // ── AutoPausePanel: four trigger checkboxes ───────────────────────────
  const autopauseRows = page.locator('.autopause-row');
  await expect(autopauseRows).toHaveCount(4);
  for (let i = 0; i < 4; i += 1) {
    await expect(autopauseRows.nth(i)).toBeVisible();
  }

  // ── PopulationPanel: total + (eventually) sparkline + lineage list ────
  await expect(page.locator('.population-total')).toBeVisible();
  // Wait briefly for the first heartbeat to populate the lineage list
  // and the chart.
  await expect
    .poll(
      async () => {
        return (await page.locator('.lineage-list').isVisible()) ? 'visible' : 'hidden';
      },
      { timeout: 10_000 },
    )
    .toBe('visible');

  // ── LineageTreePanel: tree present, L0 visible ────────────────────────
  await expect(page.locator('.lineage-tree')).toBeVisible();
  await expect(page.locator('.lineage-tree')).toContainText('L0');

  // ── LineageInspectorPanel: identity rows render for the default L0 ────
  const inspectorPanel = page.locator('.inspector-panel');
  await expect(inspectorPanel).toContainText('founder');
  await expect(inspectorPanel).toContainText('founded at');
  await expect(inspectorPanel).toContainText('members');

  // ── EventsTimelinePanel: timeline svg ─────────────────────────────────
  await expect(page.locator('.timeline-svg')).toBeVisible();
});

test('lineage inspector renders firmware and identity for the default L0', async ({ page }) => {
  await page.goto('/');
  const inspectorPanel = page.locator('.inspector-panel');
  // Identity for the founder lineage.
  await expect(inspectorPanel).toContainText('P0');
  await expect(inspectorPanel).toContainText('tick 0');
  // Firmware description from the host's drift telemetry (the founder's
  // reference firmware for the replicate directive).
  await expect(inspectorPanel).toContainText(/replicates/i);
});

test('clicking a lineage in the tree selects it in the inspector', async ({ page }) => {
  await page.goto('/');
  // L0 is the only lineage on a fresh run; clicking it should mark it
  // selected (aria-pressed=true) and the inspector should already be
  // showing it. This proves the click → store → both panels wiring.
  const l0Row = page.locator('.lineage-tree button[aria-pressed]').first();
  await l0Row.click();
  await expect(l0Row).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.inspector-panel')).toContainText('P0');
});

import { expect, test } from '@playwright/test';

// Smoke tests for the dashboard. These exercise the UI from a real
// browser, which is the only way to catch worker pacing bugs, OPFS
// behaviour, and React-runtime issues that the vitest unit suite can't.
//
// The first test waits for the founder probe to replicate at least once
// (population > 1), confirming the sim → worker → transport → store →
// React pipeline is end-to-end live.

// Suppress the new-visitor tour for the dashboard suite; its auto-fire
// would block clicks and screenshots. The NUX has its own dedicated
// suite (nux.spec.ts) that exercises auto-fire and the reopen
// affordance directly.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('bobivolve:nux-seen', '1');
  });
});

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

  // Wait for the sim to be live.
  await expect
    .poll(
      async () => {
        const text = (await page.locator('.population-total').textContent()) ?? '';
        return readNumeric(text);
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(2);

  // Tick advance over a fixed window is the right speed signal — under
  // R1 the population can saturate at carrying capacity, so growth is
  // not monotonic with speed.
  function readSimTick(): Promise<number> {
    return page
      .locator('.population-panel .panel-meta')
      .textContent()
      .then((t) => readNumeric(t ?? ''));
  }

  await page.getByRole('button', { name: '1×' }).click();
  await page.waitForTimeout(1_000);
  const tick1xStart = await readSimTick();
  await page.waitForTimeout(2_000);
  const tick1xEnd = await readSimTick();
  const advanceAt1x = tick1xEnd - tick1xStart;

  await page.getByRole('button', { name: '16×' }).click();
  await page.waitForTimeout(1_000);
  const tick16xStart = await readSimTick();
  await page.waitForTimeout(2_000);
  const tick16xEnd = await readSimTick();
  const advanceAt16x = tick16xEnd - tick16xStart;

  // 16× should advance the simulation strictly faster than 1×.
  expect(advanceAt16x).toBeGreaterThan(advanceAt1x);
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
    .toBeGreaterThan(25);

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
    .toBeGreaterThan(25);

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
    '.substrate-panel',
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

test('lineage inspector surfaces the speciation rule', async ({ page }) => {
  await page.goto('/');
  const inspectorPanel = page.locator('.inspector-panel');
  // The rule is exposed by the host on the drift telemetry message and
  // rendered next to the Drift heading. R0 sets the divisor to 100, so
  // the threshold reads as ±1.00%.
  await expect(inspectorPanel).toContainText(/speciates beyond ±\d+\.\d+% of founder/);
});

test('substrate panel renders the lattice and at least one probe dot', async ({ page }) => {
  await page.goto('/');
  // Wait for the substrate query to round-trip (REFRESH_INTERVAL_MS is
  // 750ms; allow a few cycles for slow CI).
  await expect
    .poll(
      async () => {
        const cells = await page.locator('.substrate-svg rect').count();
        return cells;
      },
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0);
  // 64×64 = 4096 cells; the founder is on the lattice from tick 0.
  const cellCount = await page.locator('.substrate-svg rect').count();
  expect(cellCount).toBe(4096);
  await expect.poll(async () => page.locator('.substrate-svg circle').count()).toBeGreaterThan(0);
});

test('Save click pauses the sim and prompts for a slot name', async ({ page }) => {
  await page.goto('/');
  // Wait for some growth so the saved tick is meaningfully nonzero.
  await expect
    .poll(
      async () => {
        const text = (await page.locator('.population-total').textContent()) ?? '';
        return readNumeric(text);
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(2);

  // The Save click triggers a window.prompt; accept it with a custom
  // slot name. Set the dialog handler before the click so we don't
  // race the prompt.
  let promptedDefault = '';
  page.once('dialog', (dialog) => {
    promptedDefault = dialog.defaultValue();
    void dialog.accept('e2e-save');
  });
  await page.locator('.run-panel').getByRole('button', { name: 'Save' }).click();

  // The suggested filename uses seed + tick.
  expect(promptedDefault).toMatch(/^seed42-tick\d+$/);

  // After save, the sim is paused and the saved-at indicator appears.
  await expect(page.getByRole('button', { name: /^Resume$/ })).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('.run-status')).toContainText(/saved at tick \d+/, {
    timeout: 5_000,
  });
});

test('Load click pauses the sim, lists saves, and restores on selection', async ({ page }) => {
  await page.goto('/');
  await expect
    .poll(
      async () => {
        const text = (await page.locator('.population-total').textContent()) ?? '';
        return readNumeric(text);
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(2);

  // Save first so there's a slot to load. Accept the prompt with a
  // known name.
  page.once('dialog', (dialog) => {
    void dialog.accept('e2e-load-fixture');
  });
  await page.locator('.run-panel').getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.run-status')).toContainText(/saved at tick \d+/, {
    timeout: 5_000,
  });
  // Resume so we can check Load pauses again.
  await page.getByRole('button', { name: /^Resume$/ }).click();

  // Let the run advance so Load is observably restoring older state.
  await page.waitForTimeout(1_000);

  // Load click reveals the picker, with the sim paused.
  await page.getByRole('button', { name: 'Load' }).click();
  await expect(page.locator('.load-picker')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Resume$/ })).toBeVisible();

  // Pick the only slot.
  await page.locator('.load-picker .save-load-button').first().click();

  // After Load the host pauses; the picker has closed; the population
  // panel re-rendered from the post-Load heartbeat.
  await expect(page.locator('.load-picker')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Resume$/ })).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('.population-total')).toContainText(/\d+ probes/);
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

test('player-driven pause survives opening and closing the patch editor', async ({ page }) => {
  // Regression: modal-on-action used to call resume() unconditionally
  // on cleanup, which un-paused whatever the player had explicitly
  // paused before opening. The fix is to capture pre-existing paused
  // state on mount and only resume if the modal was the one that
  // paused.
  await page.goto('/');

  // Pause first.
  await page.getByRole('button', { name: /^Pause$/ }).click();
  await expect(page.getByRole('button', { name: /^Resume$/ })).toBeVisible();

  // Select L0 and open the patch editor.
  const l0Row = page.locator('.lineage-tree button[aria-pressed]').first();
  await l0Row.click();
  await page.getByRole('button', { name: /^Apply patch$/ }).click();
  await expect(page.locator('.patch-editor-overlay')).toBeVisible();

  // Cancel out of the modal.
  await page.locator('.patch-editor-button', { hasText: 'Cancel' }).click();
  await expect(page.locator('.patch-editor-overlay')).toHaveCount(0);

  // Pause must still hold — the controls button still reads Resume.
  await expect(page.getByRole('button', { name: /^Resume$/ })).toBeVisible();
});

test('quarantine toggle flips the inspector and the tree pip', async ({ page }) => {
  // Player intervention smoke: select L0, hit Quarantine, see the
  // inspector flip its meta and the tree row carry the quarantine pip;
  // hit Release, see both back to normal.
  await page.goto('/');
  const l0Row = page.locator('.lineage-tree button[aria-pressed]').first();
  await l0Row.click();

  const quarantineButton = page.getByRole('button', { name: 'Quarantine' });
  await expect(quarantineButton).toBeVisible();

  await quarantineButton.click();
  await expect(page.locator('.inspector-panel .panel-meta')).toContainText('quarantined');
  await expect(page.getByRole('button', { name: 'Release quarantine' })).toBeVisible();
  await expect(page.locator('.lineage-tree .lineage-quarantine-pip').first()).toBeVisible();

  await page.getByRole('button', { name: 'Release quarantine' }).click();
  await expect(page.locator('.inspector-panel .panel-meta')).not.toContainText('quarantined');
  await expect(page.getByRole('button', { name: 'Quarantine' })).toBeVisible();
  await expect(page.locator('.lineage-tree .lineage-quarantine-pip')).toHaveCount(0);
});

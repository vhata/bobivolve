import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import type { SimStoreState } from '../ui/sim-store.js';

// Smoke tests for the dashboard. These exercise the UI from a real
// browser, which is the only way to catch worker pacing bugs, OPFS
// behaviour, and React-runtime issues that the vitest unit suite can't.
//
// The population-growth test waits for the founder probe to replicate at
// least once (population > 1), confirming the sim → worker → transport →
// store → React pipeline is end-to-end live.

// Suppress the new-visitor tour for the dashboard suite; its auto-fire
// would block clicks and screenshots. The NUX has its own dedicated
// suite (nux.spec.ts) that exercises auto-fire and the reopen
// affordance directly.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('bobivolve:nux-seen', '1');
  });
});

async function startFreshRun(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  // OPFS survives page and browser-context reloads. A prior test can
  // leave the default run paused, so live-run tests must start explicitly.
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  // Start dispatches asynchronously. Wait until its founder is visible
  // before tests can pause or inspect the new run.
  await expect(page.locator('.lineage-tree button[aria-pressed]').first()).toBeVisible();
}

function readNumeric(text: string): number {
  const match = text.match(/-?\d+(?:[\d_,]*\d)?/);
  if (match === null) return Number.NaN;
  return Number(match[0].replace(/[_,]/g, ''));
}

test('page loads with the header and tagline', async ({ page }) => {
  await startFreshRun(page);
  await expect(page.locator('h1')).toHaveText('Bobivolve');
  await expect(page.locator('.bobivolve-tagline')).toContainText('seed');
});

test('reload resumes the existing default run', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Seed' }).fill('2026');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  const populationMeta = page.locator('.population-panel .panel-meta');
  await expect(populationMeta).toContainText(/simTick [1-9]/, { timeout: 10_000 });
  await page.getByRole('button', { name: /^Pause$/ }).click();
  await expect(page.getByRole('button', { name: /^Resume$/ })).toBeVisible();
  const before = await populationMeta.textContent();
  const tick = before?.match(/simTick (\d+)/)?.[1];
  expect(tick).toBeDefined();

  await page.reload();
  await expect(page.getByRole('button', { name: /^Resume$/ })).toBeVisible();
  await expect
    .poll(async () => Number((await populationMeta.textContent())?.match(/simTick (\d+)/)?.[1]))
    .toBeGreaterThanOrEqual(Number(tick));
});

test('reload restores the active non-default run', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Switch run…' }).click();
  await page.getByRole('button', { name: 'new run…' }).click();
  await page.getByRole('textbox', { name: 'name' }).fill('reload-fixture');
  await page.getByRole('button', { name: 'create & switch' }).click();
  await page.getByRole('textbox', { name: 'Seed' }).fill('2026');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  const populationMeta = page.locator('.population-panel .panel-meta');
  await expect(populationMeta).toContainText(/simTick [1-9]/, { timeout: 10_000 });
  await page.getByRole('button', { name: /^Pause$/ }).click();
  await expect(page.getByRole('button', { name: /^Resume$/ })).toBeVisible();
  const tick = (await populationMeta.textContent())?.match(/simTick (\d+)/)?.[1];
  expect(tick).toBeDefined();

  await page.reload();
  await expect(page.getByRole('button', { name: /^Resume$/ })).toBeVisible();
  await expect
    .poll(async () => Number((await populationMeta.textContent())?.match(/simTick (\d+)/)?.[1]))
    .toBeGreaterThanOrEqual(Number(tick));
  await expect(page.getByRole('button', { name: 'Switch run…' })).toHaveAttribute(
    'title',
    'Active: reload-fixture',
  );
});

test('the sim runs: population grows past 1', async ({ page }) => {
  await startFreshRun(page);
  // Start fires at seed=42, speed=4×. Founder is one probe; first
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
  await startFreshRun(page);

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

test('1× speed advances slower than 16×', async ({ page }, testInfo) => {
  async function measure(speed: 1 | 16) {
    // Both observations start in a fresh seed-42 world at 1x. Configure
    // the requested speed while paused, before replication can dominate
    // worker cost or automatic pauses can confound the pacing comparison.
    await page.goto('/');
    const slowButton = page.getByRole('button', { name: '1×', exact: true });
    await slowButton.click();
    await expect(slowButton).toHaveAttribute('data-pending', 'false');
    await page.getByRole('textbox', { name: 'Seed', exact: true }).fill('42');
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(page.locator('.lineage-tree button[aria-pressed]').first()).toBeVisible();
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveAttribute(
      'data-pending',
      'false',
    );
    // Navigation and actionability can age even a 1x run on a slow browser.
    // Rewind through the production timeline action to give both speed
    // observations the identical real tick-zero, one-founder state.
    await expect(
      page.getByRole('button', { name: 'Pin ancestry group', exact: true }),
    ).toBeEnabled();
    await page.evaluate(async () => {
      const path = '/sim-store.ts';
      const { useSimStore } = (await import(/* @vite-ignore */ path)) as {
        useSimStore: { getState(): SimStoreState };
      };
      const transport = useSimStore.getState().transport;
      if (transport === null) throw new Error('Missing simulation transport');
      await new Promise<void>((resolve, reject) => {
        const unsubscribe = transport.onEvent((event) => {
          if (
            (event.kind === 'commandAck' || event.kind === 'commandError') &&
            event.commandId === commandId
          ) {
            unsubscribe();
            if (event.kind === 'commandError') reject(new Error(event.message));
            else resolve();
          }
        });
        useSimStore.getState().rewindToTick(0n);
        const commandId = [...useSimStore.getState().pendingCommands.values()].find(
          (command) => command.kind === 'rewindToTick',
        )?.commandId;
        if (commandId === undefined) {
          unsubscribe();
          reject(new Error('Tick-zero rewind did not start'));
        }
      });
    });
    await expect(page.locator('.population-panel .panel-meta')).toHaveText('simTick 0');
    await expect(page.locator('.population-total')).toHaveText('1 probes');
    for (const name of ['Significant drift', 'Lineage extinction', 'Patch saturated']) {
      await page.getByRole('checkbox', { name, exact: true }).uncheck();
    }
    const speedButton = page.getByRole('button', { name: `${speed}×`, exact: true });
    await speedButton.click();
    await expect(speedButton).toHaveAttribute('aria-pressed', 'true');
    await expect(speedButton).toHaveAttribute('data-pending', 'false');

    const observation = await page.evaluate(async () => {
      const control = document.querySelector<HTMLButtonElement>('.controls-panel .control-button');
      if (control === null || control.textContent !== 'Resume')
        throw new Error('Speed observation must start paused');
      const readTick = (): number =>
        Number(
          document
            .querySelector('.population-panel .panel-meta')
            ?.textContent?.match(/simTick (\d+)/)?.[1],
        );
      const waitForTick = async (target: number): Promise<number> => {
        let tick: number;
        do {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          tick = readTick();
        } while (tick < target);
        return tick;
      };
      const pausedTick = readTick();
      if (!Number.isFinite(pausedTick)) throw new Error('Missing rendered simulation tick');
      // Click the production control inside this single browser observation,
      // so driver scheduling cannot extend a growing 16x setup between calls.
      control.click();
      // Start timing after the real resumed pipeline renders its first tick.
      // Compare a bounded tick window in each fresh world; a fixed short wall
      // window can observe no rendered heartbeat on a throttled CI browser.
      const firstTick = await waitForTick(pausedTick + 1);
      const startedAt = performance.now();
      const finalTick = await waitForTick(firstTick + 32);
      const elapsedMs = performance.now() - startedAt;
      control.click();
      return { pausedTick, firstTick, finalTick, advance: finalTick - firstTick, elapsedMs };
    });
    await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveAttribute(
      'data-pending',
      'false',
    );
    expect(observation.advance).toBeGreaterThan(0);
    return observation;
  }

  const slow = await measure(1);
  const fast = await measure(16);
  const observationPath = testInfo.outputPath('speed-observations.json');
  await writeFile(observationPath, JSON.stringify({ slow, fast }, null, 2));
  await testInfo.attach('speed-observations', {
    path: observationPath,
    contentType: 'application/json',
  });
  // Actual elapsed time includes browser scheduling and rendered overshoot.
  // Both tick counts must advance, and 16x must have a strictly higher rate.
  expect(fast.advance / fast.elapsedMs).toBeGreaterThan(slow.advance / slow.elapsedMs);
});

test('pause actually halts growth at 64× with a busy worker', async ({ page }) => {
  await startFreshRun(page);
  // Speciation can auto-pause before the click; this test exercises the
  // player's Pause command under load.
  await page.getByRole('checkbox', { name: 'Significant drift' }).uncheck();
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
  await startFreshRun(page);
  await page.getByRole('checkbox', { name: 'Significant drift' }).uncheck();
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
  await startFreshRun(page);
  await expect(page.locator('.lineage-tree')).toContainText('L0');
});

test('lineage tree founder row does not duplicate name and id', async ({ page }) => {
  await startFreshRun(page);
  // The founder lineage's name is currently the same string as its id
  // ("L0"); the row should render it once, not twice. A regression
  // would print "L0 L0" verbatim, so a substring assert is sufficient.
  const rowText = await page.locator('.lineage-tree .lineage-node-row').first().textContent();
  expect(rowText ?? '').not.toMatch(/\bL0\s+L0\b/);
});

test('every panel and control is visibly rendered', async ({ page }) => {
  await startFreshRun(page);

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

  // ── AutoPausePanel: five trigger checkboxes ──────────────────────────
  // (significant drift, lineage extinction, patch saturated, first
  // contact, treaty violation; the last two are R3+ and rendered
  // disabled but still visible)
  const autopauseRows = page.locator('.autopause-row');
  await expect(autopauseRows).toHaveCount(5);
  for (let i = 0; i < 5; i += 1) {
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
  await startFreshRun(page);
  const inspectorPanel = page.locator('.inspector-panel');
  // Identity for the founder lineage.
  await expect(inspectorPanel).toContainText('P0');
  await expect(inspectorPanel).toContainText('tick 0');
  // Firmware description from the host's drift telemetry (the founder's
  // reference firmware for the replicate directive).
  await expect(inspectorPanel).toContainText(/replicates/i);
});

test('lineage inspector surfaces the speciation rule', async ({ page }) => {
  await startFreshRun(page);
  const inspectorPanel = page.locator('.inspector-panel');
  // The rule is exposed by the host on the drift telemetry message and
  // rendered next to the Drift heading. R0 sets the divisor to 100, so
  // the threshold reads as ±1.00%.
  await expect(inspectorPanel).toContainText(/speciates beyond ±\d+\.\d+% of founder/);
});

test('substrate panel renders the lattice and at least one probe dot', async ({ page }) => {
  await startFreshRun(page);
  // Substrate now renders to a canvas, so individual cells/probes
  // aren't queryable as DOM elements. Verify the canvas is mounted
  // with a non-zero pixel buffer, then sample its centre to confirm
  // the useEffect actually drew something — under normal operation
  // the centre is either resource-tinted or a probe colour, never
  // the pure-black backdrop.
  const canvas = page.locator('.substrate-panel canvas.substrate-canvas');
  await expect(canvas).toBeVisible();

  await expect
    .poll(
      async () =>
        await canvas.evaluate((el) => {
          const c = el as HTMLCanvasElement;
          return c.width > 0 && c.height > 0;
        }),
      { timeout: 10_000 },
    )
    .toBe(true);

  await expect
    .poll(
      async () =>
        await canvas.evaluate((el) => {
          const c = el as HTMLCanvasElement;
          const ctx = c.getContext('2d');
          if (ctx === null) return null;
          const x = Math.floor(c.width / 2);
          const y = Math.floor(c.height / 2);
          const data = ctx.getImageData(x, y, 1, 1).data;
          return [data[0], data[1], data[2], data[3]].join(',');
        }),
      { timeout: 10_000, intervals: [500] },
    )
    .not.toBe('0,0,0,255');
});

test('Save click pauses the sim and prompts for a slot name', async ({ page }) => {
  await startFreshRun(page);
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
  await startFreshRun(page);
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
  await startFreshRun(page);
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
  await startFreshRun(page);

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

test('patch editor rejects values beyond uint64', async ({ page }) => {
  await startFreshRun(page);
  await page.getByRole('button', { name: /^Pause$/ }).click();
  await page.locator('.lineage-tree button[aria-pressed]').first().click();
  await page.getByRole('button', { name: /^Apply patch$/ }).click();

  const gatherRate = page.getByRole('textbox', { name: 'Proposed maximum energy per tick' });
  const apply = page.locator('.patch-editor-button-primary');
  for (const invalid of ['', '-1', '1.5', (1n << 64n).toString()]) {
    await gatherRate.fill(invalid);
    await expect(apply).toBeDisabled();
    await expect(gatherRate).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('.firmware-editor-validation')).toContainText('Enter a whole number');
  }
  await gatherRate.fill(((1n << 64n) - 1n).toString());
  await expect(apply).toBeEnabled();
});

test('patch editor compares readable reference values and preserves exact submitted firmware', async ({
  page,
}) => {
  await startFreshRun(page);
  await page.getByRole('button', { name: /^Pause$/ }).click();
  await page.locator('.lineage-tree button[aria-pressed]').first().click();
  await page.getByRole('button', { name: /^Apply patch$/ }).click();
  const dialog = page.getByRole('dialog', { name: /Apply patch to/ });
  const gather = dialog.locator('.patch-editor-row').filter({ hasText: 'Maximum energy per tick' });
  const explore = dialog
    .locator('.patch-editor-row')
    .filter({ hasText: 'Movement-attempt probability per tick' });
  const replicate = dialog
    .locator('.patch-editor-row')
    .filter({ hasText: 'Minimum stored energy' });
  await expect(dialog).toContainText('Individual probes may have drifted');
  await expect(dialog).toContainText('One-time authoring charge: 100 Origin compute');
  await expect(dialog.locator('.firmware-editor-cost')).toContainText('Available compute1000');
  await expect(dialog.locator('.firmware-editor-cost')).toContainText('After submission900');
  await expect(gather.locator('.firmware-editor-current strong')).toHaveText('2');
  await expect(explore.locator('.firmware-editor-current strong')).toHaveText('1.5625%');
  await expect(replicate.locator('.firmware-editor-current strong')).toHaveText('1000');

  await dialog.getByRole('textbox', { name: 'Proposed maximum energy per tick' }).fill('4');
  const encoded = dialog.getByRole('textbox', { name: 'Proposed encoded threshold' });
  await encoded.fill('1');
  await expect(explore.locator('.firmware-editor-probability')).toHaveText('<0.000001%');
  const exactMaximum = '18446744073709551615';
  await encoded.fill(exactMaximum);
  await expect(explore.locator('.firmware-editor-probability')).toHaveText('>99.999999%');
  await dialog.getByRole('textbox', { name: 'Proposed minimum stored energy' }).fill(exactMaximum);
  await expect(gather.locator('.firmware-editor-current strong')).toHaveText('2');
  await expect(explore.locator('.firmware-editor-current strong')).toHaveText('1.5625%');
  await expect(dialog.locator('.firmware-editor-cost')).toContainText('After submission900');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Resume$/ })).toBeVisible();

  await page.getByRole('button', { name: /^Apply patch$/ }).click();
  await expect(gather.locator('.firmware-editor-current strong')).toHaveText('4');
  await expect(encoded).toHaveValue(exactMaximum);
  await expect(dialog.getByRole('textbox', { name: 'Proposed minimum stored energy' })).toHaveValue(
    exactMaximum,
  );
  await expect(dialog.locator('.firmware-editor-cost')).toContainText('Available compute900');
  await expect(dialog.locator('.firmware-editor-cost')).toContainText('After submission800');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('patch editor charges unchanged submissions and blocks an unaffordable patch', async ({
  page,
}) => {
  await startFreshRun(page);
  await page.getByRole('button', { name: /^Pause$/ }).click();
  await page.locator('.lineage-tree button[aria-pressed]').first().click();
  const dialog = page.getByRole('dialog', { name: /Apply patch to/ });
  for (let submission = 0; submission < 10; submission += 1) {
    await page.getByRole('button', { name: /^Apply patch$/ }).click();
    await expect(dialog.locator('.firmware-editor-cost')).toContainText(
      `After submission${(900 - submission * 100).toString()}`,
    );
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
  await page.getByRole('button', { name: /^Apply patch$/ }).click();
  await expect(dialog.locator('.firmware-editor-cost')).toContainText('Available compute0');
  await expect(dialog.locator('.firmware-editor-cost')).toContainText('Shortfall100');
  await expect(dialog).toContainText('Insufficient Origin compute to apply.');
  await expect(dialog.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Resume$/ })).toBeVisible();
});

test('a cancelled patch editor ignores a late acknowledgement after a new run', async ({
  page,
}) => {
  await startFreshRun(page);
  await page.getByRole('button', { name: /^Pause$/ }).click();
  await page.locator('.lineage-tree button[aria-pressed]').first().click();
  await page.getByRole('button', { name: /^Apply patch$/ }).click();
  // Hold the command reply at the store boundary to exercise the modal's
  // lifecycle independently of worker speed.
  await page.evaluate(async () => {
    const path = '/sim-store.ts';
    const { useSimStore } = (await import(
      /* @vite-ignore */ path
    )) as typeof import('../ui/sim-store.js');
    useSimStore.setState({
      applyPatch: () =>
        new Promise<string | null>((resolve) => {
          (window as Window & { finishPatch?: () => void }).finishPatch = () => {
            resolve(null);
          };
        }),
    });
  });
  const dialog = page.getByRole('dialog', { name: /Apply patch to/ });
  await dialog.getByRole('textbox', { name: 'Proposed maximum energy per tick' }).fill('4');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.getByRole('button', { name: /^Pause$/ }).click();
  await page.getByRole('button', { name: /^Apply patch$/ }).click();
  await expect(
    dialog.getByRole('textbox', { name: 'Proposed maximum energy per tick' }),
  ).toHaveValue('2');
  await page.evaluate(() => {
    (window as Window & { finishPatch?: () => void }).finishPatch?.();
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.firmware-editor-current strong').first()).toHaveText('2');
  await expect(
    dialog.getByRole('textbox', { name: 'Proposed maximum energy per tick' }),
  ).toHaveValue('2');
});

test('quarantine toggle flips the inspector and the tree pip', async ({ page }) => {
  // Player intervention smoke: select L0, hit Quarantine, see the
  // inspector flip its meta and the tree row carry the quarantine pip;
  // hit Release, see both back to normal.
  await startFreshRun(page);
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

test('patch editor closes after the host accepts the patch', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  const openPatch = page.getByRole('button', { name: /^Apply patch$/ });
  await expect(openPatch).toBeEnabled();
  await page.getByRole('button', { name: /^Pause$/ }).click();
  await openPatch.click();
  const dialog = page.getByRole('dialog', { name: /Apply patch to/ });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Resume$/ })).toBeVisible();
});

test('queued decrees and patch history survive a named save and load', async ({ page }) => {
  await startFreshRun(page);
  await page.getByRole('button', { name: /^Pause$/ }).click();
  await expect(page.getByRole('button', { name: /^Resume$/ })).toBeVisible();
  await page.locator('.lineage-tree button[aria-pressed]').first().click();

  await page.getByRole('button', { name: /^Apply patch$/ }).click();
  const patch = page.getByRole('dialog', { name: /Apply patch to/ });
  await patch.getByRole('textbox', { name: 'Proposed maximum energy per tick' }).fill('3');
  await patch.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(patch).toHaveCount(0);
  await expect(page.locator('.inspector-panel .patches-list')).toContainText('PT0');

  await page.getByRole('button', { name: 'Queue decree', exact: true }).click();
  const decree = page.getByRole('dialog', { name: 'Compose decree' });
  // Zero keeps it queued while we test persistence, irrespective of population.
  await decree.getByRole('textbox', { name: 'population <' }).fill('0');
  await decree.getByRole('button', { name: 'Queue', exact: true }).click();
  await expect(decree).toHaveCount(0);
  await expect(page.locator('.decrees-panel .decree-row')).toHaveCount(1);

  page.once('dialog', (dialog) => {
    void dialog.accept('intervention-checkpoint');
  });
  await page.locator('.run-panel').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.run-status')).toContainText(/saved at tick \d+/);
  await page.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(page.locator('.decrees-panel .decree-row')).toHaveCount(0);

  await page.getByRole('button', { name: 'Load', exact: true }).click();
  await page
    .locator('.load-picker .save-load-button')
    .filter({ hasText: 'intervention-checkpoint' })
    .click();
  await expect(page.locator('.load-picker')).toHaveCount(0);
  await expect(page.locator('.decrees-panel .decree-row')).toHaveCount(1);
  await expect(page.locator('.inspector-panel .patches-list')).toContainText('PT0');
  await expect(page.getByRole('button', { name: /^Resume$/ })).toBeVisible();
});

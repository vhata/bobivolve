import { expect, test } from '@playwright/test';

// Forensic replay: clicking a row in the events timeline rewinds the
// sim to that event's tick. Destructive — post-tick state is forfeit.
// The host loads the latest in-run snapshot at-or-before the target,
// replays any logged commands, and pauses on completion.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('bobivolve:nux-seen', '1');
  });
});

test('clicking a timeline event rewinds the sim to that event tick', async ({ page }) => {
  test.setTimeout(60_000);

  await page.goto('/');
  await page.getByRole('button', { name: 'Start', exact: true }).click();

  // Crank to 64× so a speciation lands in a reasonable window.
  await page.getByRole('button', { name: '64×', exact: true }).click({ force: true });

  // Wait for a timeline row while the simulation is still running.
  await expect(page.locator('.timeline-panel .timeline-rewind-disabled').first()).toBeVisible({
    timeout: 45_000,
  });

  // Pause before choosing a rewind target; rows are only clickable
  // while paused (modal-on-action).
  await page.getByRole('button', { name: /^Pause$/ }).click({ force: true });
  await expect(page.getByRole('button', { name: /^Resume$/ })).toBeVisible({ timeout: 10_000 });
  const rewindButton = page.locator('.timeline-panel button.timeline-rewind').first();

  // Capture the target tick from the (now-stable) latest-speciation row.
  const tickText = await rewindButton.locator('.timeline-tick').textContent();
  const tickMatch = tickText?.match(/tick\s+(\d+)/);
  expect(tickMatch).not.toBeNull();
  const targetTick = Number(tickMatch?.[1]);
  expect(targetTick).toBeGreaterThan(0);

  await rewindButton.click({ force: true });

  // The destructive nature of rewind warrants a confirm modal —
  // click through it to commit.
  const rewindButtonInModal = page.locator('.rewind-confirm button.rewind-confirm-go');
  await expect(rewindButtonInModal).toBeVisible({ timeout: 5_000 });
  await rewindButtonInModal.click({ force: true });

  // The Population panel meta carries simTick; after rewind it lands
  // on the target tick. The post-rewind heartbeat replaces simTick on
  // the next rAF; the rehydrate then repopulates the lineage tree.
  const populationMeta = page.locator('.population-panel .panel-meta');
  await expect
    .poll(
      async () => {
        const text = (await populationMeta.textContent()) ?? '';
        const m = text.match(/simTick\s+(\d+)/);
        return m === null ? null : Number(m[1]);
      },
      { timeout: 10_000, intervals: [500] },
    )
    .toBe(targetTick);
  await expect(page.locator('.timeline-panel .panel-empty')).toContainText(
    'no significant events yet',
  );
});

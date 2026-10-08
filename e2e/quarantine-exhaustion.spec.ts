import { expect, test } from '@playwright/test';
import type { SimStoreState } from '../ui/sim-store.js';

test('unfunded quarantine releases on the next tick and explains why', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('bobivolve:nux-seen', '1'));
  await page.goto('/');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.locator('.lineage-tree button[aria-pressed]').first()).toBeVisible();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveAttribute(
    'data-pending',
    'false',
  );
  // The saturation auto-pause below needs the patched lineage to carry more
  // than half the population, which stops holding once the run has aged past
  // its first speciations. Rewind through the production timeline action so
  // the fixture starts from the identical tick-zero, one-founder world
  // however long Start ran before Pause took effect.
  await page.evaluate(async () => {
    const path = '/sim-store.ts';
    const { useSimStore } = (await import(/* @vite-ignore */ path)) as {
      useSimStore: { getState(): SimStoreState };
    };
    useSimStore.getState().rewindToTick(0n);
  });
  await expect(page.locator('.population-panel .panel-meta')).toHaveText('simTick 0');
  await expect(page.locator('.population-total')).toHaveText('1 probes');
  await page.locator('.lineage-tree button[aria-pressed]').first().click();
  // Spend through actual player commands while paused, so regeneration
  // cannot race this fixture. No injected simulation or store state.
  const patch = page.getByRole('dialog', { name: /Apply patch to/ });
  for (let i = 0; i < 10; i += 1) {
    await page.getByRole('button', { name: 'Apply patch', exact: true }).click();
    await patch.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(patch).toHaveCount(0);
  }
  await expect(page.locator('.origin-panel .panel-header')).toContainText('0 / 1000');
  await page.getByRole('button', { name: 'Quarantine', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Release quarantine', exact: true })).toBeVisible();
  await expect(page.locator('.origin-panel')).toContainText('Holds are funded oldest first');
  await expect(page.locator('.origin-panel [role="status"]')).toContainText('Insufficient compute');
  await page.getByRole('checkbox', { name: 'Patch saturated', exact: true }).check();
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Quarantine', exact: true })).toBeVisible();
  await expect(page.locator('.inspector-panel .panel-meta')).not.toContainText('quarantined');
  await expect(page.locator('.lineage-tree .lineage-quarantine-pip')).toHaveCount(0);
  await expect(page.locator('.origin-panel .panel-header')).toContainText('1 / 1000');
  await expect(page.locator('.origin-panel [role="status"]')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /quarantine released.*insufficient compute/ }),
  ).toBeVisible();
});

import { expect, test } from '@playwright/test';
import type { SimStoreState } from '../ui/sim-store.js';

test('replacement waits for coherent telemetry before showing provenance', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('bobivolve:nux-seen', '1'));
  await page.goto('/');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.locator('.lineage-tree button[aria-pressed]').first()).toBeVisible();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveAttribute(
    'data-pending',
    'false',
  );

  async function patch(rate: string): Promise<void> {
    await page.getByRole('button', { name: 'Apply patch', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: /Apply patch to/ });
    await dialog.getByRole('textbox', { name: 'Proposed maximum energy per tick' }).fill(rate);
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }

  await patch('3');
  const provenance = page.getByRole('region', { name: 'Patch provenance' });
  const first = provenance.locator('details').filter({
    has: page.locator('summary', { hasText: 'PT0' }),
  });
  await first.locator('summary').click();
  await expect(first).toContainText('current reference matches this patch');

  // Delay delivery of actual worker replies; commands and telemetry remain
  // real. Hold every reply so interval polls cannot accidentally end the gap.
  await page.evaluate(async () => {
    const path = '/sim-store.ts';
    const { useSimStore } = (await import(/* @vite-ignore */ path)) as {
      useSimStore: { getState(): SimStoreState };
    };
    const transport = useSimStore.getState().transport;
    if (transport === null) throw new Error('Missing simulation transport');
    const original = transport.query;
    const releases: (() => void)[] = [];
    let holding = true;
    transport.query = (async (query) => {
      const actual = await original.call(transport, query);
      if (query.kind === 'driftTelemetry' && holding)
        await new Promise<void>((resolve) => releases.push(resolve));
      return actual;
    }) as typeof transport.query;
    const fixture = window as typeof window & { releaseDriftTelemetry?: () => void };
    fixture.releaseDriftTelemetry = () => {
      holding = false;
      transport.query = original;
      for (const release of releases) release();
      delete fixture.releaseDriftTelemetry;
    };
  });
  await patch('4');
  await expect(provenance).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Apply patch', exact: true })).toBeDisabled();
  await page.evaluate(() => {
    const fixture = window as typeof window & { releaseDriftTelemetry?: () => void };
    if (fixture.releaseDriftTelemetry === undefined) throw new Error('Missing held telemetry');
    fixture.releaseDriftTelemetry();
  });
  await expect(provenance.locator('details')).toHaveCount(2);
  await first.locator('summary').click();
  await expect(first.locator('summary')).toContainText('0 exact matches');
  await expect(first).toContainText('current reference differs from this patch');
  await expect(
    first.getByRole('cell', { name: 'Gather 3 energy/tick maximum', exact: true }),
  ).toHaveCount(1);
  await expect(
    first.getByRole('cell', { name: 'Gather 4 energy/tick maximum', exact: true }),
  ).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Apply patch', exact: true })).toBeEnabled();
});

test('patch ancestry and exact retention remain distinct after replacement and save/load', async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('bobivolve:nux-seen', '1');
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.locator('.lineage-tree button[aria-pressed]').first()).toBeVisible();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.locator('.lineage-tree button[aria-pressed]').first().click();
  async function patch(rate: string): Promise<void> {
    await page.getByRole('button', { name: 'Apply patch', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: /Apply patch to/ });
    await dialog.getByRole('textbox', { name: 'Proposed maximum energy per tick' }).fill(rate);
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
  await patch('3');
  const provenance = page.getByRole('region', { name: 'Patch provenance' });
  const first = provenance
    .locator('details')
    .filter({ has: page.locator('summary', { hasText: 'PT0' }) });
  await first.locator('summary').click();
  await expect(first).toContainText('current reference matches this patch');
  await expect(
    first.getByRole('cell', { name: 'Gather 3 energy/tick maximum', exact: true }),
  ).toHaveCount(2);
  await patch('4');
  await expect(first.locator('summary')).toContainText('0 exact matches');
  // Refreshing the complete snapshot remounts its native disclosure.
  await first.locator('summary').click();
  await expect(first).toContainText('current reference differs from this patch');
  await expect(
    first.getByRole('cell', { name: 'Gather 3 energy/tick maximum', exact: true }),
  ).toHaveCount(1);
  await expect(
    first.getByRole('cell', { name: 'Gather 4 energy/tick maximum', exact: true }),
  ).toHaveCount(1);
  await expect(provenance).toContainText('Saturation counts ancestry above 50%');
  const before = await provenance.innerText();
  page.once('dialog', (dialog) => {
    void dialog.accept('provenance');
  });
  await page.locator('.run-panel').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.run-status')).toContainText(/saved at tick \d+/);
  await patch('5');
  await expect(provenance.locator('details')).toHaveCount(3);
  await page.getByRole('button', { name: 'Load', exact: true }).click();
  await page.locator('.load-picker .save-load-button').filter({ hasText: 'provenance' }).click();
  await expect(provenance.locator('details')).toHaveCount(2);
  // Native details may retain open state across the timeline replacement.
  if (!(await first.evaluate((el) => (el as HTMLDetailsElement).open)))
    await first.locator('summary').click();
  await expect.poll(() => provenance.innerText()).toBe(before);
});

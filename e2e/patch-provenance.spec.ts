import { expect, test } from '@playwright/test';

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

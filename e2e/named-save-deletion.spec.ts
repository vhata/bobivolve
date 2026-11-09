import { expect, test } from '@playwright/test';
import { clickStart } from './start-run.js';

test('named save deletion confirms the name, preserves cancel and other saves, and survives reload', async ({
  page,
}) => {
  await page.addInitScript(() => window.localStorage.setItem('bobivolve:nux-seen', '1'));
  await page.goto('/');
  await clickStart(page);
  await expect(page.locator('.lineage-tree button[aria-pressed]').first()).toBeVisible();
  for (const slot of ['delete-fixture', 'keep-fixture']) {
    page.once('dialog', (dialog) => {
      void dialog.accept(slot);
    });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.run-status')).toContainText(/saved at tick \d+/);
  }
  await page.getByRole('button', { name: 'Load', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Load a save' });
  const deleting = picker.getByRole('button', { name: 'Delete save delete-fixture', exact: true });
  await expect(deleting).toBeVisible();
  const activeRun = await page.getByRole('button', { name: 'Switch run…' }).getAttribute('title');
  const tick = await page.locator('.population-panel .panel-meta').textContent();
  page.once('dialog', (dialog) => {
    expect(dialog.message()).toContain('Delete save "delete-fixture"?');
    void dialog.dismiss();
  });
  await deleting.click();
  await expect(deleting).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  page.once('dialog', (dialog) => {
    void dialog.accept();
  });
  await deleting.click();
  await expect(deleting).toHaveCount(0);
  await expect(
    picker.getByRole('button', { name: 'Delete save keep-fixture', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.population-panel .panel-meta')).toHaveText(tick!);
  await expect(page.getByRole('button', { name: 'Switch run…' })).toHaveAttribute(
    'title',
    activeRun!,
  );
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Load', exact: true }).click();
  await expect(
    picker.getByRole('button', { name: 'Delete save keep-fixture', exact: true }),
  ).toBeVisible();
  await expect(deleting).toHaveCount(0);
  await picker.locator('.save-load-button').filter({ hasText: 'keep-fixture' }).click();
  await expect(picker).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
});

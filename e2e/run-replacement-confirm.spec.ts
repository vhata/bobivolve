import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('bobivolve:nux-seen', '1');
  });
});

function tickOf(text: string | null): number {
  const tick = text?.match(/simTick (\d+)/)?.[1];
  expect(tick).toBeDefined();
  return Number(tick);
}

test('Start pauses and confirms before replacing the active run', async ({ page }) => {
  const runId = `replace-${Date.now().toString(36)}`;
  const populationMeta = page.locator('.population-panel .panel-meta');
  const tagline = page.locator('.bobivolve-tagline');
  const seedInput = page.getByRole('textbox', { name: 'Seed' });
  const start = page.getByRole('button', { name: 'Start', exact: true });
  const confirm = page.getByRole('dialog', { name: 'Confirm run replacement' });
  const cancel = confirm.getByRole('button', { name: 'Cancel', exact: true });
  const replace = confirm.getByRole('button', { name: 'Replace run', exact: true });
  const resume = page.getByRole('button', { name: /^Resume$/ });

  await page.goto('/');
  await page.getByRole('button', { name: 'Switch run…' }).click();
  await page.getByRole('button', { name: 'new run…' }).click();
  await page.getByRole('textbox', { name: 'name' }).fill(runId);
  await page.getByRole('button', { name: 'create & switch' }).click();
  await expect(page.getByRole('button', { name: 'Switch run…' })).toHaveAttribute(
    'title',
    `Active: ${runId}`,
  );

  // Even a just-created slot asks: the dashboard's projection cannot prove
  // that the host's slot is empty.
  await seedInput.fill('2026');
  await start.click();
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole('heading')).toHaveText(`Replace run "${runId}"?`);
  await expect(confirm).toContainText('seed 2026');
  await replace.click();
  await expect(confirm).toHaveCount(0);
  await expect(tagline).toHaveText('seed 2026');
  await expect(populationMeta).toContainText(/simTick [1-9]/, { timeout: 10_000 });
  await expect(page.getByRole('button', { name: /^Pause$/ })).toBeVisible();

  // Clicking Start on a live run pauses it and focuses Cancel.
  await seedInput.fill('7');
  await start.click();
  await expect(confirm).toBeVisible();
  await expect(resume).toBeVisible();
  await expect(cancel).toBeFocused();
  await expect(confirm).toContainText('seed 7');
  await expect(confirm).toContainText('currently at tick');

  // Cancel leaves the run in place and paused.
  await cancel.click();
  await expect(confirm).toHaveCount(0);
  await expect(tagline).toHaveText('seed 2026');
  await expect(resume).toBeVisible();

  // Pressing Enter twice in the seed field opens the dialog and then
  // activates the focused Cancel; it never replaces the run.
  await seedInput.focus();
  await page.keyboard.press('Enter');
  await expect(confirm).toBeVisible();
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(confirm).toHaveCount(0);
  await expect(tagline).toHaveText('seed 2026');

  // Escape and a backdrop click also cancel.
  await start.click();
  await expect(confirm).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await start.click();
  await expect(confirm).toBeVisible();
  await confirm.click({ position: { x: 5, y: 5 } });
  await expect(confirm).toHaveCount(0);
  await expect(tagline).toHaveText('seed 2026');
  const tick = tickOf(await populationMeta.textContent());
  expect(tick).toBeGreaterThan(0);

  // The cancelled run is still on disk after a reload.
  await page.reload();
  await expect(resume).toBeVisible();
  await expect
    .poll(async () => tickOf(await populationMeta.textContent()))
    .toBeGreaterThanOrEqual(tick);
  const reloadedTick = tickOf(await populationMeta.textContent());
  await expect(page.getByRole('button', { name: 'Switch run…' })).toHaveAttribute(
    'title',
    `Active: ${runId}`,
  );

  // Confirming replaces the run with the new seed and starts it running.
  await seedInput.fill('7');
  await start.click();
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText(`currently at tick ${reloadedTick}`);
  await replace.click();
  await expect(confirm).toHaveCount(0);
  await expect(tagline).toHaveText('seed 7');
  await expect(page.getByRole('button', { name: /^Pause$/ })).toBeVisible();
  await expect(populationMeta).toContainText(/simTick [1-9]/, { timeout: 10_000 });
});

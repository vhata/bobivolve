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

test('Start confirms before replacing a run with progress and skips the confirm for an empty slot', async ({
  page,
}) => {
  const runId = `replace-${Date.now().toString(36)}`;
  const populationMeta = page.locator('.population-panel .panel-meta');
  const seedInput = page.getByRole('textbox', { name: 'Seed' });
  const start = page.getByRole('button', { name: 'Start', exact: true });
  const confirm = page.getByRole('dialog', { name: 'Confirm run replacement' });

  await page.goto('/');
  await page.getByRole('button', { name: 'Switch run…' }).click();
  await page.getByRole('button', { name: 'new run…' }).click();
  await page.getByRole('textbox', { name: 'name' }).fill(runId);
  await page.getByRole('button', { name: 'create & switch' }).click();
  await expect(page.getByRole('button', { name: 'Switch run…' })).toHaveAttribute(
    'title',
    `Active: ${runId}`,
  );

  // A freshly created slot holds no simulation, so Start runs straight away.
  await seedInput.fill('2026');
  await start.click();
  await expect(confirm).toHaveCount(0);
  await expect(populationMeta).toContainText(/simTick [1-9]/, { timeout: 10_000 });
  await page.getByRole('button', { name: /^Pause$/ }).click();
  await expect(page.getByRole('button', { name: /^Resume$/ })).toBeVisible();
  const tick = tickOf(await populationMeta.textContent());

  // A run with progress asks first, naming the run and its tick.
  await seedInput.fill('7');
  await start.click();
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole('heading')).toHaveText(`Replace run "${runId}"?`);
  await expect(confirm).toContainText(`at tick ${tick}`);
  await expect(confirm).toContainText('seed 7');

  // Cancel leaves the run untouched and paused.
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page.locator('.bobivolve-tagline')).toHaveText('seed 2026');
  await expect(page.getByRole('button', { name: /^Resume$/ })).toBeVisible();
  expect(tickOf(await populationMeta.textContent())).toBe(tick);

  // Escape also cancels.
  await start.click();
  await expect(confirm).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);

  // The cancelled run is still on disk after a reload.
  await page.reload();
  await expect(page.getByRole('button', { name: /^Resume$/ })).toBeVisible();
  await expect
    .poll(async () => tickOf(await populationMeta.textContent()))
    .toBeGreaterThanOrEqual(tick);
  await expect(page.getByRole('button', { name: 'Switch run…' })).toHaveAttribute(
    'title',
    `Active: ${runId}`,
  );

  // Confirming replaces the run with the new seed and starts it running.
  await seedInput.fill('7');
  await start.click();
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Replace run', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page.locator('.bobivolve-tagline')).toHaveText('seed 7');
  await expect(page.getByRole('button', { name: /^Pause$/ })).toBeVisible();
  await expect(populationMeta).toContainText(/simTick [1-9]/, { timeout: 10_000 });
});

import { expect, test } from '@playwright/test';

// New-visitor tour. The NUX auto-fires when the localStorage gate is
// absent, persists a 'seen' flag on close, and is reopenable via the
// '?' button in the header. The companion dashboard suite suppresses
// it via beforeEach so other tests don't fight the backdrop.

test('auto-fires on first visit and counts step 1 / 8', async ({ page }) => {
  // Default state — no localStorage flag — should auto-open the tour.
  await page.goto('/');
  await expect(page.locator('.nux-backdrop')).toBeVisible();
  await expect(page.locator('.nux-step-counter')).toContainText('1 / 8');
  await expect(page.locator('.nux-card-title')).toContainText(/Origin/i);
});

test('Next and Back navigate through the steps', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.nux-backdrop')).toBeVisible();

  // Back is disabled on step 1.
  await expect(page.getByRole('button', { name: 'Back' })).toBeDisabled();

  // Advance three times: 1 → 4.
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('.nux-step-counter')).toContainText('2 / 8');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('.nux-step-counter')).toContainText('3 / 8');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('.nux-step-counter')).toContainText('4 / 8');

  // Step back: 4 → 3.
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.locator('.nux-step-counter')).toContainText('3 / 8');
});

test('spotlights the corresponding panel each step', async ({ page }) => {
  await page.goto('/');
  // Step 2 anchors on the run panel.
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('.run-panel.nux-spotlight')).toBeVisible();
  // Step 3 anchors on the population panel; the run panel's spotlight
  // should clear on transition.
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('.population-panel.nux-spotlight')).toBeVisible();
  await expect(page.locator('.run-panel.nux-spotlight')).toHaveCount(0);
});

test('Skip dismisses the tour and persists the seen flag', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.nux-backdrop')).toBeVisible();
  await page.getByRole('button', { name: 'Skip tour' }).click();
  await expect(page.locator('.nux-backdrop')).toHaveCount(0);

  // Reload — the flag should keep the tour from re-firing.
  await page.reload();
  await expect(page.locator('.nux-backdrop')).toHaveCount(0);
});

test('Done finishes the tour from the last step', async ({ page }) => {
  await page.goto('/');
  // Click Next seven times to land on step 8 / 8.
  for (let i = 0; i < 7; i += 1) {
    await page.getByRole('button', { name: 'Next' }).click();
  }
  await expect(page.locator('.nux-step-counter')).toContainText('8 / 8');
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('.nux-backdrop')).toHaveCount(0);
});

test('? button reopens the tour after it has been dismissed', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('bobivolve:nux-seen', '1');
  });
  await page.goto('/');
  // Tour should not auto-fire — flag is set.
  await expect(page.locator('.nux-backdrop')).toHaveCount(0);
  // The help button is in the header.
  await page.getByRole('button', { name: 'Open new-visitor tour' }).click();
  await expect(page.locator('.nux-backdrop')).toBeVisible();
  await expect(page.locator('.nux-step-counter')).toContainText('1 / 8');
});

test('Esc dismisses the tour', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.nux-backdrop')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.nux-backdrop')).toHaveCount(0);
});

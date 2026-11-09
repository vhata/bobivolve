import { expect, type Page } from '@playwright/test';

// Clicks the Run panel's Start button and accepts the replacement
// confirmation, which Start always shows before replacing the active run.
// run-replacement-confirm.spec.ts covers the dialog itself.
export async function clickStart(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Confirm run replacement' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Replace run', exact: true }).click();
  await expect(confirm).toHaveCount(0);
}

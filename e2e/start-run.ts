import type { Page } from '@playwright/test';

// Clicks the Run panel's Start button and accepts the replacement
// confirmation when one appears. Start confirms whenever the active slot
// may hold progress, and OPFS state carries over between tests, so callers
// that only need a fresh run go through this helper rather than asserting
// on the dialog. run-replacement-confirm.spec.ts covers the dialog itself.
export async function clickStart(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Confirm run replacement' });
  if (await confirm.isVisible()) {
    await confirm.getByRole('button', { name: 'Replace run', exact: true }).click();
  }
}

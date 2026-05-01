import { test } from '@playwright/test';

// Disposable test that captures a full-page screenshot of the dashboard
// after a few seconds of live sim. Useful for the assistant to eyeball
// the actual visual layout without bothering the user. Not part of the
// regression set — the visibility test next door covers structural
// invariants that matter.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('bobivolve:nux-seen', '1');
  });
});

test('snapshot the dashboard visually', async ({ page }) => {
  // Vite cold-start plus a 3s sim soak plus a fullPage capture can
  // brush against the default 30s budget on first run; the test isn't
  // in the regression set, so be generous with the budget.
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1400, height: 1100 });
  await page.goto('/');
  // Let some growth happen so the panels have content to show.
  await page.waitForTimeout(3_000);
  await page.screenshot({
    path: 'e2e/dashboard-snapshot.png',
    fullPage: true,
  });
});

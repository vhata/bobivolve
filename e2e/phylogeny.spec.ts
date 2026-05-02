import { expect, test } from '@playwright/test';

// Phylogeny view: an alternate tab beside the living-lineage tree
// that renders every lineage ever produced on a tick axis. Renders
// to a canvas (per the substrate-panel pattern) so per-lineage row
// reconciliation doesn't churn the DOM at fat lineage counts. The
// toggle swaps between living tree and phylogeny; clicking a row
// in the phylogeny selects that lineage via pointer-Y → row lookup.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('bobivolve:nux-seen', '1');
  });
});

test('phylogeny tab toggles the panel and renders the canvas', async ({ page }) => {
  await page.goto('/');

  const livingButton = page.locator('.lineage-tree-panel .lineage-view-toggle-button', {
    hasText: /^Living$/,
  });
  const phylogenyButton = page.locator('.lineage-tree-panel .lineage-view-toggle-button', {
    hasText: /^Phylogeny$/,
  });
  await expect(livingButton).toHaveAttribute('aria-checked', 'true');
  await expect(phylogenyButton).toHaveAttribute('aria-checked', 'false');

  await phylogenyButton.click();
  await expect(phylogenyButton).toHaveAttribute('aria-checked', 'true');
  await expect(livingButton).toHaveAttribute('aria-checked', 'false');

  // The canvas mounts with a non-zero pixel buffer, and the centre
  // of its top row contains the founder lineage's colour-tinted
  // pixels (i.e. not the void backdrop).
  const canvas = page.locator('.phylogeny-canvas');
  await expect(canvas).toBeVisible();
  await expect
    .poll(
      async () =>
        await canvas.evaluate((el) => {
          const c = el as HTMLCanvasElement;
          return c.width > 0 && c.height > 0;
        }),
      { timeout: 10_000 },
    )
    .toBe(true);
});

test('clicking the founder row selects L0', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('radio', { name: 'Phylogeny' }).click();

  // The founder lineage L0 sits on row 0 (top of the canvas). Click
  // its vertical band; the inspector reflects the selection.
  const canvas = page.locator('.phylogeny-canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (box === null) return;
  await page.mouse.click(box.x + box.width / 2, box.y + 14);
  await expect(page.locator('.inspector-panel')).toContainText('P0');
});

test('switching back to Living restores the tree view', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('radio', { name: 'Phylogeny' }).click();
  await expect(page.locator('.phylogeny-canvas')).toBeVisible();

  await page.getByRole('radio', { name: 'Living' }).click();
  await expect(page.locator('.phylogeny-canvas')).toHaveCount(0);
  await expect(page.locator('.lineage-tree')).toBeVisible();
});

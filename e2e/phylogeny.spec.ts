import { expect, test } from '@playwright/test';

// Phylogeny view: an alternate tab beside the living-lineage tree
// that renders every lineage ever produced on a tick axis. Clicking
// the toggle swaps which view the panel renders; clicking a row in
// the phylogeny selects that lineage (mirrors the living-tree click
// behaviour).

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('bobivolve:nux-seen', '1');
  });
});

test('phylogeny tab toggles the panel and renders the founding lineage', async ({ page }) => {
  await page.goto('/');

  // The toggle is visible immediately; "Living" is the default.
  const livingButton = page.locator('.lineage-tree-panel .lineage-view-toggle-button', {
    hasText: /^Living$/,
  });
  const phylogenyButton = page.locator('.lineage-tree-panel .lineage-view-toggle-button', {
    hasText: /^Phylogeny$/,
  });
  await expect(livingButton).toHaveAttribute('aria-checked', 'true');
  await expect(phylogenyButton).toHaveAttribute('aria-checked', 'false');

  // Switch to phylogeny.
  await phylogenyButton.click();
  await expect(phylogenyButton).toHaveAttribute('aria-checked', 'true');
  await expect(livingButton).toHaveAttribute('aria-checked', 'false');

  // The phylogeny SVG renders. The founding lineage L0 always has a
  // row, so the row group with that title is present.
  await expect(page.locator('.phylogeny-svg')).toBeVisible();
  const founderRow = page
    .locator('.phylogeny-svg g.phylogeny-row')
    .filter({ has: page.locator('title', { hasText: /^L0\b/ }) });
  await expect(founderRow).toHaveCount(1);
});

test('clicking a phylogeny row selects that lineage', async ({ page }) => {
  await page.goto('/');

  // Switch to phylogeny first so the rows are in the DOM.
  await page.getByRole('radio', { name: 'Phylogeny' }).click();

  // L0 is always present. Click its row and assert the inspector
  // header reflects the selection (matches the living-tree behaviour).
  const founderRow = page
    .locator('.phylogeny-svg g.phylogeny-row')
    .filter({ has: page.locator('title', { hasText: /^L0\b/ }) });
  await founderRow.click();
  await expect(page.locator('.inspector-panel')).toContainText('P0');
});

test('switching back to Living restores the tree view', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('radio', { name: 'Phylogeny' }).click();
  await expect(page.locator('.phylogeny-svg')).toBeVisible();

  await page.getByRole('radio', { name: 'Living' }).click();
  await expect(page.locator('.phylogeny-svg')).toHaveCount(0);
  await expect(page.locator('.lineage-tree')).toBeVisible();
});

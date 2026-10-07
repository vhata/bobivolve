import { expect, test, type Page } from '@playwright/test';
import type { SimStoreState } from '../ui/sim-store.js';

async function freshRun(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('bobivolve:nux-seen', '1'));
  await page.goto('/');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.locator('.lineage-tree button[aria-pressed]').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pin ancestry group', exact: true })).toBeEnabled();
}

async function pause(page: Page): Promise<void> {
  if (await page.getByRole('button', { name: 'Pause', exact: true }).isVisible()) {
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
  }
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveAttribute(
    'data-pending',
    'false',
  );
}

// This inspection fixture advances the real worker while paused, so CI speed
// cannot leave a growing 64x run competing with the final inspection clicks.
// Pause-button responsiveness remains covered by dashboard.spec.ts.
async function advanceAncestryFixture(
  page: Page,
  until: 'descendants' | 'extinct',
  minimumLivingLineages = 5,
): Promise<void> {
  await page.evaluate(
    async ({ condition, minimumLivingLineages }) => {
      const path = '/sim-store.ts';
      const { useSimStore } = (await import(/* @vite-ignore */ path)) as {
        useSimStore: { getState(): SimStoreState };
      };
      const transport = useSimStore.getState().transport;
      if (transport === null || !useSimStore.getState().paused)
        throw new Error('Fixture must start paused');
      const step = (): Promise<bigint> =>
        new Promise((resolve, reject) => {
          const commandId = `ancestry-fixture-${crypto.randomUUID()}`;
          const timeout = setTimeout(() => {
            unsubscribe();
            reject(new Error('Fixture step was not acknowledged'));
          }, 10_000);
          const unsubscribe = transport.onEvent((event) => {
            if (
              (event.kind !== 'commandAck' && event.kind !== 'commandError') ||
              event.commandId !== commandId
            )
              return;
            clearTimeout(timeout);
            unsubscribe();
            if (event.kind === 'commandError') reject(new Error(event.message));
            else resolve(event.simTick);
          });
          transport.send({ kind: 'step', commandId, ticks: 8n });
        });
      const firstTick = await step();
      // Include the first (at most eight) ticks in the advancement budget.
      const startedAt = firstTick - 8n;
      let tick = firstTick;
      for (;;) {
        const tree = await transport.query({ kind: 'lineageTree', queryId: '' });
        if (tree.kind !== 'lineageTree') throw new Error('Unexpected fixture query response');
        const ready =
          condition === 'descendants'
            ? tree.lineages.filter((lineage) => lineage.extinctionTick === null).length >
              minimumLivingLineages
            : tree.lineages.some(
                (lineage) => lineage.id === 'L0' && lineage.extinctionTick !== null,
              );
        if (ready) break;
        if (tick - startedAt >= 4096n)
          throw new Error(`Ancestry fixture did not reach ${condition} within 4096 ticks`);
        tick = await step();
      }
      // Step emits domain events but no heartbeat. Briefly run at 1x to obtain
      // a real population reading, then pause through the production action as
      // soon as it arrives. Never synthesize events or inject projected counts.
      useSimStore.getState().setSpeed(1);
      await new Promise<void>((resolve, reject) => {
        let pauseId: string | undefined;
        const timeout = setTimeout(() => {
          unsubscribe();
          reject(new Error('Fixture refresh did not pause'));
        }, 10_000);
        const unsubscribe = transport.onEvent((event) => {
          if (event.kind === 'tick' && pauseId === undefined) {
            useSimStore.getState().pause();
            pauseId = [...useSimStore.getState().pendingCommands.values()].find(
              (command) => command.kind === 'pause',
            )?.commandId;
          } else if (
            (event.kind === 'commandAck' || event.kind === 'commandError') &&
            event.commandId === pauseId
          ) {
            clearTimeout(timeout);
            unsubscribe();
            if (event.kind === 'commandError') reject(new Error(event.message));
            else resolve();
          }
        });
        useSimStore.getState().resume();
      });
    },
    { condition: until, minimumLivingLineages },
  );
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveAttribute(
    'data-pending',
    'false',
  );
}

async function counts(page: Page): Promise<{ grouped: number; total: number }> {
  return page.evaluate(() => {
    const numbers = [
      ...document.querySelectorAll('.ancestry-population, .ancestry-ungrouped-population'),
    ];
    return {
      grouped: numbers.reduce((sum, el) => sum + Number(el.textContent), 0),
      total: Number(
        document.querySelector('.population-total')?.textContent?.replace(/[^\d]/g, ''),
      ),
    };
  });
}

test('pinned roots follow new descendants, partition nested groups, and retain raw targets', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await freshRun(page);
  await pause(page);
  await page.getByRole('button', { name: 'Pin ancestry group', exact: true }).click();
  const root = page.locator('.ancestry-group-list [data-root-id="L0"]');
  await expect(root).toBeVisible();
  const color = await root.locator('.lineage-swatch').getAttribute('style');
  await advanceAncestryFixture(page, 'descendants', 20);
  await expect
    .poll(
      async () => {
        const text = await root.textContent();
        return Number(text?.match(/(\d+) living lineages/)?.[1]);
      },
      { timeout: 45_000 },
    )
    .toBeGreaterThan(20);
  await root.getByRole('button').click();
  await expect(page.locator('.ancestry-member-list li')).toHaveCount(20);
  const firstPageId = await page
    .locator('.ancestry-member-list button')
    .first()
    .getAttribute('data-lineage-id');
  await page.getByRole('button', { name: 'Next members', exact: true }).click();
  await expect(page.locator('.ancestry-member-list button').first()).not.toHaveAttribute(
    'data-lineage-id',
    firstPageId!,
  );
  await page.getByRole('button', { name: 'Previous members', exact: true }).click();
  const child = page.locator('.ancestry-member-list button:not([data-lineage-id="L0"])').first();
  const childId = await child.getAttribute('data-lineage-id');
  expect(childId).not.toBeNull();
  await child.click();
  await expect(page.locator('.inspector-panel .panel-meta')).toContainText(childId!);
  await expect(page.locator('.ancestry-membership')).toContainText('rooted at L0');
  await page.getByRole('button', { name: 'Pin ancestry group', exact: true }).click();
  await expect(page.locator('.ancestry-group-list > li')).toHaveCount(2);
  await expect
    .poll(async () => {
      const n = await counts(page);
      return n.grouped === n.total;
    })
    .toBe(true);
  await expect(root.locator('.lineage-swatch')).toHaveAttribute('style', color!);
  await expect(
    page.locator(`.ancestry-group-list [data-root-id="${childId}"] .lineage-swatch`),
  ).not.toHaveAttribute('style', color!);
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.locator('.lineage-tree-panel .panel-body').evaluate((body) => {
    body.scrollTop = 0;
  });
  await page.screenshot({
    path: testInfo.outputPath('ancestry-nested-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath('ancestry-nested-narrow.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 720 });

  // Group membership does not become a command target. Quarantine remains
  // attached to the individual genetic lineage selected from the member list.
  await page.getByRole('button', { name: 'Quarantine', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Release quarantine', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Inspect root L0', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Quarantine', exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Find a member' }).fill(childId!);
  await expect(
    page.locator(`.ancestry-member-list button[data-lineage-id="${childId}"]`),
  ).toHaveCount(0);
  await page.locator(`.ancestry-group-list [data-root-id="${childId}"] button`).click();
  await page.getByRole('button', { name: `Inspect root ${childId}`, exact: true }).click();
  await page.getByRole('button', { name: 'Unpin group', exact: true }).click();
  await expect(page.locator('.ancestry-group-list > li')).toHaveCount(1);
  await expect
    .poll(async () => {
      const n = await counts(page);
      return n.grouped === n.total;
    })
    .toBe(true);
  await root.getByRole('button').click();
  await page.getByRole('searchbox', { name: 'Find a member' }).fill(childId!);
  await expect(
    page.locator(`.ancestry-member-list button[data-lineage-id="${childId}"]`),
  ).toBeVisible();
});

test('group names survive reload and run switching; a fresh start clears them', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await freshRun(page);
  await pause(page);
  const runTitle = await page.getByRole('button', { name: 'Switch run…' }).getAttribute('title');
  const runId = runTitle!.replace('Active: ', '');
  await page.getByRole('button', { name: 'Pin ancestry group', exact: true }).click();
  page.once('dialog', (dialog) => dialog.accept('Home ancestry'));
  await page.getByRole('button', { name: 'Rename group', exact: true }).click();
  await expect(page.locator('.ancestry-group-list')).toContainText('Home ancestry');
  await page.reload();
  await expect(page.locator('.ancestry-group-list')).toContainText('Home ancestry');
  await page.getByRole('button', { name: 'Switch run…' }).click();
  await page.getByRole('button', { name: 'new run…' }).click();
  await page.getByRole('textbox', { name: 'name', exact: true }).fill(`ancestry-${Date.now()}`);
  await page.getByRole('button', { name: 'create & switch' }).click();
  await expect(page.locator('.ancestry-groups')).toContainText('Pin a lineage');
  await expect(page.locator('.ancestry-group-list > li')).toHaveCount(0);
  await page.getByRole('button', { name: 'Switch run…' }).click();
  await page.getByTitle(`Switch to ${runId}`, { exact: true }).click();
  await expect(page.locator('.ancestry-group-list')).toContainText('Home ancestry');
  page.once('dialog', (dialog) => dialog.accept('ancestry-checkpoint'));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.run-status')).toContainText(/saved at tick \d+/);
  await page.getByRole('button', { name: 'Load', exact: true }).click();
  await page
    .locator('.load-picker .save-load-button')
    .filter({ hasText: 'ancestry-checkpoint' })
    .click();
  await expect(page.locator('.ancestry-groups')).toContainText('Pin a lineage');
  await expect(page.locator('.ancestry-group-list > li')).toHaveCount(0);
  await page.getByRole('button', { name: 'Pin ancestry group', exact: true }).click();
  await expect(page.locator('.ancestry-group-list > li')).toHaveCount(1);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.locator('.ancestry-groups')).toContainText('Pin a lineage');
  await expect(page.locator('.ancestry-group-list > li')).toHaveCount(0);
});

test('an extinct pinned root retains its living descendants and remains inspectable', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await freshRun(page);
  await pause(page);
  await page.getByRole('button', { name: 'Pin ancestry group', exact: true }).click();
  const root = page.locator('.ancestry-group-list [data-root-id="L0"]');
  await advanceAncestryFixture(page, 'descendants');
  await expect
    .poll(async () => Number((await root.textContent())?.match(/(\d+) living lineages/)?.[1]))
    .toBeGreaterThan(5);
  await root.getByRole('button').click();
  await page.getByRole('button', { name: 'Inspect root L0', exact: true }).click();
  await page.getByRole('button', { name: 'Apply patch', exact: true }).click();
  const patch = page.getByRole('dialog', { name: /Apply patch to/ });
  await patch.getByRole('textbox', { name: 'Proposed maximum energy per tick' }).fill('0');
  await patch
    .getByRole('textbox', { name: 'Proposed minimum stored energy' })
    .fill('18446744073709551615');
  await patch.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(patch).toHaveCount(0);
  // Avoid an unrelated extinction auto-pause stopping the run before L0 dies.
  const extinctionToggle = page.getByRole('checkbox', { name: /lineage extinction/i });
  if (await extinctionToggle.count()) await extinctionToggle.uncheck();
  await advanceAncestryFixture(page, 'extinct');
  await expect(root).toContainText('root extinct');
  await expect
    .poll(async () => Number(await root.locator('.ancestry-population').textContent()))
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Inspect root L0', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unpin group', exact: true })).toBeEnabled();
  await expect(page.locator('.inspector-panel .panel-meta')).toContainText('L0');
  await expect
    .poll(async () => {
      const n = await counts(page);
      return n.grouped === n.total;
    })
    .toBe(true);
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.locator('.lineage-tree-panel .panel-body').evaluate((body) => {
    body.scrollTop = 0;
  });
  await page.screenshot({ path: testInfo.outputPath('ancestry-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('ancestry-narrow.png'), fullPage: true });
});

test('rewind retains older pinned roots and removes groups founded in the discarded future', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await freshRun(page);
  await pause(page);
  await page.getByRole('button', { name: 'Pin ancestry group', exact: true }).click();
  const root = page.locator('.ancestry-group-list [data-root-id="L0"]');
  await advanceAncestryFixture(page, 'descendants', 20);
  await expect
    .poll(async () => Number((await root.textContent())?.match(/(\d+) living lineages/)?.[1]), {
      timeout: 40_000,
    })
    .toBeGreaterThan(20);
  await root.getByRole('button').click();
  const child = page.locator('.ancestry-member-list button:not([data-lineage-id="L0"])').first();
  const childId = await child.getAttribute('data-lineage-id');
  await child.click();
  const founded = Number(
    (
      await page
        .locator('.inspector-detail > div')
        .filter({ has: page.locator('dt', { hasText: /^founded at$/ }) })
        .textContent()
    )?.match(/tick (\d+)/)?.[1],
  );
  expect(founded).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Pin ancestry group', exact: true }).click();
  await expect(page.locator('.ancestry-group-list > li')).toHaveCount(2);
  // Use the same production action as the timeline at an exact tick. The
  // timeline intentionally exposes only recent events, which need not include
  // an event before this living lineage's birth. No simulation state is injected.
  await page.evaluate(async (target) => {
    const path = '/sim-store.ts';
    const { useSimStore } = (await import(/* @vite-ignore */ path)) as {
      useSimStore: { getState(): SimStoreState };
    };
    useSimStore.getState().rewindToTick(BigInt(target));
  }, founded - 1);
  await expect(page.locator('.ancestry-group-list > li')).toHaveCount(1);
  await expect(root).toBeVisible();
  await expect(page.locator(`.ancestry-group-list [data-root-id="${childId}"]`)).toHaveCount(0);
});

import { expect, test, type Page } from '@playwright/test';
import { clickStart } from './start-run.js';
import type { SimEvent } from '../protocol/types.js';
import type { SimStoreState } from '../ui/sim-store.js';

// Forward-looking speciation promotion for a patched parent. The patch
// and the save/load round trip are real; the speciations are injected
// into the transport's event handlers with the parent shrunk below the
// 5% big-parent threshold, so only the patched axis can surface them.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('bobivolve:nux-seen', '1');
  });
});

async function patchSelected(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Apply patch', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /Apply patch to/ });
  await dialog.getByRole('textbox', { name: 'Proposed maximum energy per tick' }).fill('3');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

// Shrink `small` to under 5% of the projected population, wait for the
// panel to observe it, then deliver speciations as if from the worker.
async function emitSmallParentSpeciations(
  page: Page,
  small: readonly string[],
  speciations: readonly { readonly parent: string; readonly child: string }[],
): Promise<void> {
  await page.evaluate(
    async ({ small, speciations }) => {
      const path = '/sim-store.ts';
      const { useSimStore } = (await import(/* @vite-ignore */ path)) as {
        useSimStore: {
          getState(): SimStoreState;
          setState(partial: Partial<SimStoreState>): void;
        };
      };
      const state = useSimStore.getState();
      const transport = state.transport as unknown as {
        handlers: Set<(event: SimEvent) => void>;
      } | null;
      if (transport === null) throw new Error('Missing simulation transport');
      const byLineage = new Map<string, bigint>([['big', 10_000n]]);
      for (const id of small) byLineage.set(id, 1n);
      useSimStore.setState({
        populationTotal: 10_000n + BigInt(small.length),
        populationByLineage: byLineage,
      });
      // The panel mirrors store fields into refs from effects.
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => setTimeout(resolve, 100));
      });
      for (const { parent, child } of speciations) {
        const event: SimEvent = {
          kind: 'speciation',
          simTick: state.simTick,
          newLineageId: child,
          newLineageName: child,
          parentLineageId: parent,
          founderProbeId: `P-${child}`,
        };
        for (const handler of [...transport.handlers]) handler(event);
      }
    },
    { small, speciations },
  );
}

test('speciations from a patched small parent surface without show-all', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await clickStart(page);
  await expect(page.locator('.lineage-tree button[aria-pressed]').first()).toBeVisible();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveAttribute(
    'data-pending',
    'false',
  );
  await patchSelected(page);
  await expect(page.locator('.timeline-panel .timeline-description')).toContainText([
    'patch applied · L0',
  ]);

  const descriptions = page.locator('.timeline-panel .timeline-description');
  await emitSmallParentSpeciations(
    page,
    ['L0', 'LZ'],
    [
      { parent: 'L0', child: 'LX1' },
      { parent: 'LZ', child: 'LX2' },
    ],
  );
  await expect(descriptions.filter({ hasText: 'L0 → LX1' })).toHaveCount(1);
  await expect(descriptions.filter({ hasText: 'LZ → LX2' })).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'show all speciations' }).check();
  await expect(descriptions.filter({ hasText: 'LZ → LX2' })).toHaveCount(1);
  await page.getByRole('checkbox', { name: 'show all speciations' }).uncheck();

  // Load rebuilds patch status from the host's lineage tree.
  page.once('dialog', (dialog) => {
    void dialog.accept('patched-parent');
  });
  await page.locator('.run-panel').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.run-status')).toContainText(/saved at tick \d+/);
  await page.getByRole('button', { name: 'Load', exact: true }).click();
  await page
    .locator('.load-picker .save-load-button')
    .filter({ hasText: 'patched-parent' })
    .click();
  await expect(descriptions.filter({ hasText: 'L0 → LX1' })).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const path = '/sim-store.ts';
        const { useSimStore } = (await import(/* @vite-ignore */ path)) as {
          useSimStore: { getState(): SimStoreState };
        };
        return [...useSimStore.getState().patchedLineages];
      }),
    )
    .toEqual(['L0']);
  await emitSmallParentSpeciations(page, ['L0'], [{ parent: 'L0', child: 'LX3' }]);
  await expect(descriptions.filter({ hasText: 'L0 → LX3' })).toHaveCount(1);
});

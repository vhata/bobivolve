import { expect, test } from '@playwright/test';
import type { SimStoreState } from '../ui/sim-store.js';

test('the inspector never shows or patches from the previous lineage after a selection change', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => localStorage.setItem('bobivolve:nux-seen', '1'));
  await page.goto('/');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.locator('.lineage-tree button[aria-pressed]').first()).toBeVisible();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveAttribute(
    'data-pending',
    'false',
  );

  // Advance the real worker while paused until a second lineage exists.
  await page.evaluate(async () => {
    const path = '/sim-store.ts';
    const { useSimStore } = (await import(/* @vite-ignore */ path)) as {
      useSimStore: { getState(): SimStoreState };
    };
    const transport = useSimStore.getState().transport;
    if (transport === null) throw new Error('Missing simulation transport');
    const step = (): Promise<void> =>
      new Promise((resolve, reject) => {
        const commandId = `inspector-fixture-${crypto.randomUUID()}`;
        const unsubscribe = transport.onEvent((event) => {
          if (
            (event.kind !== 'commandAck' && event.kind !== 'commandError') ||
            event.commandId !== commandId
          )
            return;
          unsubscribe();
          if (event.kind === 'commandError') reject(new Error(event.message));
          else resolve();
        });
        transport.send({ kind: 'step', commandId, ticks: 16n });
      });
    for (let attempt = 0; useSimStore.getState().lineages.size < 2; attempt += 1) {
      if (attempt >= 256) throw new Error('No speciation within 4096 ticks');
      await step();
    }
  });

  const inspector = page.locator('.inspector-panel');
  const members = inspector
    .locator('.inspector-detail > div')
    .filter({ has: page.locator('dt', { hasText: /^members$/ }) })
    .locator('dd');
  const applyPatch = page.getByRole('button', { name: 'Apply patch', exact: true });
  const queueDecree = page.getByRole('button', { name: 'Queue decree', exact: true });
  await expect(members).toHaveText(/\d+ extant/);
  await expect(applyPatch).toBeEnabled();

  // Hold the telemetry reply for the next selection, so the gap between
  // selecting and its first reply is observable.
  await page.evaluate(async () => {
    const path = '/sim-store.ts';
    const { useSimStore } = (await import(/* @vite-ignore */ path)) as {
      useSimStore: { getState(): SimStoreState };
    };
    const transport = useSimStore.getState().transport;
    if (transport === null) throw new Error('Missing simulation transport');
    const original = transport.query;
    const releases: (() => void)[] = [];
    let holding = true;
    transport.query = (async (query) => {
      const actual = await original.call(transport, query);
      if (query.kind === 'driftTelemetry' && holding)
        await new Promise<void>((resolve) => releases.push(resolve));
      return actual;
    }) as typeof transport.query;
    const fixture = window as typeof window & { releaseDriftTelemetry?: () => void };
    fixture.releaseDriftTelemetry = () => {
      holding = false;
      transport.query = original;
      for (const release of releases) release();
      delete fixture.releaseDriftTelemetry;
    };
  });

  const rows = page.locator('.lineage-tree button.lineage-node-row');
  const childIndex = await rows.evaluateAll((buttons) =>
    buttons.findIndex((button) => button.getAttribute('aria-pressed') === 'false'),
  );
  expect(childIndex).toBeGreaterThanOrEqual(0);
  const child = rows.nth(childIndex);
  await child.click();
  await expect(child).toHaveAttribute('aria-pressed', 'true');
  const childId = await page.evaluate(async () => {
    const path = '/sim-store.ts';
    const { useSimStore } = (await import(/* @vite-ignore */ path)) as {
      useSimStore: { getState(): SimStoreState };
    };
    return useSimStore.getState().selectedLineageId;
  });
  expect(childId).not.toBe('L0');

  // Until the child's own reply arrives, nothing from L0 is shown or usable.
  await expect(members).toHaveText('…');
  await expect(applyPatch).toBeDisabled();
  await expect(queueDecree).toBeDisabled();

  await page.evaluate(() => {
    const fixture = window as typeof window & { releaseDriftTelemetry?: () => void };
    if (fixture.releaseDriftTelemetry === undefined) throw new Error('Missing held telemetry');
    fixture.releaseDriftTelemetry();
  });
  await expect(members).toHaveText(/\d+ extant/);
  await expect(applyPatch).toBeEnabled();

  // An open editor stays bound to the lineage it was opened for.
  await applyPatch.click();
  const childName = await page.evaluate(async (id) => {
    const path = '/sim-store.ts';
    const { useSimStore } = (await import(/* @vite-ignore */ path)) as {
      useSimStore: { getState(): SimStoreState };
    };
    return useSimStore.getState().lineages.get(id)?.name ?? '';
  }, childId);
  const dialog = page.getByRole('dialog', { name: `Apply patch to ${childName}`, exact: true });
  await expect(dialog).toBeVisible();
  await page.evaluate(async () => {
    const path = '/sim-store.ts';
    const { useSimStore } = (await import(/* @vite-ignore */ path)) as {
      useSimStore: { getState(): SimStoreState };
    };
    useSimStore.getState().selectLineage('L0');
  });
  await expect(page.locator('.inspector-panel .panel-meta')).toContainText('L0');
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('dialog', { name: /Apply patch to/ })).toHaveCount(1);
});

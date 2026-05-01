import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';

// Disposable performance probe. We deliberately do NOT click any speed
// buttons here — under the load conditions we're investigating, the
// click handlers are exactly what becomes unresponsive, so attempting
// to drive the speed change from the test masks the very symptom we
// want to measure. Instead we measure the dashboard at its default
// 4× auto-start, and again after warming up to a fatter population.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('bobivolve:nux-seen', '1');
  });
});

interface MetricsSample {
  readonly TaskDuration: number;
  readonly ScriptDuration: number;
  readonly LayoutDuration: number;
  readonly RecalcStyleDuration: number;
}

async function getMetrics(cdp: import('@playwright/test').CDPSession): Promise<MetricsSample> {
  const { metrics } = (await cdp.send('Performance.getMetrics')) as {
    metrics: { name: string; value: number }[];
  };
  const find = (name: string): number => metrics.find((m) => m.name === name)?.value ?? 0;
  return {
    TaskDuration: find('TaskDuration'),
    ScriptDuration: find('ScriptDuration'),
    LayoutDuration: find('LayoutDuration'),
    RecalcStyleDuration: find('RecalcStyleDuration'),
  };
}

test('profile: dashboard at default 4× speed across two windows', async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto('/');

  // The auto-start fires 4× at boot. We let it warm up and capture
  // population at three timepoints alongside CDP metrics deltas.

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');

  // Wait for the founder probe to replicate so we know the page is
  // actually live.
  await expect
    .poll(
      async () => {
        const text = (await page.locator('.population-total').textContent()) ?? '';
        const m = text.match(/(\d+)/);
        return m === null ? 0 : Number(m[1]);
      },
      { timeout: 20_000, intervals: [500] },
    )
    .toBeGreaterThan(1);

  const samples: { label: string; population: number; metrics: MetricsSample }[] = [];

  const captureWindow = async (label: string, holdMs: number): Promise<void> => {
    const before = await getMetrics(cdp);
    await page.waitForTimeout(holdMs);
    const after = await getMetrics(cdp);
    const populationText = (await page.locator('.population-total').textContent()) ?? '';
    const match = populationText.match(/(\d+)/);
    const population = match !== null ? Number(match[1]) : 0;
    samples.push({
      label,
      population,
      metrics: {
        TaskDuration: after.TaskDuration - before.TaskDuration,
        ScriptDuration: after.ScriptDuration - before.ScriptDuration,
        LayoutDuration: after.LayoutDuration - before.LayoutDuration,
        RecalcStyleDuration: after.RecalcStyleDuration - before.RecalcStyleDuration,
      },
    });
  };

  await captureWindow('early (small population)', 5_000);
  await captureWindow('mid (warming up)', 10_000);
  await captureWindow('late (heavier load)', 15_000);

  // Now try to click Pause and measure how long the click itself takes
  // and how long until the t/s readout reads 0. We use force:true and
  // dispatchEvent to avoid the actionability dance — we want a raw
  // measurement of the user-facing latency.
  const tBeforePauseClick = Date.now();
  let clickAccepted = false;
  try {
    await page
      .locator('.controls-panel button', { hasText: /^Pause$/ })
      .first()
      .dispatchEvent('click', { timeout: 8_000 });
    clickAccepted = true;
  } catch {
    clickAccepted = false;
  }
  const tAfterPauseClick = Date.now();
  let zeroTpsReachedMs: number | null = null;
  try {
    await page.waitForFunction(
      () => {
        const el = document.querySelector('.controls-panel .panel-meta');
        return /^0\s*t\/s/.test(el?.textContent ?? '');
      },
      undefined,
      { timeout: 20_000 },
    );
    zeroTpsReachedMs = Date.now() - tBeforePauseClick;
  } catch {
    zeroTpsReachedMs = null;
  }

  const summarise = (
    s: { label: string; population: number; metrics: MetricsSample },
    windowMs: number,
  ): string => {
    const sec = windowMs / 1000;
    const pct = (v: number): string => `${((v / sec) * 100).toFixed(1)}%`;
    const m = s.metrics;
    return [
      `── ${s.label} ────────────────`,
      `   sample window: ${windowMs}ms,  population at end: ${s.population}`,
      `   Task    ${m.TaskDuration.toFixed(2).padStart(7)}s  (${pct(m.TaskDuration).padStart(6)})`,
      `   Script  ${m.ScriptDuration.toFixed(2).padStart(7)}s  (${pct(m.ScriptDuration).padStart(6)})`,
      `   Layout  ${m.LayoutDuration.toFixed(2).padStart(7)}s  (${pct(m.LayoutDuration).padStart(6)})`,
      `   Style   ${m.RecalcStyleDuration.toFixed(2).padStart(7)}s  (${pct(m.RecalcStyleDuration).padStart(6)})`,
    ].join('\n');
  };

  const report = [
    'Bobivolve dashboard profile (default 4× auto-start)',
    `(captured ${new Date().toISOString()})`,
    '',
    samples[0] !== undefined ? summarise(samples[0], 5_000) : '',
    '',
    samples[1] !== undefined ? summarise(samples[1], 10_000) : '',
    '',
    samples[2] !== undefined ? summarise(samples[2], 15_000) : '',
    '',
    '── Pause click latency ────────────────',
    `   dispatch accepted: ${clickAccepted}  (took ${tAfterPauseClick - tBeforePauseClick}ms to dispatch)`,
    `   click → 0 t/s readout: ${zeroTpsReachedMs === null ? '> 20s (timed out)' : `${zeroTpsReachedMs}ms`}`,
    '',
  ].join('\n');

  // eslint-disable-next-line no-console
  console.log('\n' + report);
  fs.writeFileSync('e2e/profile-report.txt', report);
  fs.writeFileSync('e2e/profile-raw.json', JSON.stringify(samples, null, 2));
});

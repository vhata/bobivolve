import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GOLDEN_CASES, GOLDEN_DIR, runDeterministically, serializeEvents } from './runner.js';
import { INTERVENTIONS } from './interventions.js';

// Determinism goldens. ARCHITECTURE.md "Determinism test from week one":
// (seed, command-log) → event-log, diffed against a checked-in golden. The
// future Rust port will validate against these same files byte-for-byte.
//
// Verify (default): pnpm run test
// Regenerate:       REGENERATE_GOLDENS=1 pnpm exec vitest run test/determinism/golden.test.ts
//
// Regeneration writes every golden and then fails each case on purpose, so
// a run with REGENERATE_GOLDENS set can never be mistaken for a passing
// gate. Inspect the diff, then rerun without the variable to verify.
//
// A drift in any golden file is a determinism regression. Investigate
// before "fixing" — the regression should be understood, not papered over.

const REGENERATE = process.env['REGENERATE_GOLDENS'] === '1';

if (REGENERATE && !existsSync(GOLDEN_DIR)) {
  mkdirSync(GOLDEN_DIR, { recursive: true });
}

describe('determinism goldens', () => {
  it.each(GOLDEN_CASES)('matches golden for $name', (spec) => {
    const { name } = spec;
    const goldenPath = join(GOLDEN_DIR, `${name}.ndjson`);
    const events = runDeterministically(spec);
    // A run that emits only its newRun acknowledgement compares nothing
    // about the simulation itself.
    expect(events.length).toBeGreaterThan(1);
    expect(events.some((e) => e.kind !== 'commandAck')).toBe(true);
    const actual = serializeEvents(events);

    if (REGENERATE) {
      writeFileSync(goldenPath, actual);
      throw new Error(
        `Regenerated ${goldenPath}. Inspect the diff, then rerun without REGENERATE_GOLDENS to verify.`,
      );
    }

    if (!existsSync(goldenPath)) {
      throw new Error(`Missing golden ${goldenPath}. Run with REGENERATE_GOLDENS=1 to create it.`);
    }

    const expected = readFileSync(goldenPath, 'utf8');
    expect(actual).toBe(expected);
  });

  it('has exactly one checked-in golden per case', () => {
    // Only .ndjson files are goldens; ignore editor and OS litter such as
    // .DS_Store.
    const files = readdirSync(GOLDEN_DIR)
      .filter((file) => file.endsWith('.ndjson'))
      .sort();
    const expected = GOLDEN_CASES.map((spec) => `${spec.name}.ndjson`).sort();
    expect(files).toEqual(expected);
  });

  it('intervention golden exercises effects, not just command acknowledgements', () => {
    const events = runDeterministically({ seed: 42n, ticks: 300n, commands: INTERVENTIONS });
    expect(events.filter((e) => e.kind === 'commandError')).toEqual([]);
    expect(events.map((e) => e.kind)).toEqual(
      expect.arrayContaining([
        'quarantineImposed',
        'quarantineLifted',
        'patchApplied',
        'decreeQueued',
        'decreeFired',
        'patchSaturated',
      ]),
    );
    expect(serializeEvents(events)).toBe(
      serializeEvents(runDeterministically({ seed: 42n, ticks: 300n, commands: INTERVENTIONS })),
    );
  });

  it('two runs of the same case produce identical event streams', () => {
    const a = serializeEvents(runDeterministically({ seed: 42n, ticks: 1500n }));
    const b = serializeEvents(runDeterministically({ seed: 42n, ticks: 1500n }));
    expect(a).toBe(b);
  });
});

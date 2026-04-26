import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runDeterministically, serializeEvents } from './runner.js';

// Determinism goldens. ARCHITECTURE.md "Determinism test from week one":
// (seed, command-log) → event-log, diffed against a checked-in golden. The
// future Rust port will validate against these same files byte-for-byte.
//
// Regenerate with: REGENERATE_GOLDENS=1 pnpm run test
// Verify (default): pnpm run test
//
// A drift in any golden file is a determinism regression. Investigate
// before "fixing" — the regression should be understood, not papered over.

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = join(__dirname, 'golden');
const REGENERATE = process.env['REGENERATE_GOLDENS'] === '1';

interface GoldenCase {
  readonly name: string;
  readonly seed: bigint;
  readonly ticks: bigint;
}

const CASES: readonly GoldenCase[] = [
  // Small — a near-trivial run that exercises the boot path and a handful
  // of replication events. Catches regressions in the early-tick stream.
  { name: 'seed-0-ticks-1000', seed: 0n, ticks: 1000n },
  // Medium — same parameters as sim/step.test.ts's GOLDEN_POP_SEED_42_TEST
  // (27 probes after 3000 ticks). Cross-checks the two golden surfaces.
  { name: 'seed-42-ticks-3000', seed: 42n, ticks: 3000n },
  // Medium-large — different seed, long enough to exercise lineage
  // clustering: speciation events appear in the lineageId field of later
  // Replication events.
  { name: 'seed-2026-ticks-5000', seed: 2026n, ticks: 5000n },
];

if (REGENERATE && !existsSync(GOLDEN_DIR)) {
  mkdirSync(GOLDEN_DIR, { recursive: true });
}

describe('determinism goldens', () => {
  it.each(CASES)('matches golden for $name', ({ name, seed, ticks }) => {
    const goldenPath = join(GOLDEN_DIR, `${name}.ndjson`);
    const events = runDeterministically({ seed, ticks });
    const actual = serializeEvents(events);

    if (REGENERATE) {
      writeFileSync(goldenPath, actual);
      return;
    }

    if (!existsSync(goldenPath)) {
      throw new Error(`Missing golden ${goldenPath}. Run with REGENERATE_GOLDENS=1 to create it.`);
    }

    const expected = readFileSync(goldenPath, 'utf8');
    expect(actual).toBe(expected);
  });

  it('two runs of the same case produce identical event streams', () => {
    const a = serializeEvents(runDeterministically({ seed: 42n, ticks: 1500n }));
    const b = serializeEvents(runDeterministically({ seed: 42n, ticks: 1500n }));
    expect(a).toBe(b);
  });
});

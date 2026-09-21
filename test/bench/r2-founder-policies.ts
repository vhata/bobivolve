// Exploratory R2 policy comparison. This is a seeded measurement, not a
// balance assertion or an automated test. Run with scripts/r2-experiment.sh.
import { FOUNDER_FIRMWARE, type DirectiveStack } from '../../sim/directive.js';
import { createInitialState, type SimState } from '../../sim/state.js';
import { tickN } from '../../sim/step.js';
import { Seed } from '../../sim/types.js';

const SEEDS = [0n, 42n, 2026n] as const;
const SAMPLE_TICKS = [1_000n, 3_000n, 5_000n] as const;

const POLICIES: ReadonlyArray<{ name: string; firmware: DirectiveStack }> = [
  { name: 'founder', firmware: FOUNDER_FIRMWARE },
  {
    name: 'harvest-4',
    firmware: FOUNDER_FIRMWARE.map((directive) =>
      directive.kind === 'gather' ? { kind: 'gather', rate: 4n } : directive,
    ),
  },
  {
    name: 'mobility-4x',
    firmware: FOUNDER_FIRMWARE.map((directive) =>
      directive.kind === 'explore'
        ? { kind: 'explore', threshold: directive.threshold * 4n }
        : directive,
    ),
  },
];

function measure(state: SimState): Record<string, number> {
  const populations = new Map<string, number>();
  for (const probe of state.probes.values()) {
    populations.set(probe.lineageId, (populations.get(probe.lineageId) ?? 0) + 1);
  }
  const sizes = [...populations.values()].sort((a, b) => b - a);
  const population = state.probes.size;
  const extinctLifetimes = [...state.lineages.values()]
    .filter((lineage) => lineage.extinctionTick !== null)
    .map((lineage) => Number(lineage.extinctionTick! - lineage.foundedAtTick))
    .sort((a, b) => a - b);
  const middle = Math.floor(extinctLifetimes.length / 2);
  return {
    population,
    livingLineages: sizes.length,
    allLineages: state.lineages.size,
    largestSharePct: population === 0 ? 0 : (100 * (sizes[0] ?? 0)) / population,
    topTenSharePct:
      population === 0 ? 0 : (100 * sizes.slice(0, 10).reduce((a, b) => a + b, 0)) / population,
    livingCladesAtLeastTen: sizes.filter((size) => size >= 10).length,
    medianExtinctLifetime: extinctLifetimes[middle] ?? 0,
  };
}

for (const policy of POLICIES) {
  for (const seed of SEEDS) {
    const state = createInitialState(Seed(seed), policy.firmware);
    let previousTick = 0n;
    for (const sampleTick of SAMPLE_TICKS) {
      tickN(state, sampleTick - previousTick);
      previousTick = sampleTick;
      process.stdout.write(
        JSON.stringify({
          policy: policy.name,
          seed: seed.toString(),
          tick: Number(sampleTick),
          ...measure(state),
        }) + '\n',
      );
    }
  }
}

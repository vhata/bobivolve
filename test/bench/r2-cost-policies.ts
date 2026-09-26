// Controlled experiment, not a gameplay feature or a human playtest.
import { FOUNDER_FIRMWARE, type DirectiveStack } from '../../sim/directive.js';
import { createInitialState } from '../../sim/state.js';
import { tick } from '../../sim/step.js';
import { Seed } from '../../sim/types.js';
import { prototypeUpkeep } from './r2-upkeep.js';

const policies: ReadonlyArray<{ name: string; firmware: DirectiveStack }> = [
  { name: 'founder', firmware: FOUNDER_FIRMWARE },
  {
    name: 'harvest-4',
    firmware: FOUNDER_FIRMWARE.map((d) => (d.kind === 'gather' ? { kind: 'gather', rate: 4n } : d)),
  },
  {
    name: 'mobility-4x',
    firmware: FOUNDER_FIRMWARE.map((d) =>
      d.kind === 'explore' ? { kind: 'explore', threshold: 1n << 60n } : d,
    ),
  },
];
for (const condition of ['rich', 'poor'] as const) {
  for (const costModel of ['free', 'upkeep'] as const) {
    for (const policy of policies) {
      for (const seed of [0n, 42n, 2026n]) {
        process.stderr.write(`${condition}/${costModel}/${policy.name}/seed=${seed}\n`);
        const state = createInitialState(Seed(seed), policy.firmware);
        if (condition === 'poor') {
          state.resourceCaps = state.resourceCaps.map((value) => value / 4n);
          state.resources = state.resources.map((value) => value / 4n);
        }
        let upkeepEnergy = 0n;
        for (let at = 1n; at <= 5000n; at++) {
          if (costModel === 'upkeep') {
            for (const probe of state.probes.values()) {
              const cost = prototypeUpkeep(probe.firmware, at);
              probe.energy -= cost;
              upkeepEnergy += cost;
            }
          }
          tick(state);
          if (at === 1000n || at === 5000n) {
            const populations = new Map<string, number>();
            for (const probe of state.probes.values())
              populations.set(probe.lineageId, (populations.get(probe.lineageId) ?? 0) + 1);
            const sizes = [...populations.values()].sort((a, b) => b - a);
            process.stdout.write(
              JSON.stringify({
                condition,
                costModel,
                policy: policy.name,
                seed: seed.toString(),
                tick: Number(at),
                population: state.probes.size,
                livingLineages: sizes.length,
                totalLineages: state.lineages.size,
                topTenSharePct:
                  state.probes.size === 0
                    ? 0
                    : (100 * sizes.slice(0, 10).reduce((a, b) => a + b, 0)) / state.probes.size,
                upkeepEnergy: upkeepEnergy.toString(),
              }) + '\n',
            );
          }
        }
      }
    }
  }
}

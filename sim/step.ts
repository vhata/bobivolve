import type { Directive } from './directive.js';
import type { Probe, SimState } from './state.js';
import { ProbeId, SimTick } from './types.js';

// Advance the simulation by one tick. SPEC.md R0 — Petri Dish: probes
// replicate per their firmware; no resources, no death (those land at R1).
//
// Determinism notes:
//   - PRNG draws are consumed in a fixed order: probes existing at tick start,
//     iterated in Map insertion order (which JS guarantees). Children born
//     this tick are NOT iterated until the next tick.
//   - This is the only place randomness crosses the seam into mechanic
//     decisions; if a future addition needs randomness it must do so under
//     the same disciplines (sim/rng.ts, no Math.random).
export function tick(state: SimState): void {
  state.simTick = SimTick(state.simTick + 1n);

  const ids = [...state.probes.keys()];
  for (const id of ids) {
    const probe = state.probes.get(id);
    if (probe === undefined) continue;

    for (const directive of probe.firmware) {
      maybeApply(state, probe, directive);
    }
  }
}

export function tickN(state: SimState, n: bigint): void {
  for (let i = 0n; i < n; i++) tick(state);
}

function maybeApply(state: SimState, probe: Probe, directive: Directive): void {
  switch (directive.kind) {
    case 'replicate':
      maybeReplicate(state, probe, directive.threshold);
      return;
  }
}

function maybeReplicate(state: SimState, parent: Probe, threshold: bigint): void {
  const roll = state.rng.nextU64();
  if (roll >= threshold) return;

  const child: Probe = {
    id: ProbeId(`P${state.nextProbeOrdinal}`),
    lineageId: parent.lineageId,
    bornAtTick: state.simTick,
    firmware: parent.firmware,
  };
  state.nextProbeOrdinal += 1n;
  state.probes.set(child.id, child);
}

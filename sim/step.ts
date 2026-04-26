import type { Directive } from './directive.js';
import { firmwareDiverged, type Lineage } from './lineage.js';
import { maybeMutate } from './mutation.js';
import type { Probe, SimState } from './state.js';
import { LineageId, ProbeId, SimTick } from './types.js';

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

  const childFirmware = maybeMutate(state.rng, parent.firmware);
  const childId = ProbeId(`P${state.nextProbeOrdinal}`);
  state.nextProbeOrdinal += 1n;

  // Lineage clustering: if the child's firmware has drifted past the
  // divergence threshold from its parent's lineage reference, the child
  // founds a new lineage. Otherwise it inherits the parent's.
  const parentLineage = state.lineages.get(parent.lineageId);
  if (parentLineage === undefined) {
    throw new Error(`lineage ${parent.lineageId} missing from state`);
  }

  let childLineageId = parent.lineageId;
  if (firmwareDiverged(childFirmware, parentLineage.referenceFirmware)) {
    childLineageId = LineageId(`L${state.nextLineageOrdinal}`);
    state.nextLineageOrdinal += 1n;
    const newLineage: Lineage = {
      id: childLineageId,
      founderProbeId: childId,
      parentLineageId: parent.lineageId,
      referenceFirmware: childFirmware,
      foundedAtTick: state.simTick,
    };
    state.lineages.set(childLineageId, newLineage);
  }

  const child: Probe = {
    id: childId,
    lineageId: childLineageId,
    bornAtTick: state.simTick,
    firmware: childFirmware,
  };
  state.probes.set(childId, child);
}

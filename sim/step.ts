import type { DeathEvent, ReplicationEvent, SimEvent, SpeciationEvent } from '../protocol/types.js';
import type { Directive } from './directive.js';
import { BASAL_DRAIN_PER_TICK } from './energy.js';
import { firmwareDiverged, type Lineage } from './lineage.js';
import { lineageName } from './lineage-names.js';
import { maybeMutate } from './mutation.js';
import type { Probe, SimState } from './state.js';
import { LineageId, ProbeId, SimTick } from './types.js';

// Advance the simulation by one tick. R1 — Scarcity adds basal metabolism
// and death; firmware execution (replication today, gather later) runs
// for survivors only.
//
// Phase order:
//   1. Drain. Every probe loses BASAL_DRAIN_PER_TICK from its energy
//      reservoir. Probes whose energy reaches zero die and the host
//      receives a DeathEvent.
//   2. Directives. Surviving probes execute their firmware in Map
//      insertion order (the determinism contract from R0).
//
// Determinism notes:
//   - PRNG draws are consumed in a fixed order: probes existing at tick
//     start, iterated in Map insertion order (which JS guarantees).
//     Children born this tick are NOT iterated until the next tick.
//   - Drain is pure integer subtraction; no PRNG draws.
//   - Death emission order is iteration order, locked.
//   - Speciation is a deterministic function of firmware comparison.
//
// `events`, if provided, is appended to with every SimEvent the tick
// emits — death, replication, speciation. Heartbeat (Tick) events are
// owned by the host, not the sim.
export function tick(state: SimState, events?: SimEvent[]): void {
  state.simTick = SimTick(state.simTick + 1n);

  const ids = [...state.probes.keys()];

  // Phase 1: basal drain + death. Energy mutates in place — Probe is
  // otherwise readonly; this is the one field that does. Avoids per-tick
  // object allocation for every probe, which was 9× slower at sim scale.
  for (const id of ids) {
    const probe = state.probes.get(id);
    if (probe === undefined) continue;
    probe.energy -= BASAL_DRAIN_PER_TICK;
    if (probe.energy <= 0n) {
      state.probes.delete(id);
      if (events !== undefined) {
        const death: SimEvent = {
          kind: 'death',
          simTick: state.simTick,
          probeId: probe.id,
          lineageId: probe.lineageId,
        } satisfies DeathEvent & { simTick: bigint };
        events.push(death);
      }
    }
  }

  // Phase 2: directives for survivors. We iterate the captured ids again
  // so dead probes are skipped naturally and births this tick are not
  // visited.
  for (const id of ids) {
    const probe = state.probes.get(id);
    if (probe === undefined) continue;

    for (const directive of probe.firmware) {
      maybeApply(state, probe, directive, events);
    }
  }
}

export function tickN(state: SimState, n: bigint, events?: SimEvent[]): void {
  for (let i = 0n; i < n; i++) tick(state, events);
}

function maybeApply(
  state: SimState,
  probe: Probe,
  directive: Directive,
  events: SimEvent[] | undefined,
): void {
  switch (directive.kind) {
    case 'replicate':
      maybeReplicate(state, probe, directive.threshold, events);
      return;
  }
}

function maybeReplicate(
  state: SimState,
  parent: Probe,
  threshold: bigint,
  events: SimEvent[] | undefined,
): void {
  const roll = state.rng.nextU64();
  if (roll >= threshold) return;

  const mutation = maybeMutate(state.rng, parent.firmware);
  const childFirmware = mutation.firmware;

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
    const ordinal = state.nextLineageOrdinal;
    childLineageId = LineageId(`L${ordinal.toString()}`);
    state.nextLineageOrdinal += 1n;
    const newLineageName = lineageName(ordinal);
    const newLineage: Lineage = {
      id: childLineageId,
      name: newLineageName,
      founderProbeId: childId,
      parentLineageId: parent.lineageId,
      referenceFirmware: childFirmware,
      foundedAtTick: state.simTick,
    };
    state.lineages.set(childLineageId, newLineage);

    if (events !== undefined) {
      const speciation: SimEvent = {
        kind: 'speciation',
        simTick: state.simTick,
        parentLineageId: parent.lineageId,
        newLineageId: childLineageId,
        newLineageName,
        founderProbeId: childId,
      } satisfies SpeciationEvent & { simTick: bigint };
      events.push(speciation);
    }
  }

  const child: Probe = {
    id: childId,
    lineageId: childLineageId,
    bornAtTick: state.simTick,
    firmware: childFirmware,
    // Children spawn at the parent's cell. Movement (if it ever lands)
    // is a directive's job, not replication's.
    position: parent.position,
    // Children begin with the run's initial-energy budget. Replication
    // does not yet cost the parent anything; that's a deliberate
    // separation of commits — the cost lands once resources can fund
    // the deficit.
    energy: state.initialEnergy,
  };
  state.probes.set(childId, child);

  if (events !== undefined) {
    const replication: SimEvent = {
      kind: 'replication',
      simTick: state.simTick,
      parentProbeId: parent.id,
      childProbeId: childId,
      lineageId: childLineageId,
      mutated: mutation.mutated,
    } satisfies ReplicationEvent & { simTick: bigint };
    events.push(replication);
  }
}

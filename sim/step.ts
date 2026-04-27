import type { DeathEvent, ReplicationEvent, SimEvent, SpeciationEvent } from '../protocol/types.js';
import type { Directive } from './directive.js';
import { ABSORPTION_PER_PROBE_PER_TICK, BASAL_DRAIN_PER_TICK } from './energy.js';
import { firmwareDiverged, type Lineage } from './lineage.js';
import { lineageName } from './lineage-names.js';
import { maybeMutate } from './mutation.js';
import type { Probe, SimState } from './state.js';
import {
  LATTICE_CELL_COUNT,
  MAX_RESOURCE_PER_CELL,
  RESOURCE_REGEN_PER_CELL_PER_TICK,
  cellIndex,
} from './substrate.js';
import { LineageId, ProbeId, SimTick } from './types.js';

// Advance the simulation by one tick. R1 — Scarcity adds the metabolic
// loop: cells regenerate, probes absorb from their cell, basal drain
// pulls energy back down, and probes whose energy hits zero die.
//
// Phase order:
//   0. Regen. Every cell gains RESOURCE_REGEN_PER_CELL_PER_TICK,
//      capped at MAX_RESOURCE_PER_CELL.
//   1. Metabolism. For each probe, in Map insertion order: absorb from
//      its cell (capped by what is there), then deduct basal drain.
//      A probe whose energy reaches zero dies and the host receives
//      a DeathEvent.
//   2. Directives. Surviving probes execute their firmware (replication
//      today, gather + others later).
//
// Determinism notes:
//   - PRNG draws are consumed in a fixed order: probes existing at tick
//     start, iterated in Map insertion order (which JS guarantees).
//     Children born this tick are NOT iterated until the next tick.
//   - Regen, absorption, and drain are pure integer arithmetic; no
//     PRNG draws.
//   - Absorption is competitive: a probe earlier in iteration order
//     gets the cell's resources before a later probe in the same cell
//     sees them. The order is locked by Map insertion (which lines up
//     with birth order), so two runs from the same seed produce
//     identical absorption events.
//   - Speciation is a deterministic function of firmware comparison.
//
// `events`, if provided, is appended to with every SimEvent the tick
// emits — death, replication, speciation. Heartbeat (Tick) events are
// owned by the host, not the sim.
export function tick(state: SimState, events?: SimEvent[]): void {
  state.simTick = SimTick(state.simTick + 1n);

  // Phase 0: regen.
  for (let i = 0; i < LATTICE_CELL_COUNT; i++) {
    const current = state.resources[i] ?? 0n;
    if (current >= MAX_RESOURCE_PER_CELL) continue;
    const next = current + RESOURCE_REGEN_PER_CELL_PER_TICK;
    state.resources[i] = next > MAX_RESOURCE_PER_CELL ? MAX_RESOURCE_PER_CELL : next;
  }

  const ids = [...state.probes.keys()];

  // Phase 1: absorption + basal drain + death. Energy mutates in place
  // (the one mutable field on Probe); resources mutate in place too
  // (a flat bigint array). Avoids per-tick object allocation that
  // would dominate the inner loop at simulation scale.
  for (const id of ids) {
    const probe = state.probes.get(id);
    if (probe === undefined) continue;
    const idx = cellIndex(probe.position.x, probe.position.y);
    const cellResource = state.resources[idx] ?? 0n;
    const absorbed =
      cellResource < ABSORPTION_PER_PROBE_PER_TICK ? cellResource : ABSORPTION_PER_PROBE_PER_TICK;
    state.resources[idx] = cellResource - absorbed;
    probe.energy = probe.energy + absorbed - BASAL_DRAIN_PER_TICK;
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

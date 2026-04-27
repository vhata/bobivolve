import type { DeathEvent, ReplicationEvent, SimEvent, SpeciationEvent } from '../protocol/types.js';
import type { Directive } from './directive.js';
import { BASAL_DRAIN_PER_TICK, REPLICATION_COST_ENERGY } from './energy.js';
import { firmwareDiverged, type Lineage } from './lineage.js';
import { lineageName } from './lineage-names.js';
import { maybeMutate } from './mutation.js';
import type { Probe, SimState } from './state.js';
import {
  LATTICE_CELL_COUNT,
  LATTICE_SIDE,
  MAX_RESOURCE_PER_CELL,
  RESOURCE_REGEN_PER_CELL_PER_TICK,
  cellIndex,
  diffuseResources,
} from './substrate.js';
import { LineageId, ProbeId, SimTick } from './types.js';

// Advance the simulation by one tick. R1 — Scarcity composes the
// metabolism loop with directive-driven behaviour.
//
// Phase order:
//   0a. Regen. Every cell gains RESOURCE_REGEN_PER_CELL_PER_TICK,
//       capped at MAX_RESOURCE_PER_CELL.
//   0b. Diffuse. A fraction of each cell's resources flows to its 4
//       cardinal neighbours, reflecting at the boundary so total
//       resources are conserved across the diffusion step.
//   1.  Basal drain. Every probe loses BASAL_DRAIN_PER_TICK from its
//       energy reservoir. Energy may go negative here; death is not
//       checked yet — phase 2 directives can still pull a probe back
//       above zero via gather.
//   2.  Directives. For each probe, in Map insertion order, execute
//       firmware in firmware order: gather pulls from the cell, explore
//       moves to a neighbour, replicate spawns a child.
//   3.  Death. Probes whose energy ended this tick at or below zero
//       are removed and the host receives a DeathEvent.
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

  // Phase 0a: regen.
  for (let i = 0; i < LATTICE_CELL_COUNT; i++) {
    const current = state.resources[i] ?? 0n;
    if (current >= MAX_RESOURCE_PER_CELL) continue;
    const next = current + RESOURCE_REGEN_PER_CELL_PER_TICK;
    state.resources[i] = next > MAX_RESOURCE_PER_CELL ? MAX_RESOURCE_PER_CELL : next;
  }

  // Phase 0b: diffusion. Pure integer arithmetic, conservative across
  // boundaries — nothing leaves the lattice.
  diffuseResources(state.resources);

  const ids = [...state.probes.keys()];

  // Phase 1: basal drain. Pure integer subtraction; energy may go
  // negative but death is not checked here.
  for (const id of ids) {
    const probe = state.probes.get(id);
    if (probe === undefined) continue;
    probe.energy -= BASAL_DRAIN_PER_TICK;
  }

  // Phase 2: directives. Iterate the captured ids in Map insertion
  // order; for each probe still alive, run every directive in firmware
  // order. Births this tick are NOT visited — the captured ids list
  // pre-dates them.
  for (const id of ids) {
    const probe = state.probes.get(id);
    if (probe === undefined) continue;
    for (const directive of probe.firmware) {
      maybeApply(state, probe, directive, events);
    }
  }

  // Phase 3: death. A probe whose energy ended at zero or below dies
  // — the host emits a DeathEvent. Iteration order is preserved so
  // death events appear in the same sequence two runs of the same
  // seed produce.
  for (const id of ids) {
    const probe = state.probes.get(id);
    if (probe === undefined) continue;
    if (probe.energy > 0n) continue;
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
    case 'gather':
      gather(state, probe, directive.rate);
      return;
    case 'explore':
      explore(state, probe, directive.threshold);
      return;
    case 'replicate':
      maybeReplicate(state, probe, directive.threshold, events);
      return;
  }
}

function gather(state: SimState, probe: Probe, rate: bigint): void {
  // Pull up to `rate` energy units from the cell at the probe's
  // position. Capped by what the cell currently holds; an empty cell
  // yields nothing. Pure integer arithmetic; no PRNG draws.
  const idx = cellIndex(probe.position.x, probe.position.y);
  const cellResource = state.resources[idx] ?? 0n;
  const taken = cellResource < rate ? cellResource : rate;
  state.resources[idx] = cellResource - taken;
  probe.energy += taken;
}

function explore(state: SimState, probe: Probe, threshold: bigint): void {
  // Two PRNG draws on a successful move — one to gate, one to pick a
  // direction. Boundary moves are no-ops (no draw is "wasted" on a
  // refused direction; the second draw still consumes determinism so
  // the same seed produces identical streams across runs).
  const decision = state.rng.nextU64();
  if (decision >= threshold) return;
  const dirRoll = state.rng.nextU64();
  const direction = Number(dirRoll % 4n);
  let nx = probe.position.x;
  let ny = probe.position.y;
  if (direction === 0) nx -= 1;
  else if (direction === 1) nx += 1;
  else if (direction === 2) ny -= 1;
  else ny += 1;
  if (nx < 0 || nx >= LATTICE_SIDE || ny < 0 || ny >= LATTICE_SIDE) return;
  // Reassign rather than mutate so any snapshot referencing the old
  // position object stays consistent with what was seen at snapshot
  // time.
  probe.position = { x: nx, y: ny };
}

function maybeReplicate(
  state: SimState,
  parent: Probe,
  threshold: bigint,
  events: SimEvent[] | undefined,
): void {
  // Energy-threshold gating per SPEC.md: "Probes replicate when their
  // internal energy passes a directive-defined threshold." A probe must
  // also be able to fund the replication cost; without it, the act
  // would push the parent into starvation, which is not what the
  // mechanic models.
  if (parent.energy < threshold) return;
  if (parent.energy < REPLICATION_COST_ENERGY) return;
  parent.energy -= REPLICATION_COST_ENERGY;

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
    // The parent's REPLICATION_COST_ENERGY transfers across to the
    // child. Total system energy is conserved by replication; only
    // metabolism (regen, absorption, drain) changes the system total.
    energy: REPLICATION_COST_ENERGY,
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

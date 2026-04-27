import { FOUNDER_FIRMWARE, type DirectiveStack } from './directive.js';
import type { Lineage } from './lineage.js';
import { lineageName } from './lineage-names.js';
import { Xoshiro256ss, type Xoshiro256State } from './rng.js';
import { LATTICE_CENTRE, type Position } from './substrate.js';
import { LineageId, ProbeId, SimTick, type Seed } from './types.js';

// Sim state. Everything the simulation knows about itself lives here. State
// is the snapshotable unit; given (seed, command-log) the state is uniquely
// determined at every tick (ARCHITECTURE.md "Snapshots are an
// implementation-defined performance cache").

export interface Probe {
  readonly id: ProbeId;
  readonly lineageId: LineageId;
  readonly bornAtTick: SimTick;
  readonly firmware: DirectiveStack;
  readonly position: Position;
}

export interface SimState {
  simTick: SimTick;
  rng: Xoshiro256ss;
  probes: Map<ProbeId, Probe>;
  lineages: Map<LineageId, Lineage>;
  // Monotonic counters used to mint stable IDs for new probes and lineages.
  // Kept separate from rng so they survive without consuming randomness.
  nextProbeOrdinal: bigint;
  nextLineageOrdinal: bigint;
}

// Snapshotable shape of SimState. Used for save/load and the rebuild-from-log
// pass. Plain data only — no class instances, no closures, ARCHITECTURE.md
// "if a separate Rust process could produce the same byte stream, the UI
// cannot tell the difference".
export interface SimStateSnapshot {
  readonly simTick: bigint;
  readonly rngState: Xoshiro256State;
  readonly probes: readonly Probe[];
  readonly lineages: readonly Lineage[];
  readonly nextProbeOrdinal: bigint;
  readonly nextLineageOrdinal: bigint;
}

export function createInitialState(
  seed: Seed,
  founderFirmware: DirectiveStack = FOUNDER_FIRMWARE,
): SimState {
  const rng = Xoshiro256ss.fromSeed(seed);
  const founderLineageId = LineageId('L0');
  const founderProbeId = ProbeId('P0');
  const founder: Probe = {
    id: founderProbeId,
    lineageId: founderLineageId,
    bornAtTick: SimTick(0n),
    firmware: founderFirmware,
    position: LATTICE_CENTRE,
  };
  const founderLineage: Lineage = {
    id: founderLineageId,
    name: lineageName(0n),
    founderProbeId,
    parentLineageId: null,
    referenceFirmware: founderFirmware,
    foundedAtTick: SimTick(0n),
  };
  return {
    simTick: SimTick(0n),
    rng,
    probes: new Map([[founder.id, founder]]),
    lineages: new Map([[founderLineage.id, founderLineage]]),
    nextProbeOrdinal: 1n,
    nextLineageOrdinal: 1n,
  };
}

export function snapshot(state: SimState): SimStateSnapshot {
  return {
    simTick: state.simTick,
    rngState: state.rng.state(),
    probes: [...state.probes.values()],
    lineages: [...state.lineages.values()],
    nextProbeOrdinal: state.nextProbeOrdinal,
    nextLineageOrdinal: state.nextLineageOrdinal,
  };
}

export function restore(snap: SimStateSnapshot): SimState {
  return {
    simTick: SimTick(snap.simTick),
    rng: Xoshiro256ss.fromState(snap.rngState),
    probes: new Map(snap.probes.map((p) => [p.id, p])),
    lineages: new Map(snap.lineages.map((l) => [l.id, l])),
    nextProbeOrdinal: snap.nextProbeOrdinal,
    nextLineageOrdinal: snap.nextLineageOrdinal,
  };
}

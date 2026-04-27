import { FOUNDER_FIRMWARE, type DirectiveStack } from './directive.js';
import { INITIAL_ENERGY } from './energy.js';
import type { Lineage } from './lineage.js';
import { lineageName } from './lineage-names.js';
import { Xoshiro256ss, type Xoshiro256State } from './rng.js';
import { LATTICE_CENTRE, type Position } from './substrate.js';
import { LineageId, ProbeId, SimTick, type Seed } from './types.js';

// Sim state. Everything the simulation knows about itself lives here. State
// is the snapshotable unit; given (seed, command-log) the state is uniquely
// determined at every tick (ARCHITECTURE.md "Snapshots are an
// implementation-defined performance cache").

// Probe identity is immutable, but energy mutates every tick (basal
// drain) and on every directive that touches it. Mutating in place is a
// deliberate departure from the otherwise-readonly shape — the spread
// allocations swamped the inner loop at simulation scale. Snapshots
// take a shallow copy of each probe so that a saved view does not drift
// when the live state advances.
export interface Probe {
  readonly id: ProbeId;
  readonly lineageId: LineageId;
  readonly bornAtTick: SimTick;
  readonly firmware: DirectiveStack;
  readonly position: Position;
  energy: bigint;
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
  // Energy granted to every newly-minted probe (founder + each child).
  // Carried on state so tests can drive a low value through the same
  // surface as production code, and so save/load round-trips it.
  initialEnergy: bigint;
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
  readonly initialEnergy: bigint;
}

export interface CreateInitialStateOptions {
  readonly founderFirmware?: DirectiveStack;
  readonly initialEnergy?: bigint;
}

export function createInitialState(
  seed: Seed,
  founderFirmwareOrOptions: DirectiveStack | CreateInitialStateOptions = FOUNDER_FIRMWARE,
): SimState {
  // Back-compat positional form: createInitialState(seed, firmware) is
  // still the common call. Object form lets callers (tests in
  // particular) pass `initialEnergy` without committing to a positional
  // ordering across future fields.
  const opts: CreateInitialStateOptions = Array.isArray(founderFirmwareOrOptions)
    ? { founderFirmware: founderFirmwareOrOptions as DirectiveStack }
    : (founderFirmwareOrOptions as CreateInitialStateOptions);
  const founderFirmware = opts.founderFirmware ?? FOUNDER_FIRMWARE;
  const initialEnergy = opts.initialEnergy ?? INITIAL_ENERGY;

  const rng = Xoshiro256ss.fromSeed(seed);
  const founderLineageId = LineageId('L0');
  const founderProbeId = ProbeId('P0');
  const founder: Probe = {
    id: founderProbeId,
    lineageId: founderLineageId,
    bornAtTick: SimTick(0n),
    firmware: founderFirmware,
    position: LATTICE_CENTRE,
    energy: initialEnergy,
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
    initialEnergy,
  };
}

export function snapshot(state: SimState): SimStateSnapshot {
  return {
    simTick: state.simTick,
    rngState: state.rng.state(),
    // Shallow-copy each probe so subsequent in-place energy mutation in
    // the live state does not bleed into the snapshot view.
    probes: [...state.probes.values()].map((p) => ({ ...p })),
    lineages: [...state.lineages.values()],
    nextProbeOrdinal: state.nextProbeOrdinal,
    nextLineageOrdinal: state.nextLineageOrdinal,
    initialEnergy: state.initialEnergy,
  };
}

export function restore(snap: SimStateSnapshot): SimState {
  return {
    simTick: SimTick(snap.simTick),
    rng: Xoshiro256ss.fromState(snap.rngState),
    // Shallow-copy probes back: the live state will mutate energy in
    // place, and we don't want to mutate the snapshot we restored from.
    probes: new Map(snap.probes.map((p) => [p.id, { ...p }])),
    lineages: new Map(snap.lineages.map((l) => [l.id, l])),
    nextProbeOrdinal: snap.nextProbeOrdinal,
    nextLineageOrdinal: snap.nextLineageOrdinal,
    initialEnergy: snap.initialEnergy,
  };
}

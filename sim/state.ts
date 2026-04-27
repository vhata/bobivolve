import { ORIGIN_COMPUTE_MAX } from './compute.js';
import { FOUNDER_FIRMWARE, type DirectiveStack } from './directive.js';
import { INITIAL_ENERGY } from './energy.js';
import type { Lineage } from './lineage.js';
import { lineageName } from './lineage-names.js';
import { MIN_FIRMWARE_LENGTH } from './mutation.js';
import { Xoshiro256ss, type Xoshiro256State } from './rng.js';
import { LATTICE_CENTRE, generateResourceCaps, type Position } from './substrate.js';
import { LineageId, ProbeId, SimTick, type Seed } from './types.js';

// Sim state. Everything the simulation knows about itself lives here. State
// is the snapshotable unit; given (seed, command-log) the state is uniquely
// determined at every tick (ARCHITECTURE.md "Snapshots are an
// implementation-defined performance cache").

// Probe identity is immutable, but two fields mutate every tick:
// energy (basal drain, gather, replicate cost) and position (explore).
// Mutating in place is a deliberate departure from the otherwise-readonly
// shape — the spread allocations swamped the inner loop at simulation
// scale. Snapshots take a shallow copy of each probe so that a saved
// view does not drift when the live state advances; reassignments to
// position install a fresh object so snapshot consumers reading
// .position stay consistent.
export interface Probe {
  readonly id: ProbeId;
  readonly lineageId: LineageId;
  readonly bornAtTick: SimTick;
  readonly firmware: DirectiveStack;
  position: Position;
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
  // Flat row-major resource grid for the sub-lattice. Length is
  // LATTICE_CELL_COUNT; index is cellIndex(x, y) = y * LATTICE_SIDE + x.
  // Each cell carries an integer resource quantity that probes absorb
  // and basal regen replenishes (up to that cell's resourceCaps entry).
  resources: bigint[];
  // Per-cell capacity, derived once from the seed at construction.
  // Cells inside a system disc carry positive caps; cells in the
  // void carry zero. Regen replenishes up to this cap; diffusion is
  // not cap-aware and can transiently push a cell above its own cap.
  resourceCaps: bigint[];
  // Lineages currently under player quarantine. R2 intervention: a
  // probe whose lineageId is in this set skips replication entirely —
  // no energy cost, no PRNG draws, no offspring. Other directives
  // (gather, explore) run normally; the lineage simply stops
  // propagating until the player lifts the suspension. Mutating in
  // place is intentional: the set is small and the cost of recopying
  // a Set on every command would be silly.
  quarantinedLineages: Set<LineageId>;
  // Origin compute. The meta-game budget that gates every player
  // intervention (SPEC.md "Player Intervention (R2+)"). Regenerates
  // per tick toward ORIGIN_COMPUTE_MAX; held quarantines drain it.
  // Pure integer arithmetic; no PRNG draws.
  originCompute: bigint;
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
  readonly resources: readonly bigint[];
  readonly resourceCaps: readonly bigint[];
  readonly quarantinedLineages: readonly LineageId[];
  readonly originCompute: bigint;
}

export interface CreateInitialStateOptions {
  readonly founderFirmware?: DirectiveStack;
  // Override the founder's starting energy. Children do not inherit
  // from this; they receive REPLICATION_COST_ENERGY transferred from
  // the parent at birth.
  readonly founderEnergy?: bigint;
}

export function createInitialState(
  seed: Seed,
  founderFirmwareOrOptions: DirectiveStack | CreateInitialStateOptions = FOUNDER_FIRMWARE,
): SimState {
  // Back-compat positional form: createInitialState(seed, firmware) is
  // still the common call. Object form lets callers (tests in
  // particular) pass `founderEnergy` without committing to a positional
  // ordering across future fields.
  const opts: CreateInitialStateOptions = Array.isArray(founderFirmwareOrOptions)
    ? { founderFirmware: founderFirmwareOrOptions as DirectiveStack }
    : (founderFirmwareOrOptions as CreateInitialStateOptions);
  const founderFirmware = opts.founderFirmware ?? FOUNDER_FIRMWARE;
  const founderEnergy = opts.founderEnergy ?? INITIAL_ENERGY;
  // The mutation path floors firmware length at MIN_FIRMWARE_LENGTH;
  // a founder below that floor would create an inert lineage that
  // mutation could not recover from. Catch it at construction so the
  // bad input shows up at the seam, not deep in the run loop.
  if (founderFirmware.length < MIN_FIRMWARE_LENGTH) {
    throw new Error(
      `founder firmware must contain at least ${MIN_FIRMWARE_LENGTH.toString()} directive(s)`,
    );
  }

  const rng = Xoshiro256ss.fromSeed(seed);

  // Procedural system placement happens before the founder is minted,
  // so the world exists and then the founder lands in it. The first
  // system anchors at the lattice centre, guaranteeing the founder
  // starts in a viable cell. Subsequent systems consume PRNG draws
  // from the same stream as everything else — the world generation
  // is part of the (seed → state) contract.
  const resourceCaps = generateResourceCaps(rng, LATTICE_CENTRE);

  const founderLineageId = LineageId('L0');
  const founderProbeId = ProbeId('P0');
  const founder: Probe = {
    id: founderProbeId,
    lineageId: founderLineageId,
    bornAtTick: SimTick(0n),
    firmware: founderFirmware,
    position: LATTICE_CENTRE,
    energy: founderEnergy,
  };
  const founderLineage: Lineage = {
    id: founderLineageId,
    name: lineageName(0n),
    founderProbeId,
    parentLineageId: null,
    referenceFirmware: founderFirmware,
    foundedAtTick: SimTick(0n),
  };
  // Each cell starts at its own cap — system centres are bountiful,
  // void cells are dead — so probes leaving the founder's home system
  // walk through interstellar emptiness until they cross another
  // system's falloff disc.
  const resources = resourceCaps.slice();

  return {
    simTick: SimTick(0n),
    rng,
    probes: new Map([[founder.id, founder]]),
    lineages: new Map([[founderLineage.id, founderLineage]]),
    nextProbeOrdinal: 1n,
    nextLineageOrdinal: 1n,
    resources,
    resourceCaps,
    quarantinedLineages: new Set(),
    // Player begins with a full budget so the first intervention does
    // not have to wait for regen.
    originCompute: ORIGIN_COMPUTE_MAX,
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
    // Resources mutate in place each tick; copy the slice so the saved
    // view stays frozen.
    resources: state.resources.slice(),
    // resourceCaps are immutable post-construction, but copying keeps
    // the snapshot independent of any future mutation by mistake.
    resourceCaps: state.resourceCaps.slice(),
    quarantinedLineages: [...state.quarantinedLineages],
    originCompute: state.originCompute,
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
    resources: snap.resources.slice(),
    resourceCaps: snap.resourceCaps.slice(),
    quarantinedLineages: new Set(snap.quarantinedLineages),
    // Some snapshots predate this field; default to a full budget so
    // older saves still load. New snapshots always carry it.
    originCompute: snap.originCompute ?? ORIGIN_COMPUTE_MAX,
  };
}

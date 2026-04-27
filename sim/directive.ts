// Directive stack — the firmware a probe executes. SPEC.md "A parameterized
// behavior unit ... with a priority and parameters." ARCHITECTURE.md flags
// the directive stack shape as an open question pending the patch editor UX
// (R2+); the shape here is deliberately minimal so it can be reshaped without
// renaming the storage on disk.
//
// R0 shipped one directive kind (replicate). R1 adds gather and explore.
// The discriminated union widens accordingly; mutation across multiple
// directive kinds (priority swap, directive loss / gain) becomes
// meaningful once the firmware has more than one entry.

export interface ReplicateDirective {
  readonly kind: 'replicate';
  // Energy threshold for replication. A probe whose energy is at least
  // this value will replicate; replication deducts REPLICATION_COST_ENERGY
  // from the parent. SPEC.md: "Probes replicate when their internal
  // energy passes a directive-defined threshold."
  readonly threshold: bigint;
}

export interface GatherDirective {
  readonly kind: 'gather';
  // Maximum energy units pulled from the probe's cell each tick, capped
  // at whatever the cell holds. Tuned so a probe in a healthy cell
  // recoups basal drain plus a fraction of the replication cost.
  readonly rate: bigint;
}

export interface ExploreDirective {
  readonly kind: 'explore';
  // u64-threshold gate per tick: a PRNG draw strictly less than this
  // value triggers a single-step move to a uniformly random cardinal
  // neighbour (boundary blocks are no-ops). Threshold ≈ 2^60 ≈ 6.25%
  // chance per tick at the founder default.
  readonly threshold: bigint;
}

export type Directive = ReplicateDirective | GatherDirective | ExploreDirective;
export type DirectiveStack = readonly Directive[];

// Default founder firmware. Order is meaningful — directives execute
// in firmware order each tick. Gather before replicate so a probe can
// fund the replication cost from this tick's harvest; explore between
// the two so a fresh child does not immediately drift away from its
// resource source.
//
// explore.threshold = 2^58 ≈ 1.5% per tick. On a 64×64 lattice this
// gives the wave-front of colonisation real visible width — probes
// take many ticks to walk between systems, and you can watch the
// frontier creep across the void on the substrate panel.
export const FOUNDER_FIRMWARE: DirectiveStack = [
  { kind: 'gather', rate: 2n },
  { kind: 'explore', threshold: 1n << 58n },
  { kind: 'replicate', threshold: 1000n },
];

// Directive stack — the firmware a probe executes. SPEC.md "A parameterized
// behavior unit ... with a priority and parameters." ARCHITECTURE.md flags
// the directive stack shape as an open question pending the patch editor UX
// (R2+); the shape here is deliberately minimal so it can be reshaped without
// renaming the storage on disk.
//
// R0 ships exactly one directive kind: replicate. R1+ adds gather, explore,
// defend, etc.; that growth is a discriminated-union widening.

export interface ReplicateDirective {
  readonly kind: 'replicate';
  // PRNG-draw threshold per tick. A u64 draw strictly less than `threshold`
  // triggers replication. threshold = 2^54 ≈ probability 0.001 per tick.
  readonly threshold: bigint;
}

export type Directive = ReplicateDirective;
export type DirectiveStack = readonly Directive[];

// Default founder firmware. Tuned so a single probe doubles, very loosely,
// every few hundred ticks at 1x — slow enough that drift (R0 Q: "does
// firmware-as-data produce interesting drift on its own") has room to be
// observed before the population balloons to scales requiring scarcity.
export const FOUNDER_FIRMWARE: DirectiveStack = [{ kind: 'replicate', threshold: 1n << 54n }];

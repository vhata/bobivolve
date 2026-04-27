// Directive stack — the firmware a probe executes. SPEC.md "A parameterized
// behavior unit ... with a priority and parameters." ARCHITECTURE.md flags
// the directive stack shape as an open question pending the patch editor UX
// (R2+); the shape here is deliberately minimal so it can be reshaped without
// renaming the storage on disk.
//
// R0 ships exactly one directive kind: replicate. R1 adds gather and
// explore; that growth is a discriminated-union widening.

export interface ReplicateDirective {
  readonly kind: 'replicate';
  // Energy threshold for replication. A probe whose energy is at least
  // this value will replicate; replication deducts REPLICATION_COST_ENERGY
  // from the parent. SPEC.md: "Probes replicate when their internal
  // energy passes a directive-defined threshold." R0 used this same
  // field as a probability gate — R1 reinterprets it as the SPEC has
  // always intended.
  readonly threshold: bigint;
}

export type Directive = ReplicateDirective;
export type DirectiveStack = readonly Directive[];

// Default founder firmware. Energy threshold tuned so a probe in a
// healthy cell can fund a steady stream of replications under R1
// metabolism (absorption ≥ basal drain + amortised replication cost).
export const FOUNDER_FIRMWARE: DirectiveStack = [{ kind: 'replicate', threshold: 1000n }];

import type { Directive, DirectiveStack } from './directive.js';
import type { Xoshiro256ss } from './rng.js';

// Mutation. Hits when a probe replicates: each directive in the child's
// firmware is independently rolled for parameter drift. R0 implements
// parameter drift only; priority swap and directive loss/gain (SPEC.md
// "Replication and Mutation") wait for a richer firmware to mutate against
// — with a single directive in the stack, swap is a no-op and loss makes
// the lineage immediately inert.
//
// Determinism contract: every probability is expressed as a u64 threshold
// against a PRNG draw, never as IEEE-754 floating-point arithmetic. Floats
// are forbidden in the byte-for-byte path (ARCHITECTURE.md "Determinism
// disciplines"). The same seed and the same directive stack always produce
// the same mutation outcome.

const U64_MAX = 0xffffffffffffffffn;

// ~6.25% chance per directive per replication. Tuned with no selection
// pressure in mind (R0 has none); R1+ scarcity will validate or invalidate
// this rate. Expressed as a threshold so the inner loop is bigint-only.
export const PARAMETER_DRIFT_THRESHOLD = 1n << 60n;

// Maximum drift, expressed as a divisor of the parameter being drifted:
// drift magnitude is at most parameter / DRIFT_DIVISOR. With DRIFT_DIVISOR
// = 64, threshold drifts by at most ~1.5% per event. Multiplicative scaling
// keeps drift proportional across magnitudes — a probe with threshold 2^54
// drifts by ±2^48-ish, while a probe with threshold 2^40 drifts by ±2^34-ish.
export const DRIFT_DIVISOR = 64n;

// Result of a mutation pass. `mutated` is true if at least one directive
// rolled into a different value; the parent's `mutated` flag on the
// resulting Replication event is wired from this. When no directive
// mutated, the original firmware reference is returned unchanged so
// inheritance is allocation-free in the common case.
export interface MutationResult {
  readonly firmware: DirectiveStack;
  readonly mutated: boolean;
}

// Per replication, mutate each directive in the firmware independently.
export function maybeMutate(rng: Xoshiro256ss, firmware: DirectiveStack): MutationResult {
  const next: Directive[] = [];
  let mutated = false;
  for (const directive of firmware) {
    const result = maybeMutateDirective(rng, directive);
    next.push(result);
    if (result !== directive) mutated = true;
  }
  return { firmware: mutated ? next : firmware, mutated };
}

function maybeMutateDirective(rng: Xoshiro256ss, directive: Directive): Directive {
  // One draw to decide whether this directive mutates this replication.
  const decision = rng.nextU64();
  if (decision >= PARAMETER_DRIFT_THRESHOLD) return directive;

  switch (directive.kind) {
    case 'replicate':
      return {
        kind: 'replicate',
        threshold: driftU64(rng, directive.threshold),
      };
    case 'gather':
      return {
        kind: 'gather',
        rate: driftU64(rng, directive.rate),
      };
    case 'explore':
      return {
        kind: 'explore',
        threshold: driftU64(rng, directive.threshold),
      };
  }
}

// Drift a u64 parameter by a small signed amount. Sign comes from the bottom
// bit of the PRNG draw, magnitude from the upper bits modulo the allowed
// range. Modulo introduces a small bias when range is not a power of two,
// which is acceptable here — the bias is deterministic and irrelevant to
// the design question R0 is exploring.
//
// Exported for tests; internal callers go through maybeMutate.
export function driftU64(rng: Xoshiro256ss, value: bigint): bigint {
  if (value === 0n) return 0n;

  const r = rng.nextU64();
  const max = value / DRIFT_DIVISOR;
  if (max === 0n) return value;

  const sign = (r & 1n) === 0n ? 1n : -1n;
  const magnitude = (r >> 1n) % (max + 1n);
  let next = value + sign * magnitude;

  // Floor at 1 — a threshold of 0 yields an inert lineage and we want
  // mutation to drift, not extinguish. Lineage death is selection's job (R1).
  if (next < 1n) next = 1n;
  if (next > U64_MAX) next = U64_MAX;
  return next;
}

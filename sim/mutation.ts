import type { Directive, DirectiveStack } from './directive.js';
import type { Xoshiro256ss } from './rng.js';

// Mutation. Hits when a probe replicates. Three classes of mutation are
// applied in fixed order:
//
//   1. Parameter drift — each directive in the child's firmware is
//      independently rolled. The directive's numeric parameter may
//      shift by ±value/DRIFT_DIVISOR.
//   2. Priority swap — rare; swaps an adjacent pair of directives. Order
//      matters because directives execute in firmware order.
//   3. Directive loss / gain — very rare; either removes a directive or
//      duplicates one with a fresh parameter drift on the copy.
//
// SPEC.md "Replication and Mutation". The structural mutations require
// firmware with ≥2 directive kinds to be meaningful; R0 carried them as
// deferred for that reason.
//
// Determinism contract: every probability is expressed as a u64 threshold
// against a PRNG draw, never as IEEE-754 floating-point arithmetic. Floats
// are forbidden in the byte-for-byte path (ARCHITECTURE.md "Determinism
// disciplines"). The same seed and the same directive stack always produce
// the same mutation outcome.

const U64_MAX = 0xffffffffffffffffn;

// ~6.25% chance per directive per replication. Expressed as a threshold
// so the inner loop is bigint-only.
export const PARAMETER_DRIFT_THRESHOLD = 1n << 60n;

// Maximum drift, expressed as a divisor of the parameter being drifted:
// drift magnitude is at most parameter / DRIFT_DIVISOR. With DRIFT_DIVISOR
// = 64, threshold drifts by at most ~1.5% per event. Multiplicative scaling
// keeps drift proportional across magnitudes — a probe with threshold 2^54
// drifts by ±2^48-ish, while a probe with threshold 2^40 drifts by ±2^34-ish.
export const DRIFT_DIVISOR = 64n;

// Structural mutation thresholds. All gated against a single u64 draw
// per replication so each is independent of the others.
//   PRIORITY_SWAP   ≈ 1.5% per replication
//   DIRECTIVE_LOSS  ≈ 0.4% per replication
//   DIRECTIVE_GAIN  ≈ 0.4% per replication
// Gain duplicates an existing directive then runs parameter drift on
// the duplicate, per SPEC.md "a duplicate is inserted with altered
// parameters."
export const PRIORITY_SWAP_THRESHOLD = 1n << 58n;
export const DIRECTIVE_LOSS_THRESHOLD = 1n << 56n;
export const DIRECTIVE_GAIN_THRESHOLD = 1n << 56n;

// Bounds on firmware length. A lineage with zero directives is inert;
// an unbounded firmware would let pathological mutations bloat probes
// indefinitely. R1 bounds chosen to keep the inspector readable.
export const MIN_FIRMWARE_LENGTH = 1;
export const MAX_FIRMWARE_LENGTH = 8;

// Result of a mutation pass. `mutated` is true if at least one directive
// rolled into a different value; the parent's `mutated` flag on the
// resulting Replication event is wired from this. When no directive
// mutated, the original firmware reference is returned unchanged so
// inheritance is allocation-free in the common case.
export interface MutationResult {
  readonly firmware: DirectiveStack;
  readonly mutated: boolean;
}

// Per replication, run parameter drift on every directive then roll
// for the structural mutations (priority swap, directive loss, gain).
// Each PRNG draw consumed in fixed order so the mutation outcome is a
// pure function of (rng state, firmware).
export function maybeMutate(rng: Xoshiro256ss, firmware: DirectiveStack): MutationResult {
  // Phase 1: parameter drift on each directive.
  const drifted: Directive[] = [];
  let mutated = false;
  for (const directive of firmware) {
    const result = maybeMutateDirective(rng, directive);
    drifted.push(result);
    if (result !== directive) mutated = true;
  }
  const working: Directive[] = mutated ? drifted : [...firmware];

  // Phase 2: priority swap. Pick an adjacent pair and swap them.
  const swapDecision = rng.nextU64();
  if (swapDecision < PRIORITY_SWAP_THRESHOLD && working.length >= 2) {
    const positionRoll = rng.nextU64();
    const i = Number(positionRoll % BigInt(working.length - 1));
    const tmp = working[i];
    const next = working[i + 1];
    if (tmp !== undefined && next !== undefined) {
      working[i] = next;
      working[i + 1] = tmp;
      mutated = true;
    }
  }

  // Phase 3: directive loss. Remove one directive. Floor at
  // MIN_FIRMWARE_LENGTH; below that the probe is inert.
  const lossDecision = rng.nextU64();
  if (lossDecision < DIRECTIVE_LOSS_THRESHOLD && working.length > MIN_FIRMWARE_LENGTH) {
    const positionRoll = rng.nextU64();
    const i = Number(positionRoll % BigInt(working.length));
    working.splice(i, 1);
    mutated = true;
  }

  // Phase 4: directive gain. Duplicate one directive (with parameter
  // drift on the copy) at a position right after the original. Cap at
  // MAX_FIRMWARE_LENGTH so pathological gain runs do not bloat
  // firmware unboundedly.
  const gainDecision = rng.nextU64();
  if (gainDecision < DIRECTIVE_GAIN_THRESHOLD && working.length < MAX_FIRMWARE_LENGTH) {
    const positionRoll = rng.nextU64();
    const i = Number(positionRoll % BigInt(working.length));
    const original = working[i];
    if (original !== undefined) {
      const drift = forceMutateDirective(rng, original);
      working.splice(i + 1, 0, drift);
      mutated = true;
    }
  }

  return { firmware: mutated ? working : firmware, mutated };
}

// Same parameter drift as the per-directive mutation path, but always
// applied (no decision draw). Used by directive gain so the duplicate
// is meaningfully different from the original.
function forceMutateDirective(rng: Xoshiro256ss, directive: Directive): Directive {
  switch (directive.kind) {
    case 'replicate':
      return { kind: 'replicate', threshold: driftU64(rng, directive.threshold) };
    case 'gather':
      return { kind: 'gather', rate: driftU64(rng, directive.rate) };
    case 'explore':
      return { kind: 'explore', threshold: driftU64(rng, directive.threshold) };
  }
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

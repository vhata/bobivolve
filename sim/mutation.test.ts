import { describe, expect, it } from 'vitest';
import type { DirectiveStack } from './directive.js';
import { DRIFT_DIVISOR, PARAMETER_DRIFT_THRESHOLD, driftU64, maybeMutate } from './mutation.js';
import { Xoshiro256ss } from './rng.js';

describe('driftU64', () => {
  it('returns a value within ±(value / DRIFT_DIVISOR) of the input', () => {
    const value = 1n << 54n;
    const rng = Xoshiro256ss.fromSeed(1n);
    const maxDelta = value / DRIFT_DIVISOR;
    for (let i = 0; i < 1000; i++) {
      const out = driftU64(rng, value);
      const delta = out > value ? out - value : value - out;
      expect(delta).toBeLessThanOrEqual(maxDelta);
    }
  });

  it('floors at 1 — never produces 0 from a non-zero value', () => {
    const rng = Xoshiro256ss.fromSeed(7n);
    for (let i = 0; i < 200; i++) {
      const out = driftU64(rng, 64n);
      expect(out >= 1n).toBe(true);
    }
  });

  it('is deterministic: same seed and value yields same drift sequence', () => {
    const a = Xoshiro256ss.fromSeed(99n);
    const b = Xoshiro256ss.fromSeed(99n);
    for (let i = 0; i < 100; i++) {
      expect(driftU64(a, 1n << 54n)).toBe(driftU64(b, 1n << 54n));
    }
  });

  it('returns 0 unchanged', () => {
    const rng = Xoshiro256ss.fromSeed(1n);
    expect(driftU64(rng, 0n)).toBe(0n);
  });

  it('returns small values unchanged when value < DRIFT_DIVISOR', () => {
    const rng = Xoshiro256ss.fromSeed(1n);
    // value = 32, DRIFT_DIVISOR = 64 → max = 0, so no drift.
    expect(driftU64(rng, 32n)).toBe(32n);
  });
});

describe('maybeMutate', () => {
  const firmware: DirectiveStack = [{ kind: 'replicate', threshold: 1n << 54n }];

  it('mostly does not mutate (drift threshold ≈ 6.25%)', () => {
    const rng = Xoshiro256ss.fromSeed(42n);
    let mutated = 0;
    const trials = 10000;
    for (let i = 0; i < trials; i++) {
      const result = maybeMutate(rng, firmware);
      if (result.mutated) mutated++;
    }
    // Expected mutation rate ≈ 1/16. Allow generous slack to keep the
    // test robust against the deterministic stream's local fluctuations.
    expect(mutated).toBeGreaterThan(trials / 32);
    expect(mutated).toBeLessThan(trials / 8);
  });

  it('preserves directive count and kind', () => {
    const rng = Xoshiro256ss.fromSeed(1n);
    for (let i = 0; i < 500; i++) {
      const result = maybeMutate(rng, firmware);
      expect(result.firmware).toHaveLength(1);
      expect(result.firmware[0]?.kind).toBe('replicate');
    }
  });

  it('returns the original firmware reference unchanged when no directive mutated', () => {
    // Choose a seed where the first draw is reliably above the drift
    // threshold; the easiest way is to fix the seed and assert.
    const rng = Xoshiro256ss.fromSeed(1n);
    let sawIdentity = false;
    for (let i = 0; i < 500; i++) {
      const result = maybeMutate(rng, firmware);
      if (!result.mutated) {
        // No mutation: same array reference, so callers can avoid
        // allocation in the common case.
        expect(result.firmware).toBe(firmware);
        sawIdentity = true;
      }
    }
    expect(sawIdentity).toBe(true);
  });

  it('PARAMETER_DRIFT_THRESHOLD is below 2^64', () => {
    expect(PARAMETER_DRIFT_THRESHOLD < 1n << 64n).toBe(true);
  });
});

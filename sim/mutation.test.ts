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

  it('drifts sub-DRIFT_DIVISOR values by exactly ±1', () => {
    // value = 32, DRIFT_DIVISOR = 64 → proportional max is 0. The
    // sub-DRIFT_DIVISOR branch drifts by ±1 instead so small parameters
    // (notably the founder gather.rate) still bite over generations.
    const rng = Xoshiro256ss.fromSeed(1n);
    const result = driftU64(rng, 32n);
    expect(result === 31n || result === 33n).toBe(true);
  });

  it('drifts a value of 1 to either 1 (clamped from 0) or 2', () => {
    // value = 1: proportional max is 0; ±1 branch may attempt 0 (which
    // floors to 1) or 2.
    for (let seed = 1n; seed <= 8n; seed += 1n) {
      const rng = Xoshiro256ss.fromSeed(seed);
      const result = driftU64(rng, 1n);
      expect(result === 1n || result === 2n).toBe(true);
    }
  });
});

describe('structural mutations', () => {
  const triFirmware: DirectiveStack = [
    { kind: 'gather', rate: 64n },
    { kind: 'explore', threshold: 1n << 60n },
    { kind: 'replicate', threshold: 1000n },
  ];

  it('produces an identical mutation sequence for the same seed', () => {
    const a = Xoshiro256ss.fromSeed(123n);
    const b = Xoshiro256ss.fromSeed(123n);
    for (let i = 0; i < 200; i++) {
      const ra = maybeMutate(a, triFirmware);
      const rb = maybeMutate(b, triFirmware);
      expect(rb.firmware).toEqual(ra.firmware);
      expect(rb.mutated).toBe(ra.mutated);
    }
  });

  it('keeps firmware length within the configured bounds', () => {
    const rng = Xoshiro256ss.fromSeed(99n);
    let firmware = triFirmware;
    for (let i = 0; i < 5000; i++) {
      const result = maybeMutate(rng, firmware);
      expect(result.firmware.length).toBeGreaterThanOrEqual(1);
      expect(result.firmware.length).toBeLessThanOrEqual(8);
      firmware = result.firmware;
    }
  });

  it('directive gain produces a strictly-different copy of the chosen directive', () => {
    // Walk a long stream looking for gain events. A gain inserts at
    // i+1 a directive whose kind matches working[i] but whose
    // parameter has changed. Whenever we see two adjacent
    // same-kind directives in the result, their parameters must
    // differ — that is the SPEC's "altered parameters" guarantee.
    const rng = Xoshiro256ss.fromSeed(2024n);
    let firmware = triFirmware;
    let sawGain = false;
    for (let i = 0; i < 5000 && !sawGain; i++) {
      const result = maybeMutate(rng, firmware);
      if (result.firmware.length > firmware.length) {
        for (let j = 0; j < result.firmware.length - 1; j++) {
          const a = result.firmware[j];
          const b = result.firmware[j + 1];
          if (a === undefined || b === undefined) continue;
          if (a.kind === b.kind) {
            sawGain = true;
            // Same-kind adjacent pair — parameters must differ.
            const aParam =
              a.kind === 'gather' ? a.rate : a.kind === 'explore' ? a.threshold : a.threshold;
            const bParam =
              b.kind === 'gather' ? b.rate : b.kind === 'explore' ? b.threshold : b.threshold;
            expect(aParam).not.toBe(bParam);
            break;
          }
        }
      }
      firmware = result.firmware;
    }
    expect(sawGain).toBe(true);
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

  it('preserves directive kind set under structural mutations', () => {
    // Structural mutations (priority swap, loss, gain) are very rare;
    // most replications produce a stack with the same length and same
    // kinds as the input. The looser invariant here: kinds present in
    // the output are a subset of kinds present in the input — gain
    // duplicates an existing directive, never invents a new kind.
    const rng = Xoshiro256ss.fromSeed(1n);
    const inputKinds = new Set(firmware.map((d) => d.kind));
    for (let i = 0; i < 500; i++) {
      const result = maybeMutate(rng, firmware);
      for (const directive of result.firmware) {
        expect(inputKinds.has(directive.kind)).toBe(true);
      }
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

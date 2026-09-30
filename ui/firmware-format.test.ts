import { describe, expect, it } from 'vitest';
import { formatMovementAttemptChance } from './firmware-format.js';

describe('movement-attempt probability display', () => {
  it('converts known exploration gates to exact percentages', () => {
    expect(formatMovementAttemptChance('0')).toBe('0%');
    expect(formatMovementAttemptChance((1n << 58n).toString())).toBe('1.5625%');
    expect(formatMovementAttemptChance((1n << 60n).toString())).toBe('6.25%');
    expect(formatMovementAttemptChance((1n << 63n).toString())).toBe('50%');
  });

  it('distinguishes tiny and nearly certain probabilities from impossible and certain', () => {
    expect(formatMovementAttemptChance('1')).toBe('<0.000001%');
    expect(formatMovementAttemptChance(((1n << 64n) - 1n).toString())).toBe('>99.999999%');
    expect(formatMovementAttemptChance('1844674407370955161')).toBe('≈10%');
    expect(formatMovementAttemptChance('1234567890123456789')).toBe('≈6.692606%');
  });

  it('does not preview invalid or out-of-range input', () => {
    for (const invalid of ['', '-1', '1.5', '1e3', ' 1', (1n << 64n).toString()]) {
      expect(formatMovementAttemptChance(invalid)).toBeNull();
    }
  });
});

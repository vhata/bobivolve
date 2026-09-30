import { parseUint64Decimal } from '../protocol/uint64.js';

// The exploration gate compares a uint64 draw against the threshold.
// Format the percentage with integer arithmetic: converting the threshold
// to Number would round the largest valid gate to a misleading 100%.
export function formatMovementAttemptChance(raw: string): string | null {
  const threshold = parseUint64Decimal(raw);
  if (threshold === null) return null;
  if (threshold === 0n) return '0%';
  const denominator = 1n << 64n;
  const scaled = threshold * 100_000_000n; // six decimal places of percent
  const rounded = (scaled + denominator / 2n) / denominator;
  if (rounded === 0n) return '<0.000001%';
  if (rounded === 100_000_000n) return '>99.999999%';
  const whole = rounded / 1_000_000n;
  const fraction = (rounded % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  const approximate = scaled % denominator !== 0n ? '≈' : '';
  return `${approximate}${whole.toString()}${fraction === '' ? '' : `.${fraction}`}%`;
}

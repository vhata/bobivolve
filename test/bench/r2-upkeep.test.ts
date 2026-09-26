import { expect, it } from 'vitest';
import { FOUNDER_FIRMWARE } from '../../sim/directive.js';
import { prototypeUpkeep } from './r2-upkeep.js';

it('keeps founder capacity free and charges extra harvesting even without yield', () => {
  expect(prototypeUpkeep(FOUNDER_FIRMWARE, 16n)).toBe(0n);
  expect(prototypeUpkeep([{ kind: 'gather', rate: 4n }], 1n)).toBe(1n);
});
it('aggregates duplicated directives before granting baseline capacity', () => {
  expect(
    prototypeUpkeep(
      [
        { kind: 'gather', rate: 2n },
        { kind: 'gather', rate: 2n },
      ],
      1n,
    ),
  ).toBe(1n);
});
it('uses exact integer movement billing with no state or randomness', () => {
  const firmware = [{ kind: 'explore', threshold: 1n << 60n }] as const;
  expect(prototypeUpkeep(firmware, 15n)).toBe(0n);
  expect(prototypeUpkeep(firmware, 16n)).toBe(3n);
  expect(prototypeUpkeep(firmware, 32n)).toBe(3n);
});

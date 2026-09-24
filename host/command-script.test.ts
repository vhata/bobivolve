import { expect, it } from 'vitest';
import { parseCommandScript } from './command-script.js';
import { INTERVENTIONS } from '../test/determinism/interventions.js';

const encode = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));

it('preserves same-tick input order and directive string precision', () => {
  expect(parseCommandScript(encode(INTERVENTIONS), 300n)).toEqual(INTERVENTIONS);
});

it.each([
  { reason: 'root', value: {} },
  { reason: 'tick type', value: [{ tick: 0, command: INTERVENTIONS[0]!.command }] },
  { reason: 'negative tick', value: [{ tick: '-1', command: INTERVENTIONS[0]!.command }] },
  {
    reason: 'tick overflow',
    value: [{ tick: '18446744073709551616', command: INTERVENTIONS[0]!.command }],
  },
  { reason: 'unordered', value: [INTERVENTIONS[1], INTERVENTIONS[0]] },
  { reason: 'duplicate IDs', value: [INTERVENTIONS[0], INTERVENTIONS[0]] },
  { reason: 'beyond endpoint', value: [{ ...INTERVENTIONS[0], tick: '301' }] },
  {
    reason: 'destructive command',
    value: [{ tick: '0', command: { kind: 'newRun', commandId: 'bad', seed: '42' } }],
  },
  {
    reason: 'reserved ID',
    value: [{ tick: '0', command: { ...INTERVENTIONS[0]!.command, commandId: 'cli-newRun' } }],
  },
  { reason: 'unknown field', value: [{ ...INTERVENTIONS[0], typo: true }] },
  {
    reason: 'empty firmware',
    value: [
      {
        tick: '0',
        command: { kind: 'applyPatch', commandId: 'patch', lineageId: 'L0', firmware: [] },
      },
    ],
  },
  {
    reason: 'bad directive',
    value: [
      {
        tick: '0',
        command: {
          kind: 'applyPatch',
          commandId: 'patch',
          lineageId: 'L0',
          firmware: [{ kind: 'gather', params: { rate: '0x10' } }],
        },
      },
    ],
  },
])('rejects $reason', ({ value }) => {
  expect(() => parseCommandScript(encode(value), 300n)).toThrow();
});

it('bounds document size', () => {
  expect(() => parseCommandScript(' '.repeat(1_048_577), 300n)).toThrow('exceeds 1 MiB');
});

import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../protocol/types.js';
import type { QueuedDecree } from './decree.js';
import { triggerFires } from './decree.js';
import type { DirectiveStack } from './directive.js';
import { createInitialState } from './state.js';
import { tickN } from './step.js';
import { LineageId, Seed } from './types.js';

const FIRMWARE: DirectiveStack = [
  { kind: 'gather', rate: 2n },
  { kind: 'replicate', threshold: 1000n },
];

describe('triggerFires', () => {
  it('populationBelow: fires when count is strictly below threshold', () => {
    const state = createInitialState(Seed(42n), FIRMWARE);
    // Founder is the only L0 probe — count = 1.
    expect(
      triggerFires(state, {
        kind: 'populationBelow',
        lineageId: LineageId('L0'),
        threshold: 2n,
      }),
    ).toBe(true);
  });

  it('populationBelow: does not fire when count meets or exceeds threshold', () => {
    const state = createInitialState(Seed(42n), FIRMWARE);
    expect(
      triggerFires(state, {
        kind: 'populationBelow',
        lineageId: LineageId('L0'),
        threshold: 1n,
      }),
    ).toBe(false);
  });
});

describe('decree firing through tick', () => {
  it('a queued decree fires when its trigger condition holds and is removed', () => {
    const state = createInitialState(Seed(42n), FIRMWARE);
    // The trigger fires straight away: L0's population this tick will
    // be at most a handful (founder + a few children at TEST_FIRMWARE
    // replication rates), nowhere near 100.
    const decree: QueuedDecree = {
      id: 'D0',
      queuedAtTick: 0n,
      trigger: { kind: 'populationBelow', lineageId: LineageId('L0'), threshold: 100n },
      patchTargetLineageId: LineageId('L0'),
      patchFirmware: [
        { kind: 'gather', rate: 9n },
        { kind: 'replicate', threshold: 500n },
      ],
    };
    state.queuedDecrees.push(decree);
    state.nextDecreeOrdinal = 1n;

    const events: SimEvent[] = [];
    tickN(state, 1n, events);

    const fired = events.filter((e) => e.kind === 'decreeFired');
    expect(fired).toHaveLength(1);
    expect(state.queuedDecrees).toHaveLength(0);

    // The decree's patch landed on L0's reference firmware.
    expect(state.lineages.get(LineageId('L0'))?.referenceFirmware[0]).toEqual({
      kind: 'gather',
      rate: 9n,
    });
  });

  it('a queued decree stays in the queue while its trigger is unmet', () => {
    const state = createInitialState(Seed(42n), FIRMWARE);
    const decree: QueuedDecree = {
      id: 'D0',
      queuedAtTick: 0n,
      // Threshold 1 — even a single live probe in L0 satisfies "not
      // strictly below 1," so the trigger never fires while L0 lives.
      trigger: { kind: 'populationBelow', lineageId: LineageId('L0'), threshold: 1n },
      patchTargetLineageId: LineageId('L0'),
      patchFirmware: [
        { kind: 'gather', rate: 9n },
        { kind: 'replicate', threshold: 500n },
      ],
    };
    state.queuedDecrees.push(decree);
    state.nextDecreeOrdinal = 1n;

    const events: SimEvent[] = [];
    tickN(state, 100n, events);

    expect(events.find((e) => e.kind === 'decreeFired')).toBeUndefined();
    expect(state.queuedDecrees).toHaveLength(1);
  });
});

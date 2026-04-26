import { describe, expect, it } from 'vitest';
import { createInitialState, snapshot } from '../sim/state.js';
import { tickN } from '../sim/step.js';
import { Seed } from '../sim/types.js';
import { deserializeSnapshot, serializeSnapshot } from './snapshot-codec.js';

describe('snapshot codec', () => {
  it('round-trips a fresh state', () => {
    const state = createInitialState(Seed(42n));
    const snap = snapshot(state);
    const bytes = serializeSnapshot(snap);
    const back = deserializeSnapshot(bytes);
    expect(back).toEqual(snap);
  });

  it('round-trips a state after replication and speciation', () => {
    const state = createInitialState(Seed(2026n));
    tickN(state, 5000n);
    const snap = snapshot(state);
    expect(snap.probes.length).toBeGreaterThan(1);
    const bytes = serializeSnapshot(snap);
    const back = deserializeSnapshot(bytes);
    expect(back).toEqual(snap);
  });

  it('preserves bigint identity across serialisation', () => {
    const state = createInitialState(Seed(7n));
    tickN(state, 1000n);
    const snap = snapshot(state);
    const back = deserializeSnapshot(serializeSnapshot(snap));
    expect(typeof back.simTick).toBe('bigint');
    expect(typeof back.nextProbeOrdinal).toBe('bigint');
    expect(typeof back.rngState[0]).toBe('bigint');
    for (const probe of back.probes) {
      expect(typeof probe.bornAtTick).toBe('bigint');
      for (const directive of probe.firmware) {
        if (directive.kind === 'replicate') {
          expect(typeof directive.threshold).toBe('bigint');
        }
      }
    }
  });

  it('produces deterministic bytes for identical input', () => {
    const a = snapshot(createInitialState(Seed(1n)));
    const b = snapshot(createInitialState(Seed(1n)));
    expect(serializeSnapshot(a)).toEqual(serializeSnapshot(b));
  });
});

import { describe, expect, it } from 'vitest';
import { createInitialState, restore, snapshot } from '../sim/state.js';
import { tickN } from '../sim/step.js';
import { LineageId, Seed, SimTick } from '../sim/types.js';
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

  it('round-trips lineage extinctionTick (alive=null, extinct=tick)', () => {
    const state = createInitialState(Seed(42n));
    // Manually mark a lineage extinct so we don't have to wait for the
    // sim to age one out. The serialization path treats the field
    // generically; we're testing that the codec doesn't drop it.
    const founder = state.lineages.get(LineageId('L0'));
    if (founder === undefined) throw new Error('unreachable: L0 missing');
    founder.extinctionTick = SimTick(123n);

    const snap = snapshot(state);
    const back = restore(deserializeSnapshot(serializeSnapshot(snap)));
    const restoredFounder = back.lineages.get(LineageId('L0'));
    expect(restoredFounder).toBeDefined();
    expect(restoredFounder!.extinctionTick).toBe(123n);
  });

  it('restore normalises a missing extinctionTick on legacy snapshots to null', () => {
    // Simulate an on-disk snapshot from before the field existed: build
    // the JSON with the lineage record stripped of extinctionTick.
    const state = createInitialState(Seed(42n));
    const snap = snapshot(state);
    // Strip the field from the serialized form (the on-disk shape is
    // JSON; the bigint replacer doesn't run on absent fields).
    const json = JSON.parse(new TextDecoder().decode(serializeSnapshot(snap))) as {
      lineages: { extinctionTick?: unknown }[];
    };
    for (const l of json.lineages) {
      delete l.extinctionTick;
    }
    const stripped = new TextEncoder().encode(JSON.stringify(json));
    const back = restore(deserializeSnapshot(stripped));
    for (const lineage of back.lineages.values()) {
      expect(lineage.extinctionTick).toBeNull();
    }
  });
});

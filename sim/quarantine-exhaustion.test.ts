import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../protocol/types.js';
import { deserializeSnapshot, serializeSnapshot } from '../host/snapshot-codec.js';
import { createInitialState, restore, snapshot, type SimState } from './state.js';
import { tick, tickN } from './step.js';
import { LineageId, ProbeId, Seed, SimTick } from './types.js';

describe('quarantine maintenance exhaustion', () => {
  it('funds oldest holds first, releases the rest in insertion order, and consumes no RNG', () => {
    const state = createInitialState(Seed(42n));
    state.probes.clear();
    state.originCompute = 2n;
    const ids = ['L9', 'L2', 'L7', 'L1'].map(LineageId);
    state.quarantinedLineages = new Set(ids);
    const rngBefore = state.rng.state();
    const events: SimEvent[] = [];
    tick(state, events);
    expect([...state.quarantinedLineages]).toEqual(ids.slice(0, 2));
    expect(state.originCompute).toBe(1n);
    expect(events).toEqual(
      ids.slice(2).map((lineageId) => ({
        kind: 'quarantineLifted',
        simTick: 1n,
        lineageId,
        reason: 'computeExhausted',
      })),
    );
    expect(state.rng.state()).toEqual(rngBefore);
    tick(state, events);
    expect([...state.quarantinedLineages]).toEqual([LineageId('L9')]);
    tickN(state, 10n, events);
    expect(events.filter((event) => event.kind === 'quarantineLifted')).toHaveLength(3);
  });

  it('releases before directives and cannot use regeneration to fund an empty budget', () => {
    const state = createInitialState(Seed(42n));
    const baseline = restore(snapshot(state));
    state.originCompute = 0n;
    state.quarantinedLineages.add(LineageId('L0'));
    const events: SimEvent[] = [];
    const baselineEvents: SimEvent[] = [];
    tick(state, events);
    tick(baseline, baselineEvents);
    expect(state.originCompute).toBe(1n);
    expect(state.quarantinedLineages.size).toBe(0);
    expect(events[0]).toMatchObject({ kind: 'quarantineLifted', lineageId: 'L0' });
    expect(events.slice(1)).toEqual(baselineEvents);
    expect(baselineEvents.some((event) => event.kind === 'replication')).toBe(true);
    expect(state.rng.state()).toEqual(baseline.rng.state());
  });

  it('preserves reimposition priority and event parity through encoded snapshot restore', () => {
    const state = createInitialState(Seed(42n));
    state.originCompute = 2n;
    for (const id of ['L0', 'L9', 'L2']) state.quarantinedLineages.add(LineageId(id));
    state.quarantinedLineages.delete(LineageId('L0'));
    state.quarantinedLineages.add(LineageId('L0'));
    const loaded = restore(deserializeSnapshot(serializeSnapshot(snapshot(state))));
    const events: SimEvent[] = [];
    const restoredEvents: SimEvent[] = [];
    tickN(state, 5n, events);
    tickN(loaded, 5n, restoredEvents);
    expect(
      events.filter((event) => event.kind === 'quarantineLifted').map((event) => event.lineageId),
    ).toEqual(['L0', 'L2']);
    expect(restoredEvents).toEqual(events);
    expect(snapshot(loaded)).toEqual(snapshot(state));
  });

  function doomedHoldState(): { state: SimState; doomed: LineageId; living: LineageId } {
    const state = createInitialState(Seed(42n));
    const doomed = LineageId('L1');
    const living = LineageId('L0');
    const founder = state.lineages.get(living)!;
    state.lineages.set(doomed, {
      ...founder,
      id: doomed,
      founderProbeId: ProbeId('P1'),
      parentLineageId: living,
    });
    // Energy 1 drains to 0 in phase 1; no gather directive refills it.
    state.probes.set(ProbeId('P1'), {
      id: ProbeId('P1'),
      lineageId: doomed,
      bornAtTick: SimTick(0n),
      firmware: [{ kind: 'replicate', threshold: 1000n }],
      position: { x: 0, y: 0 },
      energy: 1n,
    });
    state.nextProbeOrdinal = 2n;
    state.nextLineageOrdinal = 2n;
    // The doomed hold is older, so it would be funded first.
    state.quarantinedLineages = new Set([doomed, living]);
    return { state, doomed, living };
  }

  it('releases a hold when its lineage goes extinct so living holds keep priority', () => {
    const { state, doomed, living } = doomedHoldState();
    const events: SimEvent[] = [];
    tick(state, events);
    const extinction = events.findIndex((e) => e.kind === 'extinction' && e.lineageId === doomed);
    expect(extinction).toBeGreaterThanOrEqual(0);
    expect(events[extinction + 1]).toEqual({
      kind: 'quarantineLifted',
      simTick: 1n,
      lineageId: doomed,
    });
    expect([...state.quarantinedLineages]).toEqual([living]);

    // One unit funds exactly one hold: it must go to the living lineage.
    state.originCompute = 1n;
    events.length = 0;
    tick(state, events);
    expect([...state.quarantinedLineages]).toEqual([living]);
    expect(events.some((e) => e.kind === 'quarantineLifted')).toBe(false);
    expect(state.originCompute).toBe(1n);
  });

  it('releases a hold at extinction even without an event sink', () => {
    const { state, doomed, living } = doomedHoldState();
    tick(state);
    expect(state.lineages.get(doomed)?.extinctionTick).toBe(1n);
    expect([...state.quarantinedLineages]).toEqual([living]);
  });
});

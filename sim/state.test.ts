import { describe, expect, it } from 'vitest';
import { createInitialState, restore, snapshot } from './state.js';
import { tick, tickN } from './step.js';
import { LATTICE_CENTRE } from './substrate.js';
import { ProbeId, Seed, SimTick } from './types.js';

describe('createInitialState', () => {
  it('produces a swarm of one founder probe at tick 0', () => {
    const state = createInitialState(Seed(42n));
    expect(state.simTick).toBe(SimTick(0n));
    expect(state.probes.size).toBe(1);
    const founder = state.probes.get(ProbeId('P0'));
    expect(founder).toBeDefined();
    expect(founder?.bornAtTick).toBe(SimTick(0n));
  });

  it('spawns the founder at the lattice centre', () => {
    const state = createInitialState(Seed(42n));
    const founder = state.probes.get(ProbeId('P0'));
    expect(founder?.position).toEqual(LATTICE_CENTRE);
  });

  it('spawns children at their parent cell', () => {
    // Run long enough for at least one replication so we can confirm
    // children inherit position. Replication probability is small, so
    // give it enough ticks.
    const state = createInitialState(Seed(42n));
    tickN(state, 2000n);
    expect(state.probes.size).toBeGreaterThan(1);
    for (const probe of state.probes.values()) {
      expect(probe.position).toEqual(LATTICE_CENTRE);
    }
  });

  it('is deterministic across constructions with the same seed', () => {
    const a = snapshot(createInitialState(Seed(7n)));
    const b = snapshot(createInitialState(Seed(7n)));
    expect(a).toEqual(b);
  });
});

describe('tick / tickN', () => {
  it('advances simTick by one', () => {
    const state = createInitialState(Seed(1n));
    tick(state);
    expect(state.simTick).toBe(SimTick(1n));
  });

  it('advances simTick by n', () => {
    const state = createInitialState(Seed(1n));
    tickN(state, 100n);
    expect(state.simTick).toBe(SimTick(100n));
  });

  it('is deterministic: two runs from the same seed yield identical snapshots', () => {
    const a = createInitialState(Seed(99n));
    const b = createInitialState(Seed(99n));
    tickN(a, 1000n);
    tickN(b, 1000n);
    expect(snapshot(a)).toEqual(snapshot(b));
  });
});

describe('snapshot / restore', () => {
  it('round-trips through snapshot and restore', () => {
    const state = createInitialState(Seed(555n));
    tickN(state, 17n);
    const snap = snapshot(state);

    const restored = restore(snap);
    expect(snapshot(restored)).toEqual(snap);
  });

  it('produces identical post-restore behaviour', () => {
    const a = createInitialState(Seed(2024n));
    tickN(a, 50n);
    const snap = snapshot(a);

    const b = restore(snap);
    tickN(a, 25n);
    tickN(b, 25n);
    expect(snapshot(a)).toEqual(snapshot(b));
  });
});

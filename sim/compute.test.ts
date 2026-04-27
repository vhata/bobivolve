import { describe, expect, it } from 'vitest';
import {
  ORIGIN_COMPUTE_MAX,
  ORIGIN_COMPUTE_REGEN_PER_TICK,
  QUARANTINE_MAINTENANCE_PER_TICK,
  applyComputeTick,
} from './compute.js';
import { createInitialState } from './state.js';
import { tickN } from './step.js';
import { LineageId, Seed } from './types.js';

// Origin compute mechanic. The budget regenerates per tick toward
// ORIGIN_COMPUTE_MAX; held quarantines drain it. Pure integer
// arithmetic; no PRNG draws — every test below is deterministic.

describe('applyComputeTick', () => {
  it('regenerates by ORIGIN_COMPUTE_REGEN_PER_TICK when no holds and below cap', () => {
    expect(applyComputeTick(0n, 0)).toBe(ORIGIN_COMPUTE_REGEN_PER_TICK);
    expect(applyComputeTick(500n, 0)).toBe(500n + ORIGIN_COMPUTE_REGEN_PER_TICK);
  });

  it('clamps regen at ORIGIN_COMPUTE_MAX', () => {
    expect(applyComputeTick(ORIGIN_COMPUTE_MAX, 0)).toBe(ORIGIN_COMPUTE_MAX);
    expect(applyComputeTick(ORIGIN_COMPUTE_MAX - 1n, 0)).toBe(ORIGIN_COMPUTE_MAX);
  });

  it('a single hold cancels regen exactly when both are 1/tick', () => {
    // The default tunables have regen and per-hold maintenance at 1
    // each, so one hold is a steady-state wash. If they are ever
    // tuned apart this assertion will need updating — but the
    // relationship between the two constants is the design intent.
    expect(QUARANTINE_MAINTENANCE_PER_TICK).toBe(ORIGIN_COMPUTE_REGEN_PER_TICK);
    expect(applyComputeTick(500n, 1)).toBe(500n);
  });

  it('multiple holds bleed the budget by holds × maintenance − regen per tick', () => {
    // Two holds: drain 2, regen 1, net −1.
    expect(applyComputeTick(500n, 2)).toBe(499n);
    // Three holds: drain 3, regen 1, net −2.
    expect(applyComputeTick(500n, 3)).toBe(498n);
  });

  it('clamps at zero when maintenance overdrafts', () => {
    // No regen at 1 unit; drain of 5 from a budget of 0 should not
    // produce a negative number. After regen, the budget is 1.
    expect(applyComputeTick(0n, 5)).toBe(ORIGIN_COMPUTE_REGEN_PER_TICK);
    // A near-empty budget drained then regen'd settles at regen.
    expect(applyComputeTick(2n, 5)).toBe(ORIGIN_COMPUTE_REGEN_PER_TICK);
  });
});

describe('compute integration with tick', () => {
  it('budget stays at cap when no quarantine is held', () => {
    const state = createInitialState(Seed(42n));
    expect(state.originCompute).toBe(ORIGIN_COMPUTE_MAX);
    tickN(state, 100n);
    expect(state.originCompute).toBe(ORIGIN_COMPUTE_MAX);
  });

  it('budget decays when quarantines are held faster than regen', () => {
    // Two holds: drain 2/tick, regen 1/tick, net −1/tick.
    const state = createInitialState(Seed(42n));
    state.quarantinedLineages.add(LineageId('L0'));
    state.quarantinedLineages.add(LineageId('L-fake'));
    const before = state.originCompute;
    tickN(state, 50n);
    expect(state.originCompute).toBe(before - 50n);
  });

  it('budget recovers after holds are released', () => {
    const state = createInitialState(Seed(42n));
    state.quarantinedLineages.add(LineageId('L0'));
    state.quarantinedLineages.add(LineageId('L-fake'));
    tickN(state, 100n);
    const dipped = state.originCompute;
    expect(dipped).toBeLessThan(ORIGIN_COMPUTE_MAX);

    state.quarantinedLineages.clear();
    tickN(state, 200n);
    expect(state.originCompute).toBe(ORIGIN_COMPUTE_MAX);
  });
});

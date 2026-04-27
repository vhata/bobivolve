import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../protocol/types.js';
import type { DirectiveStack } from './directive.js';
import { BASAL_DRAIN_PER_TICK } from './energy.js';
import { createInitialState, snapshot } from './state.js';
import { tick, tickN } from './step.js';
import { ProbeId, Seed, SimTick } from './types.js';

// Replication tests. R1 mechanic: a probe replicates when its energy
// reaches the directive threshold; the cost (REPLICATION_COST_ENERGY)
// is deducted from the parent on each child. Children may inherit
// drifted firmware (sim/mutation.ts). Lineages are clustered by
// sim/lineage.ts.
//
// The golden population numbers below are the byte-for-byte determinism
// contract: the TypeScript implementation defines them, and any future
// implementation (the Rust port) must reproduce them. A drift here is the
// signal that determinism just regressed.

// Test fixture: gather + replicate, no explore. Keeps probes alive
// (gather sustains the basal drain) and sends them all into the centre
// cell where iteration order produces predictable selection pressure.
// Skipping explore makes the PRNG sequence simpler than the production
// founder firmware uses.
const TEST_FIRMWARE: DirectiveStack = [
  { kind: 'gather', rate: 2n },
  { kind: 'replicate', threshold: 1000n },
];
const TEST_TICKS = 3000n;
// Gather rate matched to TEST_FIRMWARE above. Used by the metabolism
// test to predict the energy delta from one tick of gather - drain.
const TEST_GATHER_RATE = 2n;

describe('replication', () => {
  it('founder probe begins with the firmware passed at construction', () => {
    const state = createInitialState(Seed(0n), TEST_FIRMWARE);
    const founder = state.probes.get(ProbeId('P0'));
    expect(founder?.firmware).toEqual(TEST_FIRMWARE);
  });

  it('every probe belongs to a registered lineage; firmware kinds stay in the founder set', () => {
    // With lineage clustering, descendants may speciate into new
    // lineages when their firmware drifts past the divergence
    // threshold. Structural mutations (priority swap, loss, gain) can
    // also reorder, shorten, or grow firmware, so we no longer assert
    // an exact directive list — only that lineageId is registered and
    // that no foreign directive kind appears in any probe.
    const state = createInitialState(Seed(42n), TEST_FIRMWARE);
    tickN(state, TEST_TICKS);
    expect(state.probes.size).toBeGreaterThan(1);
    const founderKinds = new Set(TEST_FIRMWARE.map((d) => d.kind));
    for (const probe of state.probes.values()) {
      expect(state.lineages.has(probe.lineageId)).toBe(true);
      for (const directive of probe.firmware) {
        expect(founderKinds.has(directive.kind)).toBe(true);
      }
    }
  });

  it('parameter drift produces firmware variation across the population', () => {
    // Long enough for drift to be statistically inevitable at the seeded
    // rates. The exact distribution is locked by the determinism contract
    // — we don't assert what the variation looks like, only that it exists.
    // The replicate threshold is the larger parameter in TEST_FIRMWARE;
    // gather rate is small (2), so its DRIFT_DIVISOR-bounded drift is
    // zero — we'd never observe variation there. Threshold drifts by
    // up to ±threshold/64 per event, so 6000 ticks reliably produces
    // some.
    const state = createInitialState(Seed(42n), TEST_FIRMWARE);
    tickN(state, 6000n);
    const thresholds = new Set(
      [...state.probes.values()].map((p) => {
        for (const d of p.firmware) {
          if (d.kind === 'replicate') return d.threshold;
        }
        return null;
      }),
    );
    expect(thresholds.size).toBeGreaterThan(1);
  });

  it('children have unique IDs minted from the ordinal counter', () => {
    const state = createInitialState(Seed(42n), TEST_FIRMWARE);
    tickN(state, TEST_TICKS);
    const ids = [...state.probes.keys()];
    expect(new Set(ids).size).toBe(ids.length);
    // The ordinal counter advances on every birth and never goes back,
    // so it tracks total-ever-spawned even after deaths.
    expect(state.nextProbeOrdinal).toBe(GOLDEN_TOTAL_SPAWNED_SEED_42);
  });

  it('children record their birth tick within the run window', () => {
    const state = createInitialState(Seed(42n), TEST_FIRMWARE);
    tickN(state, TEST_TICKS);
    for (const probe of state.probes.values()) {
      expect(probe.bornAtTick >= SimTick(0n)).toBe(true);
      expect(probe.bornAtTick <= state.simTick).toBe(true);
    }
  });

  it('produces the golden population after TEST_TICKS (seed=42, test firmware)', () => {
    const state = createInitialState(Seed(42n), TEST_FIRMWARE);
    tickN(state, TEST_TICKS);
    expect(state.simTick).toBe(SimTick(TEST_TICKS));
    // Locked golden — see header comment.
    expect(state.probes.size).toBe(GOLDEN_POP_SEED_42_TEST);
  });

  it('two runs with the same seed land on identical snapshots', () => {
    const a = createInitialState(Seed(2026n), TEST_FIRMWARE);
    const b = createInitialState(Seed(2026n), TEST_FIRMWARE);
    tickN(a, TEST_TICKS);
    tickN(b, TEST_TICKS);
    expect(snapshot(a)).toEqual(snapshot(b));
  });

  it('different seeds diverge', () => {
    const a = createInitialState(Seed(1n), TEST_FIRMWARE);
    const b = createInitialState(Seed(2n), TEST_FIRMWARE);
    tickN(a, TEST_TICKS);
    tickN(b, TEST_TICKS);
    expect(snapshot(a)).not.toEqual(snapshot(b));
  });

  it('children born this tick do not replicate this tick', () => {
    // Drive past the first replication. The contract: a probe born at tick T
    // does not have its firmware run until tick T+1. We verify by checking
    // that any probe born at the current tick has not itself spawned.
    const state = createInitialState(Seed(42n), TEST_FIRMWARE);
    let crossed = false;
    for (let t = 0; t < 5000; t++) {
      const sizeBefore = state.probes.size;
      tick(state);
      if (state.probes.size > sizeBefore) {
        // A new birth happened this tick. The newcomer's id ordinal must be
        // adjacent — i.e. no grandchild was minted in the same tick.
        const sizeAfter = state.probes.size;
        const newborns = sizeAfter - sizeBefore;
        // Each existing probe rolls once. Newborns this tick do not roll.
        // Lower bound: newborns <= sizeBefore.
        expect(newborns).toBeLessThanOrEqual(sizeBefore);
        crossed = true;
        break;
      }
    }
    expect(crossed).toBe(true);
  });
});

// Golden live population for seed=42 with TEST_FIRMWARE after TEST_TICKS.
// Locked at the R1 metabolic mechanic on the procedural-systems
// substrate; the value reflects extant probes, not total ever spawned.
// Any change here is a determinism regression and should be
// investigated, not "fixed" by updating the number.
const GOLDEN_POP_SEED_42_TEST = 52;
// Total probes ever spawned in the same run (used by tests that assert
// against the ordinal counter, which never decreases).
const GOLDEN_TOTAL_SPAWNED_SEED_42 = 351n;

describe('metabolism', () => {
  it('a probe in a full cell nets gather rate − basal drain per tick', () => {
    // Pin founderEnergy below the directive threshold so the founder
    // cannot replicate during the window — that way the energy delta
    // measures metabolism alone, not metabolism net of replication
    // costs. TEST_FIRMWARE has no explore directive, so the probe
    // stays in its starting cell and gathers from full resources for
    // the entire window.
    const state = createInitialState(Seed(42n), {
      founderFirmware: TEST_FIRMWARE,
      founderEnergy: 100n,
    });
    const startEnergy = state.probes.get(ProbeId('P0'))?.energy ?? 0n;
    tickN(state, 100n);
    const expectedDelta = (TEST_GATHER_RATE - BASAL_DRAIN_PER_TICK) * 100n;
    expect(state.probes.get(ProbeId('P0'))?.energy).toBe(startEnergy + expectedDelta);
  });

  it('emits DeathEvent and removes the probe when energy is exhausted', () => {
    // Force the death path: pin the founder's energy to zero with a
    // firmware that has no gather. The system centre regens whether
    // we like it or not (the founder spawns there), but without
    // gather the founder cannot absorb the resources, so basal drain
    // takes energy negative and phase-3 death fires.
    const state = createInitialState(Seed(42n), {
      founderFirmware: [{ kind: 'replicate', threshold: 100_000n }],
    });
    const founder = state.probes.get(ProbeId('P0'));
    if (founder === undefined) throw new Error('founder missing');
    founder.energy = 0n;
    const events: SimEvent[] = [];
    tick(state, events);
    expect(state.probes.has(ProbeId('P0'))).toBe(false);
    const death = events.find((e) => e.kind === 'death');
    expect(death).toBeDefined();
    if (death?.kind === 'death') {
      expect(death.probeId).toBe('P0');
      expect(death.lineageId).toBe('L0');
    }
  });

  it('metabolism + replication is deterministic across runs from the same seed', () => {
    const events1: SimEvent[] = [];
    const events2: SimEvent[] = [];
    const a = createInitialState(Seed(99n));
    const b = createInitialState(Seed(99n));
    tickN(a, 500n, events1);
    tickN(b, 500n, events2);
    expect(events1).toEqual(events2);
    expect(snapshot(a)).toEqual(snapshot(b));
  });
});

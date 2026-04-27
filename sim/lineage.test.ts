import { describe, expect, it } from 'vitest';
import type { DirectiveStack } from './directive.js';
import { SPECIATION_DIVERGENCE_DIVISOR, firmwareDiverged, type Lineage } from './lineage.js';
import { createInitialState, snapshot } from './state.js';
import { tickN } from './step.js';
import { LineageId, ProbeId, Seed } from './types.js';

describe('firmwareDiverged', () => {
  const ref: DirectiveStack = [{ kind: 'replicate', threshold: 100_000n }];

  it('returns false for identical firmware', () => {
    expect(firmwareDiverged(ref, ref)).toBe(false);
  });

  it('returns false for parameters within tolerance', () => {
    // Drift well below threshold/DIVISOR.
    const child: DirectiveStack = [{ kind: 'replicate', threshold: 100_001n }];
    expect(firmwareDiverged(child, ref)).toBe(false);
  });

  it('returns true when drift exceeds reference / DIVISOR', () => {
    const refValue = 100_000n;
    const breach = refValue + refValue / SPECIATION_DIVERGENCE_DIVISOR + 1n;
    const child: DirectiveStack = [{ kind: 'replicate', threshold: breach }];
    expect(firmwareDiverged(child, ref)).toBe(true);
  });

  it('returns true when stacks differ in length', () => {
    const longer: DirectiveStack = [
      { kind: 'replicate', threshold: 100_000n },
      { kind: 'replicate', threshold: 100_000n },
    ];
    expect(firmwareDiverged(longer, ref)).toBe(true);
  });
});

describe('lineage clustering', () => {
  const TEST_FIRMWARE: DirectiveStack = [{ kind: 'replicate', threshold: 1000n }];

  it('seeds L0 as the founding lineage with the founder firmware as reference', () => {
    const state = createInitialState(Seed(7n), TEST_FIRMWARE);
    expect(state.lineages.size).toBe(1);
    const l0 = state.lineages.get(LineageId('L0'));
    expect(l0).toBeDefined();
    expect(l0?.founderProbeId).toBe(ProbeId('P0'));
    expect(l0?.parentLineageId).toBeNull();
    expect(l0?.referenceFirmware).toEqual(TEST_FIRMWARE);
  });

  it('every registered lineage has a sane referenceFirmware', () => {
    // Under R1, founder probes can die — so the previous assertion
    // (that every lineage's founderProbeId still resolves in
    // state.probes) is no longer a valid invariant. The lineage
    // record itself must stay consistent: founderProbeId is non-empty
    // and referenceFirmware is non-degenerate.
    const state = createInitialState(Seed(7n), TEST_FIRMWARE);
    tickN(state, 6000n);
    for (const lineage of state.lineages.values()) {
      expect(lineage.founderProbeId.length).toBeGreaterThan(0);
      expect(lineage.referenceFirmware.length).toBeGreaterThan(0);
    }
  });

  it('produces multiple lineages over enough generations', () => {
    // Production firmware (gather + explore + replicate) — explore
    // spreads probes across the lattice, multiplying the per-cell
    // carrying capacity into a much larger total replication budget,
    // so a few thousand ticks are enough to see speciation reliably.
    const state = createInitialState(Seed(42n));
    tickN(state, 8000n);
    expect(state.lineages.size).toBeGreaterThan(1);
  });

  it('every speciation produces a lineage whose parent is registered', () => {
    const state = createInitialState(Seed(42n), TEST_FIRMWARE);
    tickN(state, 8000n);
    for (const lineage of state.lineages.values()) {
      if (lineage.parentLineageId === null) continue;
      expect(state.lineages.has(lineage.parentLineageId)).toBe(true);
    }
  });

  it('each lineage references its founder probe by id (when still alive)', () => {
    const state = createInitialState(Seed(42n), TEST_FIRMWARE);
    tickN(state, 8000n);
    for (const lineage of state.lineages.values()) {
      const founder = state.probes.get(lineage.founderProbeId);
      // Founders can die under R1 — skip dead ones. For the survivors,
      // the Probe object's lineageId and firmware must match the
      // lineage's record.
      if (founder === undefined) continue;
      expect(founder.lineageId).toBe(lineage.id);
      expect(founder.firmware).toEqual(lineage.referenceFirmware);
    }
  });

  it('lineages survive a snapshot/restore round-trip', () => {
    const state = createInitialState(Seed(42n), TEST_FIRMWARE);
    tickN(state, 5000n);
    const before = snapshot(state);

    expect(before.lineages.length).toBe(state.lineages.size);
    expect(before.lineages.length).toBeGreaterThan(0);

    // Round-trip through snapshot to confirm the lineages map serialises.
    const restoredFromSnapshot = JSON.parse(
      JSON.stringify(before, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)),
    );
    expect(restoredFromSnapshot.lineages.length).toBe(before.lineages.length);
  });

  it('two runs from the same seed produce identical lineage trees', () => {
    const a = createInitialState(Seed(42n), TEST_FIRMWARE);
    const b = createInitialState(Seed(42n), TEST_FIRMWARE);
    tickN(a, 6000n);
    tickN(b, 6000n);
    expect(snapshot(a).lineages).toEqual<readonly Lineage[]>(snapshot(b).lineages);
  });
});

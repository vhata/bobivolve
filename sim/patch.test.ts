import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../protocol/types.js';
import type { DirectiveStack } from './directive.js';
import { applyPatch, checkPatchSaturation, validatePatchFirmware } from './patch.js';
import { createInitialState } from './state.js';
import { tickN } from './step.js';
import { LineageId, ProbeId, Seed } from './types.js';

// Player intervention: patches replace a lineage's reference firmware
// and overwrite every extant probe in the lineage. Subsequent
// replications drift from the patched value. Pure integer arithmetic;
// no PRNG draws. The mutation tests live in sim/mutation.test.ts and
// continue to assert that the patched firmware drifts forward as
// normal — this file focuses on the application step.

const FIRMWARE_GATHER_REPLICATE: DirectiveStack = [
  { kind: 'gather', rate: 2n },
  { kind: 'replicate', threshold: 1000n },
];

describe('validatePatchFirmware', () => {
  it('rejects empty firmware', () => {
    expect(validatePatchFirmware([])).not.toBeNull();
  });

  it('accepts a multi-directive stack', () => {
    expect(validatePatchFirmware(FIRMWARE_GATHER_REPLICATE)).toBeNull();
  });
});

describe('applyPatch', () => {
  it('overwrites the lineage reference firmware', () => {
    const state = createInitialState(Seed(42n), FIRMWARE_GATHER_REPLICATE);
    const newFirmware: DirectiveStack = [
      { kind: 'gather', rate: 5n },
      { kind: 'replicate', threshold: 800n },
    ];
    const result = applyPatch(state, LineageId('L0'), newFirmware);
    expect(result.changed).toBe(true);
    expect(result.previousFirmware).toEqual(FIRMWARE_GATHER_REPLICATE);
    expect(state.lineages.get(LineageId('L0'))?.referenceFirmware).toEqual(newFirmware);
  });

  it('overwrites every extant probe in the lineage', () => {
    const state = createInitialState(Seed(42n), FIRMWARE_GATHER_REPLICATE);
    // Spin up a small population so there are several probes carrying L0
    // firmware at patch-time.
    tickN(state, 1500n);
    const l0Before = [...state.probes.values()].filter((p) => p.lineageId === LineageId('L0'));
    expect(l0Before.length).toBeGreaterThan(1);

    const newFirmware: DirectiveStack = [
      { kind: 'gather', rate: 9n },
      { kind: 'replicate', threshold: 500n },
    ];
    const result = applyPatch(state, LineageId('L0'), newFirmware);
    expect(result.probesAffected).toBe(l0Before.length);

    for (const probe of state.probes.values()) {
      if (probe.lineageId === LineageId('L0')) {
        expect(probe.firmware).toEqual(newFirmware);
      }
    }
  });

  it('reports changed=false when patching to the same firmware', () => {
    const state = createInitialState(Seed(42n), FIRMWARE_GATHER_REPLICATE);
    const result = applyPatch(state, LineageId('L0'), FIRMWARE_GATHER_REPLICATE);
    expect(result.changed).toBe(false);
  });

  it('throws on an unknown lineage', () => {
    const state = createInitialState(Seed(42n), FIRMWARE_GATHER_REPLICATE);
    expect(() => applyPatch(state, LineageId('L999'), FIRMWARE_GATHER_REPLICATE)).toThrow();
  });

  it('does not affect probes in other lineages', () => {
    // Bootstrap until at least one speciation has happened so a non-L0
    // lineage exists. Use a wider window so seed=42 reliably speciates;
    // if the seed ever changes its speciation timing this test will need
    // a different seed.
    const state = createInitialState(Seed(42n));
    tickN(state, 4000n);
    const lineageIds = [...state.lineages.keys()];
    expect(lineageIds.length).toBeGreaterThan(1);

    // Snapshot every non-L0 probe's firmware before the patch.
    const before = new Map<ProbeId, DirectiveStack>();
    for (const probe of state.probes.values()) {
      if (probe.lineageId !== LineageId('L0')) before.set(probe.id, probe.firmware);
    }

    const newFirmware: DirectiveStack = [
      { kind: 'gather', rate: 9n },
      { kind: 'explore', threshold: 1n << 50n },
      { kind: 'replicate', threshold: 200n },
    ];
    applyPatch(state, LineageId('L0'), newFirmware);

    for (const probe of state.probes.values()) {
      if (probe.lineageId === LineageId('L0')) continue;
      expect(probe.firmware).toEqual(before.get(probe.id));
    }
  });

  it('appends the patch id to the lineage patches list', () => {
    const state = createInitialState(Seed(42n), FIRMWARE_GATHER_REPLICATE);
    const r1 = applyPatch(state, LineageId('L0'), FIRMWARE_GATHER_REPLICATE);
    expect(state.lineages.get(LineageId('L0'))?.patches).toEqual([r1.patchId]);

    const r2 = applyPatch(state, LineageId('L0'), [
      { kind: 'gather', rate: 7n },
      { kind: 'replicate', threshold: 600n },
    ]);
    expect(state.lineages.get(LineageId('L0'))?.patches).toEqual([r1.patchId, r2.patchId]);
  });
});

describe('checkPatchSaturation', () => {
  it('fires once when the carrier population exceeds 50%', () => {
    // L0 is the only lineage; applying any patch makes 100% of the
    // population a carrier, so saturation fires the next time we check.
    const state = createInitialState(Seed(42n), FIRMWARE_GATHER_REPLICATE);
    const r = applyPatch(state, LineageId('L0'), FIRMWARE_GATHER_REPLICATE);
    const firings = checkPatchSaturation(state);
    expect(firings).toHaveLength(1);
    expect(firings[0]?.patchId).toBe(r.patchId);
    expect(firings[0]?.totalPopulation).toBe(1n);
    expect(firings[0]?.carrierPopulation).toBe(1n);

    // A second check returns nothing — the patch was marked saturated.
    expect(checkPatchSaturation(state)).toHaveLength(0);
  });

  it('emits PatchSaturated through the tick path', () => {
    const state = createInitialState(Seed(42n), FIRMWARE_GATHER_REPLICATE);
    applyPatch(state, LineageId('L0'), FIRMWARE_GATHER_REPLICATE);
    const events: SimEvent[] = [];
    tickN(state, 1n, events);
    const saturated = events.filter((e) => e.kind === 'patchSaturated');
    expect(saturated).toHaveLength(1);
  });
});

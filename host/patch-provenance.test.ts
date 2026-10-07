import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FOUNDER_FIRMWARE, type DirectiveStack } from '../sim/directive.js';
import { firmwareDiverged } from '../sim/lineage.js';
import { applyPatch, checkPatchSaturation } from '../sim/patch.js';
import { createInitialState, restore, snapshot } from '../sim/state.js';
import { tickN } from '../sim/step.js';
import { LineageId, ProbeId, Seed, SimTick } from '../sim/types.js';
import { decodeQueryResult, encodeLine } from '../transport/ndjson-codec.js';
import { NodeHost } from './node.js';
import { firmwareMatches, patchProvenance } from './patch-provenance.js';
import { deserializeSnapshot, serializeSnapshot } from './snapshot-codec.js';
import { NodeStorage } from './storage-node.js';

const authored: DirectiveStack = [
  { kind: 'gather', rate: 2n },
  { kind: 'replicate', threshold: 1000n },
];

describe('patch provenance', () => {
  it('distinguishes exact identity from small drift, order, duplicates and lengths', () => {
    const drifted: DirectiveStack = [
      { kind: 'gather', rate: 2n },
      { kind: 'replicate', threshold: 1001n },
    ];
    expect(firmwareDiverged(authored, drifted)).toBe(false);
    expect(firmwareMatches(authored, drifted)).toBe(false);
    expect(firmwareMatches(authored, [...authored].reverse())).toBe(false);
    expect(firmwareMatches(authored, [...authored, authored[0]!])).toBe(false);
    expect(firmwareMatches([authored[0]!, authored[0]!], authored)).toBe(false);
    expect(
      firmwareMatches(
        authored,
        authored.map((d) => ({ ...d })),
      ),
    ).toBe(true);
  });

  it('counts ancestry separately after drift, replacement, pre-existing descendants and extinction', () => {
    const state = createInitialState(Seed(42n));
    const founder = state.probes.get(ProbeId('P0'))!;
    const l0 = LineageId('L0');
    // This descendant already existed when the patch landed: it must not inherit it retroactively.
    state.lineages.set(LineageId('L1'), {
      ...state.lineages.get(l0)!,
      id: LineageId('L1'),
      parentLineageId: l0,
    });
    state.probes.set(ProbeId('P1'), {
      ...founder,
      id: ProbeId('P1'),
      lineageId: LineageId('L1'),
      firmware: authored,
    });
    applyPatch(state, l0, authored);
    // Speciated descendants inherit the patch ancestry, even if their firmware differs.
    state.lineages.set(LineageId('L2'), {
      ...state.lineages.get(l0)!,
      id: LineageId('L2'),
      parentLineageId: l0,
      referenceFirmware: FOUNDER_FIRMWARE,
    });
    state.probes.set(ProbeId('P2'), {
      ...founder,
      id: ProbeId('P2'),
      lineageId: LineageId('L2'),
      firmware: FOUNDER_FIRMWARE,
    });
    state.probes.set(ProbeId('P3'), {
      ...founder,
      id: ProbeId('P3'),
      firmware: [
        { kind: 'gather', rate: 2n },
        { kind: 'replicate', threshold: 1001n },
      ],
    });
    expect(patchProvenance(state, state.lineages.get(l0)!)[0]).toMatchObject({
      ancestryPopulation: '3',
      exactMatchPopulation: '1',
      selectedExactMatchPopulation: '1',
      referenceMatches: true,
    });
    expect(checkPatchSaturation(state)[0]?.carrierPopulation).toBe(3n);
    applyPatch(state, l0, FOUNDER_FIRMWARE);
    expect(patchProvenance(state, state.lineages.get(l0)!)[0]).toMatchObject({
      ancestryPopulation: '3',
      exactMatchPopulation: '0',
      referenceMatches: false,
    });
    state.probes.delete(ProbeId('P0'));
    state.probes.delete(ProbeId('P3'));
    state.lineages.get(l0)!.extinctionTick = SimTick(1n);
    expect(patchProvenance(state, state.lineages.get(l0)!)[0]).toMatchObject({
      ancestryPopulation: '1',
      selectedExactMatchPopulation: '0',
    });
    expect(patchProvenance(state, state.lineages.get(LineageId('L2'))!)).toHaveLength(1);
    expect(patchProvenance(state, state.lineages.get(LineageId('L1'))!)).toEqual([]);
  });

  it('follows real mutations and inherited ancestry through speciation', () => {
    const state = createInitialState(Seed(42n));
    applyPatch(state, LineageId('L0'), FOUNDER_FIRMWARE);
    tickN(state, 500n);
    expect(state.lineages.size).toBeGreaterThan(1);
    const probes = [...state.probes.values()];
    const exact = probes.filter((p) => firmwareMatches(p.firmware, FOUNDER_FIRMWARE)).length;
    expect(exact).toBeLessThan(probes.length);
    for (const lineage of state.lineages.values()) {
      expect(patchProvenance(state, lineage)[0]).toMatchObject({
        ancestryPopulation: probes.length.toString(),
        exactMatchPopulation: exact.toString(),
      });
    }
  });

  it('preserves independently copied authored firmware and leaves legacy records unknown', () => {
    const state = createInitialState(Seed(42n));
    const input = [{ kind: 'gather' as const, rate: 3n }];
    applyPatch(state, LineageId('L0'), input);
    input[0]!.rate = 99n;
    expect(state.appliedPatches.get('PT0')?.authoredFirmware).toEqual([
      { kind: 'gather', rate: 3n },
    ]);
    const restored = restore(deserializeSnapshot(serializeSnapshot(snapshot(state))));
    expect(restored.appliedPatches.get('PT0')?.authoredFirmware).toEqual([
      { kind: 'gather', rate: 3n },
    ]);
    const record = restored.appliedPatches.get('PT0')!;
    restored.appliedPatches.set('PT0', {
      id: record.id,
      targetLineageId: record.targetLineageId,
      appliedAtTick: record.appliedAtTick,
      saturatedAtTick: record.saturatedAtTick,
    });
    const legacy = restore(deserializeSnapshot(serializeSnapshot(snapshot(restored))));
    expect(patchProvenance(legacy, legacy.lineages.get(LineageId('L0'))!)[0]).toMatchObject({
      ancestryPopulation: '1',
      authoredFirmware: null,
      exactMatchPopulation: null,
      selectedExactMatchPopulation: null,
      referenceMatches: null,
    });
  });

  it('round trips live telemetry via NDJSON, named save/load and log replay', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bobivolve-provenance-'));
    try {
      const storage = new NodeStorage({ root });
      const host = new NodeHost({
        heartbeatHz: 0,
        persistence: { storage, runId: 'provenance' },
      });
      host.send({ kind: 'newRun', commandId: 'new', seed: 42n });
      host.runUntil(1n);
      host.send({
        kind: 'applyPatch',
        commandId: 'patch',
        lineageId: 'L0',
        firmware: [
          { kind: 'gather', params: { rate: '4' } },
          { kind: 'replicate', params: { threshold: '1000' } },
        ],
      });
      host.runUntil(2n);
      const query = () =>
        host.executeQuery({ kind: 'driftTelemetry', queryId: 'q', lineageId: 'L0' });
      const expected = await query();
      expect(
        expected.kind === 'driftTelemetry' && expected.drift?.patchProvenance?.[0],
      ).toMatchObject({ patchId: 'PT0', appliedAtTick: '1', exactMatchPopulation: '4' });
      expect(decodeQueryResult(encodeLine(expected))).toEqual(expected);
      host.send({ kind: 'save', commandId: 'save', slot: 'patched' });
      await host.flush();
      host.runUntil(4n);
      host.send({ kind: 'rewindToTick', commandId: 'rewind', tick: 2n });
      await host.flush();
      expect(await query()).toEqual(expected);
      host.send({ kind: 'load', commandId: 'load', slot: 'patched' });
      await host.flush();
      expect(await query()).toEqual(expected);
      // Load an actual old-format named save through the host. No historical firmware inference.
      const saved = deserializeSnapshot((await storage.read('saves/patched.save'))!);
      const legacy = {
        ...saved,
        appliedPatches: saved.appliedPatches.map(
          ({ authoredFirmware: _authored, ...record }) => record,
        ),
      };
      await storage.write('saves/patched.save', serializeSnapshot(legacy));
      host.send({ kind: 'load', commandId: 'legacy', slot: 'patched' });
      await host.flush();
      const loaded = await query();
      expect(loaded.kind === 'driftTelemetry' && loaded.drift?.patchProvenance?.[0]).toMatchObject({
        patchId: 'PT0',
        authoredFirmware: null,
        exactMatchPopulation: null,
        referenceMatches: null,
      });
      expect(decodeQueryResult(encodeLine(loaded))).toEqual(loaded);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

import type { PatchProvenance } from '../protocol/types.js';
import type { DirectiveStack } from '../sim/directive.js';
import type { Lineage } from '../sim/lineage.js';
import type { SimState } from '../sim/state.js';

// Exact ordered firmware identity, not the tolerance used for speciation.
export function firmwareMatches(a: DirectiveStack, b: DirectiveStack): boolean {
  return (
    a.length === b.length &&
    a.every((directive, index) => {
      const other = b[index];
      if (other === undefined || directive.kind !== other.kind) return false;
      return directive.kind === 'gather'
        ? other.kind === 'gather' && directive.rate === other.rate
        : other.kind !== 'gather' && directive.threshold === other.threshold;
    })
  );
}

export function patchProvenance(state: SimState, selected: Lineage): PatchProvenance[] {
  if (selected.patches.length === 0) return [];
  // Index once per query rather than scan the population for every patch.
  const populations = new Map<string, Map<string, bigint>>();
  const key = (firmware: DirectiveStack): string =>
    JSON.stringify(
      firmware.map((d) => [d.kind, (d.kind === 'gather' ? d.rate : d.threshold).toString()]),
    );
  for (const probe of state.probes.values()) {
    let firmwareCounts = populations.get(probe.lineageId);
    if (firmwareCounts === undefined) {
      firmwareCounts = new Map();
      populations.set(probe.lineageId, firmwareCounts);
    }
    const firmwareKey = key(probe.firmware);
    firmwareCounts.set(firmwareKey, (firmwareCounts.get(firmwareKey) ?? 0n) + 1n);
  }
  return selected.patches.flatMap((patchId) => {
    const record = state.appliedPatches.get(patchId);
    if (record === undefined) return [];
    const authored = record.authoredFirmware;
    const authoredKey = authored === undefined ? null : key(authored);
    let ancestry = 0n;
    let exact = 0n;
    for (const lineage of state.lineages.values()) {
      if (!lineage.patches.includes(patchId)) continue;
      const counts = populations.get(lineage.id);
      if (counts === undefined) continue;
      for (const count of counts.values()) ancestry += count;
      if (authoredKey !== null) exact += counts.get(authoredKey) ?? 0n;
    }
    return [
      {
        patchId,
        targetLineageId: record.targetLineageId,
        appliedAtTick: record.appliedAtTick.toString(),
        ancestryPopulation: ancestry.toString(),
        authoredFirmware:
          authored === undefined
            ? null
            : authored.map((directive) => ({
                kind: directive.kind,
                params:
                  directive.kind === 'gather'
                    ? { rate: directive.rate.toString() }
                    : { threshold: directive.threshold.toString() },
              })),
        exactMatchPopulation: authored === undefined ? null : exact.toString(),
        selectedExactMatchPopulation:
          authoredKey === null
            ? null
            : (populations.get(selected.id)?.get(authoredKey) ?? 0n).toString(),
        referenceMatches:
          authored === undefined ? null : firmwareMatches(selected.referenceFirmware, authored),
      },
    ];
  });
}

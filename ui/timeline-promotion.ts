// Forward-looking promotion for the events timeline's speciation
// stratum. EventsTimelinePanel calls this when a speciation arrives;
// a speciation that passes is surfaced immediately, one that does not
// waits in the panel's candidate buffer for retroactive promotion.

// A speciation whose parent lineage holds at least this percentage of
// the live population is surfaced immediately (the parent is
// "important enough" that any drift from it is worth a click).
export const PROMOTE_PARENT_PERCENT = 5n;

// The slice of the store projection the forward-looking path reads.
export interface PromotionProjection {
  readonly populationTotal: bigint;
  readonly populationByLineage: ReadonlyMap<string, bigint>;
  readonly quarantinedLineages: ReadonlySet<string>;
  readonly patchedLineages: ReadonlySet<string>;
}

// True when a speciation from `parentLineageId` should be surfaced at
// emission: the parent is big, quarantined, or directly patched.
// Evaluated against the projection at arrival time only; a parent that
// later becomes big, quarantined, or patched does not promote earlier
// speciations (the retroactive path still can).
export function promotesSpeciationAtEmission(
  parentLineageId: string,
  projection: PromotionProjection,
): boolean {
  const total = projection.populationTotal;
  const parentPop = projection.populationByLineage.get(parentLineageId) ?? 0n;
  const parentIsBig = total > 0n && parentPop * 100n >= total * PROMOTE_PARENT_PERCENT;
  const parentIsQuarantined = projection.quarantinedLineages.has(parentLineageId);
  const parentIsPatched = projection.patchedLineages.has(parentLineageId);
  return parentIsBig || parentIsQuarantined || parentIsPatched;
}

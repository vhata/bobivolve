// Player-authored patches.
//
// SPEC.md "Player Intervention (R2+)": "Patches are authored in a directive
// editor and applied to a target lineage. Once applied, the patched
// directives are inherited by descendants and drift like any other firmware:
// a player intervention becomes part of the genetic record and can mutate
// forward in ways the player did not anticipate."
//
// R2 V1 surface (this module): a patch is a complete replacement of a
// lineage's firmware. Applying it overwrites the lineage's reference
// firmware AND every extant probe in the lineage. New mutations roll on
// top of the patch from that point forward; descendants speciating from
// the patched lineage carry the patched directives as their starting
// point. PatchSaturated detection and per-patch propagation tracking are
// deferred — the immediate UX gives the player a working "edit and apply"
// loop without the full bookkeeping the spec implies.
//
// Determinism: applying a patch consumes no PRNG draws and uses pure
// integer arithmetic. Two runs that share the same (seed, command-log,
// patch contents) produce byte-for-byte identical event streams.

import { firmwareDiverged } from './lineage.js';
import { MIN_FIRMWARE_LENGTH } from './mutation.js';
import type { AppliedPatchRecord, SimState } from './state.js';
import type { DirectiveStack } from './directive.js';
import { type LineageId, SimTick } from './types.js';

// Validate a candidate firmware before it lands. Mirrors the floor that
// createInitialState enforces on the founder — a sub-floor stack would
// produce probes that mutation cannot recover from.
export function validatePatchFirmware(firmware: DirectiveStack): string | null {
  if (firmware.length < MIN_FIRMWARE_LENGTH) {
    return `patched firmware must contain at least ${MIN_FIRMWARE_LENGTH.toString()} directive(s)`;
  }
  return null;
}

// Apply a patch in-place. Returns information the host needs to emit a
// PatchApplied event: the lineage's prior reference firmware (so the
// dashboard can show what changed) and the count of extant probes
// affected. Mutates state.
//
// Caller responsibilities:
//   - Validate the patch firmware (call validatePatchFirmware first).
//   - Confirm the lineage exists and the lineage is living (extant
//     probes > 0); applying to an extinct lineage is a no-op the host
//     should surface as a CommandError so the player understands why.
//   - Charge the Origin compute cost.
export interface PatchApplyResult {
  readonly previousFirmware: DirectiveStack;
  readonly probesAffected: number;
  // Stable id minted for this patch; carried on the PatchApplied event
  // and used by the dashboard for intervention history.
  readonly patchId: string;
  // True when the patched firmware differs from the lineage's current
  // reference. False is a player no-op — the host can choose to surface
  // it as a CommandError or accept it; current host behaviour treats it
  // as a successful but noteworthy ack.
  readonly changed: boolean;
}

export function applyPatch(
  state: SimState,
  lineageId: LineageId,
  newFirmware: DirectiveStack,
): PatchApplyResult {
  const lineage = state.lineages.get(lineageId);
  if (lineage === undefined) {
    throw new Error(`applyPatch: unknown lineage ${lineageId}`);
  }
  const previousFirmware = lineage.referenceFirmware;
  const changed = firmwareDiverged(newFirmware, previousFirmware);

  // Mint a stable patch id from the monotonic counter. Derived from
  // (seed, command-log) and so identical between two runs sharing the
  // same input. "P" prefix avoids collision with probe ids ("P0", "P1",
  // ...) — patches use "PT" to mean "patch".
  const patchId = `PT${state.nextPatchOrdinal.toString()}`;
  state.nextPatchOrdinal += 1n;

  // Append the patch id to the target lineage's patches list. Replace
  // the lineage record (otherwise readonly fields) with a fresh object
  // so any outstanding snapshot view stays consistent.
  state.lineages.set(lineageId, {
    ...lineage,
    referenceFirmware: newFirmware,
    patches: [...lineage.patches, patchId],
  });

  const record: AppliedPatchRecord = {
    id: patchId,
    targetLineageId: lineageId,
    appliedAtTick: state.simTick,
    saturatedAtTick: null,
  };
  state.appliedPatches.set(patchId, record);

  // Overwrite firmware on every extant probe in the lineage. SPEC: the
  // patched directives are inherited by descendants — extant probes
  // are the parents of those descendants, so they carry the patch
  // forward through normal replication.
  let probesAffected = 0;
  for (const probe of state.probes.values()) {
    if (probe.lineageId !== lineageId) continue;
    // Probe is otherwise readonly on its firmware field. Mutate via a
    // typed helper so the type system stays honest about what we are
    // doing — applying a player intervention is the legitimate
    // exception to "firmware is set at birth and drifts from there".
    (probe as { firmware: DirectiveStack }).firmware = newFirmware;
    probesAffected += 1;
  }

  return { previousFirmware, probesAffected, patchId, changed };
}

// Saturation threshold: PatchSaturated fires when a patch's carrier
// population exceeds this fraction of total population. Tunable;
// 0.5 (50%) reads cleanly as "the patch has taken over the swarm."
export const PATCH_SATURATION_PERCENT_NUMERATOR = 50n;
export const PATCH_SATURATION_PERCENT_DENOMINATOR = 100n;

export interface SaturationFiring {
  readonly patchId: string;
  readonly carrierPopulation: bigint;
  readonly totalPopulation: bigint;
}

// Check every applied-but-not-yet-saturated patch and return any that
// crossed the threshold this tick. Mutates state to mark each firing
// patch as saturated so the event does not refire. Pure integer
// arithmetic; deterministic.
//
// Cost is O(probes + patches × lineages); patches × lineages is small
// (R2 expectations: tens of patches, tens of lineages). Tighter
// indexing (per-patch carrier counts maintained incrementally) is a
// future optimisation.
export function checkPatchSaturation(state: SimState): SaturationFiring[] {
  if (state.appliedPatches.size === 0) return [];

  // Build a per-lineage population map and total in one pass.
  const populationByLineage = new Map<LineageId, bigint>();
  let total = 0n;
  for (const probe of state.probes.values()) {
    populationByLineage.set(probe.lineageId, (populationByLineage.get(probe.lineageId) ?? 0n) + 1n);
    total += 1n;
  }
  if (total === 0n) return [];

  const firings: SaturationFiring[] = [];
  for (const record of state.appliedPatches.values()) {
    if (record.saturatedAtTick !== null) continue;
    let carriers = 0n;
    for (const lineage of state.lineages.values()) {
      if (!lineage.patches.includes(record.id)) continue;
      carriers += populationByLineage.get(lineage.id) ?? 0n;
    }
    // carriers / total > num / den  ↔  carriers * den > total * num
    if (
      carriers * PATCH_SATURATION_PERCENT_DENOMINATOR >
      total * PATCH_SATURATION_PERCENT_NUMERATOR
    ) {
      state.appliedPatches.set(record.id, {
        ...record,
        saturatedAtTick: SimTick(state.simTick),
      });
      firings.push({ patchId: record.id, carrierPopulation: carriers, totalPopulation: total });
    }
  }
  return firings;
}

// Origin compute: the meta-game resource that gates every player
// intervention.
//
// SPEC.md "Player Intervention (R2+)": "The player has three intervention
// tools, all gated by the Origin compute budget." This module owns the
// tunables and the pure functions that move the budget; sim/step.ts wires
// them into the tick loop.
//
// Current intervention costs:
//
//   - Patch authoring: one-shot cost on submission. Failure surfaces as
//     CommandError when the budget is too small.
//   - Decree authoring: one-shot cost on submission. Same failure mode.
//   - Quarantine: per-tick maintenance cost while held. Multiple
//     concurrent holds stack. The drain is deducted every tick before
//     regen, clamped at zero — when the budget can't pay, the cost is
//     simply skipped that tick. Future polish may surface a "budget
//     bankrupt" signal so the player notices their holds are no longer
//     paying for themselves.
//
// Determinism: pure integer arithmetic, no PRNG draws. The state
// (budget, max) survives snapshot/restore as ordinary u64 fields.

// Cap and starting value. The player begins with a full budget so the
// first intervention does not have to wait. Tunable: bigger cap lets
// the player stockpile compute over quiet stretches and spend it in a
// burst when crisis hits; smaller cap forces them to drip-feed.
export const ORIGIN_COMPUTE_MAX = 1000n;

// Regen per tick. At 1 unit/tick a single quarantine costs almost
// exactly one regen-tick to maintain — a held quarantine cancels passive
// recovery, exactly the "meddling is sustainable but not free"
// Bobiverse cost. Tunable.
export const ORIGIN_COMPUTE_REGEN_PER_TICK = 1n;

// Per-tick maintenance cost per held quarantine. Same magnitude as
// regen so one hold is a true wash; two holds bleed at 1/tick; etc.
export const QUARANTINE_MAINTENANCE_PER_TICK = 1n;

// One-shot patch authoring cost. At one compute unit per tick this
// recovers in 100 ticks without quarantines; wall-clock time depends
// on achieved simulation speed.
export const PATCH_AUTHORING_COST = 100n;

// One-shot cost to queue a decree. Decrees are conditional patches and
// share the same authoring cost.
export const DECREE_AUTHORING_COST = 100n;

// Apply per-tick maintenance and regen, in that order. Maintenance is
// clamped at the current budget — when the player owes more than they
// have, the rest goes uncharged that tick. Regen is then applied and
// clamped at the cap. Returns the new budget; callers store it back on
// the state.
//
// Maintenance precedes regeneration. With one funded hold, its one-unit
// cost cancels the one-unit regeneration; multiple holds drain the budget.
// At exhaustion the current rule clamps the charge and regenerates one
// unit while holds remain active. Exhaustion policy remains deferred in
// TODO.md.
export function applyComputeTick(budget: bigint, heldQuarantines: number): bigint {
  const maintenance = QUARANTINE_MAINTENANCE_PER_TICK * BigInt(heldQuarantines);
  const drained = maintenance > budget ? 0n : budget - maintenance;
  const regenerated = drained + ORIGIN_COMPUTE_REGEN_PER_TICK;
  return regenerated > ORIGIN_COMPUTE_MAX ? ORIGIN_COMPUTE_MAX : regenerated;
}

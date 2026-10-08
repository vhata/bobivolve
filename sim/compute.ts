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
//   - Quarantine: fund holds oldest-first from the starting budget each
//     tick. Release unfunded holds before regeneration; no free holds.
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

// Calculate how many oldest holds can be fully funded before regeneration.
// The caller releases every remaining hold in insertion order. Regeneration
// cannot pay this tick's maintenance; unused compute remains in the budget.
export function applyComputeTick(
  budget: bigint,
  heldQuarantines: number,
): { readonly budget: bigint; readonly fundedQuarantines: number } {
  const affordable = budget / QUARANTINE_MAINTENANCE_PER_TICK;
  const funded = affordable < BigInt(heldQuarantines) ? affordable : BigInt(heldQuarantines);
  const regenerated =
    budget - funded * QUARANTINE_MAINTENANCE_PER_TICK + ORIGIN_COMPUTE_REGEN_PER_TICK;
  return {
    budget: regenerated > ORIGIN_COMPUTE_MAX ? ORIGIN_COMPUTE_MAX : regenerated,
    fundedQuarantines: Number(funded),
  };
}

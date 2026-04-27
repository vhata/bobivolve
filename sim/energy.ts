// R1 metabolism. Every probe carries an energy reservoir that drains
// each tick from basal metabolism and (later) replenishes via the gather
// directive consuming cell resources. When energy reaches zero the probe
// dies and the host emits DeathEvent.
//
// Determinism: like every other tunable in the sim, these constants are
// part of the (seed → event-log) contract. Changing them changes every
// existing golden. Tunable here only; never duplicate.

// Founder's starting energy at run construction. Children do NOT start
// here — they start with REPLICATION_COST_ENERGY transferred from the
// parent, keeping total system energy bounded by metabolism rather
// than by spawning fresh reserves out of nothing.
export const INITIAL_ENERGY = 10_000n;

// Energy lost per probe per tick from basal metabolism, deducted before
// any directive runs. With the default INITIAL_ENERGY a probe with no
// replenishment lives for exactly INITIAL_ENERGY / BASAL_DRAIN_PER_TICK
// ticks.
export const BASAL_DRAIN_PER_TICK = 1n;

// Energy transferred from parent to child on every successful
// replication. The parent loses this amount; the child begins life
// with exactly this much. Combined with the replicate directive's
// threshold this gates the rate at which a probe can fund offspring
// — a probe in a steady cell of net (gather.rate - BASAL_DRAIN) earns
// the cost back every COST / net ticks. Selection pressure favours
// lineages whose firmware (a tunable, mutable input — gather.rate
// drifts across generations) lets them earn the cost faster than
// their neighbours.
export const REPLICATION_COST_ENERGY = 1000n;

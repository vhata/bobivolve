// R1 metabolism. Every probe carries an energy reservoir that drains
// each tick from basal metabolism and (later) replenishes via the gather
// directive consuming cell resources. When energy reaches zero the probe
// dies and the host emits DeathEvent.
//
// Determinism: like every other tunable in the sim, these constants are
// part of the (seed → event-log) contract. Changing them changes every
// existing golden. Tunable here only; never duplicate.

// Default energy for newly-minted probes: founder at construction, every
// child at replication. Set generously so that the existing R0-era
// goldens — which run for at most 5000 ticks — see no deaths and
// continue to produce identical event logs. Death is exercised by tests
// that pass an explicit lower override to createInitialState.
export const INITIAL_ENERGY = 1_000_000n;

// Energy lost per probe per tick from basal metabolism, deducted before
// any directive runs. With the default INITIAL_ENERGY a probe with no
// replenishment lives for exactly INITIAL_ENERGY / BASAL_DRAIN_PER_TICK
// ticks.
export const BASAL_DRAIN_PER_TICK = 1n;

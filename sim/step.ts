import { SimTick } from './types.js';
import type { SimState } from './state.js';

// Advance the simulation by one tick. R0 is pre-Scarcity (SPEC.md), so for
// now there is no per-tick mechanic beyond bumping the clock — replication,
// mutation, and lineage drift land in subsequent commits.
//
// Designed to mutate state in place. SimState is conceptually a value, but
// allocating a fresh Map every tick at swarm scale is wasteful. The seam
// boundary, not the inner loop, is where immutability matters.
export function tick(state: SimState): void {
  state.simTick = SimTick(state.simTick + 1n);
}

export function tickN(state: SimState, n: bigint): void {
  for (let i = 0n; i < n; i++) tick(state);
}

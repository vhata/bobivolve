// Sub-lattice substrate. SPEC.md "Sub-lattice — coarse grid overlaid on the
// substrate. Used for resource diffusion and (from R7) communication latency."
//
// R1 introduces the lattice as the spatial topology probes inhabit. Probes
// carry positions; resources live per cell; gather and diffusion are the
// mechanics that make scarcity real.
//
// Determinism: lattice geometry is a fixed constant of the sim. Sub-lattice
// dimensions cannot change between runs of the same seed without breaking
// the determinism contract. If the side ever needs to change, that is a
// migration, not a tuning knob.

// 32×32 cells. Small enough that diffusion gradients are visible across the
// whole grid within a few hundred ticks; large enough that several lineages
// can claim distinct neighbourhoods. Tunable here only — the value is wired
// through every consumer by import, never duplicated.
export const LATTICE_SIDE = 32;

// Total cell count; helpful for sizing the flat resource grid.
export const LATTICE_CELL_COUNT = LATTICE_SIDE * LATTICE_SIDE;

// Carrying capacity of a single cell. Regen accumulates up to this value;
// excess is discarded. Tuned alongside ABSORPTION_PER_PROBE_PER_TICK and
// BASAL_DRAIN_PER_TICK so a few-probe density is sustainable per cell.
export const MAX_RESOURCE_PER_CELL = 1000n;

// Resources gained by every cell each tick, capped at MAX_RESOURCE_PER_CELL.
// Constant across the lattice in R1; later releases may make regen
// position-dependent, but for now the substrate is uniform.
export const RESOURCE_REGEN_PER_CELL_PER_TICK = 1n;

export function cellIndex(x: number, y: number): number {
  return y * LATTICE_SIDE + x;
}

export interface Position {
  // Cell coordinates on the sub-lattice. Integer values in [0, LATTICE_SIDE).
  // Plain numbers (not bigint) — u32 fits in JS number with precision to
  // spare and the field is not a tick count, so the float ban does not
  // apply.
  readonly x: number;
  readonly y: number;
}

// Centre of the lattice. Founder probe spawns here; new runs always start
// from the centre so seed-determined behaviour does not depend on geometry
// boundary effects in the early ticks.
export const LATTICE_CENTRE: Position = {
  x: Math.floor(LATTICE_SIDE / 2),
  y: Math.floor(LATTICE_SIDE / 2),
};

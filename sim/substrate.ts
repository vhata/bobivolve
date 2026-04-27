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

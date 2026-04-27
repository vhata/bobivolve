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

// 64×64 cells. SPEC.md frames the universe as "a contained galaxy of a
// few dozen densely-populated systems." The lattice is sized so a few
// dozen systems can fit at meaningful spacing and most cells stay
// interstellar void — the world feels bigger than the active patch.
// Tunable here only; the value is wired through every consumer by
// import, never duplicated.
export const LATTICE_SIDE = 64;

// Total cell count; helpful for sizing the flat resource grid.
export const LATTICE_CELL_COUNT = LATTICE_SIDE * LATTICE_SIDE;

// Carrying capacity of a system-centre cell. Per-cell caps fall off
// from system centres toward zero in the void; this constant is the
// maximum any cell can hold. Tuned alongside the gather directive's
// rate parameter (firmware-controlled) and BASAL_DRAIN_PER_TICK so a
// few-probe density is sustainable inside a system.
export const MAX_RESOURCE_PER_CELL = 1000n;

// Regen scales with each cell's cap: a cap-N cell regens at
// floor(N / RESOURCE_REGEN_DIVISOR) per tick. Cells in the void
// (cap = 0) never regen. The divisor is tuned so a system-centre
// cell (cap = MAX_RESOURCE_PER_CELL = 1000) regens at 10/tick, and
// the gradient toward the system edge falls off with the cap.
export const RESOURCE_REGEN_DIVISOR = 100n;

// SPEC.md "Galaxy and Scale": the substrate is procedurally generated
// from a seed, with star systems / resources placed deterministically.
// We model that here as a handful of system centres, each with a
// linear-falloff disc of resources around it. Most of the lattice is
// void.
export const NUM_SYSTEMS = 30;
// Falloff radius in cells. A cell at distance d from the nearest
// system centre carries cap = MAX × (1 - d²/r²) when d < r, else 0.
// Squared distance keeps the math integer.
export const SYSTEM_FALLOFF_RADIUS = 4;

export function cellIndex(x: number, y: number): number {
  return y * LATTICE_SIDE + x;
}

// Generate the per-cell resource caps for a fresh run. Deterministic
// in the supplied PRNG state — the function consumes 2 PRNG draws per
// system after the first (the first system is anchored at the lattice
// centre so the founder always lands somewhere viable).
//
// The cap at each cell is the maximum, across all system centres, of
// MAX × (1 - d²/r²) when d < r, else 0. Cells outside any system's
// disc remain at 0 (interstellar void) and never regen. Linear
// falloff in squared distance is integer-only — no floats touch the
// determinism path.
export function generateResourceCaps(rng: { nextU64: () => bigint }, centre: Position): bigint[] {
  const systems: Position[] = [centre];
  for (let i = 1; i < NUM_SYSTEMS; i++) {
    const xRoll = rng.nextU64();
    const yRoll = rng.nextU64();
    const x = Number(xRoll % BigInt(LATTICE_SIDE));
    const y = Number(yRoll % BigInt(LATTICE_SIDE));
    systems.push({ x, y });
  }
  const caps = new Array<bigint>(LATTICE_CELL_COUNT).fill(0n);
  const radiusSq = SYSTEM_FALLOFF_RADIUS * SYSTEM_FALLOFF_RADIUS;
  for (let y = 0; y < LATTICE_SIDE; y++) {
    for (let x = 0; x < LATTICE_SIDE; x++) {
      let best = 0n;
      for (const sys of systems) {
        const dx = x - sys.x;
        const dy = y - sys.y;
        const distSq = dx * dx + dy * dy;
        if (distSq >= radiusSq) continue;
        // r = MAX × (radiusSq − distSq) / radiusSq, integer.
        const num = MAX_RESOURCE_PER_CELL * BigInt(radiusSq - distSq);
        const cap = num / BigInt(radiusSq);
        if (cap > best) best = cap;
      }
      caps[y * LATTICE_SIDE + x] = best;
    }
  }
  return caps;
}

// Diffusion rate per tick, expressed as a numerator/denominator so the
// integer arithmetic is exact. Each cell sends
// floor(value * NUM / (DEN * 4)) to each of its 4 cardinal neighbours;
// boundary cells reflect (the would-be off-lattice share stays put).
// Conservation is preserved exactly.
export const DIFFUSION_RATE_NUMERATOR = 1n;
export const DIFFUSION_RATE_DENOMINATOR = 20n;

// Diffuse resources across the sub-lattice in place. Called once per
// tick. Pure integer arithmetic; no PRNG draws — the determinism
// contract is unchanged when this runs.
export function diffuseResources(resources: bigint[]): void {
  const next = resources.slice();
  for (let y = 0; y < LATTICE_SIDE; y++) {
    for (let x = 0; x < LATTICE_SIDE; x++) {
      const idx = cellIndex(x, y);
      const value = resources[idx] ?? 0n;
      const outflowPerNeighbour =
        (value * DIFFUSION_RATE_NUMERATOR) / (DIFFUSION_RATE_DENOMINATOR * 4n);
      if (outflowPerNeighbour === 0n) continue;
      let outgoing = 0n;
      if (x > 0) {
        const ni = cellIndex(x - 1, y);
        next[ni] = (next[ni] ?? 0n) + outflowPerNeighbour;
        outgoing += outflowPerNeighbour;
      }
      if (x < LATTICE_SIDE - 1) {
        const ni = cellIndex(x + 1, y);
        next[ni] = (next[ni] ?? 0n) + outflowPerNeighbour;
        outgoing += outflowPerNeighbour;
      }
      if (y > 0) {
        const ni = cellIndex(x, y - 1);
        next[ni] = (next[ni] ?? 0n) + outflowPerNeighbour;
        outgoing += outflowPerNeighbour;
      }
      if (y < LATTICE_SIDE - 1) {
        const ni = cellIndex(x, y + 1);
        next[ni] = (next[ni] ?? 0n) + outflowPerNeighbour;
        outgoing += outflowPerNeighbour;
      }
      next[idx] = (next[idx] ?? 0n) - outgoing;
    }
  }
  for (let i = 0; i < LATTICE_CELL_COUNT; i++) {
    resources[i] = next[i] ?? 0n;
  }
}

export interface Position {
  // Cell coordinates on the sub-lattice. Integer values in [0, LATTICE_SIDE).
  // Plain numbers (not bigint) — u32 fits in JS number with precision to
  // spare and the field is not a tick count, so the float ban does not
  // apply.
  readonly x: number;
  readonly y: number;
}

// Centre of the lattice. Founder probe spawns here; new runs always
// start from the centre so seed-determined behaviour does not depend
// on geometry boundary effects in the early ticks. Frozen — every
// founder probe shares this object reference, and a runtime mutation
// of either field would clobber every probe's view of "centre."
export const LATTICE_CENTRE: Position = Object.freeze({
  x: Math.floor(LATTICE_SIDE / 2),
  y: Math.floor(LATTICE_SIDE / 2),
});

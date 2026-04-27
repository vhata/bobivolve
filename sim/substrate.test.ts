import { describe, expect, it } from 'vitest';
import {
  DIFFUSION_RATE_DENOMINATOR,
  DIFFUSION_RATE_NUMERATOR,
  LATTICE_CELL_COUNT,
  LATTICE_SIDE,
  cellIndex,
  diffuseResources,
} from './substrate.js';

function fullField(value: bigint): bigint[] {
  return new Array<bigint>(LATTICE_CELL_COUNT).fill(value);
}

function totalResources(resources: readonly bigint[]): bigint {
  return resources.reduce((sum, v) => sum + v, 0n);
}

describe('diffuseResources', () => {
  it('a uniform field stays uniform', () => {
    // All cells equal → outflow per neighbour is identical → every
    // cell emits and receives the same shares. Should not change.
    const field = fullField(1000n);
    diffuseResources(field);
    for (const v of field) {
      expect(v).toBe(1000n);
    }
  });

  it('total resources are conserved (boundary reflects)', () => {
    // Mixed field; off-lattice neighbours simply do not receive shares.
    // The sum across the lattice must not change after a diffusion
    // step.
    const field = fullField(0n);
    field[cellIndex(0, 0)] = 1000n;
    field[cellIndex(LATTICE_SIDE - 1, LATTICE_SIDE - 1)] = 1000n;
    field[cellIndex(LATTICE_SIDE / 2, LATTICE_SIDE / 2)] = 1000n;
    const before = totalResources(field);
    diffuseResources(field);
    const after = totalResources(field);
    expect(after).toBe(before);
  });

  it('a single hot cell spreads to its 4 cardinal neighbours', () => {
    const field = fullField(0n);
    const x = LATTICE_SIDE / 2;
    const y = LATTICE_SIDE / 2;
    field[cellIndex(x, y)] = 8000n;
    diffuseResources(field);
    // Centre loses (8000 * NUM / DEN) total, split across 4 neighbours.
    const outflowPerNeighbour =
      (8000n * DIFFUSION_RATE_NUMERATOR) / (DIFFUSION_RATE_DENOMINATOR * 4n);
    expect(field[cellIndex(x - 1, y)]).toBe(outflowPerNeighbour);
    expect(field[cellIndex(x + 1, y)]).toBe(outflowPerNeighbour);
    expect(field[cellIndex(x, y - 1)]).toBe(outflowPerNeighbour);
    expect(field[cellIndex(x, y + 1)]).toBe(outflowPerNeighbour);
    expect(field[cellIndex(x, y)]).toBe(8000n - outflowPerNeighbour * 4n);
  });

  it('boundary cells reflect — off-lattice shares stay put', () => {
    // A corner cell has only 2 neighbours. The other two would-be
    // shares stay in the cell. After one step, total = 1000 still.
    const field = fullField(0n);
    field[cellIndex(0, 0)] = 1000n;
    diffuseResources(field);
    expect(totalResources(field)).toBe(1000n);
    const outflowPerNeighbour =
      (1000n * DIFFUSION_RATE_NUMERATOR) / (DIFFUSION_RATE_DENOMINATOR * 4n);
    // Corner has 2 neighbours: (1, 0) and (0, 1).
    expect(field[cellIndex(1, 0)]).toBe(outflowPerNeighbour);
    expect(field[cellIndex(0, 1)]).toBe(outflowPerNeighbour);
    expect(field[cellIndex(0, 0)]).toBe(1000n - outflowPerNeighbour * 2n);
  });

  it('is deterministic across calls with identical input', () => {
    const a = fullField(0n);
    const b = fullField(0n);
    a[cellIndex(5, 5)] = 1234n;
    b[cellIndex(5, 5)] = 1234n;
    for (let i = 0; i < 50; i++) {
      diffuseResources(a);
      diffuseResources(b);
    }
    expect(a).toEqual(b);
  });
});

// Conservation invariants — the long-run sim must not silently leak or
// gain energy. Closes the substrate-balance investigation logged at
// BRAINSTORM/substrate-regen-investigation.md (verdict: as-designed,
// regen reaches a non-zero steady state). These tests pin the invariants
// the verdict rests on so a future regression — particularly anything in
// R3 that touches substrate or probe energy (Deltans, treaty refunds,
// crisis-mode pacing) — surfaces as a test failure rather than as the
// player noticing weeks later.

import { describe, expect, it } from 'vitest';
import {
  diffuseResources,
  LATTICE_CELL_COUNT,
  MAX_RESOURCE_PER_CELL,
} from '../../sim/substrate.js';
import { NodeTransport } from '../../transport/node.js';
import type { Command, Query, SubstrateResult } from '../../protocol/types.js';

function sumCellsBigint(cells: readonly bigint[]): bigint {
  let total = 0n;
  for (const c of cells) total += c;
  return total;
}

function sumCellsString(cells: readonly string[]): bigint {
  let total = 0n;
  for (const c of cells) total += BigInt(c);
  return total;
}

describe('conservation invariants', () => {
  it('diffuseResources preserves total substrate exactly across many steps', () => {
    // Seed a non-trivial substrate: a handful of cells with values well
    // above the per-neighbour truncation floor (value < 80 → cell skips
    // diffusion entirely; that path is conservative by definition but
    // not interesting). Spread the seed cells around the lattice so the
    // diffusion kernel actually has work to do at every boundary.
    const cells = new Array<bigint>(LATTICE_CELL_COUNT).fill(0n);
    for (let i = 0; i < 64; i++) {
      const idx = (i * 41) % LATTICE_CELL_COUNT;
      cells[idx] = BigInt(200 + i * 13);
    }
    const totalBefore = sumCellsBigint(cells);
    expect(totalBefore).toBeGreaterThan(0n);

    // 50 diffusion steps is enough to drive the distribution close to
    // uniform inside the lattice; if the kernel were lossy, the drift
    // would compound and show up here.
    for (let step = 0; step < 50; step++) {
      diffuseResources(cells);
    }

    const totalAfter = sumCellsBigint(cells);
    expect(totalAfter).toBe(totalBefore);
  });

  it('long-run sim keeps total substrate above zero (steady state, not depletion)', async () => {
    // 3000 ticks at seed=42 is the same scale as the existing determinism
    // golden — long enough to drive the system past its initial transient
    // into the regen/diffusion equilibrium described in
    // BRAINSTORM/substrate-regen-investigation.md, fast enough to keep
    // the test under ~10s.
    const transport = new NodeTransport({ heartbeatHz: 0 });
    try {
      const newRun: Command = { kind: 'newRun', commandId: 'c0', seed: 42n };
      transport.send(newRun);
      transport.getHost().runUntil(3000n);

      const query: Query = { kind: 'substrate', queryId: 'q0' };
      const result = await transport.query(query);
      if (result.kind !== 'substrate') throw new Error('unreachable: query kind mismatch');
      const substrate = result as SubstrateResult;

      const total = sumCellsString(substrate.cells);
      // The steady-state floor sits well above zero (analysis predicts
      // ~17–30% of cap per system-disc cell). We assert only the weaker
      // claim — total > 0 — so the test does not pin an arbitrary
      // tuning-sensitive number, only the invariant that the sim does
      // not drain to nothing.
      expect(total).toBeGreaterThan(0n);

      // Probe population must also be above zero — extinction here would
      // mean the substrate is providing some resources but probes can't
      // reach them, which is its own kind of bug.
      expect(substrate.probes.length).toBeGreaterThan(0);

      // Sanity check on the per-cell cap exposed to the UI: it should
      // match the sim's MAX_RESOURCE_PER_CELL constant. A drift here
      // would signal a leak in the UI/sim coupling.
      expect(substrate.maxResourcePerCell).toBe(MAX_RESOURCE_PER_CELL.toString());

      // Per-cell caps must align with cells row-major, fully populated,
      // and bounded by the global max. The substrate-tooltip hover
      // surface consumes these to compute per-cell depletion ratio.
      expect(substrate.caps.length).toBe(substrate.cells.length);
      expect(substrate.caps.length).toBe(substrate.side * substrate.side);
      const maxCap = MAX_RESOURCE_PER_CELL;
      for (const c of substrate.caps) {
        const cap = BigInt(c);
        expect(cap >= 0n && cap <= maxCap).toBe(true);
      }
    } finally {
      transport.close();
    }
  });
});

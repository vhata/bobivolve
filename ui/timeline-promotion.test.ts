import { describe, expect, it } from 'vitest';
import { promotesSpeciationAtEmission, type PromotionProjection } from './timeline-promotion.js';

// L0 holds the population; L1 is a small (<5%) parent that is neither
// quarantined nor patched unless a case says otherwise.
function projection(overrides: Partial<PromotionProjection> = {}): PromotionProjection {
  return {
    populationTotal: 1000n,
    populationByLineage: new Map([
      ['L0', 960n],
      ['L1', 40n],
    ]),
    quarantinedLineages: new Set(),
    patchedLineages: new Set(),
    ...overrides,
  };
}

describe('forward-looking speciation promotion', () => {
  it('promotes a speciation whose parent holds at least 5% of the population', () => {
    expect(promotesSpeciationAtEmission('L0', projection())).toBe(true);
    const atThreshold = projection({
      populationByLineage: new Map([
        ['L0', 950n],
        ['L1', 50n],
      ]),
    });
    expect(promotesSpeciationAtEmission('L1', atThreshold)).toBe(true);
  });

  it('leaves a small, unquarantined, unpatched parent to the retroactive path', () => {
    expect(promotesSpeciationAtEmission('L1', projection())).toBe(false);
    expect(promotesSpeciationAtEmission('unknown', projection())).toBe(false);
    expect(
      promotesSpeciationAtEmission(
        'L1',
        projection({ populationTotal: 0n, populationByLineage: new Map() }),
      ),
    ).toBe(false);
  });

  it('promotes a speciation whose small parent is quarantined', () => {
    expect(
      promotesSpeciationAtEmission('L1', projection({ quarantinedLineages: new Set(['L1']) })),
    ).toBe(true);
  });

  it('promotes a speciation whose small parent has been patched', () => {
    expect(
      promotesSpeciationAtEmission('L1', projection({ patchedLineages: new Set(['L1']) })),
    ).toBe(true);
    // Patching a different lineage does not promote this parent's drift.
    expect(
      promotesSpeciationAtEmission('L1', projection({ patchedLineages: new Set(['L0']) })),
    ).toBe(false);
  });

  it('promotes a patched parent even before the first population heartbeat', () => {
    const empty = projection({ populationTotal: 0n, populationByLineage: new Map() });
    expect(promotesSpeciationAtEmission('L1', { ...empty, patchedLineages: new Set(['L1']) })).toBe(
      true,
    );
  });
});

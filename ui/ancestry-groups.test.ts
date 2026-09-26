import { describe, expect, it } from 'vitest';
import { deriveAncestryGroups, type AncestryPin } from './ancestry-groups.js';
import type { LineageNode } from './sim-store.js';

function node(
  id: string,
  parentId: string | null,
  extinctionTick: bigint | null = null,
): LineageNode {
  return {
    id,
    name: `Name ${id}`,
    parentId,
    foundedAtTick: 0n,
    founderProbeId: `P${id}`,
    extinctionTick,
  };
}

function pin(rootId: string): AncestryPin {
  return {
    rootId,
    name: `Group ${rootId}`,
    color: 'oklch(0.72 0.13 10)',
    foundedAtTick: 0n,
    founderProbeId: `P${rootId}`,
  };
}

describe('pinned ancestry grouping', () => {
  it('partitions living lineages by nearest pinned ancestor and reassigns them after unpinning', () => {
    const tree = new Map([
      ['a', node('a', null)],
      ['b', node('b', 'a')],
      ['c', node('c', 'b')],
      ['d', node('d', 'a')],
      ['other', node('other', null)],
    ]);
    const populations = new Map([
      ['a', 2n],
      ['b', 3n],
      ['c', 5n],
      ['d', 7n],
      ['other', 11n],
      ['unknown', 13n],
    ]);
    const result = deriveAncestryGroups(tree, populations, [pin('a'), pin('b')]);
    expect(result.groups.map((group) => [group.rootId, group.population, group.memberIds])).toEqual(
      [
        ['a', 9n, ['a', 'd']],
        ['b', 8n, ['b', 'c']],
      ],
    );
    expect(result.ownerByLineage.get('c')).toBe('b');
    expect(result.ungroupedPopulation).toBe(24n);
    expect(result.ungroupedMemberIds).toEqual(['other', 'unknown']);
    expect(
      result.groups.reduce((sum, group) => sum + group.population, result.ungroupedPopulation),
    ).toBe(41n);
    const unpinned = deriveAncestryGroups(tree, populations, [pin('a')]);
    expect(unpinned.groups[0]?.population).toBe(17n);
    expect(unpinned.ownerByLineage.get('c')).toBe('a');
  });

  it('retains extinct roots and captured display identity while descendants survive', () => {
    const tree = new Map([
      ['root', node('root', null, 10n)],
      ['child', node('child', 'root')],
    ]);
    const huge = 2n ** 63n;
    const result = deriveAncestryGroups(
      tree,
      new Map([
        ['root', 0n],
        ['child', huge],
      ]),
      [pin('root')],
    );
    expect(result.groups[0]).toMatchObject({
      name: 'Group root',
      population: huge,
      memberIds: ['child'],
    });
    expect(tree.get('root')?.name).toBe('Name root');
  });

  it('discards missing or recycled roots without losing their population', () => {
    const tree = new Map([['root', { ...node('root', null), founderProbeId: 'replacement' }]]);
    const result = deriveAncestryGroups(tree, new Map([['root', 4n]]), [
      pin('root'),
      pin('missing'),
    ]);
    expect(result.groups).toEqual([]);
    expect(result.ungroupedPopulation).toBe(4n);
  });

  it('handles very deep reversed ancestry iteratively and reuses cached ownership across heartbeats', () => {
    const tree = new Map<string, LineageNode>();
    for (let index = 29_999; index >= 0; index -= 1) {
      tree.set(String(index), node(String(index), index === 0 ? null : String(index - 1)));
    }
    const pins = [pin('0')];
    const populations = new Map([['29999', 7n]]);
    const first = deriveAncestryGroups(tree, populations, pins);
    expect(first.groups[0]?.population).toBe(7n);
    expect(deriveAncestryGroups(tree, populations, pins)).toBe(first);
    const next = deriveAncestryGroups(tree, new Map([['29999', 8n]]), pins);
    expect(next.ownerByLineage).toBe(first.ownerByLineage);
    expect(next.groups[0]?.population).toBe(8n);
  });

  it('terminates missing-parent and cyclic ancestry without guessing a group', () => {
    const tree = new Map([
      ['a', node('a', 'b')],
      ['b', node('b', 'a')],
      ['c', node('c', 'missing')],
    ]);
    const result = deriveAncestryGroups(
      tree,
      new Map([
        ['a', 1n],
        ['c', 2n],
      ]),
      [],
    );
    expect([...result.ownerByLineage.values()]).toEqual([null, null, null]);
    expect(result.ungroupedPopulation).toBe(3n);
  });
});

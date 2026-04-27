// LineageTreePanel — nested view of the LIVING lineage hierarchy.
//
// Each speciation event creates a new lineage with a parentId pointing
// at its ancestor. This panel filters the recorded lineage map to
// living-only (population > 0) and re-parents each survivor to its
// nearest still-living ancestor. Dead ancestors disappear; the chain
// of descent collapses around them, but living genealogies render at
// full depth without any indent cap. Speciation history of dead
// branches still lives in the events timeline.

import type { LineageNode } from '../sim-store.js';
import { useSimStore } from '../sim-store.js';

interface TreeNode {
  readonly lineage: LineageNode;
  readonly population: bigint;
  readonly children: readonly TreeNode[];
}

function buildLivingTree(
  lineages: ReadonlyMap<string, LineageNode>,
  populationByLineage: ReadonlyMap<string, bigint>,
): TreeNode[] {
  // Step 1: enumerate living lineages.
  const living = new Map<string, LineageNode>();
  for (const [id, lineage] of lineages) {
    const population = populationByLineage.get(id) ?? 0n;
    if (population > 0n) living.set(id, lineage);
  }

  // Step 2: re-parent each living lineage to its nearest living
  // ancestor. Walk the parentId chain skipping any non-living entry.
  // The result is the "effective parent" for tree-building purposes.
  function nearestLivingAncestor(start: LineageNode): string | null {
    let cursor = start.parentId;
    while (cursor !== null) {
      if (living.has(cursor)) return cursor;
      const ancestor = lineages.get(cursor);
      if (ancestor === undefined) return null;
      cursor = ancestor.parentId;
    }
    return null;
  }

  // Step 3: bucket children by effective parent.
  const childrenOf = new Map<string | null, LineageNode[]>();
  for (const lineage of living.values()) {
    const effectiveParent = nearestLivingAncestor(lineage);
    const list = childrenOf.get(effectiveParent);
    if (list === undefined) {
      childrenOf.set(effectiveParent, [lineage]);
    } else {
      list.push(lineage);
    }
  }

  // Step 4: walk top-down. Sort siblings by foundedAtTick for
  // deterministic ordering.
  function build(parentId: string | null): TreeNode[] {
    const children = childrenOf.get(parentId) ?? [];
    return [...children]
      .sort((a, b) => {
        if (a.foundedAtTick !== b.foundedAtTick) {
          return a.foundedAtTick < b.foundedAtTick ? -1 : 1;
        }
        return a.id.localeCompare(b.id);
      })
      .map((lineage) => ({
        lineage,
        population: populationByLineage.get(lineage.id) ?? 0n,
        children: build(lineage.id),
      }));
  }

  return build(null);
}

function TreeNodeView({
  node,
  selectedId,
  onSelect,
  quarantinedLineages,
}: {
  node: TreeNode;
  selectedId: string;
  onSelect: (id: string) => void;
  quarantinedLineages: ReadonlySet<string>;
}): React.JSX.Element {
  const selected = node.lineage.id === selectedId;
  const isQuarantined = quarantinedLineages.has(node.lineage.id);
  const className = [
    'lineage-node',
    selected ? 'lineage-node-selected' : '',
    isQuarantined ? 'lineage-node-quarantined' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <li className={className}>
      <button
        type="button"
        className="lineage-node-row"
        onClick={() => onSelect(node.lineage.id)}
        aria-pressed={selected}
      >
        <span className="lineage-id">
          {isQuarantined ? <span className="lineage-quarantine-pip">⊘</span> : null}
          {node.lineage.name}
          {node.lineage.name !== node.lineage.id ? (
            <span className="lineage-id-ordinal"> {node.lineage.id}</span>
          ) : null}
        </span>
        <span className="lineage-meta">
          {node.population.toString()} probes
          {node.lineage.foundedAtTick > 0n
            ? ` · forked at ${node.lineage.foundedAtTick.toString()}`
            : ''}
        </span>
      </button>
      {node.children.length > 0 ? (
        <ul className="lineage-children">
          {node.children.map((child) => (
            <TreeNodeView
              key={child.lineage.id}
              node={child}
              selectedId={selectedId}
              onSelect={onSelect}
              quarantinedLineages={quarantinedLineages}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function LineageTreePanel(): React.JSX.Element {
  const lineages = useSimStore((s) => s.lineages);
  const populationByLineage = useSimStore((s) => s.populationByLineage);
  const selectedLineageId = useSimStore((s) => s.selectedLineageId);
  const selectLineage = useSimStore((s) => s.selectLineage);
  const quarantinedLineages = useSimStore((s) => s.quarantinedLineages);

  const roots = buildLivingTree(lineages, populationByLineage);
  // Living lineage count for the panel header — distinct from
  // lineages.size (which counts every lineage ever recorded).
  let livingCount = 0;
  for (const id of lineages.keys()) {
    if ((populationByLineage.get(id) ?? 0n) > 0n) livingCount += 1;
  }

  return (
    <section className="panel lineage-tree-panel">
      <header className="panel-header">
        <h2>Lineages</h2>
        <span className="panel-meta">
          {livingCount.toString()} living · {lineages.size.toString()} ever
        </span>
      </header>
      <div className="panel-body">
        {roots.length === 0 ? (
          <p className="panel-empty">no living lineages</p>
        ) : (
          <ul className="lineage-tree">
            {roots.map((root) => (
              <TreeNodeView
                key={root.lineage.id}
                node={root}
                selectedId={selectedLineageId}
                onSelect={selectLineage}
                quarantinedLineages={quarantinedLineages}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

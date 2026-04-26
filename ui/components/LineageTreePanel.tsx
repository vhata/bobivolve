// LineageTreePanel — nested view of the lineage hierarchy. Each speciation
// event creates a new lineage with a parentId pointing at its ancestor;
// this panel walks that tree from L0 down. Extant population per lineage
// is read from the store's populationByLineage map.

import type { LineageNode } from '../sim-store.js';
import { useSimStore } from '../sim-store.js';

interface TreeNode {
  readonly lineage: LineageNode;
  readonly population: bigint;
  readonly children: readonly TreeNode[];
}

function buildTree(
  lineages: ReadonlyMap<string, LineageNode>,
  populationByLineage: ReadonlyMap<string, bigint>,
): TreeNode[] {
  const childrenOf = new Map<string | null, LineageNode[]>();
  for (const lineage of lineages.values()) {
    const list = childrenOf.get(lineage.parentId);
    if (list === undefined) {
      childrenOf.set(lineage.parentId, [lineage]);
    } else {
      list.push(lineage);
    }
  }

  function build(parentId: string | null): TreeNode[] {
    const children = childrenOf.get(parentId) ?? [];
    // Sort by foundedAtTick — earlier speciation appears first. Stable
    // tie-break on id keeps the order deterministic across renders.
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

function TreeNodeView({ node }: { node: TreeNode }): React.JSX.Element {
  const extinct = node.population === 0n;
  return (
    <li className={`lineage-node${extinct ? ' lineage-node-extinct' : ''}`}>
      <div className="lineage-node-row">
        <span className="lineage-id">
          {node.lineage.name}
          {node.lineage.name !== node.lineage.id ? (
            <span className="lineage-id-ordinal"> {node.lineage.id}</span>
          ) : null}
        </span>
        <span className="lineage-meta">
          {extinct ? 'extinct' : `${node.population.toString()} probes`}
          {node.lineage.foundedAtTick > 0n
            ? ` · forked at ${node.lineage.foundedAtTick.toString()}`
            : ''}
        </span>
      </div>
      {node.children.length > 0 ? (
        <ul className="lineage-children">
          {node.children.map((child) => (
            <TreeNodeView key={child.lineage.id} node={child} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function LineageTreePanel(): React.JSX.Element {
  const lineages = useSimStore((s) => s.lineages);
  const populationByLineage = useSimStore((s) => s.populationByLineage);

  const roots = buildTree(lineages, populationByLineage);

  return (
    <section className="panel lineage-tree-panel">
      <header className="panel-header">
        <h2>Lineages</h2>
        <span className="panel-meta">{lineages.size}</span>
      </header>
      <div className="panel-body">
        {roots.length === 0 ? (
          <p className="panel-empty">no lineages yet</p>
        ) : (
          <ul className="lineage-tree">
            {roots.map((root) => (
              <TreeNodeView key={root.lineage.id} node={root} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

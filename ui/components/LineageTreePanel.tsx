// LineageTreePanel — nested view of the lineage hierarchy. Each speciation
// event creates a new lineage with a parentId pointing at its ancestor;
// this panel walks that tree from L0 down. Extant population per lineage
// is read from the store's populationByLineage map.

import type { LineageNode } from '../sim-store.js';
import { useSimStore } from '../sim-store.js';

// Depth at which the visual indent stops growing. The DOM stays nested
// for selection / structural correctness; CSS caps the leftward shift
// so deep clades stay readable in the panel.
const MAX_VISUAL_DEPTH = 8;

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

// A subtree is fully archaeology when this lineage and all of its
// descendants are extinct. Drop the entire subtree from the tree —
// the events timeline still records the speciations. Lineages whose
// own row is dead but whose descendants are alive stay rendered, so
// the chain of descent for living clades is preserved.
function pruneFullyDeadSubtrees(nodes: readonly TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  for (const n of nodes) {
    const prunedChildren = pruneFullyDeadSubtrees(n.children);
    if (n.population === 0n && prunedChildren.length === 0) continue;
    out.push({ ...n, children: prunedChildren });
  }
  return out;
}

function TreeNodeView({
  node,
  depth,
  selectedId,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selectedId: string;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  const extinct = node.population === 0n;
  const selected = node.lineage.id === selectedId;
  const beyondCap = depth >= MAX_VISUAL_DEPTH;
  const className = [
    'lineage-node',
    extinct ? 'lineage-node-extinct' : '',
    selected ? 'lineage-node-selected' : '',
    beyondCap ? 'lineage-node-deep' : '',
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
          {node.lineage.name}
          {node.lineage.name !== node.lineage.id ? (
            <span className="lineage-id-ordinal"> {node.lineage.id}</span>
          ) : null}
          {beyondCap ? (
            <span className="lineage-depth-tag">
              depth {depth.toString()} · parent {node.lineage.parentId ?? '—'}
            </span>
          ) : null}
        </span>
        <span className="lineage-meta">
          {extinct ? 'extinct' : `${node.population.toString()} probes`}
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
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
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

  const roots = pruneFullyDeadSubtrees(buildTree(lineages, populationByLineage));

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
              <TreeNodeView
                key={root.lineage.id}
                node={root}
                depth={0}
                selectedId={selectedLineageId}
                onSelect={selectLineage}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

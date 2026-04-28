// LineageTreePanel — nested view of the LIVING lineage hierarchy.
//
// Each speciation event creates a new lineage with a parentId pointing
// at its ancestor. This panel filters the recorded lineage map to
// living-only (population > 0) and re-parents each survivor to its
// nearest still-living ancestor. Dead ancestors disappear; the chain
// of descent collapses around them, but living genealogies render at
// full depth without any indent cap. Speciation history of dead
// branches still lives in the events timeline.

import { lineageColor } from '../lineage-color.js';
import type { LineageNode, PopulationHistoryPoint } from '../sim-store.js';
import { useSimStore } from '../sim-store.js';

// Per-row trend signal. The player needs to spot fading lineages
// without watching every population number. Compare the lineage's
// current population to the maximum it reached within the recent
// history window: if it has shed FADE_THRESHOLD of that peak, the
// lineage is "fading"; if it is at a fresh high, it is "rising";
// otherwise stable. Pure derivation from populationHistory; no
// new state at the seam.
type Trend = 'rising' | 'falling' | 'stable' | 'unknown';

const TREND_WINDOW_SAMPLES = 20;
// Lineage is "fading" once it has lost 40% from its window-recent
// peak. Aggressive enough to trigger a glyph before extinction is
// imminent, conservative enough to ignore brief dips.
const FADE_THRESHOLD = 0.6;
// Lineage is "rising" when the current value sits more than a
// noticeable margin above the window's earliest sample. The threshold
// keeps the tree calm during normal early-game growth.
const RISE_THRESHOLD = 1.2;

function computeTrend(
  lineageId: string,
  history: readonly PopulationHistoryPoint[],
  currentPopulation: bigint,
): Trend {
  if (history.length < 2) return 'unknown';
  const window = history.slice(-TREND_WINDOW_SAMPLES);
  let peak = 0n;
  for (const point of window) {
    const value = point.byLineage.get(lineageId) ?? 0n;
    if (value > peak) peak = value;
  }
  if (peak === 0n) return 'unknown';
  const earliest = window[0]?.byLineage.get(lineageId) ?? 0n;

  // Fade gate: current * 100 < peak * 60 → current < 60% of peak.
  if (currentPopulation * 100n < peak * BigInt(Math.floor(FADE_THRESHOLD * 100))) {
    return 'falling';
  }
  // Rise gate: current * 100 > earliest * 120 → current > 1.2× earliest.
  if (
    earliest > 0n &&
    currentPopulation * 100n > earliest * BigInt(Math.floor(RISE_THRESHOLD * 100))
  ) {
    return 'rising';
  }
  return 'stable';
}

function trendGlyph(trend: Trend): string {
  switch (trend) {
    case 'rising':
      return '↑';
    case 'falling':
      return '↓';
    case 'stable':
      return '→';
    case 'unknown':
      return '';
  }
}

function trendLabel(trend: Trend): string {
  switch (trend) {
    case 'rising':
      return 'rising — population is meaningfully above its recent baseline';
    case 'falling':
      return 'fading — population has shed 40% or more from its recent peak';
    case 'stable':
      return 'stable — population is hovering near its recent baseline';
    case 'unknown':
      return '';
  }
}

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
  trendByLineage,
}: {
  node: TreeNode;
  selectedId: string;
  onSelect: (id: string) => void;
  quarantinedLineages: ReadonlySet<string>;
  trendByLineage: ReadonlyMap<string, Trend>;
}): React.JSX.Element {
  const selected = node.lineage.id === selectedId;
  const isQuarantined = quarantinedLineages.has(node.lineage.id);
  const trend = trendByLineage.get(node.lineage.id) ?? 'unknown';
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
          <span
            className="lineage-swatch"
            style={{ background: lineageColor(node.lineage.id) }}
            aria-hidden="true"
          />
          {isQuarantined ? <span className="lineage-quarantine-pip">⊘</span> : null}
          {node.lineage.name}
          {node.lineage.name !== node.lineage.id ? (
            <span className="lineage-id-ordinal"> {node.lineage.id}</span>
          ) : null}
        </span>
        <span className="lineage-meta">
          {trend !== 'unknown' ? (
            <span className={`lineage-trend lineage-trend-${trend}`} title={trendLabel(trend)}>
              {trendGlyph(trend)}
            </span>
          ) : null}
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
              trendByLineage={trendByLineage}
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
  const populationHistory = useSimStore((s) => s.populationHistory);
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

  // Compute per-lineage trend once for the whole render. Subscribing
  // to populationHistory means this panel re-renders on every Tick
  // heartbeat, which is the right cadence for the trend signal.
  const trendByLineage = new Map<string, Trend>();
  for (const id of lineages.keys()) {
    const current = populationByLineage.get(id) ?? 0n;
    if (current === 0n) continue;
    trendByLineage.set(id, computeTrend(id, populationHistory, current));
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
                trendByLineage={trendByLineage}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

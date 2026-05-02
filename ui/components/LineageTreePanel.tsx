// LineageTreePanel — nested view of the LIVING lineage hierarchy.
//
// Each speciation event creates a new lineage with a parentId pointing
// at its ancestor. This panel filters the recorded lineage map to
// living-only (population > 0) and re-parents each survivor to its
// nearest still-living ancestor. Dead ancestors disappear; the chain
// of descent collapses around them, but living genealogies render at
// full depth without any indent cap. Speciation history of dead
// branches still lives in the events timeline.

import { memo, useMemo, useState } from 'react';
import { lineageColor } from '../lineage-color.js';
import type { LineageNode, PopulationHistoryPoint } from '../sim-store.js';
import { useSimStore } from '../sim-store.js';
import { useThrottled } from '../use-throttled.js';
import { PhylogenyView } from './PhylogenyView.js';

// At fat population the tree-build (~O(lineages²) on parent-chain
// walks) and trend computation (O(living × history-window) BigInt
// arithmetic) are the hot path. The store updates populationByLineage
// every heartbeat, which invalidates the panel's useMemo and forces a
// rebuild — at scale this saturates the main thread and starves the
// click handler for Pause. Throttle the inputs to a slower cadence
// than the heartbeat: the tree topology and trend glyphs are
// glance-level signals that do not benefit from sub-second updates.
const TREE_REBUILD_INTERVAL_MS = 750;

// Hard cap on the number of living lineages to surface in the tree.
// On long runs the simulation can produce thousands of co-existing
// lineages, most of them holding only a handful of probes. Rendering
// every one as an `<li>` (with several nested spans + a button) is
// what was outpacing GC and starving the main thread. The player
// can't usefully scan thousands of rows anyway; the dashboard is a
// glance-level surface, so we keep the most populous N and surface
// the rest as a "+ N more" footer for awareness.
//
// Hide-don't-compress: per CLAUDE.md the rule is to filter out what
// the player does not need to see, not to truncate or visually
// compress what they do need. A small clade with two probes is
// substantially less load-bearing than the dominant clades, so
// dropping it from the tree (rather than collapsing depth or
// shortening rows) is the right axis to filter on.
const TREE_LINEAGE_LIMIT = 60;

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

interface BuiltTree {
  readonly roots: TreeNode[];
  readonly visibleCount: number;
  readonly hiddenCount: number;
}

function buildLivingTree(
  lineages: ReadonlyMap<string, LineageNode>,
  populationByLineage: ReadonlyMap<string, bigint>,
): BuiltTree {
  // Step 1: enumerate living lineages and their populations, then
  // keep only the top TREE_LINEAGE_LIMIT by population. The hidden
  // count is surfaced in the panel header so the player knows how
  // many small clades are off-screen.
  const all: { id: string; lineage: LineageNode; population: bigint }[] = [];
  for (const [id, lineage] of lineages) {
    const population = populationByLineage.get(id) ?? 0n;
    if (population > 0n) all.push({ id, lineage, population });
  }
  const totalLiving = all.length;
  all.sort((a, b) => {
    if (a.population !== b.population) return b.population > a.population ? 1 : -1;
    return a.id.localeCompare(b.id);
  });
  const kept = all.slice(0, TREE_LINEAGE_LIMIT);
  const living = new Map<string, LineageNode>();
  for (const entry of kept) living.set(entry.id, entry.lineage);
  const hiddenCount = totalLiving - kept.length;

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

  return { roots: build(null), visibleCount: kept.length, hiddenCount };
}

interface TreeNodeViewProps {
  readonly node: TreeNode;
  readonly selectedId: string;
  readonly onSelect: (id: string) => void;
  readonly quarantinedLineages: ReadonlySet<string>;
  readonly trendByLineage: ReadonlyMap<string, Trend>;
}

// Memoised so unchanged subtrees skip reconciliation. The throttled
// tree build keeps `node` references stable across heartbeats when
// the underlying tree didn't change, so React.memo's default
// referential prop check is sufficient.
const TreeNodeView = memo(function TreeNodeView({
  node,
  selectedId,
  onSelect,
  quarantinedLineages,
  trendByLineage,
}: TreeNodeViewProps): React.JSX.Element {
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
});

type LineageView = 'living' | 'phylogeny';

export function LineageTreePanel(): React.JSX.Element {
  const lineages = useSimStore((s) => s.lineages);
  const populationByLineage = useSimStore((s) => s.populationByLineage);
  const populationHistory = useSimStore((s) => s.populationHistory);
  const selectedLineageId = useSimStore((s) => s.selectedLineageId);
  const selectLineage = useSimStore((s) => s.selectLineage);
  const quarantinedLineages = useSimStore((s) => s.quarantinedLineages);
  const simTick = useSimStore((s) => s.simTick);

  // Two views over the same lineage data:
  //   - "living": the present-tense glance — top-N living clades by
  //     population, hierarchy, trend glyphs.
  //   - "phylogeny": retrospective — every lineage ever, on a tick
  //     axis, with branching at speciation moments and lifelines for
  //     duration.
  // Living is the default per SPEC.md "primary unit of attention is
  // the lineage" and the present-tense glance argument; phylogeny
  // answers "how did we get here?" for players who want it. The
  // toggle is local to this panel; not persisted across sessions.
  const [view, setView] = useState<LineageView>('living');

  // Throttle the heartbeat-driven inputs so the expensive recomputes
  // (tree build, trend window, render) only run a couple of times a
  // second instead of on every store update. A fresh map identity
  // arrives on every heartbeat even when the contents barely changed,
  // so without this throttle the useMemos invalidate at heartbeat
  // rate and saturate the main thread on fat runs.
  const populationByLineageThrottled = useThrottled(populationByLineage, TREE_REBUILD_INTERVAL_MS);
  const populationHistoryThrottled = useThrottled(populationHistory, TREE_REBUILD_INTERVAL_MS);
  const simTickThrottled = useThrottled(simTick, TREE_REBUILD_INTERVAL_MS);

  const { roots, livingCount, hiddenCount } = useMemo(() => {
    const tree = buildLivingTree(lineages, populationByLineageThrottled);
    let count = 0;
    for (const id of lineages.keys()) {
      if ((populationByLineageThrottled.get(id) ?? 0n) > 0n) count += 1;
    }
    return { roots: tree.roots, livingCount: count, hiddenCount: tree.hiddenCount };
  }, [lineages, populationByLineageThrottled]);

  const trendByLineage = useMemo(() => {
    const trends = new Map<string, Trend>();
    for (const id of lineages.keys()) {
      const current = populationByLineageThrottled.get(id) ?? 0n;
      if (current === 0n) continue;
      trends.set(id, computeTrend(id, populationHistoryThrottled, current));
    }
    return trends;
  }, [lineages, populationByLineageThrottled, populationHistoryThrottled]);

  return (
    <section className="panel lineage-tree-panel">
      <header className="panel-header">
        <h2>Lineages</h2>
        <span className="panel-meta">
          {livingCount.toString()} living · {lineages.size.toString()} ever
        </span>
      </header>
      <div className="panel-body">
        <LineageViewToggle view={view} onChange={setView} />
        {view === 'phylogeny' ? (
          <PhylogenyView
            lineages={lineages}
            populationByLineage={populationByLineageThrottled}
            currentTick={simTickThrottled}
            selectedLineageId={selectedLineageId}
            onSelect={selectLineage}
          />
        ) : roots.length === 0 ? (
          <p className="panel-empty">no living lineages</p>
        ) : (
          <>
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
            {hiddenCount > 0 ? (
              <p className="panel-empty">+ {hiddenCount.toString()} smaller clades hidden</p>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

function LineageViewToggle({
  view,
  onChange,
}: {
  view: LineageView;
  onChange: (next: LineageView) => void;
}): React.JSX.Element {
  return (
    <div className="lineage-view-toggle" role="radiogroup" aria-label="Lineage view">
      <button
        type="button"
        role="radio"
        aria-checked={view === 'living'}
        className={`lineage-view-toggle-button${view === 'living' ? ' lineage-view-toggle-button-active' : ''}`}
        onClick={() => {
          onChange('living');
        }}
      >
        Living
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={view === 'phylogeny'}
        className={`lineage-view-toggle-button${view === 'phylogeny' ? ' lineage-view-toggle-button-active' : ''}`}
        onClick={() => {
          onChange('phylogeny');
        }}
      >
        Phylogeny
      </button>
    </div>
  );
}

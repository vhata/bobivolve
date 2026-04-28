// SubstratePanel — spatial view of the simulation. Renders the
// sub-lattice as a resource heatmap with one filled cell per (x, y)
// in the grid; every extant probe is a small dot on top, tinted by
// the colour assigned to its lineage. Polls the host's substrate
// query at a low cadence so the dashboard does not pay heartbeat-rate
// rendering cost for what is essentially a slow snapshot.
//
// Filters: the player can dim the resource heatmap or restrict which
// probes show — useful on a busy map for picking out where a
// specific clade actually lives. Filter state is shared between the
// panel and the expanded modal so toggling stays consistent.

import { useEffect, useMemo, useState } from 'react';
import type { SubstrateProbe, SubstrateResult } from '../../protocol/types.js';
import { lineageColor } from '../lineage-color.js';
import type { LineageNode } from '../sim-store.js';
import { useSimStore } from '../sim-store.js';

const REFRESH_INTERVAL_MS = 2000;
const VIEW_PX = 320;
const EXPANDED_PX = 720;

type SubstrateView = SubstrateResult & { queryId: string };

type ProbeScope = 'all' | 'selected' | 'siblings' | 'descendants';

interface MapFilters {
  readonly showResources: boolean;
  readonly probeScope: ProbeScope;
}

const DEFAULT_FILTERS: MapFilters = {
  showResources: true,
  probeScope: 'all',
};

function cellFill(value: bigint, max: bigint): string {
  if (max === 0n) return 'oklch(0.13 0.005 60)';
  const ratio = Number((value * 100n) / max) / 100;
  const clamped = Math.max(0, Math.min(1, ratio));
  const lightness = (5 + clamped * 30).toFixed(1);
  return `hsl(180, 25%, ${lightness}%)`;
}

// Compute the set of lineage ids visible under the current scope.
// 'all' returns null — sentinel meaning "no filter, render every probe."
function visibleLineages(
  scope: ProbeScope,
  selectedId: string,
  lineages: ReadonlyMap<string, LineageNode>,
): ReadonlySet<string> | null {
  if (scope === 'all') return null;
  if (scope === 'selected') return new Set([selectedId]);
  if (scope === 'siblings') {
    const me = lineages.get(selectedId);
    const visible = new Set<string>([selectedId]);
    if (me === undefined) return visible;
    for (const lineage of lineages.values()) {
      if (lineage.parentId === me.parentId) visible.add(lineage.id);
    }
    return visible;
  }
  // descendants: selected + every lineage transitively descended from it.
  const visible = new Set<string>([selectedId]);
  const childrenOf = new Map<string, string[]>();
  for (const lineage of lineages.values()) {
    if (lineage.parentId === null) continue;
    const list = childrenOf.get(lineage.parentId);
    if (list === undefined) childrenOf.set(lineage.parentId, [lineage.id]);
    else list.push(lineage.id);
  }
  const stack: string[] = [selectedId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined) break;
    const kids = childrenOf.get(id);
    if (kids === undefined) continue;
    for (const k of kids) {
      if (visible.has(k)) continue;
      visible.add(k);
      stack.push(k);
    }
  }
  return visible;
}

export function SubstratePanel(): React.JSX.Element {
  const transport = useSimStore((s) => s.transport);
  const selectedLineageId = useSimStore((s) => s.selectedLineageId);
  const lineages = useSimStore((s) => s.lineages);

  const [view, setView] = useState<SubstrateView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [filters, setFilters] = useState<MapFilters>(DEFAULT_FILTERS);

  useEffect(() => {
    if (transport === null) return;
    let cancelled = false;
    const fetch = async (): Promise<void> => {
      try {
        const result = (await transport.query({
          kind: 'substrate',
          queryId: '',
        })) as SubstrateView;
        if (!cancelled) {
          setView(result);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void fetch();
    const interval = setInterval(() => {
      void fetch();
    }, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [transport]);

  useEffect(() => {
    if (!expanded) return undefined;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
    };
  }, [expanded]);

  const visibleSet = useMemo(
    () => visibleLineages(filters.probeScope, selectedLineageId, lineages),
    [filters.probeScope, selectedLineageId, lineages],
  );

  return (
    <section className="panel substrate-panel">
      <header className="panel-header">
        <h2>Substrate</h2>
        {view !== null ? (
          <span className="panel-meta">
            {view.side.toString()}×{view.side.toString()} · {view.probes.length.toString()} probes
          </span>
        ) : null}
      </header>
      <div className="panel-body">
        <SubstrateFilters filters={filters} onChange={setFilters} />
        {error !== null ? (
          <p className="inspector-error">{error}</p>
        ) : view === null ? (
          <p className="panel-empty">…</p>
        ) : (
          <button
            type="button"
            className="substrate-trigger"
            onClick={() => setExpanded(true)}
            aria-label="Expand the substrate view"
          >
            <SubstrateGrid
              view={view}
              highlightLineageId={selectedLineageId}
              filters={filters}
              visibleSet={visibleSet}
              sizePx={VIEW_PX}
            />
          </button>
        )}
      </div>
      {expanded && view !== null ? (
        <SubstrateModal
          view={view}
          highlightLineageId={selectedLineageId}
          filters={filters}
          onFiltersChange={setFilters}
          visibleSet={visibleSet}
          onClose={() => setExpanded(false)}
        />
      ) : null}
    </section>
  );
}

function SubstrateFilters({
  filters,
  onChange,
}: {
  filters: MapFilters;
  onChange: (next: MapFilters) => void;
}): React.JSX.Element {
  const scopes: { id: ProbeScope; label: string }[] = [
    { id: 'all', label: 'all' },
    { id: 'selected', label: 'selected' },
    { id: 'siblings', label: 'siblings' },
    { id: 'descendants', label: 'descendants' },
  ];
  return (
    <div className="substrate-filters">
      <label className="substrate-toggle">
        <input
          type="checkbox"
          checked={filters.showResources}
          onChange={(e) => onChange({ ...filters, showResources: e.target.checked })}
        />
        <span>resources</span>
      </label>
      <div className="substrate-scope" role="radiogroup" aria-label="Probe scope">
        <span className="substrate-scope-label">probes:</span>
        {scopes.map((s) => (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={filters.probeScope === s.id}
            className={`substrate-scope-button${
              filters.probeScope === s.id ? ' substrate-scope-button-active' : ''
            }`}
            onClick={() => onChange({ ...filters, probeScope: s.id })}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function SubstrateModal({
  view,
  highlightLineageId,
  filters,
  onFiltersChange,
  visibleSet,
  onClose,
}: {
  view: SubstrateView;
  highlightLineageId: string;
  filters: MapFilters;
  onFiltersChange: (next: MapFilters) => void;
  visibleSet: ReadonlySet<string> | null;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <div className="substrate-modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="substrate-modal"
        role="dialog"
        aria-label="Substrate, expanded"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <header className="substrate-modal-header">
          <span>
            {view.side.toString()}×{view.side.toString()} · {view.probes.length.toString()} probes
          </span>
          <button type="button" className="load-picker-cancel" onClick={onClose}>
            close (esc)
          </button>
        </header>
        <SubstrateFilters filters={filters} onChange={onFiltersChange} />
        <SubstrateGrid
          view={view}
          highlightLineageId={highlightLineageId}
          filters={filters}
          visibleSet={visibleSet}
          sizePx={EXPANDED_PX}
        />
      </div>
    </div>
  );
}

function SubstrateGrid({
  view,
  highlightLineageId,
  filters,
  visibleSet,
  sizePx,
}: {
  view: SubstrateView;
  highlightLineageId: string;
  filters: MapFilters;
  visibleSet: ReadonlySet<string> | null;
  sizePx: number;
}): React.JSX.Element {
  const side = view.side;
  const cellPx = sizePx / side;
  const max = BigInt(view.maxResourcePerCell);

  const cellRects: React.JSX.Element[] = [];
  if (filters.showResources) {
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        const idx = y * side + x;
        const cellStr = view.cells[idx] ?? '0';
        const value = BigInt(cellStr);
        cellRects.push(
          <rect
            key={`c-${idx.toString()}`}
            x={x * cellPx}
            y={y * cellPx}
            width={cellPx}
            height={cellPx}
            fill={cellFill(value, max)}
          >
            <title>
              ({x}, {y}) — {value.toString()} resource
            </title>
          </rect>,
        );
      }
    }
  }

  const otherProbes: React.JSX.Element[] = [];
  const highlightedProbes: React.JSX.Element[] = [];
  const dotRadius = Math.max(1.5, cellPx / 4);
  const renderDot = (probe: SubstrateProbe): React.JSX.Element => {
    const cx = (probe.x + 0.5) * cellPx;
    const cy = (probe.y + 0.5) * cellPx;
    const isHighlighted = probe.lineageId === highlightLineageId;
    return (
      <circle
        key={`p-${probe.id}`}
        cx={cx}
        cy={cy}
        r={dotRadius}
        fill={lineageColor(probe.lineageId)}
        stroke={isHighlighted ? '#ffffff' : 'none'}
        strokeWidth={isHighlighted ? 1 : 0}
      >
        <title>
          {probe.id} — {probe.lineageId} @ ({probe.x}, {probe.y})
        </title>
      </circle>
    );
  };
  for (const probe of view.probes) {
    if (visibleSet !== null && !visibleSet.has(probe.lineageId)) continue;
    const node = renderDot(probe);
    if (probe.lineageId === highlightLineageId) highlightedProbes.push(node);
    else otherProbes.push(node);
  }

  return (
    <svg
      viewBox={`0 0 ${sizePx.toString()} ${sizePx.toString()}`}
      preserveAspectRatio="xMidYMid meet"
      className="substrate-svg"
      role="img"
      aria-label="Sub-lattice resource heatmap with probe overlay"
    >
      {cellRects}
      {otherProbes}
      {highlightedProbes}
    </svg>
  );
}

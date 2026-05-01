// SubstratePanel — spatial view of the simulation. Renders the
// sub-lattice as a resource heatmap with one filled cell per (x, y)
// in the grid; every extant probe is a small dot on top, tinted by
// the colour assigned to its lineage. Polls the host's substrate
// query at a low cadence so the dashboard does not pay heartbeat-rate
// rendering cost for what is essentially a slow snapshot.
//
// Renders to a <canvas> rather than SVG. With a 64×64 grid that's
// 4096 cells and the SVG path produced 8k+ DOM elements per refresh
// — every poll reconciled the entire tree, dominated DevTools' DOM
// node count, and starved the main thread under load. Canvas is one
// element and one draw pass per update. Trade-off: native SVG
// `<title>` hover tooltips are gone; if hover identification of
// individual probes becomes load-bearing, a mousemove → cell-lookup
// → custom tooltip is the path back.
//
// Filters: the player can dim the resource heatmap or restrict which
// probes show — useful on a busy map for picking out where a
// specific clade actually lives. Filter state is shared between the
// panel and the expanded modal so toggling stays consistent.

import { useEffect, useMemo, useRef, useState } from 'react';
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
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;

    // Buffer sized for the logical sizePx scaled by device pixel
    // ratio so cells and probes stay crisp on Retina displays. CSS
    // handles the display dimensions (aspect-ratio + width:100%) so
    // the canvas can shrink responsively in the expanded modal; we
    // only own the pixel buffer here.
    const dpr = window.devicePixelRatio > 1 ? window.devicePixelRatio : 1;
    canvas.width = Math.round(sizePx * dpr);
    canvas.height = Math.round(sizePx * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const side = view.side;
    const cellPx = sizePx / side;
    const max = BigInt(view.maxResourcePerCell);

    // Background: matches the SVG's previous void colour so void cells
    // and the canvas backdrop are indistinguishable.
    ctx.fillStyle = 'oklch(0.13 0.005 60)';
    ctx.fillRect(0, 0, sizePx, sizePx);

    if (filters.showResources) {
      for (let y = 0; y < side; y++) {
        for (let x = 0; x < side; x++) {
          const idx = y * side + x;
          const cellStr = view.cells[idx] ?? '0';
          const value = BigInt(cellStr);
          ctx.fillStyle = cellFill(value, max);
          // +0.5 width/height closes the seam between adjacent cells
          // when cellPx isn't an integer; the SVG version got the same
          // effect from shape-rendering: crispEdges.
          ctx.fillRect(x * cellPx, y * cellPx, cellPx + 0.5, cellPx + 0.5);
        }
      }
    }

    const dotRadius = Math.max(1.5, cellPx / 4);
    const drawProbe = (probe: SubstrateProbe, isHighlighted: boolean): void => {
      const cx = (probe.x + 0.5) * cellPx;
      const cy = (probe.y + 0.5) * cellPx;
      ctx.beginPath();
      ctx.arc(cx, cy, dotRadius, 0, Math.PI * 2);
      ctx.fillStyle = lineageColor(probe.lineageId);
      ctx.fill();
      if (isHighlighted) {
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      }
    };
    // Two passes so the highlighted lineage's probes draw on top.
    for (const probe of view.probes) {
      if (visibleSet !== null && !visibleSet.has(probe.lineageId)) continue;
      if (probe.lineageId === highlightLineageId) continue;
      drawProbe(probe, false);
    }
    for (const probe of view.probes) {
      if (visibleSet !== null && !visibleSet.has(probe.lineageId)) continue;
      if (probe.lineageId !== highlightLineageId) continue;
      drawProbe(probe, true);
    }
  }, [view, highlightLineageId, filters, visibleSet, sizePx]);

  return (
    <canvas
      ref={canvasRef}
      className="substrate-canvas"
      role="img"
      aria-label="Sub-lattice resource heatmap with probe overlay"
    />
  );
}

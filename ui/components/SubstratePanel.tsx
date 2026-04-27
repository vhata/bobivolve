// SubstratePanel — spatial view of the simulation. Renders the
// sub-lattice as a resource heatmap with one filled cell per (x, y)
// in the grid; every extant probe is a small dot on top, tinted by
// the colour assigned to its lineage. Polls the host's substrate
// query at a low cadence so the dashboard does not pay heartbeat-rate
// rendering cost for what is essentially a slow snapshot.

import { useEffect, useState } from 'react';
import type { SubstrateResult } from '../../protocol/types.js';
import { useSimStore } from '../sim-store.js';

// 2 seconds is slow enough that the worker→main payload (1024 cell
// strings + every probe's position) does not throttle user-input
// handling at production population, fast enough to feel live.
const REFRESH_INTERVAL_MS = 2000;
// Render the lattice into a fixed-size SVG; the panel scales the SVG
// rather than the cells, so the look is consistent across viewports.
const VIEW_PX = 320;

type SubstrateView = SubstrateResult & { queryId: string };

// Lay-person hue from a lineage id. Stable hash so the same id always
// produces the same colour across renders / runs / sessions. Skips a
// few starting offsets so neighbouring ids don't land on visually
// indistinguishable hues.
function lineageHue(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % 360;
}

function lineageColor(id: string): string {
  return `hsl(${lineageHue(id).toString()}, 70%, 65%)`;
}

// Resource value → cell fill. Dark when empty, brightening toward the
// `max` value the host reported. Linear in resource units; with the
// cap at 1000 and typical depleted cells in the 0–100 range, the
// gradient is most informative in the bottom of the scale.
function cellFill(value: bigint, max: bigint): string {
  if (max === 0n) return '#0e0f12';
  const ratio = Number((value * 100n) / max) / 100;
  const clamped = Math.max(0, Math.min(1, ratio));
  // Dark teal toward bright sea-green — same hue as the live-spread
  // bar in the inspector, so the dashboard's colour vocabulary stays
  // small.
  const lightness = (5 + clamped * 30).toFixed(1);
  return `hsl(180, 25%, ${lightness}%)`;
}

export function SubstratePanel(): React.JSX.Element {
  const transport = useSimStore((s) => s.transport);
  const selectedLineageId = useSimStore((s) => s.selectedLineageId);

  const [view, setView] = useState<SubstrateView | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        {error !== null ? (
          <p className="inspector-error">{error}</p>
        ) : view === null ? (
          <p className="panel-empty">…</p>
        ) : (
          <SubstrateGrid view={view} highlightLineageId={selectedLineageId} />
        )}
      </div>
    </section>
  );
}

function SubstrateGrid({
  view,
  highlightLineageId,
}: {
  view: SubstrateView;
  highlightLineageId: string;
}): React.JSX.Element {
  const side = view.side;
  const cellPx = VIEW_PX / side;
  const max = BigInt(view.maxResourcePerCell);

  // Render order: cells (heatmap rectangles) first, probes (lineage
  // dots) on top, with the highlighted lineage's dots drawn last so
  // they sit visually above neighbours.
  const cellRects: React.JSX.Element[] = [];
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

  const otherProbes: React.JSX.Element[] = [];
  const highlightedProbes: React.JSX.Element[] = [];
  const dotRadius = Math.max(1.5, cellPx / 4);
  for (const probe of view.probes) {
    const cx = (probe.x + 0.5) * cellPx;
    const cy = (probe.y + 0.5) * cellPx;
    const isHighlighted = probe.lineageId === highlightLineageId;
    const node = (
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
    if (isHighlighted) highlightedProbes.push(node);
    else otherProbes.push(node);
  }

  return (
    <svg
      viewBox={`0 0 ${VIEW_PX.toString()} ${VIEW_PX.toString()}`}
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

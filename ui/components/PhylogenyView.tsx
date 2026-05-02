// PhylogenyView — retrospective branching diagram of every lineage
// the run has produced. Counterpart to the living-lineages tree:
// where the living tree is a present-tense glance, the phylogeny
// answers "how did we get here?".
//
// X axis: simulation tick. Y axis: lineage row, ordered by depth-first
// pre-order traversal so children sit immediately under their parent
// and sibling clades read top-to-bottom by founding order.
//
// Each lineage renders as:
//   - a vertical connector at its founding tick from its parent's row
//     to its own row (for non-root lineages)
//   - a horizontal lifeline from foundedAtTick to its endTick:
//       endTick = extinctionTick if the lineage went extinct in this
//                  session,
//                = currentTick if the lineage is still alive,
//                = foundedAtTick (a dot) if the lineage is currently
//                  unpopulated but the session has no extinction
//                  record (e.g. a Load restored a state where the
//                  lineage was already gone — the lineageTree query
//                  doesn't carry historical extinctionTick).
//
// Renders to a `<canvas>`, not SVG. The first cut shipped as SVG and
// proved that at fat lineage counts (~1800 ever) the per-throttle
// rebuild reconciles thousands of nested SVG elements and saturates
// the main thread — the same DOM-churn pattern we eliminated from
// the living lineage tree. Canvas is one element and one draw pass
// per update; click-to-select maps the pointer-Y onto a row index
// instead of using DOM listeners. Trade-off: no `<title>` hover
// tooltips; if those become load-bearing, mousemove → row-lookup →
// custom tooltip is the path back.

import { useEffect, useMemo, useRef } from 'react';
import { lineageColor } from '../lineage-color.js';
import type { LineageNode } from '../sim-store.js';

const ROW_HEIGHT = 14;
const ROW_PADDING = 8; // top/bottom gutter
const LEFT_PADDING = 4;
const RIGHT_PADDING = 4;
// Hard cap on rendered rows. Browsers limit canvas dimensions
// (Chrome / Firefox cap a single dimension around 32,767 px); a long
// run can produce tens of thousands of lineages, and at ROW_HEIGHT=14
// even a few thousand rows blow past the limit and the canvas paints
// blank. Cap to 1500 rows (≈ 21,000 px tall) which sits comfortably
// below the ceiling, and surface the dropped count as a footer. A
// scaling design (dynamic row height, virtualisation, or decimation
// by foundedAtTick) is logged in TODO.md as future polish.
const MAX_RENDERED_ROWS = 1500;

interface LayoutEntry {
  readonly lineage: LineageNode;
  readonly row: number;
  readonly endTick: bigint;
  readonly alive: boolean;
}

interface Layout {
  readonly entries: readonly LayoutEntry[];
  readonly minTick: bigint;
  readonly maxTick: bigint;
  readonly rowsTotal: number;
  // Lineages truncated past MAX_RENDERED_ROWS, surfaced as a footer
  // so the player knows the canvas isn't a complete history.
  readonly truncatedCount: number;
  // row index → lineage id, for click-to-select.
  readonly idByRow: readonly string[];
  readonly rowById: ReadonlyMap<string, number>;
}

function buildLayout(
  lineages: ReadonlyMap<string, LineageNode>,
  populationByLineage: ReadonlyMap<string, bigint>,
  currentTick: bigint,
): Layout {
  // Children grouped by parent id (null for the founding lineage).
  // Child arrays sorted by foundedAtTick then id so the layout is
  // deterministic and stable across rebuilds.
  const childrenOf = new Map<string | null, LineageNode[]>();
  for (const lineage of lineages.values()) {
    const list = childrenOf.get(lineage.parentId);
    if (list === undefined) childrenOf.set(lineage.parentId, [lineage]);
    else list.push(lineage);
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) => {
      if (a.foundedAtTick !== b.foundedAtTick) {
        return a.foundedAtTick < b.foundedAtTick ? -1 : 1;
      }
      return a.id.localeCompare(b.id);
    });
  }

  // Pre-order DFS from the root (founder). Row index increments as we
  // visit each lineage; children come immediately after their parent.
  // Once we've allocated MAX_RENDERED_ROWS rows the rest are dropped
  // and counted for the footer; we keep walking only to count, not to
  // emit entries.
  const entries: LayoutEntry[] = [];
  const idByRow: string[] = [];
  const rowById = new Map<string, number>();
  let minTick = 0n;
  let maxTick = currentTick;
  let row = 0;
  let truncatedCount = 0;
  function visit(parentId: string | null): void {
    const children = childrenOf.get(parentId) ?? [];
    for (const lineage of children) {
      if (row >= MAX_RENDERED_ROWS) {
        truncatedCount += 1;
        visit(lineage.id);
        continue;
      }
      const population = populationByLineage.get(lineage.id) ?? 0n;
      const alive = population > 0n;
      let endTick: bigint;
      if (alive) {
        endTick = currentTick;
      } else if (lineage.extinctionTick !== null) {
        endTick = lineage.extinctionTick;
      } else {
        // No recorded extinction tick. Render as a single point at
        // the founding tick so the dot sits on the speciation moment
        // and the eye doesn't draw a misleading lifeline.
        endTick = lineage.foundedAtTick;
      }
      if (lineage.foundedAtTick > maxTick) maxTick = lineage.foundedAtTick;
      if (endTick > maxTick) maxTick = endTick;
      if (lineage.foundedAtTick < minTick) minTick = lineage.foundedAtTick;
      entries.push({ lineage, row, endTick, alive });
      idByRow.push(lineage.id);
      rowById.set(lineage.id, row);
      row += 1;
      visit(lineage.id);
    }
  }
  visit(null);

  return {
    entries,
    minTick,
    maxTick,
    rowsTotal: entries.length,
    truncatedCount,
    idByRow,
    rowById,
  };
}

interface PhylogenyViewProps {
  readonly lineages: ReadonlyMap<string, LineageNode>;
  readonly populationByLineage: ReadonlyMap<string, bigint>;
  readonly currentTick: bigint;
  readonly selectedLineageId: string;
  readonly onSelect: (id: string) => void;
}

export function PhylogenyView({
  lineages,
  populationByLineage,
  currentTick,
  selectedLineageId,
  onSelect,
}: PhylogenyViewProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const layout = useMemo(
    () => buildLayout(lineages, populationByLineage, currentTick),
    [lineages, populationByLineage, currentTick],
  );

  const svgHeight = layout.rowsTotal * ROW_HEIGHT + ROW_PADDING * 2;

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (canvas === null || container === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    const width = container.clientWidth > 0 ? container.clientWidth : 540;
    const dpr = window.devicePixelRatio > 1 ? window.devicePixelRatio : 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(svgHeight * dpr);
    canvas.style.width = `${width.toString()}px`;
    canvas.style.height = `${svgHeight.toString()}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Background
    ctx.fillStyle = 'oklch(0.24 0.008 60)';
    ctx.fillRect(0, 0, width, svgHeight);

    if (layout.entries.length === 0) return;

    const tickRange = layout.maxTick > layout.minTick ? layout.maxTick - layout.minTick : 1n;
    const drawableWidth = width - LEFT_PADDING - RIGHT_PADDING;
    const xOf = (tick: bigint): number => {
      if (tickRange === 0n) return LEFT_PADDING;
      const num = (tick - layout.minTick) * BigInt(Math.round(drawableWidth * 1000));
      return LEFT_PADDING + Number(num / tickRange) / 1000;
    };
    const yOf = (row: number): number => ROW_PADDING + row * ROW_HEIGHT + ROW_HEIGHT / 2;

    // Highlight the selected row's hit-rect first so the lineage
    // lines draw on top.
    const selectedRow = layout.rowById.get(selectedLineageId);
    if (selectedRow !== undefined) {
      ctx.fillStyle = 'oklch(0.78 0.09 220 / 0.18)';
      ctx.fillRect(0, yOf(selectedRow) - ROW_HEIGHT / 2, width, ROW_HEIGHT);
    }

    // "Now" marker — faint dashed line at currentTick.
    const nowX = xOf(currentTick);
    ctx.strokeStyle = 'oklch(0.82 0.11 75 / 0.55)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(nowX, 0);
    ctx.lineTo(nowX, svgHeight);
    ctx.stroke();
    ctx.setLineDash([]);

    // Per-lineage: branch + lifeline.
    for (const entry of layout.entries) {
      const colour = lineageColor(entry.lineage.id);
      const x0 = xOf(entry.lineage.foundedAtTick);
      const x1 = xOf(entry.endTick);
      const y = yOf(entry.row);
      const parentRow =
        entry.lineage.parentId === null
          ? null
          : (layout.rowById.get(entry.lineage.parentId) ?? null);

      // Speciation branch from parent's row to own row at foundedAtTick.
      if (parentRow !== null) {
        ctx.strokeStyle = colour;
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        ctx.moveTo(x0, yOf(parentRow));
        ctx.lineTo(x0, y);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // Lifeline.
      if (x1 > x0) {
        ctx.strokeStyle = colour;
        ctx.lineCap = 'round';
        if (entry.alive) {
          ctx.lineWidth = 2;
          ctx.globalAlpha = 1;
          ctx.beginPath();
          ctx.moveTo(x0, y);
          ctx.lineTo(x1, y);
          ctx.stroke();
        } else {
          ctx.lineWidth = 1.5;
          ctx.globalAlpha = 0.55;
          ctx.setLineDash([3, 2]);
          ctx.beginPath();
          ctx.moveTo(x0, y);
          ctx.lineTo(x1, y);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        }
      } else {
        // Dot at the founding tick for lineages we don't have a
        // lifeline-end for.
        ctx.fillStyle = colour;
        ctx.beginPath();
        ctx.arc(x0, y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, [layout, currentTick, selectedLineageId, svgHeight]);

  // Click-to-select. Map pointer-Y → row index; null if outside any
  // row's vertical band.
  const onClickCanvas = (event: React.MouseEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const rect = canvas.getBoundingClientRect();
    const y = event.clientY - rect.top;
    const rowFloat = (y - ROW_PADDING) / ROW_HEIGHT;
    const row = Math.floor(rowFloat);
    if (row < 0 || row >= layout.idByRow.length) return;
    const id = layout.idByRow[row];
    if (id !== undefined) onSelect(id);
  };

  if (layout.entries.length === 0) {
    return <p className="panel-empty">no lineages yet</p>;
  }

  return (
    <div className="phylogeny" ref={containerRef}>
      <canvas
        ref={canvasRef}
        className="phylogeny-canvas"
        role="img"
        aria-label="Phylogeny — every lineage on a tick axis"
        onClick={onClickCanvas}
      />
      {layout.truncatedCount > 0 ? (
        <p className="panel-empty">
          + {layout.truncatedCount.toString()} lineages past row {MAX_RENDERED_ROWS.toString()} not
          rendered (long-run scaling is logged as future work)
        </p>
      ) : null}
    </div>
  );
}

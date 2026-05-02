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
// SVG, not canvas: the data only changes on speciation and extinction
// events (rare relative to heartbeats), so the per-update cost is
// proportional to lineage count, not heartbeat rate. If long runs
// outgrow what the SVG reconciler can chew, a canvas variant has
// the same shape — both store-driven, no per-element interactions
// other than click-to-select.

import { useMemo, useRef, useState } from 'react';
import { lineageColor } from '../lineage-color.js';
import type { LineageNode } from '../sim-store.js';

const ROW_HEIGHT = 14;
const ROW_PADDING = 8; // top/bottom gutter
const LEFT_PADDING = 4;
const RIGHT_PADDING = 4;
const DEFAULT_PIXEL_WIDTH = 540;

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
  const entries: LayoutEntry[] = [];
  let minTick = 0n;
  let maxTick = currentTick;
  let row = 0;
  function visit(parentId: string | null): void {
    const children = childrenOf.get(parentId) ?? [];
    for (const lineage of children) {
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
      row += 1;
      visit(lineage.id);
    }
  }
  visit(null);

  return { entries, minTick, maxTick, rowsTotal: entries.length };
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
  const containerRef = useRef<HTMLDivElement | null>(null);
  // The phylogeny scales horizontally to its container. We measure on
  // mount and on the next throttled rebuild; the SVG itself uses a
  // viewBox so an exact width isn't critical — sizes the rendering
  // resolution, not the layout.
  const [pixelWidth, setPixelWidth] = useState<number>(DEFAULT_PIXEL_WIDTH);

  const layout = useMemo(
    () => buildLayout(lineages, populationByLineage, currentTick),
    [lineages, populationByLineage, currentTick],
  );

  const tickRange = layout.maxTick > layout.minTick ? layout.maxTick - layout.minTick : 1n;

  const xOf = (tick: bigint): number => {
    if (tickRange === 0n) return LEFT_PADDING;
    const drawableWidth = pixelWidth - LEFT_PADDING - RIGHT_PADDING;
    const num = (tick - layout.minTick) * BigInt(Math.round(drawableWidth * 1000));
    return LEFT_PADDING + Number(num / tickRange) / 1000;
  };
  const yOf = (row: number): number => ROW_PADDING + row * ROW_HEIGHT + ROW_HEIGHT / 2;

  const svgHeight = layout.rowsTotal * ROW_HEIGHT + ROW_PADDING * 2;

  if (layout.entries.length === 0) {
    return <p className="panel-empty">no lineages yet</p>;
  }

  const lineageRowById = new Map<string, number>();
  for (const entry of layout.entries) lineageRowById.set(entry.lineage.id, entry.row);

  return (
    <div
      className="phylogeny"
      ref={(el) => {
        containerRef.current = el;
        if (el !== null && el.clientWidth > 0 && el.clientWidth !== pixelWidth) {
          setPixelWidth(el.clientWidth);
        }
      }}
    >
      <svg
        className="phylogeny-svg"
        viewBox={`0 0 ${pixelWidth.toString()} ${svgHeight.toString()}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Phylogeny — every lineage on a tick axis"
        style={{ height: `${svgHeight.toString()}px` }}
      >
        {/* Faint grid line at the right edge (currentTick) so the
            player can see the present moment relative to the lifelines. */}
        <line
          x1={xOf(currentTick)}
          x2={xOf(currentTick)}
          y1={0}
          y2={svgHeight}
          className="phylogeny-now"
        />
        {layout.entries.map((entry) => {
          const parentId = entry.lineage.parentId;
          const parentRow = parentId === null ? null : (lineageRowById.get(parentId) ?? null);
          const x0 = xOf(entry.lineage.foundedAtTick);
          const x1 = xOf(entry.endTick);
          const y = yOf(entry.row);
          const colour = lineageColor(entry.lineage.id);
          const selected = entry.lineage.id === selectedLineageId;
          const lifelineClass = entry.alive ? 'phylogeny-lifeline' : 'phylogeny-lifeline-dead';
          return (
            <g
              key={entry.lineage.id}
              className={selected ? 'phylogeny-row phylogeny-row-selected' : 'phylogeny-row'}
              onClick={() => {
                onSelect(entry.lineage.id);
              }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(entry.lineage.id);
                }
              }}
            >
              {/* A wide invisible row-rect is the click/hover target so
                  thin lifelines aren't fiddly to hit. */}
              <rect
                x={0}
                y={y - ROW_HEIGHT / 2}
                width={pixelWidth}
                height={ROW_HEIGHT}
                className="phylogeny-hit"
              />
              {parentRow !== null ? (
                <line
                  x1={x0}
                  x2={x0}
                  y1={yOf(parentRow)}
                  y2={y}
                  className="phylogeny-branch"
                  stroke={colour}
                />
              ) : null}
              {x1 > x0 ? (
                <line x1={x0} x2={x1} y1={y} y2={y} className={lifelineClass} stroke={colour} />
              ) : (
                <circle cx={x0} cy={y} r={2.5} className="phylogeny-dot" fill={colour} />
              )}
              <title>
                {entry.lineage.name}
                {entry.lineage.name !== entry.lineage.id ? ` (${entry.lineage.id})` : ''}
                {' · forked at tick '}
                {entry.lineage.foundedAtTick.toString()}
                {entry.alive ? ' · alive' : ''}
                {!entry.alive && entry.lineage.extinctionTick !== null
                  ? ` · extinct at tick ${entry.lineage.extinctionTick.toString()}`
                  : ''}
              </title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

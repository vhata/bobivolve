// PopulationPanel — population summary with a sparkline-style total-over
// time chart and a per-lineage count list below. The chart reads from the
// store's bounded populationHistory buffer; the list reads the latest
// snapshot.
//
// The list shows the top LINEAGE_LIST_LIMIT lineages by current count.
// At fat population there can be hundreds of living lineages and
// rendering every one as an <li> on every heartbeat saturates React
// reconciliation; the player only needs the dominant clades at a
// glance, with a "+ N more" footer pointing at the lineage tree for
// the full picture.

import { lineageColor } from '../lineage-color.js';
import { useSimStore } from '../sim-store.js';
import type { PopulationHistoryPoint } from '../sim-store.js';

const CHART_WIDTH = 400;
const CHART_HEIGHT = 80;
const LINEAGE_LIST_LIMIT = 12;

function buildAreaPath(history: readonly PopulationHistoryPoint[]): string | null {
  if (history.length < 2) return null;
  const first = history[0];
  const last = history[history.length - 1];
  if (first === undefined || last === undefined) return null;

  const minTick = first.tick;
  const maxTick = last.tick;
  const tickRange = maxTick > minTick ? maxTick - minTick : 1n;
  let maxTotal = 1n;
  for (const point of history) {
    if (point.total > maxTotal) maxTotal = point.total;
  }

  const xOf = (tick: bigint): number => {
    const num = (tick - minTick) * BigInt(CHART_WIDTH * 1000);
    return Number(num / tickRange) / 1000;
  };
  const yOf = (value: bigint): number => {
    const num = value * BigInt(CHART_HEIGHT * 1000);
    return CHART_HEIGHT - Number(num / maxTotal) / 1000;
  };

  const points = history
    .map((p) => `${xOf(p.tick).toFixed(2)},${yOf(p.total).toFixed(2)}`)
    .join(' L');
  return `M0,${CHART_HEIGHT.toString()} L${points} L${CHART_WIDTH.toString()},${CHART_HEIGHT.toString()} Z`;
}

export function PopulationPanel(): React.JSX.Element {
  const simTick = useSimStore((s) => s.simTick);
  const populationTotal = useSimStore((s) => s.populationTotal);
  const populationByLineage = useSimStore((s) => s.populationByLineage);
  const populationHistory = useSimStore((s) => s.populationHistory);

  const allLineages = [...populationByLineage.entries()].sort((a, b) => {
    if (a[1] !== b[1]) return Number(b[1] - a[1]);
    return a[0].localeCompare(b[0]);
  });
  const visibleLineages = allLineages.slice(0, LINEAGE_LIST_LIMIT);
  const hiddenCount = allLineages.length - visibleLineages.length;

  const areaPath = buildAreaPath(populationHistory);

  return (
    <section className="panel population-panel">
      <header className="panel-header">
        <h2>Population</h2>
        <span className="panel-meta">simTick {simTick.toString()}</span>
      </header>
      <div className="panel-body">
        <p className="population-total">{populationTotal.toString()} probes</p>
        {areaPath !== null ? (
          <svg
            className="population-chart"
            viewBox={`0 0 ${CHART_WIDTH.toString()} ${CHART_HEIGHT.toString()}`}
            preserveAspectRatio="none"
            role="img"
            aria-label="Population over time"
          >
            <path d={areaPath} className="population-chart-area" />
          </svg>
        ) : (
          <div className="population-chart-placeholder" aria-hidden="true" />
        )}
        {allLineages.length === 0 ? (
          <p className="panel-empty">awaiting first heartbeat…</p>
        ) : (
          <>
            <ul className="lineage-list">
              {visibleLineages.map(([id, count]) => (
                <li key={id}>
                  <span className="lineage-id">
                    <span
                      className="lineage-swatch"
                      style={{ background: lineageColor(id) }}
                      aria-hidden="true"
                    />
                    {id}
                  </span>
                  <span className="lineage-count">{count.toString()}</span>
                </li>
              ))}
            </ul>
            {hiddenCount > 0 ? (
              <p className="panel-empty">+ {hiddenCount.toString()} more in the lineage tree</p>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

// PopulationPanel — first panel. Shows simTick, population total, and a
// per-lineage breakdown. Reads only what it needs from the store, so a
// per-replication event that updates the map will rerender this panel
// but not unrelated ones.

import { useSimStore } from '../sim-store.js';

export function PopulationPanel(): React.JSX.Element {
  const simTick = useSimStore((s) => s.simTick);
  const populationTotal = useSimStore((s) => s.populationTotal);
  const populationByLineage = useSimStore((s) => s.populationByLineage);

  const lineages = [...populationByLineage.entries()].sort((a, b) => {
    if (a[1] !== b[1]) return Number(b[1] - a[1]);
    return a[0].localeCompare(b[0]);
  });

  return (
    <section className="panel population-panel">
      <header className="panel-header">
        <h2>Population</h2>
        <span className="panel-meta">simTick {simTick.toString()}</span>
      </header>
      <div className="panel-body">
        <p className="population-total">{populationTotal.toString()} probes</p>
        {lineages.length === 0 ? (
          <p className="panel-empty">awaiting first heartbeat…</p>
        ) : (
          <ul className="lineage-list">
            {lineages.map(([id, count]) => (
              <li key={id}>
                <span className="lineage-id">{id}</span>
                <span className="lineage-count">{count.toString()}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

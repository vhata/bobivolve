// DriftTelemetryPanel — pick a lineage, see how its parameters have
// diverged from their reference (set at speciation). Each parameter
// renders as a horizontal range bar: reference value as a tick, min-max
// span as a bar, mean as a dot.
//
// Pull-only: the panel queries on demand and on lineage selection rather
// than projecting drift state into the store. Re-querying every few ticks
// would also be reasonable; left to a follow-up if it earns its keep.

import { useEffect, useMemo, useState } from 'react';
import type { DriftTelemetry, DriftTelemetryResult } from '../../protocol/types.js';
import { useSimStore } from '../sim-store.js';

const RANGE_PX = 200;

interface RangeViewProps {
  readonly reference: bigint;
  readonly min: bigint;
  readonly max: bigint;
  readonly mean: bigint;
}

function RangeView({ reference, min, max, mean }: RangeViewProps): React.JSX.Element {
  // Span the bar over [reference - delta, reference + delta] where delta
  // is the larger of |reference - min| and |max - reference|, clamped to
  // a minimum so a no-drift lineage still renders sensibly.
  const deltaLow = reference > min ? reference - min : 0n;
  const deltaHigh = max > reference ? max - reference : 0n;
  let span = deltaLow > deltaHigh ? deltaLow : deltaHigh;
  if (span === 0n) span = reference / 100n + 1n;
  const lo = reference > span ? reference - span : 0n;
  const hi = reference + span;
  const range = hi - lo === 0n ? 1n : hi - lo;

  const project = (value: bigint): number => {
    const clamped = value < lo ? lo : value > hi ? hi : value;
    const num = (clamped - lo) * BigInt(RANGE_PX * 1000);
    return Number(num / range) / 1000;
  };

  const xMin = project(min);
  const xMax = project(max);
  const xMean = project(mean);
  const xRef = project(reference);

  return (
    <svg
      viewBox={`0 0 ${RANGE_PX.toString()} 24`}
      preserveAspectRatio="none"
      className="drift-range"
      role="img"
      aria-label="Parameter range"
    >
      <line x1={0} x2={RANGE_PX} y1={12} y2={12} className="drift-axis" />
      <line x1={xMin} x2={xMax} y1={12} y2={12} className="drift-span" />
      <line x1={xRef} x2={xRef} y1={4} y2={20} className="drift-reference" />
      <circle cx={xMean} cy={12} r={3} className="drift-mean" />
    </svg>
  );
}

interface ParamRowProps {
  readonly name: string;
  readonly reference: bigint;
  readonly min: bigint;
  readonly max: bigint;
  readonly mean: bigint;
}

function ParamRow({ name, reference, min, max, mean }: ParamRowProps): React.JSX.Element {
  const driftPct = reference === 0n ? 0 : Number(((mean - reference) * 10000n) / reference) / 100;
  return (
    <div className="drift-row">
      <div className="drift-row-header">
        <span className="param-key">{name}</span>
        <span className="drift-pct">
          {driftPct >= 0 ? '+' : ''}
          {driftPct.toFixed(2)}%
        </span>
      </div>
      <RangeView reference={reference} min={min} max={max} mean={mean} />
      <div className="drift-row-stats">
        <span>min {min.toString()}</span>
        <span>mean {mean.toString()}</span>
        <span>max {max.toString()}</span>
      </div>
    </div>
  );
}

export function DriftTelemetryPanel(): React.JSX.Element {
  const transport = useSimStore((s) => s.transport);
  const lineages = useSimStore((s) => s.lineages);
  const lineageIds = useMemo(() => [...lineages.keys()].sort(), [lineages]);

  const [selected, setSelected] = useState<string>('L0');
  const [drift, setDrift] = useState<DriftTelemetry | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!lineageIds.includes(selected) && lineageIds[0] !== undefined) {
      setSelected(lineageIds[0]);
    }
  }, [lineageIds, selected]);

  useEffect(() => {
    if (transport === null) return;
    let cancelled = false;
    setPending(true);
    setError(null);
    void transport
      .query({ kind: 'driftTelemetry', queryId: '', lineageId: selected })
      .then((result) => {
        if (cancelled) return;
        const r = result as DriftTelemetryResult & { queryId: string };
        setDrift(r.drift);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [transport, selected]);

  return (
    <section className="panel drift-panel">
      <header className="panel-header">
        <h2>Drift</h2>
        <select
          className="lineage-select"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          aria-label="Lineage"
        >
          {lineageIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </header>
      <div className="panel-body">
        {error !== null ? (
          <p className="inspector-error">{error}</p>
        ) : drift === null && !pending ? (
          <p className="panel-empty">no probes in {selected}</p>
        ) : drift === null ? (
          <p className="panel-empty">…</p>
        ) : (
          <>
            <p className="drift-population">
              {drift.population.toString()} extant probe{drift.population === 1n ? '' : 's'}
            </p>
            {Object.entries(drift.parameters).length === 0 ? (
              <p className="panel-empty">no parameters to track yet</p>
            ) : (
              Object.entries(drift.parameters).map(([name, p]) => (
                <ParamRow
                  key={name}
                  name={name}
                  reference={BigInt(p.reference)}
                  min={BigInt(p.min)}
                  max={BigInt(p.max)}
                  mean={BigInt(p.mean)}
                />
              ))
            )}
          </>
        )}
      </div>
    </section>
  );
}

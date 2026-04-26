// LineageInspectorPanel — the merged successor of the old per-probe
// inspector and the per-lineage drift panel. Selection is driven by
// clicking a lineage in the tree; the selected lineage is the one whose
// firmware, drift envelope, and identity show here.
//
// Why lineage-level instead of probe-level: probes within a lineage are
// "close enough to the lineage's reference firmware" by definition —
// once a probe drifts past the divergence threshold it speciates into a
// new lineage. The interesting unit of evolutionary attention is
// therefore the lineage, not the individual probe. Per-probe inspection
// has uses (chasing outliers, debugging) but is a drill-down concern;
// the dashboard's primary inspector is lineage-shaped.

import { useEffect, useState } from 'react';
import type { DriftTelemetry, DriftTelemetryResult } from '../../protocol/types.js';
import { useSimStore } from '../sim-store.js';

const RANGE_PX = 220;
const REFRESH_INTERVAL_MS = 1500;

function describeReplicateRate(thresholdStr: string): string {
  const t = BigInt(thresholdStr);
  const probabilityPerTick = Number(t) / 2 ** 64;
  return `replicates ≈ ${(probabilityPerTick * 100).toFixed(3)}% per tick`;
}

interface RangeViewProps {
  readonly reference: bigint;
  readonly min: bigint;
  readonly max: bigint;
  readonly mean: bigint;
}

function RangeView({ reference, min, max, mean }: RangeViewProps): React.JSX.Element {
  // Span the bar over [reference - delta, reference + delta] where delta
  // is max(|reference - min|, |max - reference|), clamped to a minimum
  // so a no-drift lineage still renders sensibly.
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

  return (
    <svg
      viewBox={`0 0 ${RANGE_PX.toString()} 24`}
      preserveAspectRatio="none"
      className="drift-range"
      role="img"
      aria-label="Parameter range"
    >
      <line x1={0} x2={RANGE_PX} y1={12} y2={12} className="drift-axis" />
      <line x1={project(min)} x2={project(max)} y1={12} y2={12} className="drift-span" />
      <line
        x1={project(reference)}
        x2={project(reference)}
        y1={4}
        y2={20}
        className="drift-reference"
      />
      <circle cx={project(mean)} cy={12} r={3} className="drift-mean" />
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

export function LineageInspectorPanel(): React.JSX.Element {
  const transport = useSimStore((s) => s.transport);
  const lineages = useSimStore((s) => s.lineages);
  const selectedLineageId = useSimStore((s) => s.selectedLineageId);

  const [drift, setDrift] = useState<DriftTelemetry | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-query on selection change and on a 1.5s interval so the drift
  // numbers stay live as the sim advances.
  useEffect(() => {
    if (transport === null) return;
    let cancelled = false;
    const fetch = async (): Promise<void> => {
      try {
        const result = (await transport.query({
          kind: 'driftTelemetry',
          queryId: '',
          lineageId: selectedLineageId,
        })) as DriftTelemetryResult & { queryId: string };
        if (!cancelled) {
          setDrift(result.drift);
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
  }, [transport, selectedLineageId]);

  const lineage = lineages.get(selectedLineageId);
  const referenceThreshold = drift?.parameters['replicate.threshold']?.reference ?? null;

  return (
    <section className="panel inspector-panel">
      <header className="panel-header">
        <h2>Lineage</h2>
        {lineage !== undefined ? (
          <span className="panel-meta">
            {lineage.name}
            {lineage.name !== lineage.id ? ` · ${lineage.id}` : ''}
          </span>
        ) : null}
      </header>
      <div className="panel-body">
        {error !== null ? (
          <p className="inspector-error">{error}</p>
        ) : lineage === undefined ? (
          <p className="panel-empty">unknown lineage {selectedLineageId}</p>
        ) : (
          <>
            <dl className="inspector-detail">
              <div>
                <dt>founder</dt>
                <dd>{lineage.founderProbeId}</dd>
              </div>
              <div>
                <dt>founded at</dt>
                <dd>tick {lineage.foundedAtTick.toString()}</dd>
              </div>
              <div>
                <dt>parent</dt>
                <dd>{lineage.parentId ?? '—'}</dd>
              </div>
              <div>
                <dt>members</dt>
                <dd>{drift !== null ? `${drift.population.toString()} extant` : '…'}</dd>
              </div>
              <div>
                <dt>firmware</dt>
                <dd>
                  {referenceThreshold !== null ? describeReplicateRate(referenceThreshold) : '…'}
                </dd>
              </div>
            </dl>
            {drift !== null && Object.keys(drift.parameters).length > 0 ? (
              <div className="lineage-drift">
                <h3 className="subhead">Drift</h3>
                {Object.entries(drift.parameters).map(([name, p]) => (
                  <ParamRow
                    key={name}
                    name={name}
                    reference={BigInt(p.reference)}
                    min={BigInt(p.min)}
                    max={BigInt(p.max)}
                    mean={BigInt(p.mean)}
                  />
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

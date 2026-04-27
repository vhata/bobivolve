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

import { useEffect, useRef, useState } from 'react';
import type { DriftTelemetry, DriftTelemetryResult } from '../../protocol/types.js';
import { useSimStore } from '../sim-store.js';
import { PatchEditorModal } from './PatchEditorModal.js';

const BAR_PX = 220;
const SPARK_PX_W = 220;
const SPARK_PX_H = 36;
const SPARK_HISTORY = 60;
const REFRESH_INTERVAL_MS = 1500;

// Plain-language summary of a parameter for the inspector's firmware
// row. Each entry is the lineage's reference (frozen at speciation)
// expressed in a unit a player can reason about.
function describeParameter(key: string, valueStr: string): string {
  const v = BigInt(valueStr);
  switch (key) {
    case 'replicate.threshold':
      return `replicates at energy ≥ ${v.toString()}`;
    case 'gather.rate':
      return `gathers up to ${v.toString()} energy per tick`;
    case 'explore.threshold': {
      const probabilityPerTick = Number(v) / 2 ** 64;
      return `wanders ≈ ${(probabilityPerTick * 100).toFixed(2)}% of ticks`;
    }
    default:
      return `${key} = ${v.toString()}`;
  }
}

function thresholdPercent(divisorStr: string): number {
  const divisor = Number(BigInt(divisorStr));
  if (divisor <= 0) return 0;
  return 100 / divisor;
}

function driftPercent(reference: bigint, value: bigint): number {
  if (reference === 0n) return 0;
  return Number(((value - reference) * 100_000n) / reference) / 1000;
}

// Map a value in [reference - threshold, reference + threshold] onto
// [0, BAR_PX]. Values outside the threshold envelope are clamped to the
// edges; in practice this should not happen, since a probe whose
// firmware exceeds the threshold would have speciated into a new
// lineage at birth.
function projectBar(value: bigint, reference: bigint, thresholdSpan: bigint): number {
  const lo = reference > thresholdSpan ? reference - thresholdSpan : 0n;
  const hi = reference + thresholdSpan;
  const range = hi - lo === 0n ? 1n : hi - lo;
  const clamped = value < lo ? lo : value > hi ? hi : value;
  return Number(((clamped - lo) * BigInt(BAR_PX * 1000)) / range) / 1000;
}

interface DriftBarProps {
  readonly reference: bigint;
  readonly min: bigint;
  readonly max: bigint;
  readonly mean: bigint;
  readonly divisor: bigint;
}

function DriftBar({ reference, min, max, mean, divisor }: DriftBarProps): React.JSX.Element {
  // Frame is fixed at the speciation envelope: [reference - reference/divisor,
  // reference + reference/divisor]. The reference sits dead centre, the
  // edges mark the threshold beyond which a probe would speciate.
  const thresholdSpan = divisor > 0n ? reference / divisor : 1n;
  const refX = projectBar(reference, reference, thresholdSpan);
  const minX = projectBar(min, reference, thresholdSpan);
  const maxX = projectBar(max, reference, thresholdSpan);
  const meanX = projectBar(mean, reference, thresholdSpan);
  return (
    <svg
      viewBox={`0 0 ${BAR_PX.toString()} 24`}
      preserveAspectRatio="none"
      className="drift-bar"
      role="img"
      aria-label="Drift envelope: edges mark the speciation threshold; the bar is the live spread; the dot is the mean."
    >
      {/* Speciation edges */}
      <line x1={1} x2={1} y1={2} y2={22} className="drift-edge">
        <title>speciation edge (low)</title>
      </line>
      <line x1={BAR_PX - 1} x2={BAR_PX - 1} y1={2} y2={22} className="drift-edge">
        <title>speciation edge (high)</title>
      </line>
      {/* Axis */}
      <line x1={0} x2={BAR_PX} y1={12} y2={12} className="drift-axis" />
      {/* Live spread */}
      <line x1={minX} x2={maxX} y1={12} y2={12} className="drift-span">
        <title>live spread across extant members</title>
      </line>
      {/* Founder reference */}
      <line x1={refX} x2={refX} y1={5} y2={19} className="drift-reference">
        <title>founder firmware (reference)</title>
      </line>
      {/* Mean dot */}
      <circle cx={meanX} cy={12} r={3} className="drift-mean">
        <title>mean across extant members</title>
      </circle>
    </svg>
  );
}

interface SparklineProps {
  readonly samples: readonly number[];
  readonly thresholdPct: number;
}

function Sparkline({ samples, thresholdPct }: SparklineProps): React.JSX.Element {
  // Y axis: ±thresholdPct percent (the speciation envelope). Centre line
  // is zero drift. Samples that exceed are clamped — same reasoning as
  // the bar: out-of-envelope members would have speciated already.
  const max = thresholdPct === 0 ? 1 : thresholdPct;
  const points = samples.map((value, index) => {
    const x = samples.length <= 1 ? SPARK_PX_W / 2 : (index / (samples.length - 1)) * SPARK_PX_W;
    const clamped = Math.max(-max, Math.min(max, value));
    const y = SPARK_PX_H / 2 - (clamped / max) * (SPARK_PX_H / 2 - 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg
      viewBox={`0 0 ${SPARK_PX_W.toString()} ${SPARK_PX_H.toString()}`}
      preserveAspectRatio="none"
      className="drift-sparkline"
      role="img"
      aria-label="Mean drift over time"
    >
      <line x1={0} x2={SPARK_PX_W} y1={SPARK_PX_H / 2} y2={SPARK_PX_H / 2} className="spark-axis" />
      {points.length >= 2 ? <polyline points={points.join(' ')} className="spark-line" /> : null}
      {points.length >= 1 ? (
        <circle
          cx={Number(points[points.length - 1]?.split(',')[0] ?? 0)}
          cy={Number(points[points.length - 1]?.split(',')[1] ?? 0)}
          r={2}
          className="spark-head"
        />
      ) : null}
    </svg>
  );
}

interface ParamRowProps {
  readonly name: string;
  readonly reference: bigint;
  readonly min: bigint;
  readonly max: bigint;
  readonly mean: bigint;
  readonly divisor: bigint;
  readonly samples: readonly number[];
  readonly thresholdPct: number;
}

function ParamRow({
  name,
  reference,
  min,
  max,
  mean,
  divisor,
  samples,
  thresholdPct,
}: ParamRowProps): React.JSX.Element {
  const drift = driftPercent(reference, mean);
  return (
    <div className="drift-row">
      <div className="drift-row-header">
        <span className="param-key">{name}</span>
        <span className="drift-pct" title="mean drift from founder firmware">
          {drift >= 0 ? '+' : ''}
          {drift.toFixed(2)}%
        </span>
      </div>
      <DriftBar reference={reference} min={min} max={max} mean={mean} divisor={divisor} />
      <Sparkline samples={samples} thresholdPct={thresholdPct} />
    </div>
  );
}

function DriftLegend(): React.JSX.Element {
  return (
    <ul className="drift-legend" aria-label="Drift glyph legend">
      <li>
        <span className="legend-glyph legend-edge" aria-hidden="true" />
        speciation edge
      </li>
      <li>
        <span className="legend-glyph legend-reference" aria-hidden="true" />
        founder
      </li>
      <li>
        <span className="legend-glyph legend-span" aria-hidden="true" />
        live spread
      </li>
      <li>
        <span className="legend-glyph legend-mean" aria-hidden="true" />
        mean
      </li>
    </ul>
  );
}

// Sparkline samples keyed by `${lineageId}::${parameterKey}` so we can
// keep a separate trace per parameter and reset cleanly when the user
// switches lineages.
type SparkBuffer = Map<string, number[]>;

function pushSample(buffer: SparkBuffer, key: string, value: number): void {
  const existing = buffer.get(key) ?? [];
  const next = existing.length >= SPARK_HISTORY ? existing.slice(1) : existing.slice();
  next.push(value);
  buffer.set(key, next);
}

export function LineageInspectorPanel(): React.JSX.Element {
  const transport = useSimStore((s) => s.transport);
  const lineages = useSimStore((s) => s.lineages);
  const selectedLineageId = useSimStore((s) => s.selectedLineageId);
  const quarantinedLineages = useSimStore((s) => s.quarantinedLineages);
  const quarantine = useSimStore((s) => s.quarantine);
  const releaseQuarantine = useSimStore((s) => s.releaseQuarantine);

  const [drift, setDrift] = useState<DriftTelemetry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [patchEditorOpen, setPatchEditorOpen] = useState(false);
  // Per-lineage sparkline buffers. Held in a ref so a render does not
  // discard the history; we surface a render counter to push samples
  // through to the children.
  const sparkBufferRef = useRef<SparkBuffer>(new Map());
  const [sparkVersion, setSparkVersion] = useState(0);

  // Re-query on selection change and on a 1.5s interval so the drift
  // numbers stay live as the sim advances. Sparkline buffers reset when
  // the selected lineage changes — different clade, different history.
  useEffect(() => {
    if (transport === null) return;
    sparkBufferRef.current = new Map();
    setSparkVersion((v) => v + 1);
    let cancelled = false;
    const fetch = async (): Promise<void> => {
      try {
        const result = (await transport.query({
          kind: 'driftTelemetry',
          queryId: '',
          lineageId: selectedLineageId,
        })) as DriftTelemetryResult & { queryId: string };
        if (cancelled) return;
        setDrift(result.drift);
        setError(null);
        if (result.drift !== null) {
          for (const [paramKey, p] of Object.entries(result.drift.parameters)) {
            const ref = BigInt(p.reference);
            const mean = BigInt(p.mean);
            pushSample(
              sparkBufferRef.current,
              `${selectedLineageId}::${paramKey}`,
              driftPercent(ref, mean),
            );
          }
          setSparkVersion((v) => v + 1);
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
  const divisorStr = drift?.divergenceDivisor ?? null;
  const thresholdPct = divisorStr === null ? 0 : thresholdPercent(divisorStr);
  const isSolo = drift !== null && drift.population === 1n;
  const isQuarantined = quarantinedLineages.has(selectedLineageId);
  // Quarantine is a no-op on extinct lineages, but the button stays
  // enabled — the host validates and replies CommandError if the target
  // is unknown. Subscribing to populationByLineage here would force a
  // re-render on every heartbeat, which at 64× speed pulled the panel
  // out of "stable" for Playwright's click-stability check; not worth
  // the cost for a UX nicety.
  const isLineageKnown = lineage !== undefined;
  const onToggleQuarantine = (): void => {
    if (isQuarantined) releaseQuarantine(selectedLineageId);
    else quarantine(selectedLineageId);
  };
  // Plain-language firmware summary, one bullet per parameter the
  // lineage's reference firmware carries.
  const firmwareLines: readonly string[] =
    drift === null
      ? []
      : Object.entries(drift.parameters).map(([key, p]) => describeParameter(key, p.reference));

  return (
    <section className="panel inspector-panel">
      <header className="panel-header">
        <h2>Lineage</h2>
        {lineage !== undefined ? (
          <span className="panel-meta">
            {lineage.name}
            {lineage.name !== lineage.id ? ` · ${lineage.id}` : ''}
            {isQuarantined ? ' · quarantined' : ''}
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
            <div className="inspector-actions">
              <button
                type="button"
                className={
                  isQuarantined ? 'lineage-action lineage-action-active' : 'lineage-action'
                }
                onClick={onToggleQuarantine}
                disabled={!isLineageKnown}
                title={
                  isQuarantined
                    ? 'Release this lineage; replication resumes from the next tick.'
                    : "Suspend this lineage's replication. Reversible."
                }
              >
                {isQuarantined ? 'Release quarantine' : 'Quarantine'}
              </button>
              <button
                type="button"
                className="lineage-action"
                onClick={() => {
                  setPatchEditorOpen(true);
                }}
                disabled={!isLineageKnown || drift === null || drift.referenceFirmware.length === 0}
                title="Author firmware modifications. Pauses the sim while editing; descendants inherit and drift."
              >
                Apply patch
              </button>
            </div>
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
                  {firmwareLines.length === 0 ? (
                    '…'
                  ) : (
                    <ul className="firmware-summary">
                      {firmwareLines.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  )}
                </dd>
              </div>
            </dl>
            {drift !== null && Object.keys(drift.parameters).length > 0 ? (
              <div className="lineage-drift">
                <div className="drift-heading">
                  <h3 className="subhead">Drift</h3>
                  <span className="drift-rule" title="speciation rule">
                    speciates beyond ±{thresholdPct.toFixed(2)}% of founder
                  </span>
                </div>
                {isSolo ? (
                  <p className="panel-empty drift-empty">
                    no descendants yet — drift will appear as the lineage replicates.
                  </p>
                ) : (
                  <>
                    <DriftLegend />
                    {Object.entries(drift.parameters).map(([name, p]) => {
                      const key = `${selectedLineageId}::${name}`;
                      // sparkVersion in the closure keeps the lookup
                      // fresh every poll without needing buffer state.
                      void sparkVersion;
                      const samples = sparkBufferRef.current.get(key) ?? [];
                      return (
                        <ParamRow
                          key={name}
                          name={name}
                          reference={BigInt(p.reference)}
                          min={BigInt(p.min)}
                          max={BigInt(p.max)}
                          mean={BigInt(p.mean)}
                          divisor={BigInt(drift.divergenceDivisor)}
                          samples={samples}
                          thresholdPct={thresholdPct}
                        />
                      );
                    })}
                  </>
                )}
              </div>
            ) : null}
          </>
        )}
      </div>
      {patchEditorOpen && lineage !== undefined && drift !== null ? (
        <PatchEditorModal
          lineageId={lineage.id}
          lineageName={lineage.name}
          initialFirmware={drift.referenceFirmware}
          onClose={() => {
            setPatchEditorOpen(false);
          }}
        />
      ) : null}
    </section>
  );
}

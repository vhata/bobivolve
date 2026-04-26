// ProbeInspectorPanel — type a probe id, see its firmware. Issues a
// ProbeInspectorQuery against the transport and renders the result.
//
// Probe state isn't projected into the store the way population/lineages
// are — it's a pull-only inspection (ARCHITECTURE.md "Query: pull-only,
// never pushed"), so the panel queries on demand and holds the result in
// local component state.

import { useEffect, useState } from 'react';
import type {
  ProbeInspectorDirective,
  ProbeInspectorProbe,
  ProbeInspectorResult,
} from '../../protocol/types.js';
import { useSimStore } from '../sim-store.js';

// Per-directive-kind interpretation of raw u64 parameter strings into
// something readable. Unknown directives fall back to "key: value".
function describeDirective(directive: ProbeInspectorDirective): string {
  if (directive.kind === 'replicate') {
    const t = BigInt(directive.params['threshold'] ?? '0');
    // Probability per tick = threshold / 2^64. Render as a percentage
    // with three significant figures.
    const probabilityPerTick = Number(t) / 2 ** 64;
    return `replicates ≈ ${(probabilityPerTick * 100).toFixed(3)}% per tick`;
  }
  return Object.entries(directive.params)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
}

export function ProbeInspectorPanel(): React.JSX.Element {
  const transport = useSimStore((s) => s.transport);
  const [probeId, setProbeId] = useState('P0');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<ProbeInspectorProbe | null | undefined>(undefined);

  async function runInspect(id: string): Promise<void> {
    if (transport === null) return;
    setPending(true);
    setError(null);
    try {
      const result = (await transport.query({
        kind: 'probeInspector',
        queryId: '',
        probeId: id,
      })) as ProbeInspectorResult & { queryId: string };
      setProbe(result.probe);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  // Auto-inspect the default P0 once a transport is attached so the
  // panel arrives with content rather than an empty-state prompt. The
  // input retains focus on user-driven changes — this only fires once
  // per (transport, current probeId) initial mount.
  // Auto-inspect P0 once a transport is attached so the panel arrives
  // with content rather than an empty-state prompt. Typing in the input
  // doesn't auto-query — that would fire one query per keystroke;
  // explicit Inspect is the user-driven request.
  useEffect(() => {
    if (transport === null) return;
    void runInspect('P0');
  }, [transport]);

  return (
    <section className="panel inspector-panel">
      <header className="panel-header">
        <h2>Probe Inspector</h2>
      </header>
      <div className="panel-body">
        <form
          className="inspector-form"
          onSubmit={(e) => {
            e.preventDefault();
            void runInspect(probeId);
          }}
        >
          <input
            className="inspector-input"
            type="text"
            value={probeId}
            onChange={(e) => setProbeId(e.target.value)}
            placeholder="P0"
            aria-label="Probe id"
          />
          <button type="submit" className="control-button" disabled={pending}>
            {pending ? '…' : 'Inspect'}
          </button>
        </form>
        {error !== null ? (
          <p className="inspector-error">{error}</p>
        ) : probe === undefined ? (
          <p className="panel-empty">enter a probe id and inspect</p>
        ) : probe === null ? (
          <p className="panel-empty">no probe with id {probeId}</p>
        ) : (
          <dl className="inspector-detail">
            <div>
              <dt>id</dt>
              <dd>{probe.id}</dd>
            </div>
            <div>
              <dt>lineage</dt>
              <dd>{probe.lineageId}</dd>
            </div>
            <div>
              <dt>born at tick</dt>
              <dd>{probe.bornAtTick.toString()}</dd>
            </div>
            <div>
              <dt>firmware</dt>
              <dd>
                <ul className="firmware-list">
                  {probe.firmware.map((directive, index) => (
                    <li key={index}>
                      <div className="directive-summary">{describeDirective(directive)}</div>
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          </dl>
        )}
      </div>
    </section>
  );
}

// AutoPausePanel — toggles for the auto-pause triggers the host arms.
// SPEC.md "Default trigger set" lists six triggers; only two are
// applicable in R0 (lineage extinction, significant drift). Extinction
// waits for probe death (R1+); significant drift maps to speciation,
// which the host emits.

import { useSimStore } from '../sim-store.js';

interface TriggerDef {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly available: boolean;
}

const TRIGGERS: readonly TriggerDef[] = [
  {
    id: 'speciation',
    label: 'Significant drift',
    description: 'Pause when a clade diverges enough to mint a new lineage.',
    available: true,
  },
  {
    id: 'lineageExtinction',
    label: 'Lineage extinction',
    description: 'Pause when a lineage drops below threshold (waits for R1 death).',
    available: false,
  },
  {
    id: 'firstContact',
    label: 'First contact',
    description: 'R3+ — first contact with a new species.',
    available: false,
  },
  {
    id: 'treatyViolation',
    label: 'Treaty violation',
    description: 'R3+ — probes act on Deltan worlds.',
    available: false,
  },
];

export function AutoPausePanel(): React.JSX.Element {
  const triggers = useSimStore((s) => s.autoPauseTriggers);
  const setTriggers = useSimStore((s) => s.setAutoPauseTriggers);
  const lastTrigger = useSimStore((s) => s.lastAutoPauseTrigger);

  function toggle(id: string): void {
    const next = new Set(triggers);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setTriggers(next);
  }

  return (
    <section className="panel autopause-panel">
      <header className="panel-header">
        <h2>Auto-pause</h2>
        {lastTrigger !== null ? <span className="panel-meta">last: {lastTrigger}</span> : null}
      </header>
      <div className="panel-body">
        <ul className="autopause-list">
          {TRIGGERS.map((t) => (
            <li
              key={t.id}
              className={`autopause-row${t.available ? '' : ' autopause-row-disabled'}`}
            >
              <label>
                <input
                  type="checkbox"
                  checked={triggers.has(t.id)}
                  onChange={() => {
                    if (t.available) toggle(t.id);
                  }}
                  disabled={!t.available}
                />
                <span className="autopause-label">{t.label}</span>
              </label>
              <p className="autopause-description">{t.description}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

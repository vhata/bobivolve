// RunPanel — start a fresh run from a seed; named Save / Load slots
// backed by OPFS.

import { useEffect, useState } from 'react';
import { useSimStore } from '../sim-store.js';

function parseSeed(input: string): bigint | null {
  if (input.trim() === '') return null;
  try {
    const value = BigInt(input);
    if (value < 0n) return null;
    return value;
  } catch {
    return null;
  }
}

function defaultSlotName(seed: bigint | null, simTick: bigint): string {
  const seedPart = seed === null ? 'unseeded' : `seed${seed.toString()}`;
  return `${seedPart}-tick${simTick.toString()}`;
}

function formatSavedAt(savedAtMs: number): string {
  const d = new Date(savedAtMs);
  return d.toLocaleString();
}

export function RunPanel(): React.JSX.Element {
  const startRun = useSimStore((s) => s.startRun);
  const save = useSimStore((s) => s.save);
  const load = useSimStore((s) => s.load);
  const seed = useSimStore((s) => s.seed);
  const simTick = useSimStore((s) => s.simTick);
  const lastSaveAtTick = useSimStore((s) => s.lastSaveAtTick);
  const saves = useSimStore((s) => s.saves);
  const refreshSaves = useSimStore((s) => s.refreshSaves);
  const transport = useSimStore((s) => s.transport);

  const [seedDraft, setSeedDraft] = useState<string>(seed === null ? '42' : seed.toString());
  const parsedSeed = parseSeed(seedDraft);
  const [slotDraft, setSlotDraft] = useState<string>(defaultSlotName(seed, simTick));
  // Whether the user has manually edited the slot name. If they have,
  // stop auto-filling it as the run advances.
  const [slotEdited, setSlotEdited] = useState(false);

  // Auto-suggest the slot name as the run advances, until the user
  // edits it. After they edit, leave it alone so they can save several
  // slots with their own names.
  useEffect(() => {
    if (!slotEdited) {
      setSlotDraft(defaultSlotName(seed, simTick));
    }
  }, [seed, simTick, slotEdited]);

  // Pull the saves list once we have a transport.
  useEffect(() => {
    if (transport === null) return;
    void refreshSaves();
  }, [transport, refreshSaves]);

  const sortedSaves = [...saves].sort((a, b) => b.savedAtMs - a.savedAtMs);

  return (
    <section className="panel run-panel">
      <header className="panel-header">
        <h2>Run</h2>
      </header>
      <div className="panel-body run-body">
        <form
          className="run-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (parsedSeed === null) return;
            startRun(parsedSeed);
            setSlotEdited(false);
          }}
        >
          <label className="run-label">
            <span>seed</span>
            <input
              className="inspector-input"
              type="text"
              value={seedDraft}
              onChange={(e) => setSeedDraft(e.target.value)}
              aria-label="Seed"
              inputMode="numeric"
            />
          </label>
          <button type="submit" className="control-button" disabled={parsedSeed === null}>
            Start
          </button>
        </form>
        <form
          className="run-form"
          onSubmit={(e) => {
            e.preventDefault();
            const slot = slotDraft.trim();
            if (slot === '') return;
            save(slot);
          }}
        >
          <label className="run-label">
            <span>save slot</span>
            <input
              className="inspector-input"
              type="text"
              value={slotDraft}
              onChange={(e) => {
                setSlotDraft(e.target.value);
                setSlotEdited(true);
              }}
              aria-label="Save slot name"
            />
          </label>
          <button type="submit" className="control-button" disabled={slotDraft.trim() === ''}>
            Save
          </button>
        </form>
        {lastSaveAtTick !== null ? (
          <p className="run-status" role="status">
            saved at tick {lastSaveAtTick.toString()}
          </p>
        ) : null}
        {sortedSaves.length === 0 ? (
          <p className="panel-empty">no saves yet</p>
        ) : (
          <ul className="saves-list">
            {sortedSaves.map((s) => (
              <li key={s.slot} className="save-row">
                <button
                  type="button"
                  className="save-load-button"
                  onClick={() => load(s.slot)}
                  title={`Load ${s.slot}`}
                >
                  <span className="save-slot-name">{s.slot}</span>
                  <span className="save-meta">
                    tick {s.tick} · {formatSavedAt(s.savedAtMs)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

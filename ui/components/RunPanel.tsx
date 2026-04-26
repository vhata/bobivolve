// RunPanel — start a fresh run from a seed; Save / Load to persistent
// storage (the worker host backs save slots with OPFS).
//
// The seed input accepts decimal integers; non-numeric values are
// rejected and the Start button stays disabled. Save/Load buttons
// dispatch the corresponding commands; their effect arrives back via
// commandAck / commandError events the host emits.

import { useState } from 'react';
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

export function RunPanel(): React.JSX.Element {
  const startRun = useSimStore((s) => s.startRun);
  const save = useSimStore((s) => s.save);
  const load = useSimStore((s) => s.load);
  const seed = useSimStore((s) => s.seed);
  const lastSaveAtTick = useSimStore((s) => s.lastSaveAtTick);

  const [draft, setDraft] = useState<string>(seed === null ? '42' : seed.toString());
  const parsed = parseSeed(draft);

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
            if (parsed === null) return;
            startRun(parsed);
          }}
        >
          <label className="run-label">
            <span>seed</span>
            <input
              className="inspector-input"
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-label="Seed"
              inputMode="numeric"
            />
          </label>
          <button type="submit" className="control-button" disabled={parsed === null}>
            Start
          </button>
        </form>
        <div className="run-actions">
          <button
            type="button"
            className="control-button"
            onClick={() => {
              save();
            }}
          >
            Save
          </button>
          <button
            type="button"
            className="control-button"
            onClick={() => {
              load();
            }}
          >
            Load
          </button>
        </div>
        {lastSaveAtTick !== null ? (
          <p className="run-status" role="status">
            saved at tick {lastSaveAtTick.toString()}
          </p>
        ) : null}
      </div>
    </section>
  );
}

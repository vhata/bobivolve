// RunPanel — start a fresh run from a seed; just-in-time Save / Load
// flows backed by OPFS. Save and Load both pause the sim before
// soliciting input from the player; neither maintains a continuously
// updating projection of the run state, since that surface is only
// consulted at the moment the player decides to act.

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
  const pause = useSimStore((s) => s.pause);
  const paused = useSimStore((s) => s.paused);
  const seed = useSimStore((s) => s.seed);
  const simTick = useSimStore((s) => s.simTick);
  const lastSaveAtTick = useSimStore((s) => s.lastSaveAtTick);
  const saves = useSimStore((s) => s.saves);
  const refreshSaves = useSimStore((s) => s.refreshSaves);

  const [seedDraft, setSeedDraft] = useState<string>(seed === null ? '42' : seed.toString());
  const parsedSeed = parseSeed(seedDraft);
  const [loadMode, setLoadMode] = useState(false);

  function handleSaveClick(): void {
    if (!paused) pause();
    const suggested = defaultSlotName(seed, simTick);
    const entered = window.prompt('Save slot name', suggested);
    if (entered === null) return;
    const slot = entered.trim();
    if (slot === '') return;
    save(slot);
  }

  function handleLoadClick(): void {
    if (!paused) pause();
    void refreshSaves();
    setLoadMode(true);
  }

  function handleSelectSlot(slot: string): void {
    load(slot);
    setLoadMode(false);
  }

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
        <div className="run-actions">
          <button type="button" className="control-button" onClick={handleSaveClick}>
            Save
          </button>
          <button type="button" className="control-button" onClick={handleLoadClick}>
            Load
          </button>
        </div>
        {lastSaveAtTick !== null ? (
          <p className="run-status" role="status">
            saved at tick {lastSaveAtTick.toString()}
          </p>
        ) : null}
        {loadMode ? (
          <div className="load-picker" role="dialog" aria-label="Load a save">
            <header className="load-picker-header">
              <span>pick a save</span>
              <button
                type="button"
                className="load-picker-cancel"
                onClick={() => setLoadMode(false)}
              >
                cancel
              </button>
            </header>
            {sortedSaves.length === 0 ? (
              <p className="panel-empty">no saves yet</p>
            ) : (
              <ul className="saves-list">
                {sortedSaves.map((s) => (
                  <li key={s.slot}>
                    <button
                      type="button"
                      className="save-load-button"
                      onClick={() => handleSelectSlot(s.slot)}
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
        ) : null}
      </div>
    </section>
  );
}

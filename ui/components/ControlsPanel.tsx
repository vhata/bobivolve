// Run controls. Pause/resume and speed selector. Wires the store actions
// straight to the UI; the store is responsible for issuing the commands
// over the transport. Pending-command tracking surfaces unconfirmed
// pause/resume/setSpeed via a "pending" data attribute and a warning
// when the ack hasn't arrived after 1 second.

import { useEffect, useState } from 'react';
import type { SimSpeed } from '../sim-store.js';
import { useSimStore } from '../sim-store.js';

const SPEEDS: readonly SimSpeed[] = [1, 4, 16, 64];

const PENDING_WARN_MS = 1_000;

function hasPending(
  pendingCommands: ReadonlyMap<string, { kind: string; issuedAtMs: number }>,
  kinds: readonly string[],
): { pending: boolean; ageMs: number } {
  let pending = false;
  let oldestIssuedAt = Number.POSITIVE_INFINITY;
  for (const cmd of pendingCommands.values()) {
    if (kinds.includes(cmd.kind)) {
      pending = true;
      if (cmd.issuedAtMs < oldestIssuedAt) oldestIssuedAt = cmd.issuedAtMs;
    }
  }
  return { pending, ageMs: pending ? Date.now() - oldestIssuedAt : 0 };
}

// Hook to re-render this component once a second so the "stuck > 1s"
// warning becomes visible without an unrelated event causing a render.
function useTickingClock(intervalMs: number): void {
  const [, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((n) => n + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}

export function ControlsPanel(): React.JSX.Element {
  const paused = useSimStore((s) => s.paused);
  const speed = useSimStore((s) => s.speed);
  const actualSpeed = useSimStore((s) => s.actualSpeed);
  const pendingCommands = useSimStore((s) => s.pendingCommands);
  const pause = useSimStore((s) => s.pause);
  const resume = useSimStore((s) => s.resume);
  const setSpeed = useSimStore((s) => s.setSpeed);

  useTickingClock(500);

  const pauseToggle = hasPending(pendingCommands, ['pause', 'resume']);
  const speedChange = hasPending(pendingCommands, ['setSpeed']);
  const pauseStuck = pauseToggle.pending && pauseToggle.ageMs > PENDING_WARN_MS;
  const speedStuck = speedChange.pending && speedChange.ageMs > PENDING_WARN_MS;

  return (
    <section className="panel controls-panel">
      <header className="panel-header">
        <h2>Controls</h2>
        <span className="panel-meta">{actualSpeed} t/s</span>
      </header>
      <div className="panel-body controls-body">
        <button
          type="button"
          className="control-button"
          onClick={paused ? resume : pause}
          aria-pressed={paused}
          data-pending={pauseToggle.pending ? 'true' : 'false'}
          data-stuck={pauseStuck ? 'true' : 'false'}
        >
          {paused ? 'Resume' : 'Pause'}
        </button>
        <div className="speed-group" role="group" aria-label="Sim speed">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              className={`speed-button${s === speed ? ' speed-button-active' : ''}`}
              onClick={() => setSpeed(s)}
              aria-pressed={s === speed}
              data-pending={speedChange.pending && s === speed ? 'true' : 'false'}
              data-stuck={speedStuck && s === speed ? 'true' : 'false'}
            >
              {s}×
            </button>
          ))}
        </div>
        {(pauseStuck || speedStuck) && (
          <p className="controls-warning" role="status">
            command not yet acknowledged by the worker — it may be busy
          </p>
        )}
      </div>
    </section>
  );
}

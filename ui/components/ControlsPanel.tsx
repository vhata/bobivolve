// Run controls. Pause/resume and speed selector. The pending indicator
// is subtle visual feedback during the ack round-trip; recovery from a
// dropped command happens automatically in the store via retry, so the
// player never sees a "stuck" state requiring action on their part.

import type { SimSpeed } from '../sim-store.js';
import { useSimStore } from '../sim-store.js';

const SPEEDS: readonly SimSpeed[] = [1, 4, 16, 64];

function hasPending(
  pendingCommands: ReadonlyMap<string, { kind: string }>,
  kinds: readonly string[],
): boolean {
  for (const cmd of pendingCommands.values()) {
    if (kinds.includes(cmd.kind)) return true;
  }
  return false;
}

export function ControlsPanel(): React.JSX.Element {
  const paused = useSimStore((s) => s.paused);
  const speed = useSimStore((s) => s.speed);
  const actualSpeed = useSimStore((s) => s.actualSpeed);
  const pendingCommands = useSimStore((s) => s.pendingCommands);
  const pause = useSimStore((s) => s.pause);
  const resume = useSimStore((s) => s.resume);
  const setSpeed = useSimStore((s) => s.setSpeed);

  const pauseTogglePending = hasPending(pendingCommands, ['pause', 'resume']);
  const speedChangePending = hasPending(pendingCommands, ['setSpeed']);

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
          data-pending={pauseTogglePending ? 'true' : 'false'}
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
              data-pending={speedChangePending && s === speed ? 'true' : 'false'}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

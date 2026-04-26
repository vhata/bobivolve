// Run controls. Pause/resume and speed selector. Wires the store actions
// straight to the UI; the store is responsible for issuing the commands
// over the transport.

import type { SimSpeed } from '../sim-store.js';
import { useSimStore } from '../sim-store.js';

const SPEEDS: readonly SimSpeed[] = [1, 4, 16, 64];

export function ControlsPanel(): React.JSX.Element {
  const paused = useSimStore((s) => s.paused);
  const speed = useSimStore((s) => s.speed);
  const actualSpeed = useSimStore((s) => s.actualSpeed);
  const pause = useSimStore((s) => s.pause);
  const resume = useSimStore((s) => s.resume);
  const setSpeed = useSimStore((s) => s.setSpeed);

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
            >
              {s}×
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

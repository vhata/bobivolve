// Bobivolve dashboard shell.

import { useEffect } from 'react';
import { ControlsPanel } from './components/ControlsPanel.js';
import { PopulationPanel } from './components/PopulationPanel.js';
import { useSimStore } from './sim-store.js';
import { WorkerTransport } from '../transport/worker.js';
import SimWorker from '../host/worker.ts?worker';

export function App(): React.JSX.Element {
  const attach = useSimStore((s) => s.attach);
  const detach = useSimStore((s) => s.detach);
  const startRun = useSimStore((s) => s.startRun);
  const seed = useSimStore((s) => s.seed);

  useEffect(() => {
    const transport = new WorkerTransport(new SimWorker());
    attach(transport);
    // Kick off a default run so a freshly-loaded page shows something.
    // Future commits will wire this through a "Start Run" panel rather
    // than auto-starting.
    startRun(42n);
    return () => {
      detach();
    };
  }, [attach, detach, startRun]);

  return (
    <div className="bobivolve-app">
      <header className="bobivolve-header">
        <h1>Bobivolve</h1>
        <p className="bobivolve-tagline">
          {seed === null ? 'A real-time evolutionary simulation.' : `seed ${seed.toString()}`}
        </p>
      </header>
      <main className="dashboard">
        <ControlsPanel />
        <PopulationPanel />
      </main>
    </div>
  );
}

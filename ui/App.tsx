// Bobivolve dashboard shell.

import { useEffect } from 'react';
import { PopulationPanel } from './components/PopulationPanel.js';
import { useSimStore } from './sim-store.js';
import { WorkerTransport } from '../transport/worker.js';
import SimWorker from '../host/worker.ts?worker';

export function App(): React.JSX.Element {
  const attach = useSimStore((s) => s.attach);
  const detach = useSimStore((s) => s.detach);

  useEffect(() => {
    const transport = new WorkerTransport(new SimWorker());
    attach(transport);
    // Kick off a default run so a freshly-loaded page shows something.
    // Future commits will wire this through a "Start Run" panel rather
    // than auto-starting.
    transport.send({ kind: 'newRun', commandId: 'ui-newRun', seed: 42n });
    return () => {
      detach();
    };
  }, [attach, detach]);

  return (
    <div className="bobivolve-app">
      <header className="bobivolve-header">
        <h1>Bobivolve</h1>
        <p className="bobivolve-tagline">A real-time evolutionary simulation.</p>
      </header>
      <main className="dashboard">
        <PopulationPanel />
      </main>
    </div>
  );
}

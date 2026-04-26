// Bobivolve dashboard shell.

import { useEffect } from 'react';
import { AutoPausePanel } from './components/AutoPausePanel.js';
import { ControlsPanel } from './components/ControlsPanel.js';
import { DriftTelemetryPanel } from './components/DriftTelemetryPanel.js';
import { EventsTimelinePanel } from './components/EventsTimelinePanel.js';
import { LineageTreePanel } from './components/LineageTreePanel.js';
import { PopulationPanel } from './components/PopulationPanel.js';
import { ProbeInspectorPanel } from './components/ProbeInspectorPanel.js';
import { RunPanel } from './components/RunPanel.js';
import { useSimStore } from './sim-store.js';
import { WorkerTransport } from '../transport/worker.js';
import SimWorker from '../host/worker.ts?worker';

export function App(): React.JSX.Element {
  const attach = useSimStore((s) => s.attach);
  const detach = useSimStore((s) => s.detach);
  const startRun = useSimStore((s) => s.startRun);
  const setSpeed = useSimStore((s) => s.setSpeed);
  const seed = useSimStore((s) => s.seed);

  useEffect(() => {
    const transport = new WorkerTransport(new SimWorker());
    attach(transport);
    // Soft default: kick off a 16× run at seed=42 so a freshly-loaded
    // page is visibly evolving within seconds. The user can override via
    // the Run panel (seed) and Controls panel (speed).
    startRun(42n);
    setSpeed(16);
    return () => {
      detach();
    };
  }, [attach, detach, startRun, setSpeed]);

  return (
    <div className="bobivolve-app">
      <header className="bobivolve-header">
        <h1>Bobivolve</h1>
        <p className="bobivolve-tagline">
          {seed === null ? 'A real-time evolutionary simulation.' : `seed ${seed.toString()}`}
        </p>
      </header>
      <main className="dashboard">
        <RunPanel />
        <ControlsPanel />
        <AutoPausePanel />
        <PopulationPanel />
        <LineageTreePanel />
        <ProbeInspectorPanel />
        <DriftTelemetryPanel />
        <EventsTimelinePanel />
      </main>
    </div>
  );
}

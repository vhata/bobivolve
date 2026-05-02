// Bobivolve dashboard shell.

import { useEffect, useState } from 'react';
import { AutoPausePanel } from './components/AutoPausePanel.js';
import { ControlsPanel } from './components/ControlsPanel.js';
import { DecreesPanel } from './components/DecreesPanel.js';
import { EventsTimelinePanel } from './components/EventsTimelinePanel.js';
import { LineageInspectorPanel } from './components/LineageInspectorPanel.js';
import { LineageTreePanel } from './components/LineageTreePanel.js';
import { NuxOverlay, shouldAutoFireNux } from './components/NuxOverlay.js';
import { OriginPanel } from './components/OriginPanel.js';
import { PopulationPanel } from './components/PopulationPanel.js';
import { RunPanel } from './components/RunPanel.js';
import { SubstratePanel } from './components/SubstratePanel.js';
import { useSimStore } from './sim-store.js';
import { WorkerTransport } from '../transport/worker.js';
import SimWorker from '../host/worker.ts?worker';

export function App(): React.JSX.Element {
  const attach = useSimStore((s) => s.attach);
  const detach = useSimStore((s) => s.detach);
  const startRun = useSimStore((s) => s.startRun);
  const setSpeed = useSimStore((s) => s.setSpeed);
  const seed = useSimStore((s) => s.seed);
  const pendingCommands = useSimStore((s) => s.pendingCommands);

  // Forensic-replay rewind can take meaningful wall-clock time at fat
  // population (the host loads the nearest snapshot and replays
  // forward in 250-tick chunks with event-loop yields). Show a
  // "rewinding…" backdrop while a rewindToTick command is in flight
  // so the player isn't staring at a frozen-looking dashboard with
  // population and lineages projected to zero — they get an
  // explanation of what's happening and the rest of the UI is greyed
  // out so they don't try to interact with stale state.
  let rewindingTick: bigint | null = null;
  for (const cmd of pendingCommands.values()) {
    if (cmd.kind === 'rewindToTick') {
      rewindingTick = cmd.targetTick ?? null;
      break;
    }
  }

  const [nuxOpen, setNuxOpen] = useState(false);

  useEffect(() => {
    const transport = new WorkerTransport(new SimWorker());
    attach(transport);
    // Soft default: kick off a 4× run at seed=42. Visible growth without
    // immediately overwhelming the layout; the user can speed up via the
    // Controls panel.
    startRun(42n);
    setSpeed(4);
    return () => {
      detach();
    };
  }, [attach, detach, startRun, setSpeed]);

  useEffect(() => {
    if (shouldAutoFireNux()) setNuxOpen(true);
  }, []);

  return (
    <div className="bobivolve-app">
      <header className="bobivolve-header">
        <div className="bobivolve-title">
          <h1>Bobivolve</h1>
          <p className="bobivolve-tagline">
            {seed === null ? 'A real-time evolutionary simulation.' : `seed ${seed.toString()}`}
          </p>
        </div>
        <button
          type="button"
          className="nux-help-button"
          onClick={() => {
            setNuxOpen(true);
          }}
          aria-label="Open new-visitor tour"
          title="New-visitor tour"
        >
          ?
        </button>
      </header>
      <main className="dashboard">
        <RunPanel />
        <ControlsPanel />
        <AutoPausePanel />
        <OriginPanel />
        <DecreesPanel />
        <PopulationPanel />
        <SubstratePanel />
        <LineageTreePanel />
        <LineageInspectorPanel />
        <EventsTimelinePanel />
      </main>
      <NuxOverlay
        open={nuxOpen}
        onClose={() => {
          setNuxOpen(false);
        }}
      />
      {rewindingTick !== null ? <RewindingOverlay tick={rewindingTick} /> : null}
    </div>
  );
}

function RewindingOverlay({ tick }: { tick: bigint }): React.JSX.Element {
  return (
    <div className="rewinding-overlay" role="status" aria-live="polite">
      <div className="rewinding-card">
        <p className="rewinding-title">Rewinding to tick {tick.toString()}…</p>
        <p className="rewinding-body">
          Loading the nearest snapshot and replaying forward. Population and lineages will jump back
          into shape when the rewind lands.
        </p>
      </div>
    </div>
  );
}

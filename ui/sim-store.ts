// Zustand store wiring the dashboard to a SimTransport. Holds the
// dashboard-readable projection of the SimEvent stream — population by
// lineage, the latest tick, the lineage tree, and so on. Components
// subscribe to slices of this state and rerender on change.
//
// Selecting derived state at the component boundary keeps each panel
// independent of the others — a panel that only cares about population
// will not rerender on a per-replication event that only the lineage
// tree views.

import { create } from 'zustand';
import type { SimEvent } from '../protocol/types.js';
import type { SimTransport } from '../transport/types.js';

export interface LineagePopulation {
  readonly lineageId: string;
  readonly count: bigint;
}

export type SimSpeed = 1 | 4 | 16 | 64;

export interface SimStoreState {
  readonly simTick: bigint;
  readonly populationTotal: bigint;
  readonly populationByLineage: ReadonlyMap<string, bigint>;
  readonly seed: bigint | null;
  readonly speed: SimSpeed;
  readonly paused: boolean;
  readonly actualSpeed: number;
  readonly transport: SimTransport | null;
  readonly attach: (transport: SimTransport) => void;
  readonly detach: () => void;
  readonly startRun: (seed: bigint) => void;
  readonly pause: () => void;
  readonly resume: () => void;
  readonly setSpeed: (speed: SimSpeed) => void;
}

export const useSimStore = create<SimStoreState>((set, get) => {
  let unsubscribe: (() => void) | null = null;

  const handleEvent = (event: SimEvent): void => {
    switch (event.kind) {
      case 'tick':
        set({
          simTick: event.simTick,
          populationTotal: event.populationTotal,
          populationByLineage: new Map(Object.entries(event.populationByLineage)),
          actualSpeed: event.actualSpeed,
        });
        return;
      case 'replication': {
        const next = new Map(get().populationByLineage);
        next.set(event.lineageId, (next.get(event.lineageId) ?? 0n) + 1n);
        set({
          simTick: event.simTick,
          populationTotal: get().populationTotal + 1n,
          populationByLineage: next,
        });
        return;
      }
      case 'speciation':
      case 'extinction':
      case 'death':
      case 'autoPaused':
      case 'commandAck':
      case 'commandError':
        // Other event kinds will populate dedicated slices as the matching
        // panels land. The tick field is the cheap update either way.
        if (event.simTick > get().simTick) set({ simTick: event.simTick });
        return;
    }
  };

  return {
    simTick: 0n,
    populationTotal: 0n,
    populationByLineage: new Map(),
    seed: null,
    speed: 1,
    paused: false,
    actualSpeed: 0,
    transport: null,
    attach: (transport) => {
      const previous = get().transport;
      if (previous !== null) {
        unsubscribe?.();
        previous.close();
      }
      unsubscribe = transport.onEvent(handleEvent);
      set({ transport });
    },
    detach: () => {
      const transport = get().transport;
      if (transport === null) return;
      unsubscribe?.();
      unsubscribe = null;
      transport.close();
      set({ transport: null });
    },
    startRun: (seed) => {
      const transport = get().transport;
      if (transport === null) {
        throw new Error('useSimStore.startRun: no transport attached');
      }
      // Reset projected state for the new run; the store does not retain
      // population/tick state across runs.
      set({
        seed,
        simTick: 0n,
        populationTotal: 0n,
        populationByLineage: new Map(),
        paused: false,
        actualSpeed: 0,
      });
      transport.send({ kind: 'newRun', commandId: 'ui-newRun', seed });
    },
    pause: () => {
      const transport = get().transport;
      if (transport === null) return;
      set({ paused: true });
      transport.send({ kind: 'pause', commandId: 'ui-pause' });
    },
    resume: () => {
      const transport = get().transport;
      if (transport === null) return;
      set({ paused: false });
      transport.send({ kind: 'resume', commandId: 'ui-resume' });
    },
    setSpeed: (speed) => {
      const transport = get().transport;
      if (transport === null) return;
      set({ speed });
      transport.send({ kind: 'setSpeed', commandId: 'ui-setSpeed', speed });
    },
  };
});

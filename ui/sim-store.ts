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

export interface LineageNode {
  readonly id: string;
  readonly name: string;
  // null for the founding lineage; otherwise the lineage that speciated
  // to produce this one.
  readonly parentId: string | null;
  readonly foundedAtTick: bigint;
}

// Sampled point in the population history. We keep a bounded rolling
// window (HISTORY_CAPACITY) and downsample as we accumulate; sampling
// every N-th tick keeps the chart readable across run lengths.
export interface PopulationHistoryPoint {
  readonly tick: bigint;
  readonly byLineage: ReadonlyMap<string, bigint>;
  readonly total: bigint;
}

const HISTORY_CAPACITY = 240;

export interface SimStoreState {
  readonly simTick: bigint;
  readonly populationTotal: bigint;
  readonly populationByLineage: ReadonlyMap<string, bigint>;
  readonly populationHistory: readonly PopulationHistoryPoint[];
  readonly lineages: ReadonlyMap<string, LineageNode>;
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
  readonly save: (slot?: string) => void;
  readonly load: (slot?: string) => void;
  readonly autoPauseTriggers: ReadonlySet<string>;
  readonly lastAutoPauseTrigger: string | null;
  readonly setAutoPauseTriggers: (triggers: ReadonlySet<string>) => void;
}

// L0 is the founding lineage — every fresh run starts with it. The sim
// emits a Speciation event for every subsequent lineage but never one for
// L0; the store seeds it implicitly.
function freshLineages(): Map<string, LineageNode> {
  return new Map([['L0', { id: 'L0', name: 'L0', parentId: null, foundedAtTick: 0n }]]);
}

export const useSimStore = create<SimStoreState>((set, get) => {
  let unsubscribe: (() => void) | null = null;

  const handleEvent = (event: SimEvent): void => {
    switch (event.kind) {
      case 'tick': {
        const byLineage = new Map(Object.entries(event.populationByLineage));
        const history = [...get().populationHistory];
        history.push({
          tick: event.simTick,
          byLineage,
          total: event.populationTotal,
        });
        // Bounded buffer with simple decimation: when full, drop every
        // other entry so we keep the curve shape across longer runs.
        if (history.length > HISTORY_CAPACITY) {
          for (let i = 0; i < history.length - 1; i += 1) {
            history.splice(i, 1);
          }
        }
        set({
          simTick: event.simTick,
          populationTotal: event.populationTotal,
          populationByLineage: byLineage,
          populationHistory: history,
          actualSpeed: event.actualSpeed,
        });
        return;
      }
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
      case 'speciation': {
        const lineages = new Map(get().lineages);
        lineages.set(event.newLineageId, {
          id: event.newLineageId,
          name: event.newLineageName,
          parentId: event.parentLineageId,
          foundedAtTick: event.simTick,
        });
        set({ simTick: event.simTick, lineages });
        return;
      }
      case 'autoPaused':
        set({
          simTick: event.simTick,
          paused: true,
          lastAutoPauseTrigger: event.trigger,
        });
        return;
      case 'extinction':
      case 'death':
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
    populationHistory: [],
    lineages: freshLineages(),
    seed: null,
    speed: 1,
    paused: false,
    actualSpeed: 0,
    autoPauseTriggers: new Set(),
    lastAutoPauseTrigger: null,
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
        populationHistory: [],
        lineages: freshLineages(),
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
    save: (slot = 'default') => {
      const transport = get().transport;
      if (transport === null) return;
      transport.send({ kind: 'save', commandId: 'ui-save', slot });
    },
    load: (slot = 'default') => {
      const transport = get().transport;
      if (transport === null) return;
      transport.send({ kind: 'load', commandId: 'ui-load', slot });
    },
    setAutoPauseTriggers: (triggers) => {
      const transport = get().transport;
      set({ autoPauseTriggers: new Set(triggers) });
      if (transport === null) return;
      transport.send({
        kind: 'configureAutoPause',
        commandId: 'ui-configureAutoPause',
        enabledTriggers: [...triggers],
      });
    },
  };
});

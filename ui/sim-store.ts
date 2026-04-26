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

// In-flight command tracking. ACK-based confirmation is the only way to
// tell whether the worker actually applied a command — without it the UI
// can flip its button text to "Resume" while the sim merrily keeps
// running because the message never made it through.
export interface PendingCommand {
  readonly commandId: string;
  readonly kind: 'pause' | 'resume' | 'setSpeed' | 'newRun' | 'save' | 'load';
  readonly issuedAtMs: number;
  // Optimistic effect summary. The UI reads it to render the projected
  // state while the ack is in flight; on ack the projection is confirmed
  // and the entry is removed.
  readonly projection?: { readonly paused?: boolean; readonly speed?: SimSpeed };
}

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
  readonly pendingCommands: ReadonlyMap<string, PendingCommand>;
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

let nextCommandOrdinal = 0;
function mintCommandId(prefix: string): string {
  const id = `${prefix}-${nextCommandOrdinal.toString()}`;
  nextCommandOrdinal += 1;
  return id;
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
        // Suppress actualSpeed updates while paused. An in-flight
        // runUntil that started before the pause click can emit a Tick
        // heartbeat with a non-zero actualSpeed AFTER the pause action
        // zeroed it; without this guard, the readout flips back to a
        // misleading non-zero value and stays there until resume.
        const paused = get().paused;
        set({
          simTick: event.simTick,
          populationTotal: event.populationTotal,
          populationByLineage: byLineage,
          populationHistory: history,
          actualSpeed: paused ? 0 : event.actualSpeed,
        });
        return;
      }
      case 'replication':
        // Population accounting flows from Tick heartbeats (throttled to
        // 60Hz). Updating on every Replication event would cause hundreds
        // of re-renders per second at fat population + high speed, which
        // saturates the browser's event loop and starves user clicks.
        // Only the simTick monotonic update lives here.
        if (event.simTick > get().simTick) set({ simTick: event.simTick });
        return;
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
      case 'commandAck': {
        // Confirm a pending command by removing it from the map. The
        // optimistic state set when the command was sent stays — the
        // ack just promotes it from "projected" to "confirmed".
        const pending = new Map(get().pendingCommands);
        if (pending.has(event.commandId)) {
          pending.delete(event.commandId);
          set({ pendingCommands: pending });
        }
        return;
      }
      case 'commandError': {
        // Roll back the optimistic projection for this command. Future
        // polish: surface the error message to the user.
        const pending = new Map(get().pendingCommands);
        const entry = pending.get(event.commandId);
        if (entry !== undefined) {
          pending.delete(event.commandId);
          if (entry.projection?.paused === true) {
            set({ pendingCommands: pending, paused: false });
          } else if (entry.projection?.paused === false) {
            set({ pendingCommands: pending, paused: true });
          } else {
            set({ pendingCommands: pending });
          }
        }
        return;
      }
      case 'extinction':
      case 'death':
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
    pendingCommands: new Map(),
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
      const commandId = mintCommandId('ui-newRun');
      const pending = new Map(get().pendingCommands);
      pending.set(commandId, {
        commandId,
        kind: 'newRun',
        issuedAtMs: Date.now(),
      });
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
        pendingCommands: pending,
      });
      transport.send({ kind: 'newRun', commandId, seed });
    },
    pause: () => {
      const transport = get().transport;
      if (transport === null) return;
      const commandId = mintCommandId('ui-pause');
      const pending = new Map(get().pendingCommands);
      pending.set(commandId, {
        commandId,
        kind: 'pause',
        issuedAtMs: Date.now(),
        projection: { paused: true },
      });
      // actualSpeed reads the last Tick heartbeat; once paused, no more
      // heartbeats fire and the lingering value reads as if the sim were
      // still running. Reset it explicitly.
      set({ paused: true, actualSpeed: 0, pendingCommands: pending });
      transport.send({ kind: 'pause', commandId });
    },
    resume: () => {
      const transport = get().transport;
      if (transport === null) return;
      const commandId = mintCommandId('ui-resume');
      const pending = new Map(get().pendingCommands);
      pending.set(commandId, {
        commandId,
        kind: 'resume',
        issuedAtMs: Date.now(),
        projection: { paused: false },
      });
      set({ paused: false, pendingCommands: pending });
      transport.send({ kind: 'resume', commandId });
    },
    setSpeed: (speed) => {
      const transport = get().transport;
      if (transport === null) return;
      const commandId = mintCommandId('ui-setSpeed');
      const pending = new Map(get().pendingCommands);
      pending.set(commandId, {
        commandId,
        kind: 'setSpeed',
        issuedAtMs: Date.now(),
        projection: { speed },
      });
      set({ speed, pendingCommands: pending });
      transport.send({ kind: 'setSpeed', commandId, speed });
    },
    save: (slot = 'default') => {
      const transport = get().transport;
      if (transport === null) return;
      const commandId = mintCommandId('ui-save');
      const pending = new Map(get().pendingCommands);
      pending.set(commandId, { commandId, kind: 'save', issuedAtMs: Date.now() });
      set({ pendingCommands: pending });
      transport.send({ kind: 'save', commandId, slot });
    },
    load: (slot = 'default') => {
      const transport = get().transport;
      if (transport === null) return;
      const commandId = mintCommandId('ui-load');
      const pending = new Map(get().pendingCommands);
      pending.set(commandId, { commandId, kind: 'load', issuedAtMs: Date.now() });
      set({ pendingCommands: pending });
      transport.send({ kind: 'load', commandId, slot });
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

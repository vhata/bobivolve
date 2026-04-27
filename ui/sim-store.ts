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
import type { DirectiveSpec, ListSavesResult, SaveSummary, SimEvent } from '../protocol/types.js';
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
  readonly founderProbeId: string;
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
// running because the message never made it through. When an ack
// doesn't arrive within RETRY_AFTER_MS, the store re-sends idempotent
// commands automatically; the player never has to handle the failure.
export interface PendingCommand {
  readonly commandId: string;
  readonly kind: 'pause' | 'resume' | 'setSpeed' | 'newRun' | 'save' | 'load';
  readonly issuedAtMs: number;
  readonly retryCount: number;
  // Optimistic effect summary. The UI reads it to render the projected
  // state while the ack is in flight; on ack the projection is confirmed
  // and the entry is removed.
  readonly projection?: { readonly paused?: boolean; readonly speed?: SimSpeed };
}

const RETRY_AFTER_MS = 1_000;
const MAX_RETRIES = 5;

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
  // Tick at which the most recent Save command was acknowledged by the
  // host. Cleared when a fresh Save dispatches; the RunPanel uses this
  // to render a "saved at tick N" indicator.
  readonly lastSaveAtTick: bigint | null;
  // List of save slots written to OPFS. Refreshed via refreshSaves().
  readonly saves: readonly SaveSummary[];
  readonly refreshSaves: () => Promise<void>;
  // The Lineage Inspector reads this; clicking a lineage in the tree
  // updates it. Defaults to L0 once the founder lineage is seeded.
  readonly selectedLineageId: string;
  readonly selectLineage: (id: string) => void;
  // Lineages currently under player quarantine. Maintained from
  // QuarantineImposed / QuarantineLifted events. After a Load the set
  // is reset to empty — the client does not yet pull the restored
  // quarantine set out of the snapshot. Tracked in TODO.md.
  readonly quarantinedLineages: ReadonlySet<string>;
  readonly quarantine: (lineageId: string) => void;
  readonly releaseQuarantine: (lineageId: string) => void;
  // Origin compute, updated from the Tick heartbeat. Null until the
  // first heartbeat arrives. Heartbeats can drop under load; treat a
  // gap as "value unchanged", not "value zero".
  readonly originCompute: bigint | null;
  readonly originComputeMax: bigint | null;
  // Submit a patch. Fire-and-forget at the store level; success or
  // failure surfaces via PatchApplied or CommandError events on the
  // transport. The host is responsible for charging compute and
  // validating; the store does not pre-check.
  readonly applyPatch: (lineageId: string, firmware: readonly DirectiveSpec[]) => void;
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
  return new Map([
    [
      'L0',
      {
        id: 'L0',
        name: 'L0',
        parentId: null,
        foundedAtTick: 0n,
        founderProbeId: 'P0',
      },
    ],
  ]);
}

export const useSimStore = create<SimStoreState>((set, get) => {
  let unsubscribe: (() => void) | null = null;
  let retryHandle: ReturnType<typeof setInterval> | null = null;

  function retryStalePending(): void {
    const state = get();
    const transport = state.transport;
    if (transport === null) return;
    const now = Date.now();
    const updated = new Map(state.pendingCommands);
    let changed = false;
    for (const cmd of state.pendingCommands.values()) {
      if (now - cmd.issuedAtMs < RETRY_AFTER_MS) continue;
      if (cmd.retryCount >= MAX_RETRIES) continue;
      // Only commands that are safe to repeat without changing semantics.
      // pause/resume are idempotent state toggles; setSpeed re-asserts a
      // value. newRun, save, and load have side effects that shouldn't
      // be repeated silently.
      if (cmd.kind !== 'pause' && cmd.kind !== 'resume' && cmd.kind !== 'setSpeed') continue;
      console.error(
        `SimStore: command ${cmd.commandId} (${cmd.kind}) unacked after ${
          now - cmd.issuedAtMs
        }ms; retrying (attempt ${(cmd.retryCount + 1).toString()}/${MAX_RETRIES.toString()})`,
      );
      updated.set(cmd.commandId, {
        ...cmd,
        retryCount: cmd.retryCount + 1,
        issuedAtMs: now,
      });
      changed = true;
      if (cmd.kind === 'pause') {
        transport.send({ kind: 'pause', commandId: cmd.commandId });
      } else if (cmd.kind === 'resume') {
        transport.send({ kind: 'resume', commandId: cmd.commandId });
      } else if (cmd.kind === 'setSpeed' && cmd.projection?.speed !== undefined) {
        transport.send({
          kind: 'setSpeed',
          commandId: cmd.commandId,
          speed: cmd.projection.speed,
        });
      }
    }
    if (changed) set({ pendingCommands: updated });
  }

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
        // While paused, force the readout to 0 — a stale heartbeat from
        // an in-flight runUntil could otherwise leave the previous
        // non-zero reading lingering on the screen.
        //
        // While running, a heartbeat that reports actualSpeed=0
        // (because the pulse couldn't fit a single tick in its
        // wall-clock budget) is a momentary measurement artefact, not a
        // sign the sim has stopped. Hold the previous reading instead
        // of blipping the readout to 0 and back.
        const current = get();
        const nextSpeed = current.paused
          ? 0
          : event.actualSpeed > 0
            ? event.actualSpeed
            : current.actualSpeed;
        set({
          simTick: event.simTick,
          populationTotal: event.populationTotal,
          populationByLineage: byLineage,
          populationHistory: history,
          actualSpeed: nextSpeed,
          originCompute: event.originCompute,
          originComputeMax: event.originComputeMax,
        });
        return;
      }
      case 'replication':
        // Replication events arrive in proportion to the active
        // population — at scale, thousands per second. Triggering a
        // store update for any field on every one cascades into
        // re-renders that can lock the UI ("Maximum update depth
        // exceeded"). The simTick field stays advanced by the
        // throttled Tick heartbeat, which is enough for the panels
        // that read it.
        return;
      case 'speciation': {
        const lineages = new Map(get().lineages);
        lineages.set(event.newLineageId, {
          id: event.newLineageId,
          name: event.newLineageName,
          parentId: event.parentLineageId,
          foundedAtTick: event.simTick,
          founderProbeId: event.founderProbeId,
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
        const ackedEntry = pending.get(event.commandId);
        if (ackedEntry !== undefined) {
          pending.delete(event.commandId);
          if (ackedEntry.kind === 'save') {
            set({ pendingCommands: pending, lastSaveAtTick: event.simTick });
            // Refresh the saves list so the new entry appears in the UI
            // without the player needing to hit a Refresh button.
            void get().refreshSaves();
          } else {
            set({ pendingCommands: pending });
          }
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
        // Same reasoning as the replication branch: deaths arrive in
        // proportion to population at scale, so a per-event store
        // update would saturate React. simTick advances via the
        // throttled Tick heartbeat instead.
        return;
      case 'quarantineImposed': {
        const next = new Set(get().quarantinedLineages);
        next.add(event.lineageId);
        set({ quarantinedLineages: next });
        return;
      }
      case 'quarantineLifted': {
        const next = new Set(get().quarantinedLineages);
        next.delete(event.lineageId);
        set({ quarantinedLineages: next });
        return;
      }
      case 'patchApplied':
        // The lineage inspector re-polls driftTelemetry every 1500ms
        // and picks up the new reference firmware from there. No
        // dedicated store state needed at V1; future work will track
        // applied patches for the lineage tree's intervention history.
        return;
      case 'patchSaturated':
        // The host's auto-pause path will follow up with an
        // AutoPaused event when the player has the trigger armed; the
        // store does not need additional state here today.
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
    selectedLineageId: 'L0',
    lastSaveAtTick: null,
    saves: [],
    quarantinedLineages: new Set(),
    originCompute: null,
    originComputeMax: null,
    transport: null,
    attach: (transport) => {
      const previous = get().transport;
      if (previous !== null) {
        unsubscribe?.();
        previous.close();
      }
      unsubscribe = transport.onEvent(handleEvent);
      if (retryHandle === null) {
        retryHandle = setInterval(retryStalePending, 500);
      }
      set({ transport });
    },
    detach: () => {
      const transport = get().transport;
      if (transport === null) return;
      unsubscribe?.();
      unsubscribe = null;
      if (retryHandle !== null) {
        clearInterval(retryHandle);
        retryHandle = null;
      }
      transport.close();
      // Pending commands sent to the now-closed transport will never see
      // their ack — drop them so the retry loop doesn't try to re-send
      // them through some future transport. (React StrictMode exercises
      // this on every dev-mode mount/unmount cycle.)
      set({ transport: null, pendingCommands: new Map() });
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
        retryCount: 0,
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
        selectedLineageId: 'L0',
        quarantinedLineages: new Set(),
        originCompute: null,
        originComputeMax: null,
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
        retryCount: 0,
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
        retryCount: 0,
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
        retryCount: 0,
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
      pending.set(commandId, { commandId, kind: 'save', issuedAtMs: Date.now(), retryCount: 0 });
      // Clear any prior "saved at" indicator while a fresh save is in
      // flight; the ack handler will set it again.
      set({ pendingCommands: pending, lastSaveAtTick: null });
      transport.send({ kind: 'save', commandId, slot });
    },
    load: (slot = 'default') => {
      const transport = get().transport;
      if (transport === null) return;
      const commandId = mintCommandId('ui-load');
      const pending = new Map(get().pendingCommands);
      pending.set(commandId, { commandId, kind: 'load', issuedAtMs: Date.now(), retryCount: 0 });
      // Reset projected state — after a Load, the sim is at a different
      // tick with a different lineage tree and population. Clearing here
      // means the heartbeat the host emits at end of Load (and any
      // events on resume) repopulate from a clean baseline; without it,
      // the dashboard would show stale data from the pre-Load run.
      set({
        pendingCommands: pending,
        simTick: 0n,
        populationTotal: 0n,
        populationByLineage: new Map(),
        populationHistory: [],
        lineages: freshLineages(),
        paused: true,
        actualSpeed: 0,
        selectedLineageId: 'L0',
        // The post-Load snapshot may carry a quarantined set, but the
        // client doesn't pull it down today. Resetting to empty matches
        // what the client will observe from the absent events; future
        // work logged in TODO.md will surface the restored set so the
        // dashboard can render it correctly post-Load.
        quarantinedLineages: new Set(),
        // Cleared so the panel does not display the pre-Load reading;
        // the next heartbeat (the host emits one at end of Load) lands
        // the restored value.
        originCompute: null,
        originComputeMax: null,
      });
      transport.send({ kind: 'load', commandId, slot });
    },
    selectLineage: (id) => {
      set({ selectedLineageId: id });
    },
    quarantine: (lineageId) => {
      const transport = get().transport;
      if (transport === null) return;
      // Optimistic flip on the local store. The host echoes via
      // QuarantineImposed if the state actually changed, which
      // re-asserts the flip; on idempotent ack-only the state already
      // matches and the echo is a no-op. On commandError (unknown
      // lineage, pre-newRun) the optimistic flip is what's exposed
      // to the player — surfaceable as a roll-back is a future polish.
      const next = new Set(get().quarantinedLineages);
      next.add(lineageId);
      const commandId = mintCommandId('ui-quarantine');
      transport.send({ kind: 'quarantine', commandId, lineageId });
      set({ quarantinedLineages: next });
    },
    releaseQuarantine: (lineageId) => {
      const transport = get().transport;
      if (transport === null) return;
      const next = new Set(get().quarantinedLineages);
      next.delete(lineageId);
      const commandId = mintCommandId('ui-releaseQuarantine');
      transport.send({ kind: 'releaseQuarantine', commandId, lineageId });
      set({ quarantinedLineages: next });
    },
    applyPatch: (lineageId, firmware) => {
      const transport = get().transport;
      if (transport === null) return;
      const commandId = mintCommandId('ui-applyPatch');
      transport.send({ kind: 'applyPatch', commandId, lineageId, firmware });
    },
    refreshSaves: async () => {
      const transport = get().transport;
      if (transport === null) return;
      try {
        const result = (await transport.query({
          kind: 'listSaves',
          queryId: '',
        })) as ListSavesResult & { queryId: string };
        set({ saves: result.saves });
      } catch {
        // Swallow — saves remain at the previous value. The RunPanel
        // can show stale data without a panic.
      }
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

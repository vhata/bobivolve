// Node-side sim host run-loop.
//
// ARCHITECTURE.md "Three layers": this is the Sim host. It owns the run-loop,
// the clock, and (later) the storage adapter; it is the legitimate place for
// wall-clock APIs (Date.now / performance.now) — the sim core forbids them.
//
// Responsibilities:
//   - Drive sim/step.ts forward through commands (newRun, setSpeed, pause,
//     resume, step).
//   - Forward SimEvents the sim emits across the seam (Replication, Speciation
//     today; future mechanics extend the set). Tick heartbeats are
//     synthesised here, not in the sim — they are wall-clock-cadenced and
//     best-effort.
//   - Acknowledge each command with CommandAck or, on validation failure,
//     CommandError.

import type { Directive } from '../sim/directive.js';
import { tick } from '../sim/step.js';
import { type SimState, createInitialState, restore, snapshot } from '../sim/state.js';
import { ProbeId, Seed, SimTick } from '../sim/types.js';
import type { Storage } from '../sim/ports.js';
import type {
  Command,
  CommandAckEvent,
  CommandErrorEvent,
  ProbeInspectorDirective,
  Query,
  QueryResult,
  SimEvent,
  TickEvent,
} from '../protocol/types.js';
import { EventLogReader, EventLogWriter } from './event-log.js';
import { deserializeSnapshot, serializeSnapshot } from './snapshot-codec.js';

// Heartbeat cadence. Best-effort — the UI must not depend on heartbeat ticks
// for correctness (ARCHITECTURE.md "Heartbeat: ... Best-effort delivery").
// 60 Hz target frame rate; a single heartbeat per UI frame at most.
const DEFAULT_HEARTBEAT_HZ = 60;

// Maximum sim ticks executed in a single run-loop slice. Caps the work the
// loop does before yielding to the event queue, so commands can interleave
// at high speeds without blocking the process.
const MAX_TICKS_PER_SLICE = 1024;

// Snapshot cadence — a snapshot lands every N ticks while the run advances.
// ARCHITECTURE.md flags this as an open question with ~30,000 as the
// suggested heuristic; tunable per host.
const DEFAULT_SNAPSHOT_CADENCE_TICKS = 30_000n;

export interface PersistenceOptions {
  readonly storage: Storage;
  // Identifies this run; used to compose log and snapshot keys under
  //   runs/<runId>/log.ndjson
  //   runs/<runId>/snapshots/<tick>.snap
  readonly runId: string;
  readonly snapshotCadenceTicks?: bigint;
}

export interface NodeHostOptions {
  // Wall-clock source. Defaults to Date.now; tests inject a fake clock.
  readonly now?: () => number;
  // Heartbeat cadence in hertz. Set to 0 to disable heartbeats entirely
  // (useful for deterministic event-log capture).
  readonly heartbeatHz?: number;
  // Persistence wiring. When provided, the host logs every command and
  // every event, writes periodic snapshots, and routes Save/Load commands
  // through the on-disk format. When absent, Save/Load fail with a
  // commandError and the run is in-memory only.
  readonly persistence?: PersistenceOptions;
}

function logKey(runId: string): string {
  return `runs/${runId}/log.ndjson`;
}

function snapshotKey(runId: string, tick: bigint): string {
  return `runs/${runId}/snapshots/${tick.toString()}.snap`;
}

function directiveToInspector(directive: Directive): ProbeInspectorDirective {
  switch (directive.kind) {
    case 'replicate':
      return {
        kind: 'replicate',
        params: { threshold: directive.threshold.toString() },
      };
  }
}

// Listener shape used by the in-process NodeTransport. Identical signature to
// SimEventHandler (transport/types.ts) but redeclared here so this file does
// not depend on the transport layer.
export type HostEventListener = (event: SimEvent) => void;

export class NodeHost {
  private readonly listeners = new Set<HostEventListener>();
  private readonly now: () => number;
  private readonly heartbeatIntervalMs: number;

  // Persistence. When configured, every cmd and ev is logged; periodic
  // snapshots land at snapshotCadenceTicks. None of this fires when
  // persistence is undefined.
  private readonly persistence: PersistenceOptions | undefined;
  private readonly logWriter: EventLogWriter | null;
  private readonly snapshotCadenceTicks: bigint;
  private lastSnapAtTick: SimTick = SimTick(0n);
  // Serialised async work. Save and Load enqueue here so they execute in
  // declaration order without overlapping.
  private workQueue: Promise<void> = Promise.resolve();
  // True while a Load is replaying the log tail. Suppresses logging and
  // listener emission so replayed events don't double-up the log or fire
  // the UI again.
  private replaying = false;

  // Run-loop state. Null until the first newRun command lands.
  private state: SimState | null = null;
  // Set by setSpeed; consumed by the eventual realtime-paced runner. Held
  // across newRun -> setSpeed -> resume so a UI can stage commands before
  // unpausing.
  private speed = 1;
  private paused = false;
  // Wall-clock at start of the most recent speed measurement.
  private lastHeartbeatAtMs = 0;
  // Sim tick at start of the most recent speed measurement.
  private lastHeartbeatAtTick: SimTick = SimTick(0n);

  constructor(options: NodeHostOptions = {}) {
    this.now = options.now ?? Date.now;
    const hz = options.heartbeatHz ?? DEFAULT_HEARTBEAT_HZ;
    this.heartbeatIntervalMs = hz > 0 ? Math.floor(1000 / hz) : Number.POSITIVE_INFINITY;
    this.persistence = options.persistence;
    this.snapshotCadenceTicks =
      options.persistence?.snapshotCadenceTicks ?? DEFAULT_SNAPSHOT_CADENCE_TICKS;
    this.logWriter =
      this.persistence !== undefined
        ? new EventLogWriter(this.persistence.storage, logKey(this.persistence.runId))
        : null;
  }

  // Execute a Query against current state. Queries are pull-only and
  // synchronous against in-memory state; the transport layer wraps the
  // call in a Promise for interface symmetry with cross-process variants.
  // ARCHITECTURE.md "Query: pull-only, never pushed".
  executeQuery(query: Query): QueryResult {
    switch (query.kind) {
      case 'probeInspector':
        return this.queryProbeInspector(query.queryId, query.probeId);
      case 'lineageTree':
      case 'driftTelemetry':
      case 'logSlice':
      case 'populationSummary':
        // Result bodies for these are still placeholders in the schema;
        // their handlers land alongside the matching dashboard panels.
        // Returning a placeholder rather than throwing keeps the query
        // surface live for early UI integration.
        return { queryId: query.queryId, kind: query.kind } as QueryResult;
    }
  }

  private queryProbeInspector(queryId: string, probeId: string): QueryResult {
    if (this.state === null) {
      return { queryId, kind: 'probeInspector', probe: null };
    }
    const probe = this.state.probes.get(ProbeId(probeId));
    if (probe === undefined) {
      return { queryId, kind: 'probeInspector', probe: null };
    }
    return {
      queryId,
      kind: 'probeInspector',
      probe: {
        id: probe.id,
        lineageId: probe.lineageId,
        bornAtTick: probe.bornAtTick,
        firmware: probe.firmware.map(directiveToInspector),
      },
    };
  }

  // Drain any pending log entries to storage and wait for any queued async
  // work (Save, Load, snapshot writes) to complete. Tests await this before
  // asserting on storage contents; the CLI awaits it before close.
  async flush(): Promise<void> {
    await this.workQueue;
    if (this.logWriter !== null) await this.logWriter.flush();
  }

  // Subscribe to events. Returns an unsubscribe function.
  subscribe(listener: HostEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // Apply a command. Validation errors are reported via commandError; valid
  // commands are acknowledged via commandAck once their effect has been
  // applied to host state.
  send(cmd: Command): void {
    // Log every command except Load: a logged Load would fork the timeline
    // every time the run is re-loaded later. Save IS logged — it marks a
    // checkpoint in the run history that future inspection should see.
    if (!this.replaying && this.logWriter !== null && cmd.kind !== 'load') {
      this.logWriter.appendCommand(this.state?.simTick ?? 0n, cmd);
    }
    switch (cmd.kind) {
      case 'newRun':
        this.handleNewRun(cmd.commandId, cmd.seed);
        return;
      case 'setSpeed':
        this.handleSetSpeed(cmd.commandId, cmd.speed);
        return;
      case 'pause':
        this.paused = true;
        this.ack(cmd.commandId);
        return;
      case 'resume':
        this.paused = false;
        // Reset the heartbeat measurement so achieved-speed reflects the
        // post-resume cadence rather than the pre-pause one.
        this.resetHeartbeatBaseline();
        this.ack(cmd.commandId);
        return;
      case 'step':
        this.handleStep(cmd.commandId, cmd.ticks);
        return;
      case 'configureAutoPause':
        // R0 ships a fixed default trigger set; the message is accepted but
        // has no effect until the auto-pause UI lands.
        this.ack(cmd.commandId);
        return;
      case 'save':
        this.handleSave(cmd.commandId);
        return;
      case 'load':
        this.handleLoad(cmd.commandId);
        return;
    }
  }

  // Run synchronously until the sim reaches `untilTick` or until `paused` is
  // set. Heartbeats fire on a wall-clock cadence measured between slices.
  // Returns when the budget is exhausted.
  runUntil(untilTick: bigint): void {
    if (this.state === null) return;
    this.resetHeartbeatBaseline();
    while (this.state.simTick < untilTick && !this.paused) {
      // One slice per loop iteration; heartbeat decision is between slices.
      const remaining = untilTick - this.state.simTick;
      const slice =
        remaining > BigInt(MAX_TICKS_PER_SLICE) ? BigInt(MAX_TICKS_PER_SLICE) : remaining;
      this.advanceUnpaused(slice);
      this.maybeEmitHeartbeat();
    }
    // Final heartbeat so the UI sees the terminal state of a finite run.
    if (this.heartbeatIntervalMs !== Number.POSITIVE_INFINITY) {
      this.emitHeartbeat();
    }
  }

  // Current sim tick, or null if no run has been started. Exposed for tests
  // and the CLI; not part of the seam.
  currentTick(): bigint | null {
    return this.state?.simTick ?? null;
  }

  // ── command handlers ───────────────────────────────────────────────────────

  private handleNewRun(commandId: string, seed: bigint): void {
    this.state = createInitialState(Seed(seed));
    this.speed = 1;
    this.paused = false;
    this.resetHeartbeatBaseline();
    this.ack(commandId);
  }

  private handleSetSpeed(commandId: string, speed: number): void {
    if (speed !== 1 && speed !== 4 && speed !== 16 && speed !== 64) {
      this.error(commandId, `invalid speed: ${speed} (allowed: 1, 4, 16, 64)`);
      return;
    }
    this.speed = speed;
    this.resetHeartbeatBaseline();
    this.ack(commandId);
  }

  private handleStep(commandId: string, ticks: bigint): void {
    if (this.state === null) {
      this.error(commandId, 'cannot step before newRun');
      return;
    }
    // Step ignores the paused flag; that's the point of step (advance one
    // tick or N ticks while otherwise paused). Zero is treated as one per
    // schema.proto's contract for the Step message.
    const n = ticks === 0n ? 1n : ticks;
    let remaining = n;
    while (remaining > 0n) {
      const slice =
        remaining > BigInt(MAX_TICKS_PER_SLICE) ? BigInt(MAX_TICKS_PER_SLICE) : remaining;
      this.advanceUnpaused(slice);
      remaining -= slice;
    }
    this.ack(commandId);
  }

  // ── tick driver ────────────────────────────────────────────────────────────

  // Advance the sim by `n` ticks, draining the events the sim emits and
  // forwarding each through `emit`. Ignores `paused`; the public
  // runUntil() / step path is responsible for honoring it.
  private advanceUnpaused(n: bigint): void {
    if (this.state === null) return;
    const state = this.state;
    const events: SimEvent[] = [];
    for (let i = 0n; i < n; i++) {
      events.length = 0;
      tick(state, events);
      for (const event of events) this.emit(event);
      this.maybeWriteSnapshot();
    }
  }

  // Trigger a snapshot if we've crossed the cadence boundary since the
  // previous one. The snapshot is captured synchronously from current state
  // (so it reflects the tick we are at, not whatever future state the work
  // queue eventually serialises against), then written to storage in the
  // queue.
  private maybeWriteSnapshot(): void {
    if (this.state === null || this.persistence === undefined || this.replaying) return;
    if (this.state.simTick - this.lastSnapAtTick < this.snapshotCadenceTicks) return;
    this.scheduleSnapshot();
  }

  // Capture and enqueue a snapshot of current state. The snap log entry is
  // appended synchronously so its position in the (tick, seq) sequence is
  // pinned to the current tick; the snapshot file write itself is async.
  private scheduleSnapshot(): void {
    if (this.state === null || this.persistence === undefined || this.logWriter === null) return;
    const state = this.state;
    const tickAt = state.simTick;
    const snap = snapshot(state);
    const key = snapshotKey(this.persistence.runId, tickAt);
    this.lastSnapAtTick = tickAt;
    this.logWriter.appendSnap(tickAt, key);
    const storage = this.persistence.storage;
    this.enqueue(async () => {
      await storage.write(key, serializeSnapshot(snap));
    });
  }

  // ── heartbeat ──────────────────────────────────────────────────────────────

  private maybeEmitHeartbeat(): void {
    if (this.heartbeatIntervalMs === Number.POSITIVE_INFINITY) return;
    const now = this.now();
    if (now - this.lastHeartbeatAtMs < this.heartbeatIntervalMs) return;
    this.emitHeartbeat();
  }

  private emitHeartbeat(): void {
    if (this.state === null) return;
    const state = this.state;
    const now = this.now();
    const elapsedMs = now - this.lastHeartbeatAtMs;
    const elapsedTicks = state.simTick - this.lastHeartbeatAtTick;

    // Achieved speed: ticks per second over the measurement window. The proto
    // defines this as a uint32; clamp at 0 (run resumed but no ticks yet) and
    // at u32 max.
    let actualSpeed = 0;
    if (elapsedMs > 0 && elapsedTicks > 0n) {
      const ticksPerSec = Number(elapsedTicks) / (elapsedMs / 1000);
      const clamped = Math.min(Math.max(0, Math.floor(ticksPerSec)), 0xffff_ffff);
      actualSpeed = clamped;
    }

    const populationByLineage: Record<string, bigint> = {};
    for (const probe of state.probes.values()) {
      const key = probe.lineageId;
      populationByLineage[key] = (populationByLineage[key] ?? 0n) + 1n;
    }

    const event: TickEvent & { simTick: bigint } = {
      kind: 'tick',
      simTick: state.simTick,
      actualSpeed,
      populationTotal: BigInt(state.probes.size),
      populationByLineage,
    };
    this.emit(event);

    this.lastHeartbeatAtMs = now;
    this.lastHeartbeatAtTick = state.simTick;
  }

  private resetHeartbeatBaseline(): void {
    this.lastHeartbeatAtMs = this.now();
    this.lastHeartbeatAtTick = this.state?.simTick ?? SimTick(0n);
  }

  // ── ack / error / emit ─────────────────────────────────────────────────────

  private ack(commandId: string): void {
    if (commandId === '') return;
    const tickAt = this.state?.simTick ?? 0n;
    const event: CommandAckEvent & { simTick: bigint } = {
      kind: 'commandAck',
      simTick: tickAt,
      commandId,
    };
    this.emit(event);
  }

  private error(commandId: string, message: string): void {
    if (commandId === '') return;
    const tickAt = this.state?.simTick ?? 0n;
    const event: CommandErrorEvent & { simTick: bigint } = {
      kind: 'commandError',
      simTick: tickAt,
      commandId,
      message,
    };
    this.emit(event);
  }

  private emit(event: SimEvent): void {
    if (this.replaying) return;
    if (this.logWriter !== null) {
      this.logWriter.appendEvent(event.simTick, event);
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (e) {
        // A misbehaving listener must not bring down the run-loop. Log and
        // continue; this is the legitimate use of console.error per the
        // project lint config.
        console.error('NodeHost listener threw:', e);
      }
    }
  }

  // ── Save / Load ────────────────────────────────────────────────────────────

  private handleSave(commandId: string): void {
    if (this.persistence === undefined) {
      this.error(commandId, 'cannot save: no persistence configured');
      return;
    }
    if (this.state === null) {
      this.error(commandId, 'cannot save before newRun');
      return;
    }
    // Force a snapshot now so the save reflects current state precisely,
    // then flush so the on-disk log includes it.
    this.scheduleSnapshot();
    this.enqueue(async () => {
      if (this.logWriter !== null) await this.logWriter.flush();
      this.ack(commandId);
    });
  }

  private handleLoad(commandId: string): void {
    if (this.persistence === undefined) {
      this.error(commandId, 'cannot load: no persistence configured');
      return;
    }
    this.enqueue(async () => {
      await this.doLoad(commandId);
    });
  }

  private async doLoad(commandId: string): Promise<void> {
    if (this.persistence === undefined) return;
    const persistence = this.persistence;

    // Flush any in-flight buffer before reading; we want a consistent view
    // of the log on disk.
    if (this.logWriter !== null) await this.logWriter.flush();

    const reader = new EventLogReader(persistence.storage, logKey(persistence.runId));
    const allEntries = await reader.readAll();
    if (allEntries.length === 0) {
      this.error(commandId, `no log entries for run ${persistence.runId}`);
      return;
    }

    const latest = await reader.latestSnap();
    if (latest === null) {
      // Rebuild-from-log without a snap is the longer fallback path
      // ARCHITECTURE.md describes for cross-version loading. R0 requires a
      // snap (the host writes one on Save and at cadence, so this only
      // triggers when the log was hand-edited or aborted before cadence).
      this.error(
        commandId,
        `no snapshot in log for run ${persistence.runId}; rebuild-from-log is not yet implemented`,
      );
      return;
    }

    const snapBytes = await persistence.storage.read(latest.snapshotKey);
    if (snapBytes === null) {
      this.error(commandId, `snapshot file missing: ${latest.snapshotKey}`);
      return;
    }

    const restored = restore(deserializeSnapshot(snapBytes));
    this.state = restored;
    this.lastSnapAtTick = restored.simTick;

    // Determine how far the log got past the latest snap, then advance the
    // sim silently to catch up. Determinism guarantees that the events the
    // sim re-emits during this catch-up match the ev entries already in the
    // log; we discard them (replaying flag suppresses listener emission and
    // log writes).
    let maxTick = latest.tick;
    for (const entry of allEntries) {
      if (entry.tick > maxTick) maxTick = entry.tick;
    }

    this.replaying = true;
    try {
      const toAdvance = maxTick - restored.simTick;
      if (toAdvance > 0n) {
        const events: SimEvent[] = [];
        for (let i = 0n; i < toAdvance; i++) {
          events.length = 0;
          tick(restored, events);
        }
      }
    } finally {
      this.replaying = false;
    }

    // Resume the writer so future entries don't collide with previously
    // logged ones at the same tick.
    if (this.logWriter !== null) {
      const last = allEntries[allEntries.length - 1];
      if (last !== undefined) this.logWriter.resumeAt(last.tick, last.seq + 1);
    }

    // Pause post-load; the user is presumed to be inspecting before
    // resuming.
    this.paused = true;
    this.resetHeartbeatBaseline();

    this.ack(commandId);
  }

  private enqueue(work: () => Promise<void>): void {
    this.workQueue = this.workQueue
      .then(() => work())
      .catch((e: unknown) => {
        console.error('NodeHost work queue:', e);
      });
  }
}

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
import { SPECIATION_DIVERGENCE_DIVISOR } from '../sim/lineage.js';
import { tick } from '../sim/step.js';
import { type SimState, createInitialState, restore, snapshot } from '../sim/state.js';
import { LATTICE_SIDE, MAX_RESOURCE_PER_CELL } from '../sim/substrate.js';
import { LineageId, ProbeId, Seed, SimTick } from '../sim/types.js';
import type { Storage } from '../sim/ports.js';
import type {
  AutoPausedEvent,
  Command,
  CommandAckEvent,
  CommandErrorEvent,
  ParameterDrift,
  ProbeInspectorDirective,
  QuarantineImposedEvent,
  QuarantineLiftedEvent,
  Query,
  QueryResult,
  SimEvent,
  SubstrateProbe,
  TickEvent,
} from '../protocol/types.js';
import { EventLogWriter } from './event-log.js';
import { deserializeSnapshot, serializeSnapshot } from './snapshot-codec.js';

// Heartbeat cadence. Best-effort — the UI must not depend on heartbeat ticks
// for correctness (ARCHITECTURE.md "Heartbeat: ... Best-effort delivery").
// 60 Hz target frame rate; a single heartbeat per UI frame at most.
const DEFAULT_HEARTBEAT_HZ = 60;

// Maximum sim ticks executed in a single run-loop inner slice between
// budget / pause checks. Smaller slice = more responsive pause and
// wall-clock-budget enforcement; the per-iteration loop overhead is
// negligible next to BigInt-heavy tick work.
const MAX_TICKS_PER_SLICE = 8;

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

// Named save slots live under `saves/`, separate from the active run's
// log under `runs/`. The index file records what's in each slot so the
// UI can list them without enumerating the storage directory directly.
const SAVES_INDEX_KEY = 'saves/index.json';

function saveSlotKey(slot: string): string {
  // Slot names must not contain `/` (would escape the saves namespace).
  if (slot.includes('/') || slot === '' || slot === '..' || slot === '.') {
    throw new Error(`invalid save slot: ${JSON.stringify(slot)}`);
  }
  return `saves/${slot}.save`;
}

interface SaveSlotEntry {
  readonly slot: string;
  readonly tick: string;
  readonly savedAtMs: number;
}

interface SavesIndex {
  readonly saves: readonly SaveSlotEntry[];
}

async function readSavesIndex(storage: Storage): Promise<SavesIndex> {
  const bytes = await storage.read(SAVES_INDEX_KEY);
  if (bytes === null) return { saves: [] };
  try {
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text) as { saves?: readonly SaveSlotEntry[] };
    if (!Array.isArray(parsed.saves)) return { saves: [] };
    return { saves: parsed.saves };
  } catch {
    // A corrupt index is treated as empty rather than throwing — the
    // saves on disk are still recoverable by name; the player just
    // can't browse them. Future polish: surface a warning.
    return { saves: [] };
  }
}

function directiveToInspector(directive: Directive): ProbeInspectorDirective {
  switch (directive.kind) {
    case 'replicate':
      return {
        kind: 'replicate',
        params: { threshold: directive.threshold.toString() },
      };
    case 'gather':
      return {
        kind: 'gather',
        params: { rate: directive.rate.toString() },
      };
    case 'explore':
      return {
        kind: 'explore',
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

  // Auto-pause triggers currently armed. Updated by configureAutoPause
  // commands; consulted after each event to decide whether to pause and
  // emit an AutoPaused event. SPEC.md "Auto-pause triggers ... user
  // configurable" — the host enforces; the UI offers the toggles.
  private autoPauseTriggers = new Set<string>();

  // Persistence. When configured, every cmd and ev is logged; periodic
  // snapshots land at snapshotCadenceTicks. None of this fires when
  // persistence is undefined.
  private readonly persistence: PersistenceOptions | undefined;
  // Re-created on each newRun so the previous run's seq counter doesn't
  // bleed into the new log.
  private logWriter: EventLogWriter | null;
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
  async executeQuery(query: Query): Promise<QueryResult> {
    switch (query.kind) {
      case 'probeInspector':
        return this.queryProbeInspector(query.queryId, query.probeId);
      case 'driftTelemetry':
        return this.queryDriftTelemetry(query.queryId, query.lineageId);
      case 'listSaves':
        return this.queryListSaves(query.queryId);
      case 'substrate':
        return this.querySubstrate(query.queryId);
      case 'lineageTree':
      case 'logSlice':
      case 'populationSummary':
        // Result bodies for these are still placeholders in the schema;
        // their handlers land alongside the matching dashboard panels.
        // Returning a placeholder rather than throwing keeps the query
        // surface live for early UI integration.
        return { queryId: query.queryId, kind: query.kind } as QueryResult;
    }
  }

  private async queryListSaves(queryId: string): Promise<QueryResult> {
    if (this.persistence === undefined) {
      return { queryId, kind: 'listSaves', saves: [] };
    }
    const index = await readSavesIndex(this.persistence.storage);
    return { queryId, kind: 'listSaves', saves: index.saves };
  }

  private querySubstrate(queryId: string): QueryResult {
    if (this.state === null) {
      return {
        queryId,
        kind: 'substrate',
        side: LATTICE_SIDE,
        cells: [],
        maxResourcePerCell: MAX_RESOURCE_PER_CELL.toString(),
        probes: [],
      };
    }
    const cells = this.state.resources.map((r) => r.toString());
    const probes: SubstrateProbe[] = [];
    for (const probe of this.state.probes.values()) {
      probes.push({
        id: probe.id,
        lineageId: probe.lineageId,
        x: probe.position.x,
        y: probe.position.y,
      });
    }
    return {
      queryId,
      kind: 'substrate',
      side: LATTICE_SIDE,
      cells,
      maxResourcePerCell: MAX_RESOURCE_PER_CELL.toString(),
      probes,
    };
  }

  private queryDriftTelemetry(queryId: string, lineageId: string): QueryResult {
    if (this.state === null) {
      return { queryId, kind: 'driftTelemetry', lineageId, drift: null };
    }
    const lineage = this.state.lineages.get(LineageId(lineageId));
    if (lineage === undefined) {
      return { queryId, kind: 'driftTelemetry', lineageId, drift: null };
    }

    // Walk extant probes in this lineage, accumulate per-parameter stats.
    // Reference values come from the lineage's referenceFirmware (set at
    // speciation, immutable afterwards). Each directive contributes one
    // parameter keyed by `${kind}.${param}` so a richer firmware does
    // not collide.
    const accum = new Map<string, { sum: bigint; min: bigint; max: bigint; count: bigint }>();
    const accumulate = (key: string, value: bigint): void => {
      const existing = accum.get(key);
      if (existing === undefined) {
        accum.set(key, { sum: value, min: value, max: value, count: 1n });
      } else {
        accum.set(key, {
          sum: existing.sum + value,
          min: value < existing.min ? value : existing.min,
          max: value > existing.max ? value : existing.max,
          count: existing.count + 1n,
        });
      }
    };
    let population = 0n;
    for (const probe of this.state.probes.values()) {
      if (probe.lineageId !== lineage.id) continue;
      population += 1n;
      for (const directive of probe.firmware) {
        switch (directive.kind) {
          case 'replicate':
            accumulate('replicate.threshold', directive.threshold);
            break;
          case 'gather':
            accumulate('gather.rate', directive.rate);
            break;
          case 'explore':
            accumulate('explore.threshold', directive.threshold);
            break;
        }
      }
    }

    // Reference values from the lineage's frozen reference firmware.
    const reference = new Map<string, bigint>();
    for (const directive of lineage.referenceFirmware) {
      switch (directive.kind) {
        case 'replicate':
          reference.set('replicate.threshold', directive.threshold);
          break;
        case 'gather':
          reference.set('gather.rate', directive.rate);
          break;
        case 'explore':
          reference.set('explore.threshold', directive.threshold);
          break;
      }
    }

    const parameters: Record<string, ParameterDrift> = {};
    for (const [key, stats] of accum) {
      const ref = reference.get(key) ?? 0n;
      const mean = stats.count === 0n ? 0n : stats.sum / stats.count;
      parameters[key] = {
        reference: ref.toString(),
        min: stats.min.toString(),
        max: stats.max.toString(),
        mean: mean.toString(),
      };
    }

    return {
      queryId,
      kind: 'driftTelemetry',
      lineageId,
      drift: {
        population,
        parameters,
        divergenceDivisor: SPECIATION_DIVERGENCE_DIVISOR.toString(),
      },
    };
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
    // Log every command except Load and newRun:
    //  - Load is a meta-control that forks the timeline; logging it would
    //    cause a circular reference on future loads.
    //  - newRun is logged inside handleNewRun, after the writer is reset
    //    for the new run, so the cmd lands in the right slot.
    // Save IS logged — it marks a checkpoint in the run history.
    if (
      !this.replaying &&
      this.logWriter !== null &&
      cmd.kind !== 'load' &&
      cmd.kind !== 'newRun'
    ) {
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
        this.autoPauseTriggers = new Set(cmd.enabledTriggers);
        this.ack(cmd.commandId);
        return;
      case 'quarantine':
        this.handleQuarantineToggle(cmd.commandId, cmd.lineageId, true);
        return;
      case 'releaseQuarantine':
        this.handleQuarantineToggle(cmd.commandId, cmd.lineageId, false);
        return;
      case 'save':
        this.handleSave(cmd.commandId, cmd.slot);
        return;
      case 'load':
        this.handleLoad(cmd.commandId, cmd.slot);
        return;
    }
  }

  // Both Quarantine and ReleaseQuarantine commands flow through here. The
  // shape is symmetric: validate, no-op-ack on idempotent, otherwise flip
  // the set membership and emit the matching domain event. Splitting the
  // commands kept the seam clean; a single internal helper keeps the host
  // code from duplicating the validation.
  //
  // Origin compute gating is deferred to task 3 — SPEC says quarantine
  // costs Origin compute, the agreed shape is a per-tick maintenance
  // cost while a quarantine is held. That gate lands when the budget
  // does; this slice ships the flag-only mechanic.
  private handleQuarantineToggle(commandId: string, lineageId: string, quarantine: boolean): void {
    if (this.state === null) {
      this.error(
        commandId,
        quarantine ? 'cannot quarantine before newRun' : 'cannot release before newRun',
      );
      return;
    }
    const id = LineageId(lineageId);
    if (!this.state.lineages.has(id)) {
      this.error(commandId, `unknown lineage: ${lineageId}`);
      return;
    }
    const set = this.state.quarantinedLineages;
    const wasQuarantined = set.has(id);
    if (quarantine === wasQuarantined) {
      // Idempotent: already in target state. Ack only — no event.
      this.ack(commandId);
      return;
    }
    if (quarantine) {
      set.add(id);
      const event: QuarantineImposedEvent & { simTick: bigint } = {
        kind: 'quarantineImposed',
        simTick: this.state.simTick,
        lineageId,
      };
      this.emit(event);
    } else {
      set.delete(id);
      const event: QuarantineLiftedEvent & { simTick: bigint } = {
        kind: 'quarantineLifted',
        simTick: this.state.simTick,
        lineageId,
      };
      this.emit(event);
    }
    this.ack(commandId);
  }

  // Run synchronously until the sim reaches `untilTick`, or until `paused`
  // is set, or until `wallClockBudgetMs` of wall-clock time has elapsed —
  // whichever happens first. Heartbeats fire on a wall-clock cadence
  // measured between slices.
  //
  // The wall-clock budget exists so the worker host's pulser can bound
  // how long one pulse blocks the worker's event loop, regardless of how
  // expensive a single tick has become at fat population. Without it, a
  // pulse asking for "advance 64 ticks" can run for seconds when each
  // tick is BigInt-heavy, and any incoming pause/setSpeed message sits
  // in the postMessage queue for that whole duration.
  runUntil(untilTick: bigint, wallClockBudgetMs?: number): void {
    if (this.state === null) return;
    // The heartbeat baseline is updated at end-of-emit, not at start
    // here. Resetting at runUntil start would constrain each heartbeat
    // to measure only the per-pulse advance, ignoring the idle gap
    // between pulses; that produces per-pulse rates which occasionally
    // read 0 t/s even while the sim is healthily advancing. Letting the
    // baseline ride forward means each heartbeat reports the rate since
    // the previous heartbeat — a more honest aggregate.
    const start = wallClockBudgetMs !== undefined ? performance.now() : 0;
    while (this.state.simTick < untilTick && !this.paused) {
      // One slice per loop iteration; heartbeat decision is between slices.
      const remaining = untilTick - this.state.simTick;
      const slice =
        remaining > BigInt(MAX_TICKS_PER_SLICE) ? BigInt(MAX_TICKS_PER_SLICE) : remaining;
      this.advanceUnpaused(slice);
      this.maybeEmitHeartbeat();
      if (wallClockBudgetMs !== undefined && performance.now() - start >= wallClockBudgetMs) {
        break;
      }
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
    // newRun starts a fresh run. If persistence is configured, the previous
    // run's log is deleted so the slot doesn't accumulate multiple newRun
    // entries (which would make Load replay them in sequence). Snapshot
    // files become orphans; a future reaper can sweep them, but they are
    // no longer referenced once the snap log entries are gone.
    const persistence = this.persistence;
    if (persistence !== undefined) {
      const storage = persistence.storage;
      const key = logKey(persistence.runId);
      this.logWriter = new EventLogWriter(storage, key);
      this.lastSnapAtTick = SimTick(0n);
      this.enqueue(async () => {
        await storage.delete(key);
      });
    }

    this.state = createInitialState(Seed(seed));
    this.speed = 1;
    this.paused = false;
    this.resetHeartbeatBaseline();

    // Log the newRun command into the freshly-reset writer so the
    // canonical (seed, command-log) description survives.
    if (!this.replaying && this.logWriter !== null) {
      this.logWriter.appendCommand(0n, { kind: 'newRun', commandId, seed });
    }
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
  // forwarding each through `emit`. Auto-pause triggers are consulted
  // after each event; if one fires, the loop bails out so the next tick
  // does not advance past the trigger point. Ignores `paused`; the
  // public runUntil() / step path is responsible for honoring it.
  private advanceUnpaused(n: bigint): void {
    if (this.state === null) return;
    const state = this.state;
    const events: SimEvent[] = [];
    for (let i = 0n; i < n; i++) {
      events.length = 0;
      tick(state, events);
      for (const event of events) {
        this.emit(event);
        if (this.maybeAutoPause(event)) return;
      }
      this.maybeWriteSnapshot();
    }
  }

  // Returns true if an auto-pause trigger fired for this event. The host
  // sets this.paused, emits an AutoPaused event, and the caller bails
  // out of further advancement.
  private maybeAutoPause(event: SimEvent): boolean {
    if (this.replaying) return false;
    let trigger: string | null = null;
    if (event.kind === 'speciation' && this.autoPauseTriggers.has('speciation')) {
      trigger = 'speciation';
    } else if (event.kind === 'extinction' && this.autoPauseTriggers.has('lineageExtinction')) {
      trigger = 'lineageExtinction';
    }
    if (trigger === null) return false;
    this.paused = true;
    const autoPaused: AutoPausedEvent & { simTick: bigint } = {
      kind: 'autoPaused',
      simTick: event.simTick,
      trigger,
    };
    this.emit(autoPaused);
    return true;
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

  private handleSave(commandId: string, slot: string): void {
    if (this.persistence === undefined) {
      this.error(commandId, 'cannot save: no persistence configured');
      return;
    }
    if (this.state === null) {
      this.error(commandId, 'cannot save before newRun');
      return;
    }
    let key: string;
    try {
      key = saveSlotKey(slot);
    } catch (e) {
      this.error(commandId, e instanceof Error ? e.message : String(e));
      return;
    }
    // Capture the snapshot synchronously so it reflects the state at
    // save-time; the actual disk write happens on the work queue.
    const snap = snapshot(this.state);
    const tickAt = this.state.simTick;
    const persistence = this.persistence;
    this.enqueue(async () => {
      const bytes = serializeSnapshot(snap);
      await persistence.storage.write(key, bytes);
      // Update the index — read existing, replace any same-named slot,
      // write back. The whole thing is small so atomicity isn't a
      // concern at R0 scales.
      const existing = await readSavesIndex(persistence.storage);
      const updated: SavesIndex = {
        saves: [
          ...existing.saves.filter((s) => s.slot !== slot),
          { slot, tick: tickAt.toString(), savedAtMs: Date.now() },
        ],
      };
      await persistence.storage.write(
        SAVES_INDEX_KEY,
        new TextEncoder().encode(JSON.stringify(updated)),
      );
      this.ack(commandId);
    });
  }

  private handleLoad(commandId: string, slot: string): void {
    if (this.persistence === undefined) {
      this.error(commandId, 'cannot load: no persistence configured');
      return;
    }
    this.enqueue(async () => {
      await this.doLoad(commandId, slot);
    });
  }

  private async doLoad(commandId: string, slot: string): Promise<void> {
    if (this.persistence === undefined) return;
    const persistence = this.persistence;

    let key: string;
    try {
      key = saveSlotKey(slot);
    } catch (e) {
      this.error(commandId, e instanceof Error ? e.message : String(e));
      return;
    }

    const snapBytes = await persistence.storage.read(key);
    if (snapBytes === null) {
      this.error(commandId, `save slot not found: ${slot}`);
      return;
    }

    const restored = restore(deserializeSnapshot(snapBytes));
    this.state = restored;
    this.lastSnapAtTick = restored.simTick;

    // Reset the active run's log — the loaded state forks the timeline,
    // and continuing to append to the prior run's log would create a
    // confusing discontinuity. The save slot itself is unchanged on
    // disk; the player can save again under the same slot to update.
    const activeLogKey = logKey(persistence.runId);
    await persistence.storage.delete(activeLogKey);
    this.logWriter = new EventLogWriter(persistence.storage, activeLogKey);

    // Pause post-load; the user is presumed to be inspecting before
    // resuming.
    this.paused = true;
    this.resetHeartbeatBaseline();

    // Emit a heartbeat so the UI's projected state catches up to the
    // restored sim state. Without this, the dashboard keeps rendering
    // whatever it had before the Load and looks like nothing happened.
    if (this.heartbeatIntervalMs !== Number.POSITIVE_INFINITY) {
      this.emitHeartbeat();
    }

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

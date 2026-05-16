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

import { DECREE_AUTHORING_COST, ORIGIN_COMPUTE_MAX, PATCH_AUTHORING_COST } from '../sim/compute.js';
import type { DecreeTrigger, QueuedDecree } from '../sim/decree.js';
import type { Directive, DirectiveStack } from '../sim/directive.js';
import { SPECIATION_DIVERGENCE_DIVISOR } from '../sim/lineage.js';
import { applyPatch, validatePatchFirmware } from '../sim/patch.js';
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
  DecreeQueuedEvent,
  DecreeRevokedEvent,
  DecreeTriggerSpec,
  DirectiveSpec,
  ParameterDrift,
  PatchAppliedEvent,
  PopulationSummaryPoint,
  ProbeInspectorDirective,
  QuarantineImposedEvent,
  QuarantineLiftedEvent,
  Query,
  QueryResult,
  SimEvent,
  SubstrateProbe,
  TickEvent,
} from '../protocol/types.js';
import { EventLogReader, EventLogWriter, type LogEntry, type SnapLogEntry } from './event-log.js';
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

// Replay-loop chunk size. handleRewindToTick advances synchronously
// from the latest snap to the target, and at fat population each
// tick can take several ms; without yielding, a 30k-tick replay
// blocks the worker thread for tens of seconds and pause clicks pile
// up unacked. After every chunk of REPLAY_YIELD_TICKS we yield via
// setTimeout(0) so the worker drains its postMessage queue.
const REPLAY_YIELD_TICKS = 250n;

// Snapshot cadence — a snapshot lands every N ticks while the run advances.
// ARCHITECTURE.md flags this as an open question with ~30,000 as the
// suggested heuristic; tunable per host.
const DEFAULT_SNAPSHOT_CADENCE_TICKS = 30_000n;

// PopulationSummary rolling-buffer capacity. Mirrors the UI store's
// HISTORY_CAPACITY (ui/sim-store.ts) — same heartbeat data feeds both,
// and the query surface exists so a fresh dashboard can rehydrate the
// sparkline after a reload without waiting for the buffer to refill
// from live heartbeats.
const POPULATION_SUMMARY_CAPACITY = 240;

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

function snapshotsDirKey(runId: string): string {
  return `runs/${runId}/snapshots`;
}

function snapshotKey(runId: string, tick: bigint): string {
  return `${snapshotsDirKey(runId)}/${tick.toString()}.snap`;
}

// Storage adapters that can sweep a directory clean — both NodeStorage and
// OPFSStorage opt in. Declared here so the host can duck-type the
// capability without forcing it onto the Storage port (which crosses the
// sim/host seam and is intentionally minimal). A storage adapter that
// does not implement this is treated as a no-op reaper.
interface ReapableStorage {
  reapDirectory(dirKey: string): Promise<number>;
}

function isReapable(storage: object): storage is ReapableStorage {
  return (
    'reapDirectory' in storage &&
    typeof (storage as { reapDirectory: unknown }).reapDirectory === 'function'
  );
}

// Per-run-slot management: enumeration + recursive deletion + mtime
// lookup. Both NodeStorage and OPFSStorage opt in. Same duck-typing
// shape as ReapableStorage: kept off the Storage port to preserve the
// minimal sim/host seam.
interface RunsCapableStorage {
  listEntries(
    parentKey: string,
  ): Promise<readonly { readonly name: string; readonly kind: 'file' | 'directory' }[]>;
  getMtimeMs(key: string): Promise<number | null>;
  removeDirectory(dirKey: string): Promise<void>;
}

function isRunsCapable(storage: object): storage is RunsCapableStorage {
  return (
    'listEntries' in storage &&
    typeof (storage as { listEntries: unknown }).listEntries === 'function' &&
    'getMtimeMs' in storage &&
    typeof (storage as { getMtimeMs: unknown }).getMtimeMs === 'function' &&
    'removeDirectory' in storage &&
    typeof (storage as { removeDirectory: unknown }).removeDirectory === 'function'
  );
}

// Active run-slot marker. Plain UTF-8 file at the storage namespace
// root whose contents are the runId of the current active slot. The
// host writes it on every successful switchRun; the worker / CLI read
// it at startup to reopen the same slot the player was last on.
// Absence is fine — callers fall back to PersistenceOptions.runId.
const ACTIVE_RUN_KEY = 'runs/.active';

async function writeActiveRunMarker(storage: Storage, runId: string): Promise<void> {
  await storage.write(ACTIVE_RUN_KEY, new TextEncoder().encode(runId));
}

// Build the per-slot info the UI's switch-run modal renders. Latest
// tick comes from the highest-numbered file in `runs/<id>/snapshots/`;
// lastModifiedMs comes from the slot's log mtime (0 when no log yet,
// e.g. a freshly-created slot whose owner hasn't issued newRun).
async function inspectRunSlot(
  storage: RunsCapableStorage,
  runId: string,
): Promise<{ runId: string; latestTick: string; lastModifiedMs: number }> {
  const snapEntries = await storage.listEntries(`runs/${runId}/snapshots`);
  let latestTick = 0n;
  for (const entry of snapEntries) {
    if (entry.kind !== 'file') continue;
    if (!entry.name.endsWith('.snap')) continue;
    const tickStr = entry.name.slice(0, -'.snap'.length);
    let tick: bigint;
    try {
      tick = BigInt(tickStr);
    } catch {
      continue;
    }
    if (tick > latestTick) latestTick = tick;
  }
  const lastModifiedMs = (await storage.getMtimeMs(`runs/${runId}/log.ndjson`)) ?? 0;
  return { runId, latestTick: latestTick.toString(), lastModifiedMs };
}

// Sweep snapshot files left over from a previous run under the same runId.
// newRun deletes the active log; once the snap log entries are gone, the
// snapshot files in `runs/<runId>/snapshots/` are unreachable — they
// cannot be loaded (no snap entry points at them) and they cannot be
// rewound to (handleRewindToTick reads the log). They are pure waste.
//
// "Orphan" here is the strong form: every snap file under the runId's
// snapshot directory at the moment newRun fires. The previous run's log
// is being deleted in the same handleNewRun pass, so by the time anyone
// could read it, no entry references any of these files. The fresh run
// will write its own tick-0 snapshot moments later.
//
// Idempotent and safe on an empty / never-existed slot — a missing
// directory yields 0 reaped.
async function reapOrphanSnapshots(persistence: PersistenceOptions): Promise<number> {
  if (!isReapable(persistence.storage)) return 0;
  return persistence.storage.reapDirectory(snapshotsDirKey(persistence.runId));
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

// Parse a wire-side DirectiveSpec into a sim-side Directive. Returns
// null when the kind or params are malformed; the host surfaces that
// as a CommandError. The conversion reverses directiveToInspector and
// the lint discipline that forbids floats in tick fields enforces the
// integer types here.
function inspectorToDirective(spec: DirectiveSpec): Directive | null {
  const decode = (key: string): bigint | null => {
    const raw = spec.params[key];
    if (raw === undefined) return null;
    try {
      return BigInt(raw);
    } catch {
      return null;
    }
  };
  switch (spec.kind) {
    case 'replicate': {
      const threshold = decode('threshold');
      return threshold === null ? null : { kind: 'replicate', threshold };
    }
    case 'gather': {
      const rate = decode('rate');
      return rate === null ? null : { kind: 'gather', rate };
    }
    case 'explore': {
      const threshold = decode('threshold');
      return threshold === null ? null : { kind: 'explore', threshold };
    }
    default:
      return null;
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
  // Persistence config. Mutable in one specific dimension: switchRun
  // replaces the runId in flight (storage adapter and snapshot cadence
  // are preserved). The replacement is atomic — a fresh PersistenceOptions
  // object so no half-state is observable. All reads of runId go through
  // this.persistence.runId so they pick up the post-switch value.
  private persistence: PersistenceOptions | undefined;
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

  // Rolling population-summary buffer, sampled at each heartbeat emit
  // (so its cadence tracks the wall-clock heartbeat, not the per-tick
  // sim cadence). Bounded by POPULATION_SUMMARY_CAPACITY; older points
  // are decimated as new ones arrive. The PopulationSummary query
  // returns a snapshot of this buffer.
  private populationHistory: PopulationSummaryPoint[] = [];

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
      case 'decreeQueue':
        return this.queryDecreeQueue(query.queryId);
      case 'lineageTree':
        return this.queryLineageTree(query.queryId);
      case 'listRuns':
        return this.queryListRuns(query.queryId);
      case 'logSlice':
        return this.queryLogSlice(query.queryId, query.fromTick, query.toTick);
      case 'populationSummary':
        return this.queryPopulationSummary(query.queryId);
    }
  }

  // LogSlice — return every SimEvent the sim emitted whose simTick falls
  // in [fromTick, toTick] (inclusive both ends), in (tick, seq)
  // declaration order. Reads from the persisted log via EventLogReader.
  // Empty when persistence is not configured (no on-disk log to read);
  // the surface is best-effort like the heartbeat. Any unflushed buffer
  // entries are drained first so a query immediately after a runUntil
  // sees the events those ticks emitted.
  private async queryLogSlice(
    queryId: string,
    fromTick: bigint,
    toTick: bigint,
  ): Promise<QueryResult> {
    if (this.persistence === undefined) {
      return { queryId, kind: 'logSlice', events: [] };
    }
    if (this.logWriter !== null) {
      await this.logWriter.flush();
    }
    const reader = new EventLogReader(this.persistence.storage, logKey(this.persistence.runId));
    const entries = await reader.readAll();
    const events: SimEvent[] = [];
    for (const entry of entries) {
      if (entry.type !== 'ev') continue;
      if (entry.tick < fromTick) continue;
      if (entry.tick > toTick) continue;
      events.push(entry.event);
    }
    return { queryId, kind: 'logSlice', events };
  }

  // PopulationSummary — snapshot of the rolling heartbeat-sampled
  // population buffer in tick-ascending order. Best-effort like the
  // heartbeat itself: a host running with heartbeatHz = 0 has no
  // samples and returns an empty list.
  private queryPopulationSummary(queryId: string): QueryResult {
    return {
      queryId,
      kind: 'populationSummary',
      points: this.populationHistory.slice(),
    };
  }

  private queryLineageTree(queryId: string): QueryResult {
    if (this.state === null) {
      return { queryId, kind: 'lineageTree', lineages: [] };
    }
    const lineages = [...this.state.lineages.values()].map((l) => ({
      id: l.id,
      name: l.name,
      parentLineageId: l.parentLineageId ?? '',
      foundedAtTick: l.foundedAtTick,
      // Strict pass-through. The sim sets this once at extinction and
      // never resets it; a missing field on an older snapshot has been
      // normalised to null by `restore()`.
      extinctionTick: l.extinctionTick,
      founderProbeId: l.founderProbeId,
      patches: l.patches.slice(),
      quarantined: this.state!.quarantinedLineages.has(l.id),
    }));
    return { queryId, kind: 'lineageTree', lineages };
  }

  private queryDecreeQueue(queryId: string): QueryResult {
    if (this.state === null) {
      return { queryId, kind: 'decreeQueue', decrees: [] };
    }
    const decrees = this.state.queuedDecrees.map((d) => {
      let trigger: DecreeTriggerSpec;
      switch (d.trigger.kind) {
        case 'populationBelow':
          trigger = {
            kind: 'populationBelow',
            lineageId: d.trigger.lineageId,
            threshold: d.trigger.threshold.toString(),
          };
          break;
      }
      return {
        id: d.id,
        queuedAtTick: d.queuedAtTick,
        trigger,
        patchTargetLineageId: d.patchTargetLineageId,
        patchFirmware: d.patchFirmware.map(directiveToInspector),
      };
    });
    return { queryId, kind: 'decreeQueue', decrees };
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
        caps: [],
        maxResourcePerCell: MAX_RESOURCE_PER_CELL.toString(),
        probes: [],
      };
    }
    const cells = this.state.resources.map((r) => r.toString());
    const caps = this.state.resourceCaps.map((c) => c.toString());
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
      caps,
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

    const referenceFirmware = lineage.referenceFirmware.map(directiveToInspector);

    return {
      queryId,
      kind: 'driftTelemetry',
      lineageId,
      drift: {
        population,
        parameters,
        divergenceDivisor: SPECIATION_DIVERGENCE_DIVISOR.toString(),
        referenceFirmware,
        patches: lineage.patches.slice(),
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
    // Log every command except Load, newRun, and RewindToTick:
    //  - Load is a meta-control that forks the timeline; logging it would
    //    cause a circular reference on future loads.
    //  - newRun is logged inside handleNewRun, after the writer is reset
    //    for the new run, so the cmd lands in the right slot.
    //  - RewindToTick rewrites in-memory state to a historical snapshot;
    //    persisting it would require either truncating the log or
    //    appending a fork marker, neither of which is in scope for the
    //    destructive-MVP shape (see handleRewindToTick).
    // Save IS logged — it marks a checkpoint in the run history.
    if (
      !this.replaying &&
      this.logWriter !== null &&
      cmd.kind !== 'load' &&
      cmd.kind !== 'newRun' &&
      cmd.kind !== 'rewindToTick'
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
      case 'applyPatch':
        this.handleApplyPatch(cmd.commandId, cmd.lineageId, cmd.firmware);
        return;
      case 'queueDecree':
        this.handleQueueDecree(cmd);
        return;
      case 'revokeDecree':
        this.handleRevokeDecree(cmd.commandId, cmd.decreeId);
        return;
      case 'save':
        this.handleSave(cmd.commandId, cmd.slot);
        return;
      case 'load':
        this.handleLoad(cmd.commandId, cmd.slot);
        return;
      case 'rewindToTick':
        this.handleRewindToTick(cmd.commandId, cmd.tick);
        return;
      case 'switchRun':
        this.handleSwitchRun(cmd.commandId, cmd.runId);
        return;
      case 'deleteRun':
        this.handleDeleteRun(cmd.commandId, cmd.runId);
        return;
    }
  }

  // ApplyPatch: validate, charge Origin compute, install the patch,
  // emit PatchApplied. SPEC.md "patches are inherited by descendants
  // and drift like any other firmware" — applying overwrites the
  // lineage's referenceFirmware and every extant probe in the lineage;
  // subsequent replications drift from the patched stack via the
  // normal mutation path.
  private handleApplyPatch(
    commandId: string,
    lineageId: string,
    firmwareSpecs: readonly DirectiveSpec[],
  ): void {
    if (this.state === null) {
      this.error(commandId, 'cannot apply patch before newRun');
      return;
    }
    const id = LineageId(lineageId);
    if (!this.state.lineages.has(id)) {
      this.error(commandId, `unknown lineage: ${lineageId}`);
      return;
    }
    // Lineage must be living for the patch to bite anything.
    let extant = 0;
    for (const probe of this.state.probes.values()) {
      if (probe.lineageId === id) {
        extant += 1;
        // No need to count higher than 1; the gate is "any".
        break;
      }
    }
    if (extant === 0) {
      this.error(commandId, `lineage ${lineageId} has no extant probes`);
      return;
    }

    const firmware: Directive[] = [];
    for (const spec of firmwareSpecs) {
      const directive = inspectorToDirective(spec);
      if (directive === null) {
        this.error(commandId, `malformed directive in patch: ${JSON.stringify(spec)}`);
        return;
      }
      firmware.push(directive);
    }
    const newFirmware: DirectiveStack = firmware;

    const validation = validatePatchFirmware(newFirmware);
    if (validation !== null) {
      this.error(commandId, validation);
      return;
    }

    if (this.state.originCompute < PATCH_AUTHORING_COST) {
      this.error(
        commandId,
        `insufficient Origin compute: need ${PATCH_AUTHORING_COST.toString()}, have ${this.state.originCompute.toString()}`,
      );
      return;
    }
    this.state.originCompute -= PATCH_AUTHORING_COST;

    const result = applyPatch(this.state, id, newFirmware);

    const event: PatchAppliedEvent & { simTick: bigint } = {
      kind: 'patchApplied',
      simTick: this.state.simTick,
      lineageId,
      probesAffected: BigInt(result.probesAffected),
      patchId: result.patchId,
    };
    this.emit(event);
    this.ack(commandId);
  }

  // QueueDecree: validate the trigger and patch, charge compute, mint a
  // stable id, append to the queue. The decree fires later from
  // sim/step.ts when the trigger condition holds.
  private handleQueueDecree(cmd: {
    commandId: string;
    trigger: DecreeTriggerSpec;
    patchTargetLineageId: string;
    patchFirmware: readonly DirectiveSpec[];
  }): void {
    if (this.state === null) {
      this.error(cmd.commandId, 'cannot queue decree before newRun');
      return;
    }

    // Translate trigger spec → typed sim trigger.
    let trigger: DecreeTrigger;
    switch (cmd.trigger.kind) {
      case 'populationBelow': {
        const monitored = LineageId(cmd.trigger.lineageId);
        if (!this.state.lineages.has(monitored)) {
          this.error(cmd.commandId, `unknown lineage in trigger: ${cmd.trigger.lineageId}`);
          return;
        }
        let threshold: bigint;
        try {
          threshold = BigInt(cmd.trigger.threshold);
        } catch {
          this.error(cmd.commandId, `malformed threshold: ${cmd.trigger.threshold}`);
          return;
        }
        if (threshold < 0n) {
          this.error(cmd.commandId, `threshold must be non-negative`);
          return;
        }
        trigger = { kind: 'populationBelow', lineageId: monitored, threshold };
        break;
      }
    }

    const target = LineageId(cmd.patchTargetLineageId);
    if (!this.state.lineages.has(target)) {
      this.error(cmd.commandId, `unknown patch target lineage: ${cmd.patchTargetLineageId}`);
      return;
    }

    const firmware: Directive[] = [];
    for (const spec of cmd.patchFirmware) {
      const directive = inspectorToDirective(spec);
      if (directive === null) {
        this.error(cmd.commandId, `malformed directive in decree patch: ${JSON.stringify(spec)}`);
        return;
      }
      firmware.push(directive);
    }
    const patchFirmware: DirectiveStack = firmware;

    const validation = validatePatchFirmware(patchFirmware);
    if (validation !== null) {
      this.error(cmd.commandId, validation);
      return;
    }

    if (this.state.originCompute < DECREE_AUTHORING_COST) {
      this.error(
        cmd.commandId,
        `insufficient Origin compute: need ${DECREE_AUTHORING_COST.toString()}, have ${this.state.originCompute.toString()}`,
      );
      return;
    }
    this.state.originCompute -= DECREE_AUTHORING_COST;

    const decreeId = `D${this.state.nextDecreeOrdinal.toString()}`;
    this.state.nextDecreeOrdinal += 1n;
    const decree: QueuedDecree = {
      id: decreeId,
      queuedAtTick: this.state.simTick,
      trigger,
      patchTargetLineageId: target,
      patchFirmware,
    };
    this.state.queuedDecrees.push(decree);

    const event: DecreeQueuedEvent & { simTick: bigint } = {
      kind: 'decreeQueued',
      simTick: this.state.simTick,
      decreeId,
    };
    this.emit(event);
    this.ack(cmd.commandId);
  }

  private handleRevokeDecree(commandId: string, decreeId: string): void {
    if (this.state === null) {
      this.error(commandId, 'cannot revoke decree before newRun');
      return;
    }
    const before = this.state.queuedDecrees.length;
    this.state.queuedDecrees = this.state.queuedDecrees.filter((d) => d.id !== decreeId);
    const removed = before !== this.state.queuedDecrees.length;
    if (removed) {
      const event: DecreeRevokedEvent & { simTick: bigint } = {
        kind: 'decreeRevoked',
        simTick: this.state.simTick,
        decreeId,
      };
      this.emit(event);
    }
    // Idempotent: revoking a decree that has already fired or never
    // existed acks without an event.
    this.ack(commandId);
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

  // Quarantined lineages and pause flag. Exposed for tests so rewind /
  // load behaviour can be asserted on without a query round-trip; not
  // part of the seam.
  quarantinedLineages(): ReadonlySet<string> {
    return this.state?.quarantinedLineages ?? new Set();
  }
  isPaused(): boolean {
    return this.paused;
  }

  // ── command handlers ───────────────────────────────────────────────────────

  private handleNewRun(commandId: string, seed: bigint): void {
    // newRun starts a fresh run. If persistence is configured, the previous
    // run's log is deleted so the slot doesn't accumulate multiple newRun
    // entries (which would make Load replay them in sequence). Snapshot
    // files written by the previous run are also reaped — once the log is
    // gone, the snap entries that pointed at them are gone too, and the
    // files cannot be loaded or rewound to. The fresh run will write its
    // own tick-0 snapshot moments later.
    const persistence = this.persistence;
    if (persistence !== undefined) {
      const storage = persistence.storage;
      const key = logKey(persistence.runId);
      this.logWriter = new EventLogWriter(storage, key);
      this.lastSnapAtTick = SimTick(0n);
      this.enqueue(async () => {
        await storage.delete(key);
        await reapOrphanSnapshots(persistence);
      });
    }

    this.state = createInitialState(Seed(seed));
    this.speed = 1;
    this.paused = false;
    this.resetHeartbeatBaseline();
    this.populationHistory = [];

    // Log the newRun command into the freshly-reset writer so the
    // canonical (seed, command-log) description survives.
    if (!this.replaying && this.logWriter !== null) {
      this.logWriter.appendCommand(0n, { kind: 'newRun', commandId, seed });
    }

    // Eagerly capture a tick-0 snapshot so forensic-replay rewinds
    // from any later tick always have an anchor. Without this the
    // first snap doesn't land until SNAPSHOT_CADENCE ticks in, and
    // any rewind attempted before then would error out for "no
    // snapshot at-or-before". The cost is one snapshot per run.
    if (!this.replaying) {
      this.scheduleSnapshot();
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
    } else if (event.kind === 'patchSaturated' && this.autoPauseTriggers.has('patchSaturated')) {
      trigger = 'patchSaturated';
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

    const populationTotal = BigInt(state.probes.size);
    const event: TickEvent & { simTick: bigint } = {
      kind: 'tick',
      simTick: state.simTick,
      actualSpeed,
      populationTotal,
      populationByLineage,
      originCompute: state.originCompute,
      originComputeMax: ORIGIN_COMPUTE_MAX,
      paused: this.paused,
      speed: this.speed,
    };
    this.emit(event);
    this.recordPopulationSample(state.simTick, populationTotal);

    this.lastHeartbeatAtMs = now;
    this.lastHeartbeatAtTick = state.simTick;
  }

  // Append a sample to the rolling population-summary buffer. Mirrors
  // the decimation pattern in ui/sim-store.ts: when full, drop every
  // other entry so the curve shape across a longer run is preserved.
  // Called from emitHeartbeat — sampling cadence is the heartbeat
  // cadence, not the per-tick cadence.
  private recordPopulationSample(tick: bigint, totalProbes: bigint): void {
    this.populationHistory.push({ tick, totalProbes });
    if (this.populationHistory.length > POPULATION_SUMMARY_CAPACITY) {
      const decimated: PopulationSummaryPoint[] = [];
      for (let i = 0; i < this.populationHistory.length; i += 2) {
        const point = this.populationHistory[i];
        if (point !== undefined) decimated.push(point);
      }
      // Always retain the most recent sample so the sparkline shows the
      // latest tick the player just saw.
      const tail = this.populationHistory[this.populationHistory.length - 1];
      if (tail !== undefined && decimated[decimated.length - 1] !== tail) {
        decimated.push(tail);
      }
      this.populationHistory = decimated;
    }
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
    // The previous run's heartbeat samples belong to a different
    // timeline; the rolling buffer rebuilds from post-load heartbeats.
    this.populationHistory = [];

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

  // Forensic replay — destructive scrub. Restores state to the latest
  // in-run snapshot at-or-before targetTick, replays any logged
  // commands between snap.tick and targetTick, then advances the sim
  // to land on targetTick. Pauses on completion.
  //
  // Limitations of the destructive-MVP shape:
  //  - Post-rewind state is forfeit. Save before rewinding if the
  //    current state is worth preserving; the existing Save command
  //    captures a snapshot at the live tick.
  //  - The on-disk log is left intact. Any post-targetTick entries
  //    become a stale fork; future post-rewind events get appended at
  //    the new (rewound) tick numbers, so the log is no longer
  //    monotonic in tick after a rewind. Save / Load on save slots
  //    continue to work normally because they round-trip through a
  //    single snapshot, not the log; replay-from-fresh of the active
  //    log will diverge from the rewound state, which is the price
  //    we accept for the simpler implementation.
  //  - The non-destructive variant ("preview, then commit") is tracked
  //    in TODO.md as a future stretch under #r2-stretch.
  // SwitchRun — make `runId` the active run-slot. Per the design at
  // BRAINSTORM/opfs-slot-ui.md (commit-time): pause first, snapshot the
  // outgoing slot at its current tick (so a return-to-this-slot later
  // restores exactly), then point at the new slot. If the new slot has
  // log entries on disk we restore from its highest-tick snapshot and
  // replay any logged commands past that snap up to the log head;
  // otherwise the host enters its post-construction state and waits
  // for newRun. Either way we update the active marker file so the
  // next host startup reopens the same slot.
  //
  // Log replay past the latest snap closes the snapshot-cadence loss
  // window: if the outgoing slot's snap-on-switch fails to fire (e.g.
  // host crash between writeSnap and writeActiveRunMarker), the
  // incoming-slot path here recovers state from (latest snap + log
  // tail) rather than just the latest snap alone. Same fallback
  // discipline as handleRewindToTick — both call restoreToTick.
  private handleSwitchRun(commandId: string, runId: string): void {
    if (this.persistence === undefined) {
      this.error(commandId, 'cannot switchRun: no persistence configured');
      return;
    }
    if (runId === '' || runId.includes('/') || runId.includes('\0')) {
      this.error(commandId, `invalid runId: ${JSON.stringify(runId)}`);
      return;
    }
    const persistence = this.persistence;
    if (runId === persistence.runId) {
      // No-op switch is benign. Acknowledge so the UI's correlation
      // doesn't hang.
      this.ack(commandId);
      return;
    }

    // Pause synchronously so subsequent ticks can't race with the
    // enqueued switch work.
    this.paused = true;

    this.enqueue(async () => {
      // (1) Snap-out the outgoing slot at its current tick if the
      //     state is live, so a future switch-back restores cleanly.
      //     Flush the active log writer first so any pending cmd/ev
      //     entries land on disk before the snap entry, then append a
      //     well-formed SnapLogEntry referencing the freshly-written
      //     snapshot file so the future restore picks it up via the
      //     log (not just the filesystem directory).
      if (this.state !== null) {
        const tickAt = this.state.simTick;
        const key = snapshotKey(persistence.runId, tickAt);
        const bytes = serializeSnapshot(snapshot(this.state));
        await persistence.storage.write(key, bytes);
        if (this.logWriter !== null) {
          this.logWriter.appendSnap(tickAt, key);
          await this.logWriter.flush();
        }
      }

      // (2) Repoint persistence at the incoming slot. The storage
      //     adapter is unchanged; only the runId changes.
      this.persistence = { ...persistence, runId };
      // The active log writer must follow.
      this.logWriter = new EventLogWriter(persistence.storage, logKey(runId));

      // (3) Try to restore from the incoming slot's log. The shared
      //     restoreToTick helper picks the highest snap entry at-or-
      //     before the log head, falls back to rebuild-from-log if
      //     the snap file is missing, and replays any logged commands
      //     past the snap up to the log head. The log head is the max
      //     tick seen across all entries — the upper bound on what
      //     was observably recorded for this slot.
      //
      //     A slot with no log entries (fresh, never had newRun) takes
      //     the early-return path: state stays null, lastSnapAtTick
      //     resets to 0, and the player can issue newRun against it.
      const reader = new EventLogReader(persistence.storage, logKey(runId));
      const entries = await reader.readAll();
      if (entries.length === 0) {
        this.state = null;
        this.lastSnapAtTick = SimTick(0n);
      } else {
        let maxTick = 0n;
        for (const entry of entries) {
          if (entry.tick > maxTick) maxTick = entry.tick;
        }
        const result = await this.restoreToTick(maxTick, entries, persistence);
        if (!result.ok) {
          // Malformed log (no newRun command and no usable snapshot).
          // Surface the error rather than silently entering null state;
          // the UI can prompt the player to delete-and-recreate the slot.
          this.error(commandId, `cannot switchRun to ${runId}: ${result.reason}`);
          return;
        }
      }
      // The outgoing slot's heartbeat samples don't apply to the
      // incoming slot's timeline; the buffer rebuilds from heartbeats
      // emitted after the switch.
      this.populationHistory = [];

      // (4) Persist the active marker so the next host startup picks
      //     up this slot.
      await writeActiveRunMarker(persistence.storage, runId);

      // SwitchRun always lands paused — the player explicitly asked
      // to step away from the live run; resuming the new slot is a
      // separate decision. doRewindToTick has the same discipline.
      this.paused = true;
      this.resetHeartbeatBaseline();
      if (this.heartbeatIntervalMs !== Number.POSITIVE_INFINITY) {
        this.emitHeartbeat();
      }
      this.ack(commandId);
    });
  }

  // DeleteRun — recursively remove a slot's directory tree. Refused on
  // the active slot (player must switchRun away first); the modal UX
  // surfaces this by greying the active row's Delete affordance.
  private handleDeleteRun(commandId: string, runId: string): void {
    if (this.persistence === undefined) {
      this.error(commandId, 'cannot deleteRun: no persistence configured');
      return;
    }
    if (runId === '' || runId.includes('/') || runId.includes('\0')) {
      this.error(commandId, `invalid runId: ${JSON.stringify(runId)}`);
      return;
    }
    if (runId === this.persistence.runId) {
      this.error(commandId, `cannot delete the active run-slot (${runId}); switch away first`);
      return;
    }
    const persistence = this.persistence;
    if (!isRunsCapable(persistence.storage)) {
      this.error(commandId, 'storage adapter does not support deleteRun');
      return;
    }
    const storage = persistence.storage;
    this.enqueue(async () => {
      await storage.removeDirectory(`runs/${runId}`);
      this.ack(commandId);
    });
  }

  private async queryListRuns(queryId: string): Promise<QueryResult> {
    if (this.persistence === undefined || !isRunsCapable(this.persistence.storage)) {
      // No persistence (or adapter doesn't support enumeration) — the
      // dashboard renders an empty list, which is the honest answer.
      return { queryId, kind: 'listRuns', runs: [], activeRunId: '' };
    }
    const storage = this.persistence.storage;
    const activeRunId = this.persistence.runId;
    const entries = await storage.listEntries('runs');
    const runs = [];
    for (const entry of entries) {
      if (entry.kind !== 'directory') continue;
      // Skip the active marker dotfile if it ever gets confused as a dir.
      if (entry.name.startsWith('.')) continue;
      runs.push(await inspectRunSlot(storage, entry.name));
    }
    // Active slot may not have a snapshot directory yet (fresh slot).
    // Make sure it appears in the list either way.
    if (!runs.some((r) => r.runId === activeRunId)) {
      runs.push(await inspectRunSlot(storage, activeRunId));
    }
    runs.sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);
    return { queryId, kind: 'listRuns', runs, activeRunId };
  }

  private handleRewindToTick(commandId: string, targetTick: bigint): void {
    if (this.persistence === undefined) {
      this.error(commandId, 'cannot rewind: no persistence configured');
      return;
    }
    if (this.state === null) {
      this.error(commandId, 'cannot rewind before newRun');
      return;
    }
    if (targetTick > this.state.simTick) {
      this.error(
        commandId,
        `cannot rewind to a future tick (target=${targetTick}, now=${this.state.simTick})`,
      );
      return;
    }
    this.enqueue(async () => {
      await this.doRewindToTick(commandId, targetTick);
    });
  }

  private async doRewindToTick(commandId: string, targetTick: bigint): Promise<void> {
    if (this.persistence === undefined) return;
    const persistence = this.persistence;

    // Drain any buffered log entries to storage before reading. The
    // writer buffers cmd/ev/snap appends in memory until a flush; if a
    // snapshot was scheduled between the last flush and this rewind,
    // its snap entry might still be in the buffer rather than on disk.
    if (this.logWriter !== null) {
      await this.logWriter.flush();
    }

    // Read the active run's log. Snapshots fire on SNAPSHOT_CADENCE_TICKS
    // (plus tick 0 for the initial newRun), so the worst-case replay
    // distance is the snapshot cadence; in practice often much less
    // because we land on the most recent snap at-or-before target.
    const reader = new EventLogReader(persistence.storage, logKey(persistence.runId));
    const entries = await reader.readAll();

    const result = await this.restoreToTick(targetTick, entries, persistence);
    if (!result.ok) {
      this.error(commandId, `cannot rewind: ${result.reason}`);
      return;
    }

    this.paused = true;
    this.resetHeartbeatBaseline();
    // The pre-rewind samples were taken at later ticks; clearing the
    // buffer keeps the sparkline monotonic in tick.
    this.populationHistory = [];

    // Single heartbeat so the UI catches up to the rewound state.
    if (this.heartbeatIntervalMs !== Number.POSITIVE_INFINITY) {
      this.emitHeartbeat();
    }

    this.ack(commandId);
  }

  // Restore this.state to `targetTick` using `entries` from the active
  // slot's log. Picks the latest snap at-or-before target, loads it,
  // and replays logged cmds strictly after the snap up to the target.
  // Falls back to rebuild-from-log (createInitialState with the seed
  // from the first newRun command, then replay forward) when no usable
  // snap is available — the realisation of ARCHITECTURE.md "the seed
  // plus the command log is the canonical universe; snapshots are an
  // implementation-defined performance cache."
  //
  // The fallback fires when:
  //   - no snap entry exists at-or-before target (fresh run, no
  //     cadence snapshot yet), OR
  //   - a snap entry exists in the log but the snapshot file is
  //     missing on disk (e.g. user nuked the snapshots/ dir, or a
  //     future Rust port can't read TS-format snaps).
  // The cost is a full replay from tick 0; for long runs at fat
  // population that's measurable, but the alternative is the operation
  // failing when it could have recovered.
  //
  // Shared by handleRewindToTick (target = player-chosen tick) and
  // handleSwitchRun (target = the slot's log head). Returns ok:false
  // when the log lacks a usable seed (no newRun command); callers
  // surface that as a commandError.
  private async restoreToTick(
    targetTick: bigint,
    entries: readonly LogEntry[],
    persistence: PersistenceOptions,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    let bestSnap: SnapLogEntry | null = null;
    for (const entry of entries) {
      if (entry.type !== 'snap') continue;
      if (entry.tick > targetTick) continue;
      if (bestSnap === null || entry.tick > bestSnap.tick) bestSnap = entry;
    }

    let usedRebuild = false;
    let startTick = 0n;
    if (bestSnap !== null) {
      const snapBytes = await persistence.storage.read(bestSnap.snapshotKey);
      if (snapBytes !== null) {
        const restored = restore(deserializeSnapshot(snapBytes));
        this.state = restored;
        this.lastSnapAtTick = restored.simTick;
        startTick = restored.simTick;
      } else {
        // Snap entry pointed at a missing file — fall through to
        // rebuild.
        bestSnap = null;
      }
    }
    if (bestSnap === null) {
      const rebuilt = this.rebuildStateFromLog(entries);
      if (rebuilt === null) {
        return {
          ok: false,
          reason: `no snapshot at-or-before tick ${targetTick.toString()} and log lacks a newRun command to seed a rebuild`,
        };
      }
      this.state = rebuilt;
      this.lastSnapAtTick = rebuilt.simTick;
      startTick = rebuilt.simTick;
      usedRebuild = true;
    }

    // Replay logged commands strictly after the starting tick up to
    // the target. Set `replaying` so emit() / ack() / log writes
    // don't fire — replay is silent. The command handlers still
    // update in-memory state (lineages, quarantines, etc.) which is
    // what we want to recover.
    //
    // Yield to the event loop every REPLAY_YIELD_TICKS so the worker
    // can drain pending postMessage events (pause clicks etc.) while
    // the replay walks forward.
    this.replaying = true;
    try {
      // Narrowing escapes the closure across the await; this.state has
      // been set to a non-null SimState above, and the only thing that
      // could clear it inside this try block is reentry (which the
      // replaying flag suppresses). Hoist the assertion via a local
      // alias so the loop body type-checks. The non-null assertion is
      // safe because both branches of the snap-vs-rebuild fork above
      // assign this.state before reaching here.
      const state = this.state as SimState;
      for (const entry of entries) {
        if (entry.type !== 'cmd') continue;
        if (entry.tick <= startTick) continue;
        if (entry.tick > targetTick) break;
        // Skip the newRun on a rebuild path: rebuildStateFromLog
        // already consumed the seed and seeded createInitialState, so
        // re-issuing it here would clobber the freshly-built state.
        if (usedRebuild && entry.command.kind === 'newRun') continue;
        // Skip persistence-meta commands during replay: re-firing
        // switchRun would reroute the host away from the slot we're
        // restoring; deleteRun would wipe a sibling; save would
        // overwrite a named save with a mid-replay snapshot. None of
        // these affect sim state (the thing replay is reconstructing);
        // all of them have external side effects we don't want.
        if (
          entry.command.kind === 'switchRun' ||
          entry.command.kind === 'deleteRun' ||
          entry.command.kind === 'save'
        ) {
          continue;
        }
        while (state.simTick < entry.tick) {
          await this.advanceWithYield(entry.tick);
        }
        this.send(entry.command);
      }
      while (state.simTick < targetTick) {
        await this.advanceWithYield(targetTick);
      }
    } finally {
      this.replaying = false;
    }

    return { ok: true };
  }

  // Rebuild a fresh sim state from the command log alone — no
  // snapshot involved. Used as the fallback in doRewindToTick when no
  // snapshot is available or its file is missing on disk. Returns
  // null when the log lacks a newRun entry (rebuild has nothing to
  // seed createInitialState with); the caller then surfaces an error.
  //
  // The rebuild does NOT advance ticks here — it only seeds state at
  // tick 0. The caller's existing replay loop then walks the log
  // commands forward to the target tick (skipping the newRun it
  // already consumed). Splitting it this way keeps the replay loop
  // single-source for both the snapshot-restore and rebuild paths.
  private rebuildStateFromLog(entries: readonly LogEntry[]): SimState | null {
    let seed: bigint | null = null;
    for (const entry of entries) {
      if (entry.type !== 'cmd') continue;
      if (entry.command.kind !== 'newRun') continue;
      seed = entry.command.seed;
      break;
    }
    if (seed === null) return null;
    return createInitialState(Seed(seed));
  }

  // Replay helper: advance up to REPLAY_YIELD_TICKS at once, then
  // yield to the event loop so the worker can process pending
  // postMessages (pause, etc.). Bounded by `until` so we never
  // overshoot the next replay checkpoint.
  private async advanceWithYield(until: bigint): Promise<void> {
    if (this.state === null) return;
    const remaining = until - this.state.simTick;
    const cap = remaining > REPLAY_YIELD_TICKS ? REPLAY_YIELD_TICKS : remaining;
    this.advanceUnpaused(cap);
    // setTimeout(0) yields to the macrotask queue — microtasks alone
    // don't drain incoming postMessage events.
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 0);
    });
  }

  private enqueue(work: () => Promise<void>): void {
    this.workQueue = this.workQueue
      .then(() => work())
      .catch((e: unknown) => {
        console.error('NodeHost work queue:', e);
      });
  }
}

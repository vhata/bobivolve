// Node-side sim host run-loop.
//
// ARCHITECTURE.md "Three layers": this is the Sim host. It owns the run-loop,
// the clock, and (later) the storage adapter; it is the legitimate place for
// wall-clock APIs (Date.now / performance.now) — the sim core forbids them.
//
// Responsibilities:
//   - Drive sim/step.ts forward through commands (newRun, setSpeed, pause,
//     resume, step).
//   - Translate state diffs into SimEvents that cross the seam: Replication
//     events from probe-id deltas; Tick heartbeats from population summaries.
//   - Acknowledge each command with CommandAck or, on validation failure,
//     CommandError.
//
// Determinism contract: this host imports nothing from sim that mutates the
// state in ways the proto-defined commands do not describe. The probe-id
// snapshot diffing approach (see deriveReplicationEvents) is deliberately
// indirect — it observes state changes from outside rather than instrumenting
// sim/step.ts. Limitation: it cannot tell mutated children from non-mutated
// children, so the `mutated` flag on Replication is reported as `false` until
// the sim itself starts emitting these events. This is acceptable for R0; the
// design question R0 is testing is drift-as-data, not the per-event UI feed.

import { tick } from '../sim/step.js';
import { type SimState, createInitialState } from '../sim/state.js';
import { Seed, type SimTick } from '../sim/types.js';
import type {
  Command,
  CommandAckEvent,
  CommandErrorEvent,
  ReplicationEvent,
  SimEvent,
  TickEvent,
} from '../protocol/types.js';

// Heartbeat cadence. Best-effort — the UI must not depend on heartbeat ticks
// for correctness (ARCHITECTURE.md "Heartbeat: ... Best-effort delivery").
// 60 Hz target frame rate; a single heartbeat per UI frame at most.
const DEFAULT_HEARTBEAT_HZ = 60;

// Maximum sim ticks executed in a single run-loop slice. Caps the work the
// loop does before yielding to the event queue, so commands can interleave
// at high speeds without blocking the process.
const MAX_TICKS_PER_SLICE = 1024;

export interface NodeHostOptions {
  // Wall-clock source. Defaults to Date.now; tests inject a fake clock.
  readonly now?: () => number;
  // Heartbeat cadence in hertz. Set to 0 to disable heartbeats entirely
  // (useful for deterministic event-log capture).
  readonly heartbeatHz?: number;
}

// Listener shape used by the in-process NodeTransport. Identical signature to
// SimEventHandler (transport/types.ts) but redeclared here so this file does
// not depend on the transport layer.
export type HostEventListener = (event: SimEvent) => void;

export class NodeHost {
  private readonly listeners = new Set<HostEventListener>();
  private readonly now: () => number;
  private readonly heartbeatIntervalMs: number;

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
  private lastHeartbeatAtTick: SimTick = 0n as SimTick;

  constructor(options: NodeHostOptions = {}) {
    this.now = options.now ?? Date.now;
    const hz = options.heartbeatHz ?? DEFAULT_HEARTBEAT_HZ;
    this.heartbeatIntervalMs = hz > 0 ? Math.floor(1000 / hz) : Number.POSITIVE_INFINITY;
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
      case 'load':
        // Storage adapter not yet wired. R0 acks these as no-ops; the seam is
        // exercised, the persistence is not.
        this.ack(cmd.commandId);
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

  // Advance the sim by `n` ticks, emitting Replication events for every probe
  // that appeared in the probe map during the slice. Ignores `paused`; the
  // public advance() / runUntil() / step path is responsible for honoring it.
  private advanceUnpaused(n: bigint): void {
    if (this.state === null) return;
    const state = this.state;

    for (let i = 0n; i < n; i++) {
      const before = new Set(state.probes.keys());
      tick(state);
      this.deriveReplicationEvents(before);
    }
  }

  // Derive Replication events by diffing the probe-id set before/after a tick.
  // Approach (a) from the brief: clean but indirect. Limitations:
  //   - The `mutated` flag is always false. The host cannot observe mutation
  //     without instrumenting sim/step.ts; mutation visibility waits for the
  //     sim to emit these events itself.
  //   - The parent_probe_id is unknown. The probe-id ordinal is monotonic
  //     across all parents, so a child's id reveals nothing about its origin
  //     without sim-side instrumentation. Reported as the empty string for
  //     now; the field stays in the schema.
  //   - Correctness depends on probe ids being unique and never reused. The
  //     sim's nextProbeOrdinal contract guarantees this (sim/state.ts).
  private deriveReplicationEvents(before: Set<string>): void {
    if (this.state === null) return;
    const state = this.state;
    for (const [id, probe] of state.probes) {
      if (before.has(id)) continue;
      const event: ReplicationEvent & { simTick: bigint } = {
        kind: 'replication',
        simTick: state.simTick,
        parentProbeId: '',
        childProbeId: id,
        lineageId: probe.lineageId,
        mutated: false,
      };
      this.emit(event);
    }
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
    this.lastHeartbeatAtTick = this.state?.simTick ?? (0n as SimTick);
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
}

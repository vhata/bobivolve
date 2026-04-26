// Web Worker host for the browser. Imported by the UI as
//   import SimWorker from '../host/worker.ts?worker';
// Vite handles the ?worker suffix; the file becomes a standalone worker
// bundle.
//
// ARCHITECTURE.md: "Sim host. Run loop, clock, storage adapter. Worker |
// Node | Tauri (later)". This is the Worker variant.
//
// The wire shape between worker and main thread is plain structured-cloned
// objects: { type: 'command', cmd: Command } from main → worker;
// { type: 'event', event: SimEvent } from worker → main. bigints survive
// structured clone, so no JSON encoding is needed at the worker boundary.

/// <reference lib="webworker" />

import { NodeHost } from './node.js';
import { OPFSStorage } from './storage-opfs.js';
import type { Command, Query, QueryResult, SimEvent } from '../protocol/types.js';

interface CommandMessage {
  readonly type: 'command';
  readonly cmd: Command;
}

interface QueryMessage {
  readonly type: 'query';
  readonly query: Query;
}

interface EventMessage {
  readonly type: 'event';
  readonly event: SimEvent;
}

interface QueryResultMessage {
  readonly type: 'queryResult';
  readonly queryId: string;
  readonly result: QueryResult;
}

type IncomingMessage = CommandMessage | QueryMessage;

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

// Persistence: OPFS-backed runs at a fixed runId='default'. Each newRun
// command resets the slot (deletes the old log, fresh writer), so
// successive runs in the same browser tab don't accumulate. Save / Load
// buttons in the UI act on the current slot.
const host = new NodeHost({
  heartbeatHz: 60,
  persistence: {
    storage: new OPFSStorage({ root: 'bobivolve' }),
    runId: 'default',
  },
});

host.subscribe((event: SimEvent) => {
  const msg: EventMessage = { type: 'event', event };
  ctx.postMessage(msg);
});

// Pacing. 1x ≈ one sim tick per UI frame at 60 Hz; speed multiplies the
// per-pulse budget. Adaptive: if the inner loop can't keep up, achieved
// speed drifts below target and the Tick heartbeat reports it honestly.
const PULSE_INTERVAL_MS = 16;
let speedTicksPerPulse = 1;
let pulseHandle: ReturnType<typeof setInterval> | null = null;

function startPulsing(): void {
  if (pulseHandle !== null) return;
  pulseHandle = setInterval(() => {
    const current = host.currentTick();
    if (current === null) return;
    host.runUntil(current + BigInt(speedTicksPerPulse));
  }, PULSE_INTERVAL_MS);
}

function stopPulsing(): void {
  if (pulseHandle !== null) {
    clearInterval(pulseHandle);
    pulseHandle = null;
  }
}

ctx.addEventListener('message', (e: MessageEvent<IncomingMessage>) => {
  if (e.data.type === 'query') {
    const result = host.executeQuery(e.data.query);
    const reply: QueryResultMessage = { type: 'queryResult', queryId: result.queryId, result };
    ctx.postMessage(reply);
    return;
  }

  if (e.data.type !== 'command') return;
  const cmd = e.data.cmd;
  // Update pacing state before forwarding the command, so setSpeed takes
  // effect on the same pulse where the command lands.
  switch (cmd.kind) {
    case 'setSpeed':
      if (cmd.speed === 1 || cmd.speed === 4 || cmd.speed === 16 || cmd.speed === 64) {
        speedTicksPerPulse = cmd.speed;
      }
      break;
    case 'newRun':
    case 'resume':
      startPulsing();
      break;
    case 'pause':
      stopPulsing();
      break;
    default:
      break;
  }
  host.send(cmd);
});

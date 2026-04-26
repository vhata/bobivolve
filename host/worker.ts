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

// Pacing. Each pulse advances at most `speedTicksPerPulse` ticks AND at
// most enough to fit in PULSE_BUDGET_MS of wall-clock work, whichever is
// smaller. Without the budget cap, one runUntil at fat populations can
// run for hundreds of milliseconds while the worker's event loop is
// blocked, and a Pause click sits in the message queue. Adapting the
// budget to observed ms-per-tick keeps message dispatch responsive
// regardless of population scale; achieved speed drops honestly under
// load and the Tick heartbeat reports it.
//
// The next pulse is scheduled only after the current one completes
// (recursive setTimeout, not setInterval), so a slow pulse doesn't queue
// the next one.

const PULSE_INTERVAL_MS = 16;
// Wall-clock target for one pulse's tick work. The remaining ~4ms of a
// 16ms frame is reserved for message dispatch, OPFS writes, and event
// emission.
const PULSE_BUDGET_MS = 12;
let speedTicksPerPulse = 1;
let pulseHandle: ReturnType<typeof setTimeout> | null = null;
let running = false;
// EWMA of observed ms-per-tick. Initialised at 0.05ms so a fresh run at
// small population can saturate at the requested speed; the average
// adapts upward as ticks slow with growing population.
let msPerTickEWMA = 0.05;

function pulse(): void {
  if (!running) return;
  const current = host.currentTick();
  if (current !== null) {
    const allowedByBudget = Math.max(1, Math.floor(PULSE_BUDGET_MS / msPerTickEWMA));
    const budget = Math.min(speedTicksPerPulse, allowedByBudget);
    const start = performance.now();
    host.runUntil(current + BigInt(budget));
    const elapsed = performance.now() - start;
    if (budget > 0) {
      const observed = elapsed / budget;
      // Lean toward fast adaptation when we exceed the budget so a
      // sudden population jump doesn't take many pulses to react to.
      const alpha = observed > msPerTickEWMA ? 0.6 : 0.2;
      msPerTickEWMA = msPerTickEWMA * (1 - alpha) + observed * alpha;
    }
  }
  if (running) {
    pulseHandle = setTimeout(pulse, PULSE_INTERVAL_MS);
  }
}

function startPulsing(): void {
  if (running) return;
  running = true;
  pulseHandle = setTimeout(pulse, 0);
}

function stopPulsing(): void {
  running = false;
  if (pulseHandle !== null) {
    clearTimeout(pulseHandle);
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

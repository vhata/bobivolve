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

// Pacing. Each pulse advances exactly speedTicksPerPulse ticks, then
// yields. The next pulse is scheduled only after the current one
// completes (recursive setTimeout, not setInterval), so a slow pulse
// doesn't queue the next one and the worker's event loop always gets a
// chance to drain incoming messages (pause, setSpeed, queries) between
// pulses.
//
// Achieved speed = speedTicksPerPulse / (max(PULSE_INTERVAL_MS,
// duration-of-pulse) / 1000). At fat populations the duration grows
// past PULSE_INTERVAL_MS and achieved speed honestly drops below the
// target; the Tick heartbeat reports it.

const PULSE_INTERVAL_MS = 16;
let speedTicksPerPulse = 1;
let pulseHandle: ReturnType<typeof setTimeout> | null = null;
let running = false;

function pulse(): void {
  if (!running) return;
  const current = host.currentTick();
  if (current !== null) {
    host.runUntil(current + BigInt(speedTicksPerPulse));
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

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
import type { Command, SimEvent } from '../protocol/types.js';

interface CommandMessage {
  readonly type: 'command';
  readonly cmd: Command;
}

interface EventMessage {
  readonly type: 'event';
  readonly event: SimEvent;
}

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

const host = new NodeHost({
  heartbeatHz: 60,
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

ctx.addEventListener('message', (e: MessageEvent<CommandMessage>) => {
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

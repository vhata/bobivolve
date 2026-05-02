#!/usr/bin/env node
// Cross-process sim host. Long-lived Node process that owns a NodeHost
// and exchanges NDJSON-framed messages with its parent over stdin/stdout.
//
// ARCHITECTURE.md "Transports": this is the child end of the cross-process
// NodeTransport variant. The wire format mirrors the worker boundary's
// envelope shape — { type, ... } per line — but the framing is NDJSON
// rather than structured-clone postMessage. Symmetric with the eventual
// Rust binary, which will speak the same line protocol.
//
// Parent → child:
//   {"type":"command","cmd": <Command>}
//   {"type":"query","query": <Query>}
//
// Child → parent:
//   {"type":"event","event": <SimEvent>}
//   {"type":"queryResult","result": <QueryResult>}
//   {"type":"ready"}                              once on startup
//
// Bigint encoding follows proto3 JSON (uint64 as decimal string), exactly
// as the existing host/node-cli.ts NDJSON output does, so the wire is
// round-trippable through the codec.
//
// Pacing mirrors host/worker.ts: a setTimeout-driven pulse advances the
// host by `speedTicksPerPulse` ticks, capped at PULSE_BUDGET_MS of
// wall-clock work, with the next pulse scheduled only after the current
// completes. Pause / setSpeed / newRun / resume / rewindToTick / load
// drive the pulser the same way the Worker host does.
//
// No persistence in the child by default. The parent can add a persistent
// storage adapter when this transport grows beyond R0 — at the moment the
// in-process and Worker variants cover the persistence-needing cases
// (CLI, browser); the cross-process variant exists to validate the seam
// for the future Rust binary, where persistence will live alongside the
// sim in the child.

import { createInterface } from 'node:readline';
import { NodeHost } from './node.js';
import type { Command, Query, QueryResult, SimEvent } from '../protocol/types.js';
import { encodeLine, reviveCommand, reviveQuery } from '../transport/ndjson-codec.js';

const host = new NodeHost({
  // Heartbeat at 4Hz. Same rationale as host/worker.ts: keeps the dashboard
  // feeling live without saturating the wire with Tick events at fat
  // population.
  heartbeatHz: 4,
});

// Forward every host event out as a one-line NDJSON message. The child does
// not filter — unlike the Worker host, which drops `replication` and
// `death` events at the postMessage boundary, the cross-process variant
// is a transport, not a dashboard, and its callers may want every event.
host.subscribe((event: SimEvent) => {
  const msg = { type: 'event', event };
  process.stdout.write(encodeLine(msg));
});

// Pacing — see host/worker.ts:99-129 for the full rationale. PULSE_BUDGET_MS
// caps a single pulse's tick work so pause / setSpeed remain responsive
// at fat population.
const PULSE_INTERVAL_MS = 16;
const PULSE_BUDGET_MS = 12;
let speedTicksPerPulse = 1;
let pulseHandle: ReturnType<typeof setTimeout> | null = null;
let running = false;

function pulse(): void {
  if (!running) return;
  const current = host.currentTick();
  if (current !== null) {
    host.runUntil(current + BigInt(speedTicksPerPulse), PULSE_BUDGET_MS);
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

interface IncomingCommandWire {
  readonly type: 'command';
  readonly cmd: unknown;
}
interface IncomingQueryWire {
  readonly type: 'query';
  readonly query: unknown;
}
type IncomingWire = IncomingCommandWire | IncomingQueryWire;

function handleLine(line: string): void {
  if (line.length === 0) return;
  let raw: IncomingWire;
  try {
    raw = JSON.parse(line) as IncomingWire;
  } catch (e) {
    // Bad JSON from the parent. Surface to stderr so the parent can see it
    // (stderr is the diagnostics channel; stdout is the protocol channel).
    process.stderr.write(`stdio-child: malformed NDJSON line: ${(e as Error).message}\n`);
    return;
  }

  if (raw.type === 'query') {
    const query: Query = reviveQuery(raw.query);
    void host.executeQuery(query).then((result: QueryResult) => {
      const msg = { type: 'queryResult', result };
      process.stdout.write(encodeLine(msg));
    });
    return;
  }

  if (raw.type !== 'command') {
    process.stderr.write(`stdio-child: unknown wire type: ${JSON.stringify(raw)}\n`);
    return;
  }

  const cmd: Command = reviveCommand(raw.cmd);

  // Pacing state updates mirror host/worker.ts:154-187 exactly. The
  // Worker host is the model; deviating would create a determinism /
  // perceived-behaviour skew between transports.
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
    case 'rewindToTick':
      stopPulsing();
      break;
    case 'load':
      stopPulsing();
      break;
    default:
      break;
  }
  host.send(cmd);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', handleLine);

// Clean exit when the parent closes stdin. Stop pulsing first so no
// further work hits stdout after the parent has stopped reading.
rl.on('close', () => {
  stopPulsing();
  process.exit(0);
});

// Ready handshake. The parent waits for this line before sending commands,
// so a slow startup (module load, first JIT pass) doesn't drop initial
// messages on the floor.
process.stdout.write(encodeLine({ type: 'ready' }));

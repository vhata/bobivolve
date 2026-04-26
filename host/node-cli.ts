#!/usr/bin/env node
// Headless sim runner.
//
// Drives a NodeHost end-to-end from the command line, emitting NDJSON
// SimEvents to stdout. ARCHITECTURE.md "Headless capability" — this is the
// canonical reference for the determinism golden test.
//
//   --seed <u64>          Required (unless --resume). splitmix64 seed.
//   --ticks <u64>         Required. Sim ticks to advance to (absolute, not
//                         relative — when resuming from a saved run, this
//                         is the target final tick, not additional ticks).
//   --no-heartbeat        Optional. Suppress Tick heartbeats; emit only
//                         domain events. Use this for deterministic
//                         event-log capture — heartbeats are wall-clock
//                         cadenced and would otherwise introduce
//                         nondeterminism into the byte stream.
//   --save-dir <path>     Optional. Enable persistence; logs and snapshots
//                         land under <path>/runs/<runId>/.
//   --run-id <id>         Required when --save-dir is given. Names the run
//                         under the save dir.
//   --resume              Resume a previously-saved run. Requires
//                         --save-dir and --run-id. Sends a Load command
//                         instead of newRun, then continues to --ticks.
//
// Bigint encoding: proto3 JSON encodes uint64 as a string. We follow that
// convention here so the NDJSON is round-trippable with a JSON parser that
// does not natively understand bigints.

import { parseArgs } from 'node:util';
import { NodeHost } from './node.js';
import { NodeStorage } from './storage-node.js';
import { NodeTransport } from '../transport/node.js';
import type { Command, SimEvent } from '../protocol/types.js';

interface CliOptions {
  readonly seed: bigint | null;
  readonly ticks: bigint;
  readonly heartbeat: boolean;
  readonly saveDir: string | null;
  readonly runId: string | null;
  readonly resume: boolean;
}

function parseCliArgs(argv: readonly string[]): CliOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      seed: { type: 'string' },
      ticks: { type: 'string' },
      'no-heartbeat': { type: 'boolean' },
      'save-dir': { type: 'string' },
      'run-id': { type: 'string' },
      resume: { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.ticks === undefined) throw new Error('--ticks is required');

  const resume = values.resume === true;
  if (!resume && values.seed === undefined) {
    throw new Error('--seed is required (or --resume to continue a saved run)');
  }
  if (resume && values.seed !== undefined) {
    throw new Error('--seed and --resume are mutually exclusive');
  }

  let seed: bigint | null = null;
  if (values.seed !== undefined) {
    try {
      seed = BigInt(values.seed);
    } catch {
      throw new Error(`--seed must be a decimal integer, got: ${values.seed}`);
    }
    if (seed < 0n) throw new Error('--seed must be non-negative');
  }

  let ticks: bigint;
  try {
    ticks = BigInt(values.ticks);
  } catch {
    throw new Error(`--ticks must be a decimal integer, got: ${values.ticks}`);
  }
  if (ticks < 0n) throw new Error('--ticks must be non-negative');

  const saveDir = values['save-dir'] ?? null;
  const runId = values['run-id'] ?? null;

  if (saveDir !== null && runId === null) {
    throw new Error('--save-dir requires --run-id');
  }
  if (resume && saveDir === null) {
    throw new Error('--resume requires --save-dir and --run-id');
  }

  return {
    seed,
    ticks,
    heartbeat: values['no-heartbeat'] !== true,
    saveDir,
    runId,
    resume,
  };
}

// JSON.stringify replacer that encodes bigints as decimal strings, mirroring
// proto3 JSON encoding for uint64 fields.
function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function emitEventLine(event: SimEvent): void {
  process.stdout.write(JSON.stringify(event, bigintReplacer) + '\n');
}

export async function runCli(argv: readonly string[]): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseCliArgs(argv);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`bobivolve: ${msg}\n`);
    return 2;
  }

  const persistence =
    opts.saveDir !== null && opts.runId !== null
      ? { storage: new NodeStorage({ root: opts.saveDir }), runId: opts.runId }
      : undefined;

  const host = new NodeHost({
    heartbeatHz: opts.heartbeat ? 60 : 0,
    ...(persistence !== undefined ? { persistence } : {}),
  });
  const transport = new NodeTransport({ host });
  const unsubscribe = transport.onEvent(emitEventLine);

  if (opts.resume) {
    const load: Command = {
      kind: 'load',
      commandId: 'cli-load',
      slot: opts.runId ?? 'default',
    };
    transport.send(load);
    // Wait for the load to complete before resuming. Load is async; flush
    // drains the work queue.
    await host.flush();
    const resume: Command = { kind: 'resume', commandId: 'cli-resume' };
    transport.send(resume);
  } else if (opts.seed !== null) {
    const newRun: Command = {
      kind: 'newRun',
      commandId: 'cli-newRun',
      seed: opts.seed,
    };
    transport.send(newRun);
  }

  // Drive the run-loop synchronously. The CLI is single-threaded; we do not
  // need the heartbeat-cadence interleaving the UI host needs.
  host.runUntil(opts.ticks);

  // Flush persistent state before close so writers durably land their
  // tail; tests reading the log immediately after expect this.
  await host.flush();

  unsubscribe();
  transport.close();
  return 0;
}

// Top-level entry. node:util's parseArgs takes argv after process.argv[1],
// per Node's convention.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const argv = process.argv.slice(2);
  runCli(argv).then(
    (code) => {
      process.exit(code);
    },
    (e: unknown) => {
      const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
      process.stderr.write(`bobivolve: ${msg}\n`);
      process.exit(1);
    },
  );
}

#!/usr/bin/env node
// Headless sim runner.
//
// Drives a NodeHost end-to-end from the command line, emitting NDJSON
// SimEvents to stdout. ARCHITECTURE.md "Headless capability" — this is the
// canonical reference for the future determinism golden test.
//
//   --seed <u64>   Required. Decimal integer; used as the splitmix64 seed.
//   --ticks <u64>  Required. Number of sim ticks to advance.
//   --no-heartbeat Optional. Suppress Tick heartbeats; emit only domain
//                  events. Use this for deterministic event-log capture —
//                  heartbeats are wall-clock-cadenced and would otherwise
//                  introduce nondeterminism into the byte stream.
//
// Bigint encoding: proto3 JSON encodes uint64 as a string. We follow that
// convention here so the NDJSON is round-trippable with a JSON parser that
// does not natively understand bigints.
//
// This file lives under /host because it is part of the host layer; the
// transport directory is reserved for the UI-side wire-up.

import { parseArgs } from 'node:util';
import { NodeTransport } from '../transport/node.js';
import type { Command, SimEvent } from '../protocol/types.js';

interface CliOptions {
  readonly seed: bigint;
  readonly ticks: bigint;
  readonly heartbeat: boolean;
}

function parseCliArgs(argv: readonly string[]): CliOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      seed: { type: 'string' },
      ticks: { type: 'string' },
      'no-heartbeat': { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.seed === undefined) throw new Error('--seed is required');
  if (values.ticks === undefined) throw new Error('--ticks is required');

  let seed: bigint;
  let ticks: bigint;
  try {
    seed = BigInt(values.seed);
  } catch {
    throw new Error(`--seed must be a decimal integer, got: ${values.seed}`);
  }
  try {
    ticks = BigInt(values.ticks);
  } catch {
    throw new Error(`--ticks must be a decimal integer, got: ${values.ticks}`);
  }

  if (seed < 0n) throw new Error('--seed must be non-negative');
  if (ticks < 0n) throw new Error('--ticks must be non-negative');

  return {
    seed,
    ticks,
    heartbeat: values['no-heartbeat'] !== true,
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

  const transport = new NodeTransport({
    heartbeatHz: opts.heartbeat ? 60 : 0,
  });
  const unsubscribe = transport.onEvent(emitEventLine);

  const newRun: Command = {
    kind: 'newRun',
    commandId: 'cli-newRun',
    seed: opts.seed,
  };
  transport.send(newRun);

  // Drive the run-loop synchronously. The CLI is single-threaded; we do not
  // need the heartbeat-cadence interleaving the UI host needs.
  transport.getHost().runUntil(opts.ticks);

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

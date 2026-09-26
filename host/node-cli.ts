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
//                         --save-dir and --run-id. Restores the run log and
//                         its latest snapshot, then continues to --ticks.
//
// Bigint encoding: proto3 JSON encodes uint64 as a string. We follow that
// convention here so the NDJSON is round-trippable with a JSON parser that
// does not natively understand bigints.

import { readFile } from 'node:fs/promises';
import { parseCommandScript, type ScriptCommand } from './command-script.js';
import { parseArgs } from 'node:util';
import { NodeHost } from './node.js';
import { NodeStorage } from './storage-node.js';
import { NodeTransport } from '../transport/node.js';
import type { SimEvent } from '../protocol/types.js';
import { parseUint64Decimal } from '../protocol/uint64.js';

interface CliOptions {
  readonly seed: bigint | null;
  readonly ticks: bigint;
  readonly heartbeat: boolean;
  readonly saveDir: string | null;
  readonly runId: string | null;
  readonly resume: boolean;
  readonly commands: string | null;
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
      commands: { type: 'string' },
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

  const seed = values.seed === undefined ? null : parseUint64Decimal(values.seed);
  if (values.seed !== undefined && seed === null)
    throw new Error('--seed must be a decimal uint64');
  const ticks = parseUint64Decimal(values.ticks);
  if (ticks === null) throw new Error('--ticks must be a decimal uint64');

  const saveDir = values['save-dir'] ?? null;
  const runId = values['run-id'] ?? null;

  if (
    runId !== null &&
    (runId === '' || runId === '.' || runId === '..' || /[/\\\0]/.test(runId))
  ) {
    throw new Error('--run-id must be a nonempty directory name without path separators');
  }
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
    commands: values.commands ?? null,
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
  let script: readonly ScriptCommand[];
  try {
    opts = parseCliArgs(argv);
    script =
      opts.commands === null
        ? []
        : parseCommandScript(await readFile(opts.commands, 'utf8'), opts.ticks);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`bobivolve: ${msg}\n`);
    return 2;
  }

  const storage = opts.saveDir === null ? null : new NodeStorage({ root: opts.saveDir });
  const persistence =
    storage !== null && opts.runId !== null
      ? { storage, runId: opts.resume ? `${opts.runId}-cli-startup` : opts.runId }
      : undefined;
  const host = new NodeHost({
    heartbeatHz: opts.heartbeat ? 60 : 0,
    ...(persistence !== undefined ? { persistence } : {}),
  });
  const transport = new NodeTransport({ host });
  const errors: string[] = [];
  const acknowledged = new Set<string>();
  const unsubscribe = transport.onEvent((event) => {
    emitEventLine(event);
    if (event.kind === 'commandError') errors.push(event.message);
    if (event.kind === 'commandAck') acknowledged.add(event.commandId);
  });

  try {
    if (opts.resume) {
      if (
        storage === null ||
        opts.runId === null ||
        !(await storage.exists(`runs/${opts.runId}/log.ndjson`))
      ) {
        throw new Error(`cannot resume: no persisted run ${opts.runId ?? ''}`);
      }
      // Start without live state in a distinct slot so switchRun restores
      // even when the requested slot is named "default". Nothing is saved
      // in the bootstrap slot: its buffered switch command is discarded.
      transport.send({ kind: 'switchRun', commandId: 'cli-restore', runId: opts.runId });
      await host.flush();
      const restoredTick = host.currentTick();
      if (!acknowledged.has('cli-restore') || restoredTick === null || errors.length > 0) {
        throw new Error(`cannot resume: ${errors.join('; ') || 'run restoration failed'}`);
      }
      if (opts.ticks < restoredTick) {
        throw new Error(
          `--ticks ${opts.ticks} precedes persisted tick ${restoredTick}; resume cannot rewind`,
        );
      }
      if (script.some((entry) => entry.tick <= restoredTick)) {
        throw new Error(
          'resumed command scripts must start strictly after the persisted tick; use a continuation-only script',
        );
      }
      transport.send({ kind: 'resume', commandId: 'cli-resume' });
    } else if (opts.seed !== null) {
      transport.send({ kind: 'newRun', commandId: 'cli-newRun', seed: opts.seed });
    }

    for (const entry of script) {
      host.runUntil(entry.tick);
      transport.send(entry.command);
      if (errors.length > 0 || !acknowledged.has(entry.command.commandId)) {
        const failure =
          errors.join('; ') || `command ${entry.command.commandId} was not acknowledged`;
        // Earlier acknowledged interventions must survive a rejected command.
        // Preserve the execution error if storage cannot flush that history.
        try {
          await host.flush();
        } catch (error) {
          throw new Error(
            `${failure}; could not persist completed commands: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        throw new Error(failure);
      }
    }
    host.runUntil(opts.ticks);
    // Record the exact endpoint even if the final ticks emitted no domain
    // events. switchRun reconstructs to the log head on the next invocation.
    if (persistence !== undefined) transport.send({ kind: 'pause', commandId: 'cli-checkpoint' });
    await host.flush();
    if (errors.length > 0 || host.currentTick() !== opts.ticks) {
      throw new Error(errors.join('; ') || 'simulation did not reach the requested tick');
    }
    return 0;
  } catch (error) {
    process.stderr.write(`bobivolve: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    unsubscribe();
    transport.close();
  }
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

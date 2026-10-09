// Programmatic equivalent of `host/node-cli.ts` for use inside tests.
// Runs a NodeHost in-process for a fixed (seed, ticks) and returns the
// emitted SimEvents in declaration order. Heartbeats are suppressed —
// they are wall-clock-cadenced and would inject nondeterminism into the
// byte stream.
//
// The output differs from the CLI's in exactly one place: the opening
// newRun acknowledgement carries RUNNER_NEW_RUN_COMMAND_ID here and
// CLI_NEW_RUN_COMMAND_ID from the CLI. cli-parity.test.ts checks that every
// other byte of CLI output matches the goldens.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeTransport } from '../../transport/node.js';
import type { Command, SimEvent } from '../../protocol/types.js';
import { INTERVENTIONS, type ScheduledCommand } from './interventions.js';

export const RUNNER_NEW_RUN_COMMAND_ID = 'determinism-newRun';
export const CLI_NEW_RUN_COMMAND_ID = 'cli-newRun';

export const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), 'golden');

export interface DeterminismRun {
  readonly seed: bigint;
  readonly ticks: bigint;
  readonly commands?: readonly ScheduledCommand[];
}

export interface GoldenCase extends DeterminismRun {
  readonly name: string;
}

// Every checked-in golden. golden.test.ts fails on a golden file without a
// case here, and cli-parity.test.ts runs the CLI for each case.
export const GOLDEN_CASES: readonly GoldenCase[] = [
  // Small — a near-trivial run that exercises the boot path and a handful
  // of replication events. Catches regressions in the early-tick stream.
  { name: 'seed-0-ticks-1000', seed: 0n, ticks: 1000n },
  // Medium — same parameters as sim/step.test.ts's GOLDEN_POP_SEED_42_TEST
  // (27 probes after 3000 ticks). Cross-checks the two golden surfaces.
  { name: 'seed-42-ticks-3000', seed: 42n, ticks: 3000n },
  // Medium-large — different seed, long enough to exercise lineage
  // clustering: speciation events appear in the lineageId field of later
  // Replication events.
  { name: 'seed-2026-ticks-5000', seed: 2026n, ticks: 5000n },
  { name: 'seed-42-interventions-ticks-300', seed: 42n, ticks: 300n, commands: INTERVENTIONS },
];

export function runDeterministically(spec: DeterminismRun): readonly SimEvent[] {
  const transport = new NodeTransport({ heartbeatHz: 0 });
  const events: SimEvent[] = [];
  const unsubscribe = transport.onEvent((event) => {
    events.push(event);
  });

  const newRun: Command = {
    kind: 'newRun',
    commandId: RUNNER_NEW_RUN_COMMAND_ID,
    seed: spec.seed,
  };
  transport.send(newRun);
  let previousTick = 0n;
  for (const entry of spec.commands ?? []) {
    if (entry.tick < previousTick || entry.tick > spec.ticks) {
      throw new Error('Determinism commands must be ordered and within the run');
    }
    transport.getHost().runUntil(entry.tick);
    transport.send(entry.command);
    previousTick = entry.tick;
  }
  transport.getHost().runUntil(spec.ticks);

  unsubscribe();
  transport.close();
  return events;
}

// JSON.stringify replacer that encodes bigints as decimal strings, matching
// the proto3 JSON convention used by host/node-cli.ts. Apart from the newRun
// command ID above, the two outputs must agree byte-for-byte.
function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  return value;
}

export function serializeEvents(events: readonly SimEvent[]): string {
  return events.map((e) => JSON.stringify(e, bigintReplacer)).join('\n') + '\n';
}

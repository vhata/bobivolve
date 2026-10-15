import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SimEvent } from '../protocol/types.js';
import { NodeHost } from './node.js';
import { isValidRunId } from './run-id.js';
import { NodeStorage } from './storage-node.js';

const UNSAFE_RUN_IDS = ['', '.', '..', '.active', '.hidden', 'a/b', 'a\\b', 'a\0b', '../active'];

describe('isValidRunId', () => {
  it.each(['default', 'run-2026-10-09-1200', '__startup__', 'a.b', 'run.'])(
    'accepts %j',
    (runId) => {
      expect(isValidRunId(runId)).toBe(true);
    },
  );

  it.each(UNSAFE_RUN_IDS)('rejects %j', (runId) => {
    expect(isValidRunId(runId)).toBe(false);
  });
});

describe('run-slot commands reject unsafe run IDs', () => {
  let root: string;
  let storage: NodeStorage;
  let host: NodeHost;
  let events: SimEvent[];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'bobivolve-run-id-'));
    storage = new NodeStorage({ root });
    host = new NodeHost({
      heartbeatHz: 0,
      persistence: { storage, runId: 'active', snapshotCadenceTicks: 1_000_000n },
    });
    events = [];
    host.subscribe((event) => events.push(event));
    host.send({ kind: 'newRun', commandId: 'new', seed: 42n });
    host.runUntil(50n);
    // Seed a sibling slot and the active marker so a traversal would
    // have something besides the active run to destroy.
    await storage.write('runs/sibling/log.ndjson', new TextEncoder().encode(''));
    await storage.write('runs/.active', new TextEncoder().encode('active'));
    await host.flush();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function response(commandId: string): SimEvent | undefined {
    return events.find(
      (event) =>
        (event.kind === 'commandAck' || event.kind === 'commandError') &&
        event.commandId === commandId,
    );
  }

  async function expectRunsIntact(): Promise<void> {
    expect(await storage.exists('runs/active/log.ndjson')).toBe(true);
    expect(await storage.exists('runs/active/snapshots/0.snap')).toBe(true);
    expect(await storage.exists('runs/sibling/log.ndjson')).toBe(true);
    expect(new TextDecoder().decode((await storage.read('runs/.active')) ?? undefined)).toBe(
      'active',
    );
  }

  it.each(UNSAFE_RUN_IDS)('deleteRun(%j) is refused and removes nothing', async (runId) => {
    host.send({ kind: 'deleteRun', commandId: 'delete', runId });
    await host.flush();
    expect(response('delete')).toMatchObject({
      kind: 'commandError',
      message: expect.stringContaining('invalid runId'),
    });
    await expectRunsIntact();
  });

  it.each(UNSAFE_RUN_IDS)('switchRun(%j) is refused and keeps the active run', async (runId) => {
    host.send({ kind: 'switchRun', commandId: 'switch', runId });
    await host.flush();
    expect(response('switch')).toMatchObject({
      kind: 'commandError',
      message: expect.stringContaining('invalid runId'),
    });
    expect(host.currentTick()).toBe(50n);
    await expectRunsIntact();
  });

  it('still deletes a valid inactive run slot', async () => {
    host.send({ kind: 'deleteRun', commandId: 'delete', runId: 'sibling' });
    await host.flush();
    expect(response('delete')).toMatchObject({ kind: 'commandAck' });
    expect(await storage.exists('runs/sibling/log.ndjson')).toBe(false);
    expect(await storage.exists('runs/active/log.ndjson')).toBe(true);
  });
});

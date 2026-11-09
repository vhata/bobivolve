// Run-slot and named-save identity on storage that folds case.
//
// macOS and Windows filesystems are case-insensitive by default, so
// `runs/ACTIVE` and `runs/active` are one directory and `saves/Keep.save`
// and `saves/keep.save` are one file. The host must not treat two such
// spellings as distinct slots: deleting `ACTIVE` while `active` is current
// once destroyed the active run, and saving `keep` after `Keep` overwrote
// Keep's bytes while listing both.
//
// FoldingStorage reproduces that on any filesystem by lower-casing every
// key before it reaches disk. The same scenarios also run against plain
// NodeStorage on the real filesystem when the test machine's temp
// directory is case-insensitive.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SimEvent } from '../protocol/types.js';
import { NodeHost } from './node.js';
import { NodeStorage, type StorageDirEntry } from './storage-node.js';

class FoldingStorage extends NodeStorage {
  override read(key: string): Promise<Uint8Array | null> {
    return super.read(key.toLowerCase());
  }
  override write(key: string, data: Uint8Array): Promise<void> {
    return super.write(key.toLowerCase(), data);
  }
  override append(key: string, data: Uint8Array): Promise<void> {
    return super.append(key.toLowerCase(), data);
  }
  override delete(key: string): Promise<void> {
    return super.delete(key.toLowerCase());
  }
  override exists(key: string): Promise<boolean> {
    return super.exists(key.toLowerCase());
  }
  override listEntries(key: string): Promise<readonly StorageDirEntry[]> {
    return super.listEntries(key.toLowerCase());
  }
  override getMtimeMs(key: string): Promise<number | null> {
    return super.getMtimeMs(key.toLowerCase());
  }
  override removeDirectory(key: string): Promise<void> {
    return super.removeDirectory(key.toLowerCase());
  }
  override reapDirectory(key: string): Promise<number> {
    return super.reapDirectory(key.toLowerCase());
  }
}

function tempDirIsCaseInsensitive(): boolean {
  const probe = mkdtempSync(join(tmpdir(), 'bobivolve-case-probe-'));
  try {
    writeFileSync(join(probe, 'Probe'), '');
    return existsSync(join(probe, 'probe'));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

const REAL_FS_CASE_INSENSITIVE = tempDirIsCaseInsensitive();

const storages: readonly {
  readonly name: string;
  readonly skip: boolean;
  readonly make: (root: string) => NodeStorage;
}[] = [
  {
    name: 'case-folding storage',
    skip: false,
    make: (root) => new FoldingStorage({ root }),
  },
  {
    name: REAL_FS_CASE_INSENSITIVE
      ? 'the real case-insensitive filesystem'
      : 'the real filesystem (skipped: temp directory is case-sensitive)',
    skip: !REAL_FS_CASE_INSENSITIVE,
    make: (root) => new NodeStorage({ root }),
  },
];

for (const { name, skip, make } of storages) {
  describe.skipIf(skip)(`storage aliases on ${name}`, () => {
    let root: string;
    let storage: NodeStorage;
    let host: NodeHost;
    let events: SimEvent[];

    beforeEach(async () => {
      root = mkdtempSync(join(tmpdir(), 'bobivolve-alias-'));
      storage = make(root);
      host = new NodeHost({
        heartbeatHz: 0,
        persistence: { storage, runId: 'active', snapshotCadenceTicks: 1_000_000n },
      });
      events = [];
      host.subscribe((event) => events.push(event));
      host.send({ kind: 'newRun', commandId: 'new', seed: 42n });
      host.runUntil(50n);
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

    async function send(
      command: { kind: 'switchRun' | 'deleteRun'; runId: string },
      commandId: string,
    ): Promise<SimEvent | undefined> {
      host.send({ ...command, commandId });
      await host.flush();
      return response(commandId);
    }

    async function runIds(): Promise<readonly string[]> {
      const result = await host.executeQuery({ kind: 'listRuns', queryId: 'runs' });
      if (result.kind !== 'listRuns') throw new Error('unexpected query');
      return result.runs.map((run) => run.runId).sort();
    }

    async function expectActiveIntact(): Promise<void> {
      expect(await storage.exists('runs/active/log.ndjson')).toBe(true);
      expect(await storage.exists('runs/active/snapshots/0.snap')).toBe(true);
      expect(new TextDecoder().decode((await storage.read('runs/.active')) ?? undefined)).toBe(
        'active',
      );
    }

    it('refuses to delete a run ID that aliases the active run', async () => {
      expect(await send({ kind: 'deleteRun', runId: 'ACTIVE' }, 'delete')).toMatchObject({
        kind: 'commandError',
        message: expect.stringContaining('active run-slot'),
      });
      await expectActiveIntact();
      expect(host.currentTick()).toBe(50n);
    });

    it('refuses to switch to a run ID that aliases the active run', async () => {
      expect(await send({ kind: 'switchRun', runId: 'ACTIVE' }, 'switch')).toMatchObject({
        kind: 'commandError',
        message: expect.stringContaining('differing only by case or Unicode normalization'),
      });
      await expectActiveIntact();
      expect(host.currentTick()).toBe(50n);
      expect(await runIds()).toEqual(['active', 'sibling']);
      // The refusal leaves the active run deletable by nobody.
      expect(await send({ kind: 'deleteRun', runId: 'active' }, 'delete')).toMatchObject({
        kind: 'commandError',
      });
      await expectActiveIntact();
    });

    it('refuses to switch to or delete an alias of a listed inactive run', async () => {
      expect(await send({ kind: 'switchRun', runId: 'SIBLING' }, 'switch')).toMatchObject({
        kind: 'commandError',
        message: expect.stringContaining('differing only by case or Unicode normalization'),
      });
      expect(await send({ kind: 'deleteRun', runId: 'Sibling' }, 'delete')).toMatchObject({
        kind: 'commandError',
        message: expect.stringContaining('differing only by case or Unicode normalization'),
      });
      expect(await storage.exists('runs/sibling/log.ndjson')).toBe(true);
      expect(await runIds()).toEqual(['active', 'sibling']);
    });

    it('still switches to and deletes slots by their exact spelling', async () => {
      expect(await send({ kind: 'switchRun', runId: 'sibling' }, 'switch')).toMatchObject({
        kind: 'commandAck',
      });
      expect(await send({ kind: 'deleteRun', runId: 'active' }, 'delete')).toMatchObject({
        kind: 'commandAck',
      });
      expect(await storage.exists('runs/active/log.ndjson')).toBe(false);
      expect(await runIds()).toEqual(['sibling']);
    });

    it('refuses to save Keep then keep over the same file', async () => {
      host.send({ kind: 'save', commandId: 'save-Keep', slot: 'Keep' });
      await host.flush();
      expect(response('save-Keep')).toMatchObject({ kind: 'commandAck' });
      const keepBytes = await storage.read('saves/Keep.save');
      const index = await storage.read('saves/index.json');
      host.runUntil(51n);
      host.send({ kind: 'save', commandId: 'save-keep', slot: 'keep' });
      await host.flush();
      expect(response('save-keep')).toMatchObject({
        kind: 'commandError',
        message: expect.stringContaining('differing only by case or Unicode normalization'),
      });
      expect(await storage.read('saves/Keep.save')).toEqual(keepBytes);
      expect(await storage.read('saves/index.json')).toEqual(index);
      const result = await host.executeQuery({ kind: 'listSaves', queryId: 'saves' });
      if (result.kind !== 'listSaves') throw new Error('unexpected query');
      expect(result.saves.map((save) => [save.slot, save.tick])).toEqual([['Keep', '50']]);
    });
  });
}

describe('run-slot aliases through Unicode normalization', () => {
  let root: string;
  let host: NodeHost;
  let events: SimEvent[];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'bobivolve-alias-nfc-'));
    host = new NodeHost({
      heartbeatHz: 0,
      persistence: { storage: new NodeStorage({ root }), runId: 'Café' },
    });
    events = [];
    host.subscribe((event) => events.push(event));
    host.send({ kind: 'newRun', commandId: 'new', seed: 42n });
    host.runUntil(10n);
    await host.flush();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it.each(['Café', 'CAFÉ'])('refuses deleteRun(%j) while Café is active', async (runId) => {
    host.send({ kind: 'deleteRun', commandId: 'delete', runId });
    await host.flush();
    expect(events.find((event) => event.kind === 'commandError')).toMatchObject({
      commandId: 'delete',
      message: expect.stringContaining('active run-slot'),
    });
    expect(host.currentTick()).toBe(10n);
  });
});

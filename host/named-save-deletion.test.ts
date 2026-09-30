import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SimEvent } from '../protocol/types.js';
import { NodeHost } from './node.js';
import { NodeStorage } from './storage-node.js';
import { EventLogReader } from './event-log.js';

class FaultStorage extends NodeStorage {
  failDelete = false;
  failIndexWrite = false;
  failIndexRead = false;
  override async delete(key: string): Promise<void> {
    if (this.failDelete && key === 'saves/remove.save') throw new Error('injected file failure');
    await super.delete(key);
  }
  override async write(key: string, bytes: Uint8Array): Promise<void> {
    if (this.failIndexWrite && key === 'saves/index.json')
      throw new Error('injected index failure');
    await super.write(key, bytes);
  }
  override async read(key: string): Promise<Uint8Array | null> {
    if (this.failIndexRead && key === 'saves/index.json')
      throw new Error('injected index read failure');
    return super.read(key);
  }
}

describe('named save deletion', () => {
  let root: string;
  let storage: FaultStorage;
  let host: NodeHost;
  let events: SimEvent[];
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'bobivolve-delete-save-'));
    storage = new FaultStorage({ root });
    host = new NodeHost({ heartbeatHz: 0, persistence: { storage, runId: 'active' } });
    events = [];
    host.subscribe((event) => events.push(event));
    host.send({ kind: 'newRun', commandId: 'new', seed: 42n });
    host.runUntil(10n);
    host.send({ kind: 'save', commandId: 'save-remove', slot: 'remove' });
    host.send({ kind: 'save', commandId: 'save-keep', slot: 'keep' });
    await host.flush();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function remove(commandId = 'delete'): Promise<void> {
    host.send({ kind: 'deleteSave', commandId, slot: 'remove' });
    await host.flush();
  }
  function response(commandId = 'delete'): SimEvent | undefined {
    return events.find(
      (event) =>
        (event.kind === 'commandAck' || event.kind === 'commandError') &&
        event.commandId === commandId,
    );
  }
  async function slots(): Promise<string[]> {
    const result = await host.executeQuery({ kind: 'listSaves', queryId: 'list' });
    if (result.kind !== 'listSaves') throw new Error('unexpected query');
    return result.saves.map((save) => save.slot);
  }

  it.each([false, true])(
    'deletes just the requested snapshot, preserving active state and pause=%s',
    async (paused) => {
      host.send({ kind: paused ? 'pause' : 'resume', commandId: 'pause-state' });
      const kept = await storage.read('saves/keep.save');
      await remove();
      expect(response()).toMatchObject({ kind: 'commandAck', simTick: 10n });
      expect(host.isPaused()).toBe(paused);
      expect(await storage.read('saves/remove.save')).toBeNull();
      expect(await storage.read('saves/keep.save')).toEqual(kept);
      expect(await slots()).toEqual(['keep']);
      expect(await storage.exists('runs/active/log.ndjson')).toBe(true);
      host.send({ kind: 'save', commandId: 'after', slot: 'after' });
      await host.flush();
      expect(await storage.read('saves/after.save')).toEqual(kept);
      const entries = await new EventLogReader(storage, 'runs/active/log.ndjson').readAll();
      expect(
        entries.some((entry) => entry.type === 'cmd' && entry.command.kind === 'deleteSave'),
      ).toBe(false);
    },
  );

  it('missing snapshot and repeated deletion succeed without affecting other saves', async () => {
    await storage.delete('saves/remove.save');
    await remove();
    await remove('retry');
    expect(response()).toMatchObject({ kind: 'commandAck' });
    expect(response('retry')).toMatchObject({ kind: 'commandAck' });
    expect(await slots()).toEqual(['keep']);
  });

  it('file failure leaves the snapshot and index intact', async () => {
    const index = await storage.read('saves/index.json');
    storage.failDelete = true;
    await remove();
    expect(response()).toMatchObject({
      kind: 'commandError',
      message: expect.stringContaining('injected file failure'),
    });
    expect(await storage.read('saves/index.json')).toEqual(index);
    expect(await storage.exists('saves/remove.save')).toBe(true);
    storage.failDelete = false;
    await remove('retry');
    expect(response('retry')).toMatchObject({ kind: 'commandAck' });
  });

  it('index failure explicitly reports removed bytes and retry repairs the listing', async () => {
    storage.failIndexWrite = true;
    await remove();
    expect(response()).toMatchObject({
      kind: 'commandError',
      message: expect.stringContaining(
        'was removed, but its listing could not be updated. Retry Delete',
      ),
    });
    expect(await storage.read('saves/remove.save')).toBeNull();
    expect(await slots()).toEqual(['remove', 'keep']);
    storage.failIndexWrite = false;
    await remove('retry');
    expect(response('retry')).toMatchObject({ kind: 'commandAck' });
    expect(await slots()).toEqual(['keep']);
  });

  it.each(['invalid json', '{"saves":null}', '{"saves":[{}]}', 'null'])(
    'rejects malformed index %s before deleting any bytes',
    async (index) => {
      await storage.write('saves/index.json', new TextEncoder().encode(index));
      await remove();
      expect(response()).toMatchObject({ kind: 'commandError' });
      expect(await storage.exists('saves/remove.save')).toBe(true);
      expect(await storage.exists('saves/keep.save')).toBe(true);
      expect(new TextDecoder().decode((await storage.read('saves/index.json')) ?? undefined)).toBe(
        index,
      );
    },
  );

  it('unreadable index prevents deletion', async () => {
    storage.failIndexRead = true;
    await remove();
    expect(response()).toMatchObject({ kind: 'commandError' });
    expect(await storage.exists('saves/remove.save')).toBe(true);
  });

  it.each(['', ' ', '.', '..', '../keep', 'a/b', 'a\\b', 'a\0b'])(
    'rejects invalid slot %j',
    async (slot) => {
      const index = await storage.read('saves/index.json');
      host.send({ kind: 'deleteSave', commandId: 'delete', slot });
      await host.flush();
      expect(response()).toMatchObject({
        kind: 'commandError',
        message: expect.stringContaining('invalid save slot'),
      });
      expect(await storage.read('saves/index.json')).toEqual(index);
      expect(await storage.exists('saves/remove.save')).toBe(true);
    },
  );

  it('refuses deletion without persistence', () => {
    const ephemeral = new NodeHost({ heartbeatHz: 0 });
    const replies: SimEvent[] = [];
    ephemeral.subscribe((event) => replies.push(event));
    ephemeral.send({ kind: 'deleteSave', commandId: 'delete', slot: 'remove' });
    expect(replies).toContainEqual(
      expect.objectContaining({ kind: 'commandError', commandId: 'delete' }),
    );
  });
});

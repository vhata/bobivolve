import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SimEvent } from '../protocol/types.js';
import { NodeHost } from './node.js';
import { NodeStorage } from './storage-node.js';

class FaultStorage extends NodeStorage {
  failIndexRead = false;
  override async read(key: string): Promise<Uint8Array | null> {
    if (this.failIndexRead && key === 'saves/index.json')
      throw new Error('injected index read failure');
    return super.read(key);
  }
}

describe('named save index preservation', () => {
  let root: string;
  let storage: FaultStorage;
  let host: NodeHost;
  let events: SimEvent[];
  let clock: number;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'bobivolve-save-index-'));
    storage = new FaultStorage({ root });
    clock = 1_000;
    host = new NodeHost({
      heartbeatHz: 0,
      now: () => clock,
      persistence: { storage, runId: 'active' },
    });
    events = [];
    host.subscribe((event) => events.push(event));
    host.send({ kind: 'newRun', commandId: 'new', seed: 42n });
    host.runUntil(10n);
    host.send({ kind: 'save', commandId: 'save-a', slot: 'a' });
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

  async function save(slot: string, commandId = `save-${slot}`): Promise<void> {
    host.send({ kind: 'save', commandId, slot });
    await host.flush();
  }

  async function indexText(): Promise<string | null> {
    const bytes = await storage.read('saves/index.json');
    return bytes === null ? null : new TextDecoder().decode(bytes);
  }

  it('appends to a valid index and stamps savedAtMs from the injected clock', async () => {
    clock = 2_500;
    await save('b');
    expect(response('save-b')).toMatchObject({ kind: 'commandAck' });
    const result = await host.executeQuery({ kind: 'listSaves', queryId: 'list' });
    if (result.kind !== 'listSaves') throw new Error('unexpected query');
    expect(result.saves).toEqual([
      { slot: 'a', tick: '10', savedAtMs: 1_000 },
      { slot: 'b', tick: '10', savedAtMs: 2_500 },
    ]);
  });

  it('overwrites a same-named slot in place', async () => {
    host.runUntil(20n);
    await save('a', 'resave-a');
    expect(response('resave-a')).toMatchObject({ kind: 'commandAck' });
    const result = await host.executeQuery({ kind: 'listSaves', queryId: 'list' });
    if (result.kind !== 'listSaves') throw new Error('unexpected query');
    expect(result.saves.map((entry) => [entry.slot, entry.tick])).toEqual([['a', '20']]);
  });

  it.each([
    'invalid json',
    '{"saves":null}',
    '{"saves":[{}]}',
    'null',
    '{"saves":[{"slot":"a","tick":"10"}]}',
    '{"saves":[{"slot":"a","tick":"10","savedAtMs":"1"}]}',
  ])('refuses to save over malformed index %s and leaves every file untouched', async (index) => {
    await storage.write('saves/index.json', new TextEncoder().encode(index));
    const aBytes = await storage.read('saves/a.save');
    await save('b');
    expect(response('save-b')).toMatchObject({
      kind: 'commandError',
      message: expect.stringContaining('save index is invalid'),
    });
    expect(await indexText()).toBe(index);
    expect(await storage.exists('saves/b.save')).toBe(false);
    expect(await storage.read('saves/a.save')).toEqual(aBytes);
  });

  it('refuses to save when the index cannot be read', async () => {
    const index = await indexText();
    storage.failIndexRead = true;
    await save('b');
    expect(response('save-b')).toMatchObject({
      kind: 'commandError',
      message: expect.stringContaining('injected index read failure'),
    });
    storage.failIndexRead = false;
    expect(await indexText()).toBe(index);
    expect(await storage.exists('saves/b.save')).toBe(false);
  });

  it.each([
    ['a', 'A'],
    ['Café', 'Café'],
    ['ß', 'ss'],
  ])(
    'refuses a name that may alias listed save %s as %s without touching it',
    async (first, second) => {
      if (first !== 'a') await save(first);
      const index = await indexText();
      const firstBytes = await storage.read(`saves/${first}.save`);
      host.runUntil(20n);
      await save(second, 'alias');
      expect(response('alias')).toMatchObject({
        kind: 'commandError',
        message: expect.stringContaining('differing only by case or Unicode normalization'),
      });
      expect(await indexText()).toBe(index);
      expect(await storage.read(`saves/${first}.save`)).toEqual(firstBytes);
    },
  );
});

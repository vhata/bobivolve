import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { EventLogReader } from './event-log.js';
import { NodeHost } from './node.js';
import { NodeStorage } from './storage-node.js';
import type { Command, SimEvent } from '../protocol/types.js';

it.each(['rewind', 'switch'] as const)(
  'rebuilds complete state for %s when every eligible snapshot is corrupt',
  async (operation) => {
    const root = await mkdtemp(join(tmpdir(), 'bobivolve-corrupt-snap-'));
    try {
      const storage = new NodeStorage({ root });
      let host = new NodeHost({
        heartbeatHz: 0,
        persistence: { storage, runId: 'run', snapshotCadenceTicks: 10n },
      });
      const events: SimEvent[] = [];
      host.subscribe((event) => events.push(event));
      host.send({ kind: 'newRun', commandId: 'new', seed: 42n });
      host.runUntil(10n);
      host.send({ kind: 'quarantine', commandId: 'hold', lineageId: 'L0' });
      host.send({
        kind: 'applyPatch',
        commandId: 'patch',
        lineageId: 'L0',
        firmware: [{ kind: 'gather', params: { rate: '3' } }],
      });
      host.runUntil(25n);
      host.send({ kind: 'save', commandId: 'save-before', slot: 'before' });
      await host.flush();
      const before = await storage.read('saves/before.save');
      if (operation === 'rewind') {
        host.runUntil(30n);
        await host.flush();
      } else {
        host = new NodeHost({ heartbeatHz: 0, persistence: { storage, runId: 'bootstrap' } });
        host.subscribe((event) => events.push(event));
      }
      for (const tick of [0, 10, 20]) {
        await storage.write(
          `runs/run/snapshots/${tick}.snap`,
          new TextEncoder().encode('{bad snapshot'),
        );
      }
      const command: Command =
        operation === 'rewind'
          ? { kind: 'rewindToTick', commandId: 'recover', tick: 25n }
          : { kind: 'switchRun', commandId: 'recover', runId: 'run' };
      host.send(command);
      await host.flush();
      expect(events.filter((e) => e.kind === 'commandError')).toEqual([]);
      expect(events.some((e) => e.kind === 'commandAck' && e.commandId === 'recover')).toBe(true);
      expect(host.currentTick()).toBe(25n);
      expect(host.isPaused()).toBe(true);
      host.send({ kind: 'save', commandId: 'save-after', slot: 'after' });
      await host.flush();
      expect(await storage.read('saves/after.save')).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each(['missing', 'corrupt', 'wrong-tick', 'unreadable'] as const)(
  'uses an older snapshot in a loaded timeline without a seed when the latest is %s',
  async (damage) => {
    const root = await mkdtemp(join(tmpdir(), 'bobivolve-older-snap-'));
    try {
      const storage = new NodeStorage({ root });
      const host = new NodeHost({
        heartbeatHz: 0,
        persistence: { storage, runId: 'run', snapshotCadenceTicks: 10n },
      });
      const events: SimEvent[] = [];
      host.subscribe((event) => events.push(event));
      host.send({ kind: 'newRun', commandId: 'new', seed: 42n });
      host.runUntil(10n);
      host.send({ kind: 'save', commandId: 'anchor', slot: 'anchor' });
      await host.flush();
      host.send({ kind: 'load', commandId: 'load', slot: 'anchor' });
      await host.flush(); // fork now has a tick-10 anchor, no newRun seed
      host.send({ kind: 'quarantine', commandId: 'hold', lineageId: 'L0' });
      host.send({ kind: 'resume', commandId: 'resume' });
      host.runUntil(25n);
      host.send({ kind: 'save', commandId: 'before', slot: 'before' });
      await host.flush();
      const expected = await storage.read('saves/before.save');
      host.runUntil(30n);
      await host.flush();
      const key = 'runs/run/snapshots/20.snap';
      if (damage === 'missing') await storage.delete(key);
      if (damage === 'corrupt') await storage.write(key, new TextEncoder().encode('{}'));
      if (damage === 'wrong-tick') {
        await storage.write(key, (await storage.read('runs/run/snapshots/30.snap'))!);
      }
      const read = storage.read.bind(storage);
      const spy = vi.spyOn(storage, 'read').mockImplementation(async (path) => {
        if (damage === 'unreadable' && path === key) throw new Error('snapshot read failed');
        return read(path);
      });
      host.send({ kind: 'rewindToTick', commandId: 'recover', tick: 25n });
      await host.flush();
      spy.mockRestore();
      expect(events.filter((e) => e.kind === 'commandError')).toEqual([]);
      expect(events.some((e) => e.kind === 'commandAck' && e.commandId === 'recover')).toBe(true);
      host.send({ kind: 'save', commandId: 'after', slot: 'after' });
      await host.flush();
      expect(await storage.read('saves/after.save')).toEqual(expected);
    } finally {
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('reports an unrecoverable loaded timeline without replacing live state or truncating its log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bobivolve-no-anchor-'));
  try {
    const storage = new NodeStorage({ root });
    const host = new NodeHost({ heartbeatHz: 0, persistence: { storage, runId: 'run' } });
    const events: SimEvent[] = [];
    host.subscribe((event) => events.push(event));
    host.send({ kind: 'newRun', commandId: 'new', seed: 42n });
    host.runUntil(10n);
    host.send({ kind: 'save', commandId: 'anchor', slot: 'anchor' });
    await host.flush();
    host.send({ kind: 'load', commandId: 'load', slot: 'anchor' });
    await host.flush();
    host.send({ kind: 'resume', commandId: 'resume' });
    host.runUntil(20n);
    host.send({ kind: 'save', commandId: 'before', slot: 'before' });
    await host.flush();
    const before = await storage.read('saves/before.save');
    const log = await storage.read('runs/run/log.ndjson');
    const anchor = (await new EventLogReader(storage, 'runs/run/log.ndjson').readAll()).find(
      (e) => e.type === 'snap',
    );
    if (anchor?.type !== 'snap') throw new Error('missing load anchor');
    await storage.write(anchor.snapshotKey, new TextEncoder().encode('broken'));
    host.send({ kind: 'rewindToTick', commandId: 'recover', tick: 15n });
    await host.flush();
    expect(
      events.find((e) => e.kind === 'commandError' && e.commandId === 'recover'),
    ).toMatchObject({
      message: expect.stringContaining('no usable snapshot'),
    });
    expect(events.some((e) => e.kind === 'commandAck' && e.commandId === 'recover')).toBe(false);
    const retained = new TextDecoder().decode(
      (await storage.read('runs/run/log.ndjson')) ?? undefined,
    );
    const previous = new TextDecoder().decode(log ?? undefined);
    expect(retained.startsWith(previous)).toBe(true);
    expect(JSON.parse(retained.slice(previous.length))).toMatchObject({
      type: 'ev',
      event: { kind: 'commandError', commandId: 'recover' },
    });
    host.send({ kind: 'save', commandId: 'after', slot: 'after' });
    await host.flush();
    expect(await storage.read('saves/after.save')).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

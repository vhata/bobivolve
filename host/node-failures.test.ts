import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { NodeHost } from './node.js';
import { NodeStorage } from './storage-node.js';
import type { Command, SimEvent } from '../protocol/types.js';

it.each(['switch-log', 'switch-marker', 'switch-append', 'load-anchor', 'load-log', 'rewind-log'])(
  'preserves the active run and reports a correlated error on %s failure',
  async (failure) => {
    const root = await mkdtemp(join(tmpdir(), 'bobivolve-failure-'));
    try {
      const storage = new NodeStorage({ root });
      const host = new NodeHost({ heartbeatHz: 0, persistence: { storage, runId: 'original' } });
      const events: SimEvent[] = [];
      host.subscribe((e) => events.push(e));
      host.send({ kind: 'newRun', commandId: 'new', seed: 42n });
      host.runUntil(10n);
      host.send({ kind: 'save', commandId: 'checkpoint', slot: 'checkpoint' });
      await host.flush();
      host.runUntil(20n);
      host.send({ kind: 'quarantine', commandId: 'hold', lineageId: 'L0' });
      host.send({ kind: 'save', commandId: 'before', slot: 'before' });
      await host.flush();
      const expected = await storage.read('saves/before.save');
      const oldLog = await storage.read('runs/original/log.ndjson');
      await storage.write('runs/.active', new TextEncoder().encode('original'));
      if (failure === 'switch-log')
        await storage.write('runs/broken/log.ndjson', new TextEncoder().encode('{bad'));
      const write = storage.write.bind(storage);
      const spy = vi.spyOn(storage, 'write').mockImplementation(async (key, data) => {
        if (
          (failure === 'switch-marker' && key === 'runs/.active') ||
          (failure === 'load-anchor' && key.includes('/load-')) ||
          ((failure === 'load-log' || failure === 'rewind-log') &&
            key === 'runs/original/log.ndjson')
        ) {
          throw new Error('storage unavailable');
        }
        return write(key, data);
      });
      const appendSpy =
        failure === 'switch-append'
          ? vi.spyOn(storage, 'append').mockRejectedValueOnce(new Error('append failed'))
          : null;
      const command: Command = failure.startsWith('switch')
        ? { kind: 'switchRun', commandId: 'failing', runId: 'broken' }
        : failure.startsWith('load')
          ? { kind: 'load', commandId: 'failing', slot: 'checkpoint' }
          : { kind: 'rewindToTick', commandId: 'failing', tick: 10n };
      host.send(command);
      // Interleaved commands must not mutate the old or recovering state.
      host.send({ kind: 'newRun', commandId: 'racing', seed: 2026n });
      host.runUntil(30n);
      await host.flush();
      spy.mockRestore();
      appendSpy?.mockRestore();
      expect(
        events.filter((e) => e.kind === 'commandError' && e.commandId === 'failing'),
      ).toHaveLength(1);
      expect(events.some((e) => e.kind === 'commandAck' && e.commandId === 'failing')).toBe(false);
      expect(events.some((e) => e.kind === 'commandError' && e.commandId === 'racing')).toBe(true);
      expect(host.currentTick()).toBe(20n);
      expect(host.isPaused()).toBe(true);
      expect(await host.executeQuery({ kind: 'listRuns', queryId: 'runs' })).toMatchObject({
        activeRunId: 'original',
      });
      expect(new TextDecoder().decode((await storage.read('runs/.active'))!)).toBe('original');
      expect(
        new TextDecoder()
          .decode((await storage.read('runs/original/log.ndjson'))!)
          .startsWith(new TextDecoder().decode(oldLog!)),
      ).toBe(true);
      host.send({ kind: 'save', commandId: 'after', slot: 'after' });
      await host.flush();
      expect(await storage.read('saves/after.save')).toEqual(expected);
      // A fresh host must still recover the original run after the failure.
      const fresh = new NodeHost({ heartbeatHz: 0, persistence: { storage, runId: 'bootstrap' } });
      fresh.send({ kind: 'switchRun', commandId: 'restore', runId: 'original' });
      await fresh.flush();
      fresh.send({ kind: 'save', commandId: 'recovered', slot: 'recovered' });
      await fresh.flush();
      expect(await storage.read('saves/recovered.save')).toEqual(expected);
    } finally {
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('reports a failed save once and permits a later successful save', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bobivolve-save-failure-'));
  try {
    const storage = new NodeStorage({ root });
    const host = new NodeHost({ heartbeatHz: 0, persistence: { storage, runId: 'run' } });
    const events: SimEvent[] = [];
    host.subscribe((e) => events.push(e));
    host.send({ kind: 'newRun', commandId: 'new', seed: 42n });
    await host.flush();
    const spy = vi.spyOn(storage, 'write').mockRejectedValueOnce(new Error('disk full'));
    host.send({ kind: 'save', commandId: 'bad-save', slot: 'checkpoint' });
    await host.flush();
    spy.mockRestore();
    expect(
      events.filter((e) => e.kind === 'commandError' && e.commandId === 'bad-save'),
    ).toHaveLength(1);
    expect(events.some((e) => e.kind === 'commandAck' && e.commandId === 'bad-save')).toBe(false);
    host.send({ kind: 'save', commandId: 'retry', slot: 'checkpoint' });
    await host.flush();
    expect(events.some((e) => e.kind === 'commandAck' && e.commandId === 'retry')).toBe(true);
  } finally {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
});

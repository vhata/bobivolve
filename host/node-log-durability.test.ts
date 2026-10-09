import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Storage } from '../sim/ports.js';
import type { SimEvent } from '../protocol/types.js';
import { EventLogWriter, parseEntry, type LogEntry } from './event-log.js';
import { NodeHost } from './node.js';

// Automatic event-log flushing (NodeHostOptions.logFlushIntervalMs), the
// policy the browser worker relies on so a reload, tab close or crash
// does not lose an unpaused run. These tests never call host.flush():
// that is the explicit flush Pause triggers, and the point is that the
// log reaches storage without it.

// In-memory Storage. A gate, when set, holds every operation on matching
// keys until it is released, so tests can interleave commands with
// in-flight storage work.
class MemoryStorage implements Storage {
  readonly files = new Map<string, Uint8Array>();
  readonly appends: string[] = [];
  gate: { readonly match: (key: string) => boolean; readonly open: Promise<void> } | null = null;

  private async pass(key: string): Promise<void> {
    if (this.gate?.match(key) === true) await this.gate.open;
  }

  async read(key: string): Promise<Uint8Array | null> {
    await this.pass(key);
    return this.files.get(key) ?? null;
  }

  async write(key: string, data: Uint8Array): Promise<void> {
    await this.pass(key);
    this.files.set(key, data.slice());
  }

  async append(key: string, data: Uint8Array): Promise<void> {
    await this.pass(key);
    const prev = this.files.get(key) ?? new Uint8Array();
    const next = new Uint8Array(prev.length + data.length);
    next.set(prev);
    next.set(data, prev.length);
    this.files.set(key, next);
    this.appends.push(key);
  }

  async delete(key: string): Promise<void> {
    await this.pass(key);
    this.files.delete(key);
  }

  log(runId: string): LogEntry[] {
    const bytes = this.files.get(`runs/${runId}/log.ndjson`);
    if (bytes === undefined) return [];
    return new TextDecoder()
      .decode(bytes)
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map(parseEntry);
  }
}

function gate(): { open: Promise<void>; release: () => void } {
  let release = (): void => {};
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { open, release };
}

// Let queued host work and in-memory storage settle without flushing.
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// A worker-shaped host: starts on an unused slot and restores the
// default slot, exactly as host/worker.ts does at startup.
async function startWorkerHost(
  storage: Storage,
  options: { now?: () => number; logFlushIntervalMs?: number; snapshotCadenceTicks?: bigint } = {},
): Promise<NodeHost> {
  const host = new NodeHost({
    heartbeatHz: 0,
    persistence: {
      storage,
      runId: '__startup__',
      ...(options.snapshotCadenceTicks !== undefined
        ? { snapshotCadenceTicks: options.snapshotCadenceTicks }
        : {}),
    },
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.logFlushIntervalMs !== undefined
      ? { logFlushIntervalMs: options.logFlushIntervalMs }
      : {}),
  });
  host.send({ kind: 'switchRun', commandId: 'startup', runId: 'default' });
  await host.flush();
  return host;
}

function maxTick(entries: readonly LogEntry[]): bigint {
  return entries.reduce((max, entry) => (entry.tick > max ? entry.tick : max), -1n);
}

// Every snap entry in the log must point at a snapshot file on disk.
function missingSnapshots(storage: MemoryStorage, runId: string): string[] {
  return storage
    .log(runId)
    .flatMap((e) =>
      e.type === 'snap' && !storage.files.has(e.snapshotKey) ? [e.snapshotKey] : [],
    );
}

describe('automatic event-log flushing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists unpaused play so a restarted host restores it', async () => {
    const storage = new MemoryStorage();
    let clock = 0;
    const host = await startWorkerHost(storage, {
      now: () => clock,
      logFlushIntervalMs: 1000,
    });
    host.send({ kind: 'newRun', commandId: 'start', seed: 42n });
    // Worker-style pulses with wall-clock time passing between them.
    for (let pulse = 1n; pulse <= 50n; pulse += 1n) {
      clock += 250;
      host.runUntil(pulse * 10n);
      await settle();
    }
    expect(host.isPaused()).toBe(false);
    expect(host.currentTick()).toBe(500n);

    // Simulates a reload: the first host is abandoned without a flush.
    const restarted = await startWorkerHost(storage);
    expect(restarted.currentTick()).toBeGreaterThanOrEqual(480n);
    expect(storage.files.has('runs/__startup__/log.ndjson')).toBe(false);
  });

  it('flushes at most once per interval while the run advances', async () => {
    const storage = new MemoryStorage();
    let clock = 0;
    const host = await startWorkerHost(storage, {
      now: () => clock,
      logFlushIntervalMs: 1000,
    });
    const events: SimEvent[] = [];
    host.subscribe((event) => events.push(event));
    host.send({ kind: 'newRun', commandId: 'start', seed: 42n });
    await settle();
    const appendsAfterStart = storage.appends.length;
    let lastTick = 0n;
    const pulseAt = async (ms: number): Promise<number> => {
      clock = ms;
      lastTick += 10n;
      host.runUntil(lastTick);
      await settle();
      return storage.appends.length - appendsAfterStart;
    };
    expect(await pulseAt(1000)).toBe(1);
    expect(await pulseAt(1400)).toBe(1);
    expect(await pulseAt(1999)).toBe(1);
    expect(await pulseAt(2000)).toBe(2);
    // The due flush drained everything emitted up to the end of its pulse.
    expect(storage.log('default').filter((e) => e.type === 'ev')).toHaveLength(events.length);
  });

  it('persists a command issued while paused', async () => {
    const storage = new MemoryStorage();
    const host = await startWorkerHost(storage, { now: () => 0, logFlushIntervalMs: 1000 });
    host.send({ kind: 'newRun', commandId: 'start', seed: 42n });
    host.runUntil(20n);
    host.send({ kind: 'pause', commandId: 'pause' });
    await settle();
    host.send({ kind: 'step', commandId: 'step', ticks: 5n });
    await settle();

    const entries = storage.log('default');
    expect(entries.some((e) => e.type === 'cmd' && e.command.kind === 'step')).toBe(true);
    expect(maxTick(entries)).toBe(25n);
    const restarted = await startWorkerHost(storage);
    expect(restarted.currentTick()).toBe(25n);
  });

  it('persists the run up to an auto-pause', async () => {
    const storage = new MemoryStorage();
    // A frozen clock: after the first request no periodic flush is due,
    // so only the auto-pause itself can write the paused tick.
    const host = await startWorkerHost(storage, { now: () => 0, logFlushIntervalMs: 1000 });
    host.send({ kind: 'newRun', commandId: 'start', seed: 42n });
    host.send({ kind: 'configureAutoPause', commandId: 'ap', enabledTriggers: ['speciation'] });
    host.runUntil(4n);
    await settle();
    host.runUntil(100n);
    expect(host.isPaused()).toBe(true);
    expect(host.currentTick()).toBe(8n);
    await settle();

    const entries = storage.log('default');
    expect(entries.some((e) => e.type === 'ev' && e.event.kind === 'autoPaused')).toBe(true);
    const restarted = await startWorkerHost(storage);
    expect(restarted.currentTick()).toBe(8n);
  });

  it('never writes a new run into the log its reset is about to delete', async () => {
    const storage = new MemoryStorage();
    let clock = 0;
    const host = await startWorkerHost(storage, {
      now: () => clock,
      logFlushIntervalMs: 1000,
    });
    host.send({ kind: 'newRun', commandId: 'first', seed: 42n });
    await settle();
    // Hold the named save so a flush for the first run waits
    // behind it in the work queue when the second newRun arrives.
    const held = gate();
    storage.gate = { match: (key) => key.startsWith('saves/'), open: held.open };
    host.send({ kind: 'save', commandId: 'checkpoint', slot: 'checkpoint' });
    clock += 1000;
    host.runUntil(10n);
    host.send({ kind: 'newRun', commandId: 'second', seed: 2026n });
    storage.gate = null;
    held.release();
    await settle();

    const entries = storage.log('default');
    const newRuns = entries.filter((e) => e.type === 'cmd' && e.command.kind === 'newRun');
    expect(newRuns).toHaveLength(1);
    expect(newRuns[0]).toMatchObject({ command: { commandId: 'second', seed: 2026n } });
    expect(entries.some((e) => e.type === 'snap' && e.tick === 0n)).toBe(true);
    expect(maxTick(entries)).toBe(0n);
  });

  it('never appends the pre-rewind writer onto the truncated log', async () => {
    const storage = new MemoryStorage();
    const host = await startWorkerHost(storage, { now: () => 0, logFlushIntervalMs: 1000 });
    const events: SimEvent[] = [];
    host.subscribe((event) => events.push(event));
    host.send({ kind: 'newRun', commandId: 'start', seed: 42n });
    host.runUntil(40n);
    await settle();
    host.runUntil(60n);
    // Hold the rewind's log read so a command can arrive mid-operation.
    const held = gate();
    storage.gate = { match: (key) => key === 'runs/default/log.ndjson', open: held.open };
    host.send({ kind: 'rewindToTick', commandId: 'rewind', tick: 30n });
    await settle();
    host.send({ kind: 'setSpeed', commandId: 'racing', speed: 4 });
    storage.gate = null;
    held.release();
    await settle();

    expect(events.some((e) => e.kind === 'commandAck' && e.commandId === 'rewind')).toBe(true);
    expect(events.some((e) => e.kind === 'commandError' && e.commandId === 'racing')).toBe(true);
    const entries = storage.log('default');
    expect(maxTick(entries)).toBe(30n);
    // The rewind's own acknowledgement belongs to the new timeline.
    expect(
      entries.some(
        (e) => e.type === 'ev' && e.event.kind === 'commandAck' && e.event.commandId === 'rewind',
      ),
    ).toBe(true);
  });

  it('never writes a snap entry before its snapshot file', async () => {
    const storage = new MemoryStorage();
    let clock = 0;
    // Every slice is due a periodic flush, so a flush job is always queued
    // ahead of the cadence snapshot's file write.
    const host = await startWorkerHost(storage, {
      now: () => (clock += 1000),
      logFlushIntervalMs: 1000,
      snapshotCadenceTicks: 20n,
    });
    host.send({ kind: 'newRun', commandId: 'start', seed: 42n });
    await settle();
    const held = gate();
    storage.gate = { match: (key) => key.endsWith('/20.snap'), open: held.open };
    host.runUntil(40n);
    await settle();
    expect(storage.files.has('runs/default/snapshots/20.snap')).toBe(false);
    expect(storage.log('default').length).toBeGreaterThan(0);
    expect(missingSnapshots(storage, 'default')).toEqual([]);

    storage.gate = null;
    held.release();
    await settle();
    const snaps = storage.log('default').filter((e) => e.type === 'snap');
    expect(snaps.map((e) => e.tick)).toEqual([0n, 20n, 40n]);
    expect(missingSnapshots(storage, 'default')).toEqual([]);
  });

  it('flushes a cadence snapshot entry once its file is written', async () => {
    const storage = new MemoryStorage();
    // A frozen clock: no periodic flush is due, so only the snapshot's own
    // request can write its entry.
    const host = await startWorkerHost(storage, {
      now: () => 0,
      logFlushIntervalMs: 1000,
      snapshotCadenceTicks: 20n,
    });
    host.send({ kind: 'newRun', commandId: 'start', seed: 42n });
    await settle();
    host.runUntil(20n);
    await settle();
    expect(storage.log('default').some((e) => e.type === 'snap' && e.tick === 20n)).toBe(true);
  });

  it('flushes the error of a failed queued command', async () => {
    const storage = new MemoryStorage();
    let clock = 0;
    const host = await startWorkerHost(storage, {
      now: () => clock,
      logFlushIntervalMs: 1000,
    });
    host.send({ kind: 'newRun', commandId: 'start', seed: 42n });
    host.runUntil(10n);
    host.send({ kind: 'pause', commandId: 'pause' });
    await settle();
    const write = storage.write.bind(storage);
    vi.spyOn(storage, 'write').mockImplementation(async (key, data) => {
      if (key.startsWith('saves/')) throw new Error('disk full');
      return write(key, data);
    });
    // A due periodic flush is queued ahead of the save, so the save's own
    // flush request coalesces into it and runs before the save fails.
    clock += 1000;
    host.send({ kind: 'step', commandId: 'step', ticks: 1n });
    host.send({ kind: 'save', commandId: 'failing', slot: 'failing' });
    await settle();
    expect(
      storage
        .log('default')
        .some(
          (e) =>
            e.type === 'ev' && e.event.kind === 'commandError' && e.event.commandId === 'failing',
        ),
    ).toBe(true);
  });

  it('queues at most one flush per writer while one is waiting', async () => {
    const storage = new MemoryStorage();
    const host = await startWorkerHost(storage, { now: () => 0, logFlushIntervalMs: 1000 });
    host.send({ kind: 'newRun', commandId: 'start', seed: 42n });
    host.send({ kind: 'pause', commandId: 'pause' });
    await settle();
    const flushes = vi.spyOn(EventLogWriter.prototype, 'flush');
    for (let i = 0; i < 5; i += 1) {
      host.send({ kind: 'setSpeed', commandId: `speed-${i}`, speed: 4 });
    }
    await settle();
    expect(flushes).toHaveBeenCalledTimes(1);
    expect(
      storage.log('default').filter((e) => e.type === 'cmd' && e.command.kind === 'setSpeed'),
    ).toHaveLength(5);
  });

  it('writes the buffer on an explicit flush after an automatic flush failed', async () => {
    const storage = new MemoryStorage();
    const host = await startWorkerHost(storage, { now: () => 0, logFlushIntervalMs: 1000 });
    host.send({ kind: 'newRun', commandId: 'start', seed: 42n });
    host.runUntil(10n);
    host.send({ kind: 'pause', commandId: 'pause' });
    await settle();
    vi.spyOn(storage, 'append').mockRejectedValueOnce(new Error('append failed'));
    host.send({ kind: 'step', commandId: 'step', ticks: 2n });
    await settle();
    expect(storage.log('default').some((e) => e.type === 'cmd' && e.command.kind === 'step')).toBe(
      false,
    );

    // An explicit flush (the worker's Pause flush) still persists the
    // buffer, then reports the earlier failure once.
    await expect(host.flush()).rejects.toThrow('append failed');
    const entries = storage.log('default');
    expect(entries.some((e) => e.type === 'cmd' && e.command.kind === 'step')).toBe(true);
    expect(maxTick(entries)).toBe(12n);
    await expect(host.flush()).resolves.toBeUndefined();
  });

  it('leaves logging to explicit flushes when no interval is configured', async () => {
    const storage = new MemoryStorage();
    const host = await startWorkerHost(storage, { now: () => 0 });
    host.send({ kind: 'newRun', commandId: 'start', seed: 42n });
    host.runUntil(100n);
    host.send({ kind: 'step', commandId: 'step', ticks: 1n });
    await settle();
    expect(storage.log('default')).toEqual([]);
    await host.flush();
    expect(maxTick(storage.log('default'))).toBe(101n);
  });
});

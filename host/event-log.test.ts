import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EventLogReader,
  EventLogWriter,
  parseEntry,
  serializeEntry,
  type LogEntry,
} from './event-log.js';
import { NodeStorage } from './storage-node.js';

describe('event log entry codec', () => {
  it('round-trips a cmd entry', () => {
    const entry: LogEntry = {
      type: 'cmd',
      tick: 0n,
      seq: 0,
      command: { kind: 'newRun', commandId: 'c1', seed: 42n },
    };
    const text = serializeEntry(entry);
    expect(text.endsWith('\n')).toBe(true);
    const back = parseEntry(text);
    expect(back).toEqual(entry);
  });

  it('round-trips an ev entry with bigint simTick', () => {
    const entry: LogEntry = {
      type: 'ev',
      tick: 190n,
      seq: 1,
      event: {
        kind: 'replication',
        simTick: 190n,
        parentProbeId: 'P0',
        childProbeId: 'P1',
        lineageId: 'L0',
        mutated: false,
      },
    };
    const back = parseEntry(serializeEntry(entry));
    expect(back).toEqual(entry);
  });

  it('round-trips a snap entry', () => {
    const entry: LogEntry = {
      type: 'snap',
      tick: 30000n,
      seq: 0,
      snapshotKey: 'snapshots/30000.snap',
    };
    expect(parseEntry(serializeEntry(entry))).toEqual(entry);
  });

  it('rejects empty lines on parse', () => {
    expect(() => parseEntry('')).toThrow();
    expect(() => parseEntry('   ')).toThrow();
  });
});

describe('EventLogWriter / EventLogReader', () => {
  let root: string;
  let storage: NodeStorage;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bobivolve-eventlog-'));
    storage = new NodeStorage({ root });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes entries and reads them back in order', async () => {
    const writer = new EventLogWriter(storage, 'log.ndjson');
    writer.appendCommand(0n, { kind: 'newRun', commandId: 'c1', seed: 1n });
    writer.appendEvent(0n, { kind: 'commandAck', simTick: 0n, commandId: 'c1' });
    writer.appendEvent(190n, {
      kind: 'replication',
      simTick: 190n,
      parentProbeId: 'P0',
      childProbeId: 'P1',
      lineageId: 'L0',
      mutated: false,
    });
    await writer.flush();

    const reader = new EventLogReader(storage, 'log.ndjson');
    const entries = await reader.readAll();
    expect(entries).toHaveLength(3);
    expect(entries[0]?.type).toBe('cmd');
    expect(entries[1]?.type).toBe('ev');
    expect(entries[2]?.type).toBe('ev');
  });

  it('assigns seq starting at 0 within each tick, resetting on tick change', async () => {
    const writer = new EventLogWriter(storage, 'log.ndjson');
    writer.appendCommand(0n, { kind: 'newRun', commandId: 'c1', seed: 1n });
    writer.appendEvent(0n, { kind: 'commandAck', simTick: 0n, commandId: 'c1' });
    writer.appendEvent(0n, { kind: 'commandAck', simTick: 0n, commandId: 'c2' });
    writer.appendEvent(5n, { kind: 'commandAck', simTick: 5n, commandId: 'c3' });
    await writer.flush();

    const reader = new EventLogReader(storage, 'log.ndjson');
    const entries = await reader.readAll();
    expect(entries.map((e) => [e.tick, e.seq])).toEqual([
      [0n, 0],
      [0n, 1],
      [0n, 2],
      [5n, 0],
    ]);
  });

  it('latestSnap returns the snap with the highest tick', async () => {
    const writer = new EventLogWriter(storage, 'log.ndjson');
    writer.appendSnap(0n, 'snapshots/0.snap');
    writer.appendEvent(50n, { kind: 'commandAck', simTick: 50n, commandId: 'x' });
    writer.appendSnap(30000n, 'snapshots/30000.snap');
    writer.appendEvent(31000n, { kind: 'commandAck', simTick: 31000n, commandId: 'y' });
    await writer.flush();

    const reader = new EventLogReader(storage, 'log.ndjson');
    const latest = await reader.latestSnap();
    expect(latest).not.toBeNull();
    expect(latest?.tick).toBe(30000n);
    expect(latest?.snapshotKey).toBe('snapshots/30000.snap');
  });

  it('latestSnap returns null when no snap entries exist', async () => {
    const writer = new EventLogWriter(storage, 'log.ndjson');
    writer.appendCommand(0n, { kind: 'newRun', commandId: 'c1', seed: 1n });
    await writer.flush();
    const reader = new EventLogReader(storage, 'log.ndjson');
    expect(await reader.latestSnap()).toBeNull();
  });

  it('tailAfter returns only entries strictly after (tick, seq)', async () => {
    const writer = new EventLogWriter(storage, 'log.ndjson');
    writer.appendSnap(100n, 'snapshots/100.snap');
    writer.appendEvent(100n, { kind: 'commandAck', simTick: 100n, commandId: 'a' });
    writer.appendCommand(200n, { kind: 'pause', commandId: 'b' });
    writer.appendCommand(300n, { kind: 'resume', commandId: 'c' });
    await writer.flush();

    const reader = new EventLogReader(storage, 'log.ndjson');
    const tail = await reader.tailAfter(100n, 0);
    expect(tail.map((e) => [e.tick, e.seq])).toEqual([
      [100n, 1],
      [200n, 0],
      [300n, 0],
    ]);
  });

  it('returns empty array for missing log file', async () => {
    const reader = new EventLogReader(storage, 'never-existed.ndjson');
    expect(await reader.readAll()).toEqual([]);
  });
});

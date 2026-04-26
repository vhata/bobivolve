import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Command, SimEvent } from '../protocol/types.js';
import { EventLogReader } from './event-log.js';
import { NodeHost } from './node.js';
import { NodeStorage } from './storage-node.js';

// End-to-end persistence: NodeHost with a NodeStorage attached writes its
// command log, event log, and periodic snapshots to disk; Save forces a
// snapshot; Load reads the latest snapshot and replays the tail to land at
// the same simTick the run was at on save.

describe('NodeHost persistence', () => {
  let root: string;
  let storage: NodeStorage;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bobivolve-persist-'));
    storage = new NodeStorage({ root });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeHost(runId: string, snapshotCadenceTicks?: bigint): NodeHost {
    return new NodeHost({
      heartbeatHz: 0,
      persistence: {
        storage,
        runId,
        ...(snapshotCadenceTicks !== undefined ? { snapshotCadenceTicks } : {}),
      },
    });
  }

  it('logs every command and event to disk', async () => {
    const host = makeHost('logged-run');
    host.send({ kind: 'newRun', commandId: 'c0', seed: 42n });
    host.runUntil(1000n);
    await host.flush();

    const reader = new EventLogReader(storage, 'runs/logged-run/log.ndjson');
    const entries = await reader.readAll();
    const cmds = entries.filter((e) => e.type === 'cmd');
    const evs = entries.filter((e) => e.type === 'ev');
    expect(cmds.length).toBe(1);
    expect(evs.length).toBeGreaterThan(0);
    expect(cmds[0]?.command).toMatchObject({ kind: 'newRun', seed: 42n });
  });

  it('writes a snap entry at the cadence boundary', async () => {
    const host = makeHost('snap-cadence', 500n);
    host.send({ kind: 'newRun', commandId: 'c0', seed: 42n });
    host.runUntil(1500n); // crosses 500, 1000, 1500 → expect snaps at 500, 1000, 1500
    await host.flush();

    const reader = new EventLogReader(storage, 'runs/snap-cadence/log.ndjson');
    const snaps = (await reader.readAll()).filter((e) => e.type === 'snap');
    expect(snaps.length).toBeGreaterThanOrEqual(2);
    for (const snap of snaps) {
      expect(snap.tick % 500n).toBe(0n);
      // Snapshot file actually exists
      if (snap.type === 'snap') {
        expect(await storage.exists(snap.snapshotKey)).toBe(true);
      }
    }
  });

  it('Save forces a snapshot at the current tick and acks after flush', async () => {
    const host = makeHost('saved-run', 1_000_000n); // disable cadence by going huge
    host.send({ kind: 'newRun', commandId: 'c0', seed: 42n });
    host.runUntil(800n);

    const acks: string[] = [];
    host.subscribe((e: SimEvent) => {
      if (e.kind === 'commandAck') acks.push(e.commandId);
    });

    host.send({ kind: 'save', commandId: 'save-1', slot: 'default' });
    await host.flush();

    expect(acks).toContain('save-1');
    // Save writes a named slot under saves/, not into the active log.
    expect(await storage.exists('saves/default.save')).toBe(true);
    expect(await storage.exists('saves/index.json')).toBe(true);
  });

  it('Save before newRun fails with commandError', async () => {
    const host = makeHost('empty-run');
    const errors: string[] = [];
    host.subscribe((e: SimEvent) => {
      if (e.kind === 'commandError') errors.push(e.message);
    });

    host.send({ kind: 'save', commandId: 'save-1', slot: 'default' });
    await host.flush();

    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('cannot save before newRun');
  });

  it('Save and Load round-trip: same simTick after load, continuation matches in-memory baseline', async () => {
    // Phase 1: run + save
    {
      const host = makeHost('rt');
      host.send({ kind: 'newRun', commandId: 'c0', seed: 42n });
      host.runUntil(1500n);
      host.send({ kind: 'save', commandId: 'save-1', slot: 'default' });
      await host.flush();
    }

    // Phase 2: load on a fresh host, continue, capture events
    const events1: SimEvent[] = [];
    {
      const host = makeHost('rt');
      host.subscribe((e: SimEvent) => events1.push(e));
      host.send({ kind: 'load', commandId: 'load-1', slot: 'default' });
      await host.flush();
      host.send({ kind: 'resume', commandId: 'resume-1' });
      host.runUntil(2000n);
      await host.flush();
    }

    // Baseline: a fresh in-memory run from seed=42 to tick 2000
    const events2: SimEvent[] = [];
    {
      const host = new NodeHost({ heartbeatHz: 0 });
      host.subscribe((e: SimEvent) => events2.push(e));
      host.send({ kind: 'newRun', commandId: 'c0', seed: 42n });
      host.runUntil(2000n);
      await host.flush();
    }

    // Filter: replication / speciation events from tick > 1500. The in-memory
    // baseline ran from tick 0; the loaded run resumed from tick 1500. The
    // events emitted past tick 1500 should match between the two runs.
    const domainEvents = (es: readonly SimEvent[]) =>
      es.filter((e) => (e.kind === 'replication' || e.kind === 'speciation') && e.simTick > 1500n);

    expect(domainEvents(events1)).toEqual(domainEvents(events2));
  });

  it('Load fails when the named slot does not exist', async () => {
    const host = makeHost('never-existed');
    const errors: string[] = [];
    host.subscribe((e: SimEvent) => {
      if (e.kind === 'commandError') errors.push(e.message);
    });

    host.send({ kind: 'load', commandId: 'load-1', slot: 'no-such-slot' });
    await host.flush();

    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/save slot not found: no-such-slot/);
  });

  it('listSaves query returns slots written by Save', async () => {
    const host = makeHost('with-saves');
    host.send({ kind: 'newRun', commandId: 'c0', seed: 42n });
    host.runUntil(500n);
    host.send({ kind: 'save', commandId: 'save-1', slot: 'first' });
    host.runUntil(1000n);
    host.send({ kind: 'save', commandId: 'save-2', slot: 'second' });
    await host.flush();

    const result = await host.executeQuery({ kind: 'listSaves', queryId: 'q1' });
    if (result.kind !== 'listSaves') throw new Error('unexpected result kind');
    expect(result.saves.map((s) => s.slot).sort()).toEqual(['first', 'second']);
  });

  it('Save / Load cleanup: snapshot files persist alongside the log', async () => {
    const host = makeHost('files', 500n);
    host.send({ kind: 'newRun', commandId: 'c0', seed: 42n });
    host.runUntil(1000n);
    host.send({ kind: 'save', commandId: 'save-1', slot: 'default' } satisfies Command);
    await host.flush();

    expect(await storage.exists('runs/files/log.ndjson')).toBe(true);
    expect(await storage.exists('runs/files/snapshots/500.snap')).toBe(true);
    expect(await storage.exists('runs/files/snapshots/1000.snap')).toBe(true);
  });
});

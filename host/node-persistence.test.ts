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

  it('newRun reaps orphan snapshot files left from a prior run on the same slot', async () => {
    // Phase 1: run + accumulate a few cadence snapshots on slot 'reap'.
    {
      const host = makeHost('reap', 500n);
      host.send({ kind: 'newRun', commandId: 'c0', seed: 42n });
      host.runUntil(1500n);
      await host.flush();
    }

    // Sanity: snapshots from the first run are on disk.
    expect(await storage.exists('runs/reap/snapshots/500.snap')).toBe(true);
    expect(await storage.exists('runs/reap/snapshots/1000.snap')).toBe(true);
    expect(await storage.exists('runs/reap/snapshots/1500.snap')).toBe(true);

    // Phase 2: a fresh host on the same runId issues newRun. The previous
    // run's log is deleted (existing behaviour) AND its orphan snap files
    // are reaped. The fresh run's own tick-0 snap is then written.
    {
      const host = makeHost('reap', 500n);
      host.send({ kind: 'newRun', commandId: 'c1', seed: 99n });
      await host.flush();

      // Tick-0 snap from the new run is the only snapshot remaining.
      expect(await storage.exists('runs/reap/snapshots/0.snap')).toBe(true);
      expect(await storage.exists('runs/reap/snapshots/500.snap')).toBe(false);
      expect(await storage.exists('runs/reap/snapshots/1000.snap')).toBe(false);
      expect(await storage.exists('runs/reap/snapshots/1500.snap')).toBe(false);
    }
  });

  it('newRun reap is safe on an empty / never-existed slot', async () => {
    // No prior run, no snapshots directory. newRun must not error.
    const host = makeHost('virgin');
    host.send({ kind: 'newRun', commandId: 'c0', seed: 42n });
    await host.flush();

    // Newly minted tick-0 snap is present; no errors thrown.
    expect(await storage.exists('runs/virgin/snapshots/0.snap')).toBe(true);
  });

  describe('per-run slots', () => {
    it('switchRun snap-saves the outgoing slot, switches, and writes the active marker', async () => {
      const host = makeHost('alpha', 1_000_000n); // disable cadence
      host.send({ kind: 'newRun', commandId: 'c0', seed: 42n });
      host.runUntil(150n);
      await host.flush();

      // Switch to a fresh slot 'beta'. The host should snap-save alpha
      // at its current tick (so a switch-back later restores cleanly),
      // then point at beta which has no snapshot — host enters its
      // empty post-construct state.
      host.send({ kind: 'switchRun', commandId: 'c1', runId: 'beta' });
      await host.flush();

      // alpha gained an explicit snap on switch-out (in addition to
      // any cadence snaps).
      expect(await storage.exists('runs/alpha/snapshots/150.snap')).toBe(true);
      // beta is fresh — no snapshot directory, no log writes yet.
      expect(await storage.exists('runs/beta/snapshots/0.snap')).toBe(false);
      // Active marker now names beta.
      const marker = await storage.read('runs/.active');
      expect(marker).not.toBeNull();
      expect(new TextDecoder().decode(marker!)).toBe('beta');

      // Issue newRun on beta to seed it, then switch back to alpha.
      host.send({ kind: 'newRun', commandId: 'c2', seed: 99n });
      host.runUntil(50n);
      await host.flush();
      expect(await storage.exists('runs/beta/snapshots/0.snap')).toBe(true);

      host.send({ kind: 'switchRun', commandId: 'c3', runId: 'alpha' });
      await host.flush();
      // Marker restored to alpha.
      expect(new TextDecoder().decode((await storage.read('runs/.active'))!)).toBe('alpha');
      // The host's currentTick is now alpha's snap-saved tick (150).
      // We verify by sending a probe-inspector query against the
      // founder probe — present in alpha, absent in beta's fresh
      // post-newRun state. Cheap proxy for "alpha state restored".
      const result = await host.executeQuery({
        kind: 'lineageTree',
        queryId: 'q-after-switch-back',
      });
      if (result.kind !== 'lineageTree') throw new Error('unreachable');
      expect(result.lineages.length).toBeGreaterThan(0);
    });

    it('deleteRun is refused on the active slot but removes inactive ones', async () => {
      const host = makeHost('keeper', 1_000_000n);
      host.send({ kind: 'newRun', commandId: 'c0', seed: 42n });
      host.runUntil(50n);
      await host.flush();

      // Switch to a sibling and write some state.
      host.send({ kind: 'switchRun', commandId: 'c1', runId: 'doomed' });
      await host.flush();
      host.send({ kind: 'newRun', commandId: 'c2', seed: 42n });
      host.runUntil(50n);
      await host.flush();
      // Switch back to keeper, leaving doomed inactive.
      host.send({ kind: 'switchRun', commandId: 'c3', runId: 'keeper' });
      await host.flush();

      expect(await storage.exists('runs/doomed/snapshots/0.snap')).toBe(true);

      // Refused: active slot.
      const errors: SimEvent[] = [];
      const unsub = host.subscribe((e) => {
        if (e.kind === 'commandError') errors.push(e);
      });
      host.send({ kind: 'deleteRun', commandId: 'c4', runId: 'keeper' });
      await host.flush();
      expect(errors.some((e) => e.kind === 'commandError' && e.commandId === 'c4')).toBe(true);
      // The active slot still on disk.
      expect(await storage.exists('runs/keeper/log.ndjson')).toBe(true);

      // Permitted: inactive slot — recursively removed.
      host.send({ kind: 'deleteRun', commandId: 'c5', runId: 'doomed' });
      await host.flush();
      expect(await storage.exists('runs/doomed/snapshots/0.snap')).toBe(false);
      expect(await storage.exists('runs/doomed/log.ndjson')).toBe(false);
      unsub();
    });

    it('switchRun-in replays log entries past the latest snap (crash-recovery path)', async () => {
      // Simulates a host that crashed between cadence snapshots on the
      // 'crashed' slot: a long log tail past the tick-0 snap exists,
      // but no later cadence snap and no snap-on-switch-out entry.
      // When a fresh host attaches to a different slot and switches in
      // to 'crashed', it must reconstruct state up to the log head by
      // replaying the tail past the latest snap. Today's tick-0-snap-
      // only restore would lose the quarantine; the new path replays
      // the quarantine cmd and advances to the log's high water mark.

      // Phase 1: populate 'crashed' from a host that never gets to
      // switch-out. Cadence high enough that no mid-run cadence snap
      // fires past tick 0. The host is then discarded, simulating a
      // crash; no flush-to-disk-on-shutdown happens beyond the explicit
      // flush() below.
      const cadence = 1_000_000n;
      {
        const host = makeHost('crashed', cadence);
        host.send({ kind: 'newRun', commandId: 'c0', seed: 42n });
        host.runUntil(50n);
        host.send({ kind: 'quarantine', commandId: 'q1', lineageId: 'L0' });
        host.runUntil(200n);
        await host.flush();
      }
      // Sanity: only the tick-0 snap is on disk for 'crashed'.
      expect(await storage.exists('runs/crashed/snapshots/0.snap')).toBe(true);
      expect(await storage.exists('runs/crashed/snapshots/200.snap')).toBe(false);

      // Find the log's high water mark — that's the tick the recovery
      // can reach. The sim was at tick 200 in memory but the log only
      // records ticks at which something happened; the highest logged
      // event tick is the most we can recover (ARCHITECTURE.md "the
      // seed plus the command log is the canonical universe").
      const reader = new EventLogReader(storage, 'runs/crashed/log.ndjson');
      const entries = await reader.readAll();
      let maxLogTick = 0n;
      for (const e of entries) if (e.tick > maxLogTick) maxLogTick = e.tick;
      // The quarantine landed at tick 50; the log tail must reach past
      // that for the test to mean anything.
      expect(maxLogTick).toBeGreaterThan(50n);

      // Phase 2: fresh host attached to a different slot ('observer')
      // that has no state of its own. SwitchRun in to 'crashed' must
      // restore by replaying the log tail past the latest snap.
      const host2 = makeHost('observer', cadence);
      host2.send({ kind: 'switchRun', commandId: 'sw', runId: 'crashed' });
      await host2.flush();

      // Recovery lands at the log head; the quarantine — issued well
      // before the log head — is back in place. Without the log-replay
      // fix, host2.currentTick would be 0 and the quarantine would be
      // gone (tick-0 snap loaded, no replay past it).
      expect(host2.currentTick()).toBe(maxLogTick);
      expect(host2.quarantinedLineages().has('L0')).toBe(true);
      expect(host2.isPaused()).toBe(true);
    });

    it('listRuns enumerates persisted slots and marks the active one', async () => {
      const host = makeHost('first', 1_000_000n);
      host.send({ kind: 'newRun', commandId: 'c0', seed: 42n });
      host.runUntil(50n);
      await host.flush();

      host.send({ kind: 'switchRun', commandId: 'c1', runId: 'second' });
      await host.flush();
      host.send({ kind: 'newRun', commandId: 'c2', seed: 99n });
      host.runUntil(50n);
      await host.flush();

      const result = await host.executeQuery({ kind: 'listRuns', queryId: 'q' });
      if (result.kind !== 'listRuns') throw new Error('unreachable');
      const byId = new Map(result.runs.map((r) => [r.runId, r]));
      expect(byId.has('first')).toBe(true);
      expect(byId.has('second')).toBe(true);
      expect(result.activeRunId).toBe('second');
      // first's latestTick is the snap-saved 50 (snap-on-switch-out).
      expect(byId.get('first')!.latestTick).toBe('50');
      // second's latestTick is its newRun's tick-0 snap.
      expect(byId.get('second')!.latestTick).toBe('0');
    });
  });
});

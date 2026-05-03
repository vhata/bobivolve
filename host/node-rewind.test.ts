import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeHost } from './node.js';
import { NodeStorage } from './storage-node.js';

// Forensic-replay rewind: load latest in-run snapshot at-or-before
// targetTick, replay any logged commands strictly between snap.tick and
// targetTick, then advance the sim deterministically to land on target.
// Pauses on completion. Destructive — post-rewind state is forfeit.

describe('NodeHost rewindToTick', () => {
  let root: string;
  let storage: NodeStorage;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bobivolve-rewind-'));
    storage = new NodeStorage({ root });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeHost(runId: string): NodeHost {
    return new NodeHost({
      heartbeatHz: 0,
      persistence: { storage, runId },
    });
  }

  it('rewinds to a pre-quarantine tick: the quarantine is gone', async () => {
    const host = makeHost('rewind-pre-quarantine');
    host.send({ kind: 'newRun', commandId: 'c0', seed: 42n });
    host.runUntil(500n);
    // Quarantine the founder lineage at tick ~500.
    host.send({ kind: 'quarantine', commandId: 'q1', lineageId: 'L0' });
    host.runUntil(1000n);
    expect(host.quarantinedLineages().has('L0')).toBe(true);

    // Rewind to tick 100 — strictly before the quarantine command.
    host.send({ kind: 'rewindToTick', commandId: 'r1', tick: 100n });
    await host.flush();

    expect(host.currentTick()).toBe(100n);
    expect(host.quarantinedLineages().has('L0')).toBe(false);
    expect(host.isPaused()).toBe(true);
  });

  it('rewinds to a post-quarantine tick: the quarantine is replayed', async () => {
    const host = makeHost('rewind-post-quarantine');
    host.send({ kind: 'newRun', commandId: 'c0', seed: 42n });
    host.runUntil(500n);
    host.send({ kind: 'quarantine', commandId: 'q1', lineageId: 'L0' });
    host.runUntil(1000n);

    // Rewind to tick 800 — after the quarantine command at ~500.
    host.send({ kind: 'rewindToTick', commandId: 'r1', tick: 800n });
    await host.flush();

    expect(host.currentTick()).toBe(800n);
    expect(host.quarantinedLineages().has('L0')).toBe(true);
    expect(host.isPaused()).toBe(true);
  });

  it('errors on rewinding to a future tick', async () => {
    const host = makeHost('rewind-future');
    const errors: { commandId: string; message: string }[] = [];
    host.subscribe((event) => {
      if (event.kind === 'commandError') {
        errors.push({ commandId: event.commandId, message: event.message });
      }
    });
    host.send({ kind: 'newRun', commandId: 'c0', seed: 42n });
    host.runUntil(100n);

    host.send({ kind: 'rewindToTick', commandId: 'r1', tick: 500n });
    await host.flush();

    const err = errors.find((e) => e.commandId === 'r1');
    expect(err).toBeDefined();
    expect(err?.message).toMatch(/future tick/);
    expect(host.currentTick()).toBe(100n);
  });

  it('errors on rewinding without persistence', async () => {
    const host = new NodeHost({ heartbeatHz: 0 });
    const errors: { commandId: string; message: string }[] = [];
    host.subscribe((event) => {
      if (event.kind === 'commandError') {
        errors.push({ commandId: event.commandId, message: event.message });
      }
    });
    host.send({ kind: 'newRun', commandId: 'c0', seed: 42n });
    host.runUntil(100n);

    host.send({ kind: 'rewindToTick', commandId: 'r1', tick: 50n });
    await host.flush();

    const err = errors.find((e) => e.commandId === 'r1');
    expect(err).toBeDefined();
    expect(err?.message).toMatch(/no persistence/);
  });

  describe('rebuild-from-log fallback', () => {
    // Realises ARCHITECTURE.md "the seed plus the command log is the
    // canonical universe; snapshots are an implementation-defined
    // performance cache." When the snapshot is gone, the rewind path
    // reconstructs state by replaying the log from tick 0.

    it('rewinds when no snapshot file exists in the slot at all', async () => {
      const host = makeHost('no-snap-yet');
      host.send({ kind: 'newRun', commandId: 'c0', seed: 42n });
      host.runUntil(200n);
      await host.flush();

      // Nuke the snapshots directory entirely — simulate a full snap
      // wipeout while the log survives. Use the storage's host-level
      // helper so it works for the OPFS adapter too if this test ever
      // moves up to an integration layer.
      await storage.reapDirectory('runs/no-snap-yet/snapshots');

      // Rewind to tick 150. The log carries newRun(seed=42) plus the
      // post-tick-0 cmds (none here beyond newRun); rebuild-from-log
      // seeds createInitialState(42), then advanceWithYield runs the
      // sim forward to land on 150.
      host.send({ kind: 'rewindToTick', commandId: 'r1', tick: 150n });
      await host.flush();

      expect(host.currentTick()).toBe(150n);
      expect(host.isPaused()).toBe(true);
    });

    it('rewinds when the snap log entry exists but its file is missing', async () => {
      const host = makeHost('snap-file-missing');
      host.send({ kind: 'newRun', commandId: 'c0', seed: 42n });
      host.runUntil(200n);
      await host.flush();

      // Delete the tick-0 snap file but leave the snap LOG entry that
      // points at it. The rewind path's snap.read returns null;
      // fallback rebuilds from tick 0.
      await storage.delete('runs/snap-file-missing/snapshots/0.snap');

      host.send({ kind: 'rewindToTick', commandId: 'r1', tick: 100n });
      await host.flush();

      expect(host.currentTick()).toBe(100n);
      expect(host.isPaused()).toBe(true);
    });

    it('replays player commands after a rebuild-from-log path', async () => {
      const host = makeHost('rebuild-with-quarantine');
      host.send({ kind: 'newRun', commandId: 'c0', seed: 42n });
      host.runUntil(50n);
      host.send({ kind: 'quarantine', commandId: 'q1', lineageId: 'L0' });
      host.runUntil(150n);
      await host.flush();

      // Wipe the snapshots dir so the rewind has to rebuild.
      await storage.reapDirectory('runs/rebuild-with-quarantine/snapshots');

      // Rewind to tick 100 — strictly after the quarantine command.
      // The rebuild seeds at tick 0, the replay loop walks forward
      // re-issuing the quarantine when the loop reaches its tick, and
      // the quarantine is back in place at tick 100.
      host.send({ kind: 'rewindToTick', commandId: 'r1', tick: 100n });
      await host.flush();

      expect(host.currentTick()).toBe(100n);
      expect(host.quarantinedLineages().has('L0')).toBe(true);
      expect(host.isPaused()).toBe(true);
    });

    it('errors when log lacks a newRun command (rebuild has nothing to seed)', async () => {
      // Synthesise a malformed log: a snap entry pointing at a
      // missing file, but no newRun command anywhere. Rebuild can't
      // proceed — surface the error.
      const runId = 'rebuild-no-seed';
      await storage.write(
        `runs/${runId}/log.ndjson`,
        new TextEncoder().encode(
          JSON.stringify({
            type: 'snap',
            tick: '50',
            seq: 0,
            snapshotKey: `runs/${runId}/snapshots/50.snap`,
          }) + '\n',
        ),
      );

      const host = makeHost(runId);
      const errors: { commandId: string; message: string }[] = [];
      host.subscribe((event) => {
        if (event.kind === 'commandError') {
          errors.push({ commandId: event.commandId, message: event.message });
        }
      });
      // Need a state to even get into doRewindToTick. Issue newRun in
      // a separate slot so the host has state, then switch... actually
      // simpler: just newRun on this slot, which creates state and
      // appends a newRun command to the log. But that defeats the
      // test's premise. Instead: bootstrap state via an in-memory
      // newRun, then surgery the log to drop the newRun entry.
      host.send({ kind: 'newRun', commandId: 'c0', seed: 7n });
      host.runUntil(100n);
      await host.flush();
      // Surgery: rewrite the log without any newRun cmd entries, plus
      // the orphan snap entry from above. Real log got the newRun
      // appended; we strip it.
      await storage.write(
        `runs/${runId}/log.ndjson`,
        new TextEncoder().encode(
          JSON.stringify({
            type: 'snap',
            tick: '50',
            seq: 0,
            snapshotKey: `runs/${runId}/snapshots/missing-50.snap`,
          }) + '\n',
        ),
      );

      host.send({ kind: 'rewindToTick', commandId: 'r1', tick: 50n });
      await host.flush();

      const err = errors.find((e) => e.commandId === 'r1');
      expect(err).toBeDefined();
      expect(err?.message).toMatch(/lacks a newRun/);
    });
  });
});

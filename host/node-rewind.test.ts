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
});

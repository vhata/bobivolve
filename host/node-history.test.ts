import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { NodeHost } from './node.js';
import { NodeStorage } from './storage-node.js';
import { deserializeSnapshot } from './snapshot-codec.js';
import { INTERVENTION_FIRMWARE } from '../test/determinism/interventions.js';
import type { Command, SimEvent } from '../protocol/types.js';

// Several filesystem round trips share CI with the simulation suite. This
// checks state equivalence, not a five-second storage performance budget.
it('preserves complete intervention state through save, rewind, load and run switching', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bobivolve-history-'));
  try {
    const storage = new NodeStorage({ root });
    const host = new NodeHost({
      heartbeatHz: 0,
      persistence: { storage, runId: 'history', snapshotCadenceTicks: 10n },
    });
    const events: SimEvent[] = [];
    host.subscribe((event) => events.push(event));
    async function send(command: Command): Promise<void> {
      host.send(command);
      await host.flush();
      expect(events.filter((e) => e.kind === 'commandError')).toEqual([]);
      expect(events.some((e) => e.kind === 'commandAck' && e.commandId === command.commandId)).toBe(
        true,
      );
    }
    async function savedState(slot: string): Promise<Uint8Array> {
      await send({ kind: 'save', commandId: `save-${slot}`, slot });
      const bytes = await storage.read(`saves/${slot}.save`);
      expect(bytes).not.toBeNull();
      return bytes!;
    }
    await send({ kind: 'newRun', commandId: 'new', seed: 42n });
    host.runUntil(10n);
    await host.flush(); // snapshot at tick 10 precedes every intervention
    await send({
      kind: 'applyPatch',
      commandId: 'patch',
      lineageId: 'L0',
      firmware: INTERVENTION_FIRMWARE,
    });
    await send({ kind: 'quarantine', commandId: 'hold', lineageId: 'L0' });
    await send({
      kind: 'queueDecree',
      commandId: 'queue',
      trigger: { kind: 'populationBelow', lineageId: 'L0', threshold: '0' },
      patchTargetLineageId: 'L0',
      patchFirmware: INTERVENTION_FIRMWARE,
    });
    const expected = await savedState('checkpoint');
    const decoded = deserializeSnapshot(expected);
    expect(decoded.quarantinedLineages).toEqual(['L0']);
    expect(decoded.appliedPatches).toHaveLength(1);
    expect(decoded.queuedDecrees).toHaveLength(1);
    expect(decoded.originCompute).toBe(800n);

    host.runUntil(25n);
    await send({ kind: 'rewindToTick', commandId: 'rewind', tick: 10n });
    expect(await savedState('rewound')).toEqual(expected);

    await send({ kind: 'resume', commandId: 'resume' });
    host.runUntil(25n);
    const continued = await savedState('continued');
    await send({ kind: 'load', commandId: 'load', slot: 'checkpoint' });
    expect(await savedState('loaded')).toEqual(expected);
    await send({ kind: 'resume', commandId: 'resume-loaded' });
    host.runUntil(25n);
    expect(await savedState('continued-loaded')).toEqual(continued);

    await send({ kind: 'switchRun', commandId: 'away', runId: 'other' });
    await send({ kind: 'newRun', commandId: 'other-new', seed: 2026n });
    host.runUntil(5n);
    await send({ kind: 'switchRun', commandId: 'back', runId: 'history' });
    expect(host.isPaused()).toBe(true);
    expect(await savedState('switched')).toEqual(continued);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

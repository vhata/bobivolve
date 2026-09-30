import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../protocol/types.js';
import { reviveEvent } from '../transport/ndjson-codec.js';
import { NodeHost } from './node.js';
import { NodeStorage } from './storage-node.js';
import { EventLogReader } from './event-log.js';

function exhaust(host: NodeHost): void {
  for (let i = 0; i < 10; i++) {
    host.send({
      kind: 'applyPatch',
      commandId: `patch-${i.toString()}`,
      lineageId: 'L0',
      firmware: [
        { kind: 'gather', params: { rate: '2' } },
        { kind: 'explore', params: { threshold: (1n << 58n).toString() } },
        { kind: 'replicate', params: { threshold: '1000' } },
      ],
    });
  }
  host.send({ kind: 'quarantine', commandId: 'hold', lineageId: 'L0' });
}

const domain = (events: readonly SimEvent[]) =>
  events.filter(
    (event) => !['commandAck', 'tick', 'autoPaused'].includes(event.kind) && event.simTick > 0n,
  );

describe('exhausted quarantine persistence', () => {
  it('replays the same releases and continuation from save/load and rewind', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bobivolve-exhaustion-'));
    try {
      const storage = new NodeStorage({ root });
      const host = new NodeHost({ heartbeatHz: 0, persistence: { storage, runId: 'original' } });
      const events: SimEvent[] = [];
      host.subscribe((event) => events.push(event));
      host.send({ kind: 'newRun', commandId: 'new', seed: 42n });
      exhaust(host);
      host.send({ kind: 'save', commandId: 'save', slot: 'exhausted' });
      await host.flush();
      host.runUntil(10n);
      await host.flush();
      const expected = domain(events);
      expect(events.some((event) => event.kind === 'commandError')).toBe(false);
      expect(expected[0]).toEqual({
        kind: 'quarantineLifted',
        simTick: 1n,
        lineageId: 'L0',
        reason: 'computeExhausted',
      });
      expect(host.quarantinedLineages().size).toBe(0);
      const log = await new EventLogReader(storage, 'runs/original/log.ndjson').readAll();
      expect(
        log.filter((entry) => entry.type === 'ev' && entry.event.kind === 'quarantineLifted'),
      ).toHaveLength(1);
      expect(
        reviveEvent(
          JSON.parse(
            JSON.stringify(expected[0], (_key, value: unknown) =>
              typeof value === 'bigint' ? value.toString() : value,
            ),
          ),
        ),
      ).toEqual(expected[0]);

      const loaded = new NodeHost({ heartbeatHz: 0, persistence: { storage, runId: 'loaded' } });
      const loadedEvents: SimEvent[] = [];
      loaded.subscribe((event) => loadedEvents.push(event));
      loaded.send({ kind: 'load', commandId: 'load', slot: 'exhausted' });
      await loaded.flush();
      expect([...loaded.quarantinedLineages()]).toEqual(['L0']);
      loaded.send({ kind: 'resume', commandId: 'resume' });
      loaded.runUntil(10n);
      await loaded.flush();
      expect(domain(loadedEvents)).toEqual(expected);

      host.send({ kind: 'rewindToTick', commandId: 'rewind', tick: 0n });
      await host.flush();
      expect([...host.quarantinedLineages()]).toEqual(['L0']);
      events.length = 0;
      host.send({ kind: 'resume', commandId: 'resume' });
      host.runUntil(10n);
      await host.flush();
      expect(domain(events)).toEqual(expected);
      host.send({ kind: 'rewindToTick', commandId: 'rewind-after', tick: 1n });
      await host.flush();
      expect(host.quarantinedLineages().size).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([0, 4])(
    'delivers release and final budget before auto-pause at heartbeatHz %i',
    (heartbeatHz) => {
      const host = new NodeHost({ heartbeatHz, now: () => 0 });
      const events: SimEvent[] = [];
      host.subscribe((event) => events.push(event));
      host.send({ kind: 'newRun', commandId: 'new', seed: 42n });
      host.runUntil(7n);
      exhaust(host);
      host.send({
        kind: 'configureAutoPause',
        commandId: 'configure',
        enabledTriggers: ['speciation'],
      });
      events.length = 0;
      // Worker-like budgeted execution does not force a terminal heartbeat.
      host.runUntil(20n, 1000);
      expect(events[0]).toMatchObject({
        kind: 'quarantineLifted',
        simTick: 8n,
        reason: 'computeExhausted',
      });
      expect(events.at(-1)).toMatchObject({ kind: 'autoPaused', simTick: 8n });
      const heartbeats = events.filter((event) => event.kind === 'tick');
      if (heartbeatHz === 0) expect(heartbeats).toHaveLength(0);
      else expect(heartbeats).toMatchObject([{ simTick: 8n, originCompute: 1n, paused: true }]);
      expect(host.quarantinedLineages().size).toBe(0);
    },
  );
});

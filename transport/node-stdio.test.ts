// Cross-process NodeStdioTransport round-trip tests.
//
// Each test spawns a real child process, exercises a slice of the
// SimTransport surface, and tears down. Wall-clock pacing in the child
// (16ms pulse) means each test takes several hundred milliseconds at
// minimum — keep the suite lean.

import { describe, expect, it } from 'vitest';
import { NodeStdioTransport } from './node-stdio.js';
import type { Query, QueryResult, SimEvent } from '../protocol/types.js';

// Helper: wait for at least one event matching `predicate`, with a timeout.
// Resolves with the first matching event; rejects on timeout or transport
// error.
function waitForEvent(
  transport: NodeStdioTransport,
  predicate: (event: SimEvent) => boolean,
  timeoutMs: number,
): Promise<SimEvent> {
  return new Promise<SimEvent>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`waitForEvent: timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const unsubscribe = transport.onEvent((event) => {
      if (predicate(event)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(event);
      }
    });
  });
}

describe('NodeStdioTransport', () => {
  it('spawns a child, completes the ready handshake, and closes cleanly', async () => {
    const transport = new NodeStdioTransport();
    try {
      await transport.ready();
    } finally {
      transport.close();
    }
  }, 15_000);

  it('round-trips a command and observes tick events', async () => {
    const transport = new NodeStdioTransport();
    try {
      await transport.ready();
      transport.send({ kind: 'newRun', commandId: 'c0', seed: 42n });
      const tick = await waitForEvent(transport, (e) => e.kind === 'tick' && e.simTick > 0n, 5_000);
      expect(tick.kind).toBe('tick');
      expect(tick.simTick).toBeGreaterThan(0n);
    } finally {
      transport.close();
    }
  }, 15_000);

  it('round-trips a query and revives the bigint fields', async () => {
    const transport = new NodeStdioTransport();
    try {
      await transport.ready();
      transport.send({ kind: 'newRun', commandId: 'c0', seed: 42n });
      // Let at least one tick advance so populationHistory has something
      // meaningful in it.
      await waitForEvent(transport, (e) => e.kind === 'tick' && e.simTick > 0n, 5_000);
      const query: Query = { kind: 'lineageTree', queryId: 'q0' };
      const result: QueryResult = await transport.query(query);
      expect(result.kind).toBe('lineageTree');
      expect(result.queryId).toBe('q0');
      // newRun seeds the founder lineage; the tree must have at least it.
      if (result.kind !== 'lineageTree') throw new Error('unreachable');
      expect(result.lineages.length).toBeGreaterThanOrEqual(1);
      // Bigint revival: foundedAtTick on every entry must be a bigint, not
      // a string from the wire.
      for (const entry of result.lineages) {
        expect(typeof entry.foundedAtTick).toBe('bigint');
      }
    } finally {
      transport.close();
    }
  }, 15_000);
});

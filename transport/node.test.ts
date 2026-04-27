import { describe, expect, it } from 'vitest';
import { NodeTransport } from './node.js';
import type { Command, ReplicationEvent, SimEvent } from '../protocol/types.js';

// End-to-end transport contract tests. The transport is the sole surface the
// UI sees; the assertions below cover the SimTransport contract:
//   - send is fire-and-forget; commands are acknowledged via SimEvent.
//   - onEvent returns an unsubscribe; calling it stops the flow.
//   - Multiple subscribers see the same event stream.
//   - close detaches the transport from the host.
//
// The events asserted here are byte-for-byte deterministic — same seed, same
// tick budget, same sequence. This is the assertion that ARCHITECTURE.md's
// determinism golden will eventually formalize.

const SEED_42 = 42n;
const TICKS_3000 = 3000n;
// Total probes ever spawned (founder + every replication) for the
// seed=42, 3000-tick run under R1 metabolic mechanics on the
// procedural-systems substrate with the production FOUNDER_FIRMWARE.
// Some of these have since died, so this is not the live population.
const GOLDEN_TOTAL_SPAWNED_SEED_42 = 4054n;

function fakeClock(): () => number {
  let t = 0;
  return () => {
    t += 1;
    return t;
  };
}

describe('NodeTransport contract', () => {
  it('send + onEvent: commands are acknowledged via the event stream', () => {
    const transport = new NodeTransport({ now: fakeClock(), heartbeatHz: 0 });
    const events: SimEvent[] = [];
    transport.onEvent((e) => events.push(e));

    const cmd: Command = { kind: 'newRun', commandId: 'cmd-1', seed: SEED_42 };
    transport.send(cmd);

    const ack = events.find((e) => e.kind === 'commandAck');
    expect(ack).toBeDefined();
    if (ack?.kind === 'commandAck') {
      expect(ack.commandId).toBe('cmd-1');
    }
    transport.close();
  });

  it('onEvent unsubscribe stops further deliveries to that handler', () => {
    const transport = new NodeTransport({ now: fakeClock(), heartbeatHz: 0 });
    const seen: SimEvent[] = [];
    const unsubscribe = transport.onEvent((e) => seen.push(e));
    transport.send({ kind: 'newRun', commandId: 'a', seed: SEED_42 });
    const beforeUnsub = seen.length;
    expect(beforeUnsub).toBeGreaterThan(0);
    unsubscribe();
    transport.send({ kind: 'pause', commandId: 'b' });
    expect(seen.length).toBe(beforeUnsub);
    transport.close();
  });

  it('multiple subscribers see the same events', () => {
    const transport = new NodeTransport({ now: fakeClock(), heartbeatHz: 0 });
    const a: SimEvent[] = [];
    const b: SimEvent[] = [];
    transport.onEvent((e) => a.push(e));
    transport.onEvent((e) => b.push(e));
    transport.send({ kind: 'newRun', commandId: 'x', seed: SEED_42 });
    transport.getHost().runUntil(50n);
    expect(a.length).toBe(b.length);
    expect(a.length).toBeGreaterThan(0);
    transport.close();
  });

  it('close prevents further send / onEvent / query calls', () => {
    const transport = new NodeTransport({ now: fakeClock(), heartbeatHz: 0 });
    transport.close();
    expect(() => transport.send({ kind: 'pause', commandId: '' })).toThrow();
    expect(() => transport.onEvent(() => undefined)).toThrow();
    return expect(transport.query({ kind: 'lineageTree', queryId: 'q1' })).rejects.toThrow();
  });

  it('produces a deterministic replication sequence for seed=42, ticks=3000', () => {
    function run(): readonly (ReplicationEvent & { simTick: bigint })[] {
      const transport = new NodeTransport({ now: fakeClock(), heartbeatHz: 0 });
      const events: SimEvent[] = [];
      transport.onEvent((e) => events.push(e));
      transport.send({ kind: 'newRun', commandId: '', seed: SEED_42 });
      transport.getHost().runUntil(TICKS_3000);
      transport.close();
      return events.filter(
        (e): e is ReplicationEvent & { simTick: bigint } => e.kind === 'replication',
      );
    }
    const a = run();
    const b = run();
    // Two runs with the same seed produce identical event streams. The
    // production determinism golden will assert this against a checked-in
    // file; here we assert the property without committing the file.
    expect(a).toEqual(b);
    expect(BigInt(a.length) + 1n).toBe(GOLDEN_TOTAL_SPAWNED_SEED_42);
  });

  it('different seeds produce different replication streams', () => {
    // Compare event sequences, not just counts: two seeds may coincidentally
    // produce the same number of replications by tick TICKS_3000 while their
    // birth ticks and child ids differ.
    function streamFor(seed: bigint): readonly (ReplicationEvent & { simTick: bigint })[] {
      const transport = new NodeTransport({ now: fakeClock(), heartbeatHz: 0 });
      const events: SimEvent[] = [];
      transport.onEvent((e) => events.push(e));
      transport.send({ kind: 'newRun', commandId: '', seed });
      transport.getHost().runUntil(TICKS_3000);
      transport.close();
      return events.filter(
        (e): e is ReplicationEvent & { simTick: bigint } => e.kind === 'replication',
      );
    }
    expect(streamFor(1n)).not.toEqual(streamFor(2n));
  });
});

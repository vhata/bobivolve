import { describe, expect, it, vi } from 'vitest';
import { NodeHost } from './node.js';
import type { Command, ReplicationEvent, SimEvent, TickEvent } from '../protocol/types.js';

// Host-level tests. Verify that the run-loop wires the sim/UI seam end-to-end:
//   - Commands are acknowledged.
//   - Replication events appear as new probes are minted.
//   - Tick heartbeats carry the population summary the UI needs.
//
// The host is the piece ARCHITECTURE.md flags as the legitimate place for
// wall-clock APIs; tests inject a deterministic clock so the heartbeat
// cadence is observable without flakiness.

// Test fixture matching sim/step.test.ts's TEST_FIRMWARE — same default in
// sim/directive.ts (FOUNDER_FIRMWARE), so we can lock golden numbers against
// the existing sim-level golden.
const SEED_42 = 42n;
const TICKS_3000 = 3000n;
// Live population at end of run, FOUNDER_FIRMWARE (gather + explore +
// replicate). Probes spread across the lattice, so per-cell carrying
// capacity multiplies into a much larger global figure than the
// no-explore TEST_FIRMWARE in sim/step.test.ts.
const GOLDEN_LIVE_POP_SEED_42 = 968n;
// Total probes ever spawned across the same run.
const GOLDEN_TOTAL_SPAWNED_SEED_42 = 6480n;

function makeFakeClock(): () => number {
  // Returns a clock whose readings advance by 1ms per call, deterministically.
  // Heartbeat cadence becomes a function of call count rather than wall time.
  let now = 0;
  return () => {
    now += 1;
    return now;
  };
}

function collectEvents(host: NodeHost): { events: SimEvent[]; unsubscribe: () => void } {
  const events: SimEvent[] = [];
  const unsubscribe = host.subscribe((e) => {
    events.push(e);
  });
  return { events, unsubscribe };
}

describe('NodeHost commands', () => {
  it('acks newRun and stamps commandAck with the provided commandId', () => {
    const host = new NodeHost({ now: makeFakeClock(), heartbeatHz: 0 });
    const { events } = collectEvents(host);

    const cmd: Command = { kind: 'newRun', commandId: 'cmd-1', seed: SEED_42 };
    host.send(cmd);

    const ack = events.find((e) => e.kind === 'commandAck');
    expect(ack).toBeDefined();
    if (ack?.kind === 'commandAck') {
      expect(ack.commandId).toBe('cmd-1');
    }
  });

  it('does not emit an ack when commandId is empty', () => {
    const host = new NodeHost({ now: makeFakeClock(), heartbeatHz: 0 });
    const { events } = collectEvents(host);
    host.send({ kind: 'newRun', commandId: '', seed: SEED_42 });
    expect(events.find((e) => e.kind === 'commandAck')).toBeUndefined();
  });

  it('reports an error when step is sent before newRun', () => {
    const host = new NodeHost({ now: makeFakeClock(), heartbeatHz: 0 });
    const { events } = collectEvents(host);
    host.send({ kind: 'step', commandId: 'cmd-step', ticks: 1n });
    const err = events.find((e) => e.kind === 'commandError');
    expect(err).toBeDefined();
    if (err?.kind === 'commandError') {
      expect(err.commandId).toBe('cmd-step');
      expect(err.message).toMatch(/newRun/);
    }
  });

  it('rejects setSpeed values outside the allowed set', () => {
    const host = new NodeHost({ now: makeFakeClock(), heartbeatHz: 0 });
    const { events } = collectEvents(host);
    host.send({ kind: 'newRun', commandId: '', seed: SEED_42 });
    host.send({ kind: 'setSpeed', commandId: 'cmd-speed', speed: 7 });
    const err = events.find((e) => e.kind === 'commandError' && e.commandId === 'cmd-speed');
    expect(err).toBeDefined();
  });

  it('accepts setSpeed values in the allowed set', () => {
    const host = new NodeHost({ now: makeFakeClock(), heartbeatHz: 0 });
    const { events } = collectEvents(host);
    host.send({ kind: 'newRun', commandId: '', seed: SEED_42 });
    for (const speed of [1, 4, 16, 64] as const) {
      host.send({ kind: 'setSpeed', commandId: `cmd-speed-${speed}`, speed });
    }
    const acks = events.filter(
      (e) => e.kind === 'commandAck' && e.commandId.startsWith('cmd-speed-'),
    );
    expect(acks).toHaveLength(4);
  });
});

describe('NodeHost replication events', () => {
  it('emits a replication event for each new probe minted', () => {
    const host = new NodeHost({ now: makeFakeClock(), heartbeatHz: 0 });
    const { events } = collectEvents(host);
    host.send({ kind: 'newRun', commandId: '', seed: SEED_42 });
    host.runUntil(TICKS_3000);

    const replications = events.filter(
      (e): e is ReplicationEvent & { simTick: bigint } => e.kind === 'replication',
    );
    // Founder + every replication = total ever spawned. Some have died
    // by tick 3000 under R1 metabolism, so the live population is lower.
    expect(BigInt(replications.length) + 1n).toBe(GOLDEN_TOTAL_SPAWNED_SEED_42);

    // Every replication event names a well-formed probe id and a
    // well-formed lineage id (children of speciating parents land in
    // a new lineage, so the id is no longer always L0).
    for (const e of replications) {
      expect(e.childProbeId).toMatch(/^P\d+$/);
      expect(e.lineageId).toMatch(/^L\d+$/);
    }
  });

  it('replication events appear in monotonic sim-tick order', () => {
    const host = new NodeHost({ now: makeFakeClock(), heartbeatHz: 0 });
    const { events } = collectEvents(host);
    host.send({ kind: 'newRun', commandId: '', seed: SEED_42 });
    host.runUntil(TICKS_3000);

    const replications = events.filter((e) => e.kind === 'replication');
    let last = 0n;
    for (const e of replications) {
      expect(e.simTick >= last).toBe(true);
      last = e.simTick;
    }
  });

  it('two runs with the same seed produce identical replication event sequences', () => {
    function run(): SimEvent[] {
      const host = new NodeHost({ now: makeFakeClock(), heartbeatHz: 0 });
      const { events } = collectEvents(host);
      host.send({ kind: 'newRun', commandId: '', seed: SEED_42 });
      host.runUntil(TICKS_3000);
      return events.filter((e) => e.kind === 'replication');
    }
    expect(run()).toEqual(run());
  });
});

describe('NodeHost heartbeat', () => {
  it('emits a final tick heartbeat after runUntil completes', () => {
    const host = new NodeHost({ now: makeFakeClock(), heartbeatHz: 60 });
    const { events } = collectEvents(host);
    host.send({ kind: 'newRun', commandId: '', seed: SEED_42 });
    host.runUntil(100n);

    const heartbeats = events.filter(
      (e): e is TickEvent & { simTick: bigint } => e.kind === 'tick',
    );
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);
    const last = heartbeats[heartbeats.length - 1];
    expect(last?.simTick).toBe(100n);
    // Population is summarised in the heartbeat.
    expect(typeof last?.populationTotal).toBe('bigint');
  });

  it('suppresses heartbeats when heartbeatHz is 0', () => {
    const host = new NodeHost({ now: makeFakeClock(), heartbeatHz: 0 });
    const { events } = collectEvents(host);
    host.send({ kind: 'newRun', commandId: '', seed: SEED_42 });
    host.runUntil(100n);
    expect(events.find((e) => e.kind === 'tick')).toBeUndefined();
  });

  it('heartbeat carries population_by_lineage entries that sum to populationTotal', () => {
    const host = new NodeHost({ now: makeFakeClock(), heartbeatHz: 60 });
    const { events } = collectEvents(host);
    host.send({ kind: 'newRun', commandId: '', seed: SEED_42 });
    host.runUntil(TICKS_3000);

    const heartbeats = events.filter(
      (e): e is TickEvent & { simTick: bigint } => e.kind === 'tick',
    );
    const last = heartbeats[heartbeats.length - 1];
    expect(last).toBeDefined();
    if (last !== undefined) {
      let sum = 0n;
      for (const v of Object.values(last.populationByLineage)) sum += v;
      expect(sum).toBe(last.populationTotal);
      expect(last.populationTotal).toBe(GOLDEN_LIVE_POP_SEED_42);
    }
  });
});

describe('NodeHost pause / resume / step', () => {
  it('paused state suppresses runUntil progress', () => {
    const host = new NodeHost({ now: makeFakeClock(), heartbeatHz: 0 });
    host.send({ kind: 'newRun', commandId: '', seed: SEED_42 });
    host.send({ kind: 'pause', commandId: '' });
    host.runUntil(100n);
    expect(host.currentTick()).toBe(0n);
  });

  it('resume re-enables progress', () => {
    const host = new NodeHost({ now: makeFakeClock(), heartbeatHz: 0 });
    host.send({ kind: 'newRun', commandId: '', seed: SEED_42 });
    host.send({ kind: 'pause', commandId: '' });
    host.runUntil(100n);
    host.send({ kind: 'resume', commandId: '' });
    host.runUntil(100n);
    expect(host.currentTick()).toBe(100n);
  });

  it('step advances even when paused', () => {
    const host = new NodeHost({ now: makeFakeClock(), heartbeatHz: 0 });
    host.send({ kind: 'newRun', commandId: '', seed: SEED_42 });
    host.send({ kind: 'pause', commandId: '' });
    host.send({ kind: 'step', commandId: '', ticks: 5n });
    expect(host.currentTick()).toBe(5n);
  });

  it('step ticks=0 advances by one (proto3 contract)', () => {
    const host = new NodeHost({ now: makeFakeClock(), heartbeatHz: 0 });
    host.send({ kind: 'newRun', commandId: '', seed: SEED_42 });
    host.send({ kind: 'pause', commandId: '' });
    host.send({ kind: 'step', commandId: '', ticks: 0n });
    expect(host.currentTick()).toBe(1n);
  });
});

describe('NodeHost listener safety', () => {
  it('a throwing listener does not bring down the run-loop or other listeners', () => {
    const host = new NodeHost({ now: makeFakeClock(), heartbeatHz: 0 });
    const seen: string[] = [];
    // The host logs the listener error to stderr; suppress it so the test
    // run is quiet. The behaviour we're asserting is that the run continues.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    host.subscribe(() => {
      throw new Error('boom');
    });
    host.subscribe((e) => seen.push(e.kind));
    host.send({ kind: 'newRun', commandId: 'x', seed: SEED_42 });
    host.runUntil(50n);
    // Other listener still saw events; runUntil did not throw.
    expect(seen).toContain('commandAck');
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

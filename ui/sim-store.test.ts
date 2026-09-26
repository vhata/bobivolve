import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command, Query, QueryResult, SimEvent } from '../protocol/types.js';
import type { SimTransport } from '../transport/types.js';
import { useSimStore } from './sim-store.js';
import type { LineageNode } from './sim-store.js';
import { readAncestryPins, writeAncestryPins } from './ancestry-groups.js';

class StubTransport implements SimTransport {
  sent: Command[] = [];
  listener: ((event: SimEvent) => void) | null = null;
  send(command: Command): void {
    this.sent.push(command);
  }
  onEvent(listener: (event: SimEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }
  queryResult: Promise<QueryResult> | null = null;
  queryHandler: ((query: Query) => Promise<QueryResult>) | null = null;
  query(_query: Query): Promise<QueryResult> {
    if (this.queryHandler !== null) return this.queryHandler(_query);
    if (this.queryResult === null) throw new Error('unused');
    return this.queryResult;
  }
  close(): void {}
  emit(event: SimEvent): void {
    this.listener?.(event);
  }
}

beforeEach(() => {
  useSimStore.getState().detach();
  useSimStore.setState(useSimStore.getInitialState(), true);
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});

afterEach(() => {
  useSimStore.getState().detach();
  vi.unstubAllGlobals();
});

let nextRun = 0;
function lineage(id = 'L0', foundedAtTick = 0n, parentId: string | null = null): LineageNode {
  return {
    id,
    name: `Genetic ${id}`,
    parentId,
    foundedAtTick,
    founderProbeId: `P${id}`,
    extinctionTick: null,
  };
}

function treeResult(nodes: readonly LineageNode[]): QueryResult {
  return {
    kind: 'lineageTree',
    queryId: '',
    lineages: nodes.map((node) => ({
      ...node,
      parentLineageId: node.parentId ?? '',
      patches: [],
      quarantined: false,
    })),
  };
}

function ancestryFixture() {
  const runId = `ancestry-${nextRun++}`;
  const host = { activeRunId: runId, nodes: [lineage()] };
  const transport = new StubTransport();
  transport.queryHandler = async (query) => {
    if (query.kind === 'lineageTree') return treeResult(host.nodes);
    if (query.kind === 'listRuns')
      return {
        kind: 'listRuns',
        queryId: '',
        activeRunId: host.activeRunId,
        runs: [{ runId: host.activeRunId, latestTick: '100', lastModifiedMs: 1 }],
      };
    throw new Error(`Unexpected ${query.kind} query`);
  };
  useSimStore.getState().attach(transport);
  const complete = (success = true, tick = 100n): void => {
    const command = transport.sent.at(-1);
    if (command === undefined) throw new Error('No command to complete');
    transport.emit(
      success
        ? { kind: 'commandAck', commandId: command.commandId, simTick: tick }
        : {
            kind: 'commandError',
            commandId: command.commandId,
            simTick: tick,
            message: 'storage unavailable',
          },
    );
  };
  const ready = async (): Promise<void> => {
    await vi.waitFor(() => expect(useSimStore.getState().ancestryPinsReady).toBe(true));
  };
  return { runId, host, transport, complete, ready };
}

describe('ancestry group state and lifecycle', () => {
  it.each(['bootstrap', 'switch'] as const)(
    'keeps stored roots when rewind is requested during %s hydration',
    async (transition) => {
      const fixture = ancestryFixture();
      const targetRun = transition === 'switch' ? `${fixture.runId}-other` : fixture.runId;
      writeAncestryPins(targetRun, [
        {
          rootId: 'L0',
          name: 'Remembered root',
          color: 'oklch(0.72 0.13 10)',
          foundedAtTick: 0n,
          founderProbeId: 'PL0',
        },
      ]);
      if (transition === 'switch') await useSimStore.getState().bootstrapRun();
      const query = fixture.transport.queryHandler!;
      let resolveTree!: (result: QueryResult) => void;
      fixture.transport.queryHandler = (request) =>
        request.kind === 'lineageTree'
          ? new Promise((resolve) => {
              resolveTree = resolve;
            })
          : query(request);
      let bootstrap: Promise<void> | undefined;
      if (transition === 'switch') {
        useSimStore.getState().switchRun(targetRun);
        fixture.host.activeRunId = targetRun;
        fixture.complete();
      } else bootstrap = useSimStore.getState().bootstrapRun();
      await vi.waitFor(() => expect(resolveTree).toBeTypeOf('function'));
      const sentBefore = fixture.transport.sent.length;
      useSimStore.getState().rewindToTick(0n);
      expect(fixture.transport.sent).toHaveLength(sentBefore);
      expect(useSimStore.getState().commandError).toContain('Wait for ancestry');
      expect(readAncestryPins(targetRun).pins[0]?.name).toBe('Remembered root');
      resolveTree(treeResult([lineage()]));
      await bootstrap;
      await fixture.ready();
      expect(useSimStore.getState().ancestryPins[0]?.name).toBe('Remembered root');
      fixture.transport.queryHandler = query;
      useSimStore.getState().rewindToTick(0n);
      fixture.complete(true, 0n);
      await fixture.ready();
      expect(useSimStore.getState().ancestryPins[0]?.name).toBe('Remembered root');
    },
  );

  it('captures names and colors, limits pins, and never renames genetic lineages', async () => {
    const fixture = ancestryFixture();
    fixture.host.nodes = Array.from({ length: 7 }, (_, index) => lineage(`L${index}`));
    await useSimStore.getState().bootstrapRun();
    for (let index = 0; index < 6; index += 1)
      expect(useSimStore.getState().pinAncestry(`L${index}`)).toBeNull();
    const colors = new Map(
      useSimStore.getState().ancestryPins.map((pin) => [pin.rootId, pin.color]),
    );
    expect(new Set(colors.values()).size).toBe(6);
    expect(useSimStore.getState().pinAncestry('L6')).toContain('6');
    const captured = useSimStore.getState().ancestryPins[0];
    expect(useSimStore.getState().renameAncestry('L0', '  Watchful descendants  ')).toBeNull();
    expect(useSimStore.getState().ancestryPins[0]).toMatchObject({
      name: 'Watchful descendants',
      color: captured?.color,
    });
    expect(useSimStore.getState().lineages.get('L0')?.name).toBe('Genetic L0');
    expect(useSimStore.getState().renameAncestry('L0', 'x'.repeat(41))).not.toBeNull();
    expect(useSimStore.getState().renameAncestry('L0', '   ')).not.toBeNull();
    useSimStore.getState().unpinAncestry('L1');
    expect(useSimStore.getState().pinAncestry('L6')).toBeNull();
    for (const pin of useSimStore.getState().ancestryPins) {
      expect(pin.color).toBe(colors.get(pin.rootId === 'L6' ? 'L1' : pin.rootId));
    }
    expect(readAncestryPins(fixture.runId).pins).toEqual(useSimStore.getState().ancestryPins);
  });

  it('restores browser pins at bootstrap and keeps run namespaces separate', async () => {
    const fixture = ancestryFixture();
    writeAncestryPins(fixture.runId, [
      {
        rootId: 'L0',
        name: 'Remembered',
        color: 'oklch(0.72 0.13 10)',
        foundedAtTick: 0n,
        founderProbeId: 'PL0',
      },
    ]);
    await useSimStore.getState().bootstrapRun();
    expect(useSimStore.getState().ancestryPins[0]?.name).toBe('Remembered');
    useSimStore.getState().switchRun(`${fixture.runId}-other`);
    expect(useSimStore.getState().ancestryPins).toEqual([]);
    expect(useSimStore.getState().pinAncestry('L0')).not.toBeNull();
    fixture.host.activeRunId = `${fixture.runId}-other`;
    fixture.complete();
    await fixture.ready();
    expect(useSimStore.getState().ancestryPins).toEqual([]);
    useSimStore.getState().pinAncestry('L0');
    useSimStore.getState().renameAncestry('L0', 'Other run');
    useSimStore.getState().switchRun(fixture.runId);
    fixture.host.activeRunId = fixture.runId;
    fixture.complete();
    await fixture.ready();
    expect(useSimStore.getState().ancestryPins[0]?.name).toBe('Remembered');
  });

  it.each(['new', 'load', 'switch', 'rewind'] as const)(
    'retains previous pins and namespace when %s fails',
    async (kind) => {
      const fixture = ancestryFixture();
      await useSimStore.getState().bootstrapRun();
      useSimStore.getState().pinAncestry('L0');
      const pins = useSimStore.getState().ancestryPins;
      if (kind === 'new') useSimStore.getState().startRun(99n);
      if (kind === 'load') useSimStore.getState().load('foreign');
      if (kind === 'switch') useSimStore.getState().switchRun('unreachable');
      if (kind === 'rewind') useSimStore.getState().rewindToTick(0n);
      expect(useSimStore.getState().ancestryPinsReady).toBe(false);
      expect(readAncestryPins(fixture.runId).pins).toEqual(pins);
      fixture.complete(false);
      await fixture.ready();
      expect(useSimStore.getState().activeRunId).toBe(fixture.runId);
      expect(useSimStore.getState().ancestryPins).toEqual(pins);
      expect(useSimStore.getState().lineages.get('L0')?.name).toBe('Genetic L0');
      expect(readAncestryPins('unreachable').pins).toEqual([]);
    },
  );

  it.each(['new', 'load'] as const)(
    'clears pins only after successful %s even with identical recycled lineage IDs',
    async (kind) => {
      const fixture = ancestryFixture();
      await useSimStore.getState().bootstrapRun();
      useSimStore.getState().pinAncestry('L0');
      if (kind === 'new') useSimStore.getState().startRun(99n);
      else useSimStore.getState().load('foreign');
      expect(readAncestryPins(fixture.runId).pins).toHaveLength(1);
      fixture.complete();
      await fixture.ready();
      expect(useSimStore.getState().ancestryPins).toEqual([]);
      expect(readAncestryPins(fixture.runId).pins).toEqual([]);
    },
  );

  it('retains existing roots on rewind but permanently drops future roots before their IDs can reappear', async () => {
    const fixture = ancestryFixture();
    fixture.host.nodes = [lineage(), lineage('L1', 20n, 'L0')];
    await useSimStore.getState().bootstrapRun();
    useSimStore.getState().pinAncestry('L0');
    useSimStore.getState().pinAncestry('L1');
    useSimStore.getState().rewindToTick(10n);
    expect(readAncestryPins(fixture.runId).pins).toHaveLength(2);
    // Even a later tree that already contains the recreated future root cannot
    // revive its pin; success first clips metadata to the acknowledged endpoint.
    fixture.complete(true, 10n);
    await fixture.ready();
    expect(useSimStore.getState().ancestryPins.map((pin) => pin.rootId)).toEqual(['L0']);
    expect(readAncestryPins(fixture.runId).pins.map((pin) => pin.rootId)).toEqual(['L0']);
  });

  it('exposes hydration failures and supports retry without discarding saved pins', async () => {
    const fixture = ancestryFixture();
    writeAncestryPins(fixture.runId, [
      {
        rootId: 'L0',
        name: 'Remembered',
        color: 'oklch(0.72 0.13 10)',
        foundedAtTick: 0n,
        founderProbeId: 'PL0',
      },
    ]);
    const query = fixture.transport.queryHandler!;
    fixture.transport.queryHandler = (request) =>
      request.kind === 'lineageTree'
        ? Promise.reject(new Error('temporary failure'))
        : query(request);
    await useSimStore.getState().bootstrapRun();
    expect(useSimStore.getState().ancestryPinsReady).toBe(false);
    expect(useSimStore.getState().ancestryRestoreError).toContain('Retry');
    expect(readAncestryPins(fixture.runId).pins).toHaveLength(1);
    fixture.transport.queryHandler = query;
    await useSimStore.getState().rehydrateAfterLoad();
    expect(useSimStore.getState().ancestryRestoreError).toBeNull();
    expect(useSimStore.getState().ancestryPins[0]?.name).toBe('Remembered');
  });

  it('continues with session pins when browser storage cannot be read or written', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    });
    const fixture = ancestryFixture();
    await useSimStore.getState().bootstrapRun();
    expect(useSimStore.getState().pinAncestry('L0')).toBeNull();
    expect(useSimStore.getState().ancestryPinStorageError).toContain('session');
    useSimStore.getState().switchRun(`${fixture.runId}-other`);
    fixture.host.activeRunId = `${fixture.runId}-other`;
    fixture.complete();
    await fixture.ready();
    useSimStore.getState().switchRun(fixture.runId);
    fixture.host.activeRunId = fixture.runId;
    fixture.complete();
    await fixture.ready();
    expect(useSimStore.getState().ancestryPins).toHaveLength(1);
  });

  it('cleans deleted run metadata only after acknowledgement, including cached pins', async () => {
    const fixture = ancestryFixture();
    await useSimStore.getState().bootstrapRun();
    useSimStore.getState().pinAncestry('L0');
    useSimStore.getState().switchRun(`${fixture.runId}-other`);
    fixture.host.activeRunId = `${fixture.runId}-other`;
    fixture.complete();
    await fixture.ready();
    useSimStore.getState().deleteRun(fixture.runId);
    fixture.complete(false);
    expect(readAncestryPins(fixture.runId).pins).toHaveLength(1);
    useSimStore.getState().deleteRun(fixture.runId);
    fixture.complete();
    expect(readAncestryPins(fixture.runId).pins).toEqual([]);
    useSimStore.getState().switchRun(fixture.runId);
    fixture.host.activeRunId = fixture.runId;
    fixture.complete();
    await fixture.ready();
    expect(useSimStore.getState().ancestryPins).toEqual([]);
  });

  it('preserves speciation and extinction events arriving while lineage hydration is pending', async () => {
    const fixture = ancestryFixture();
    await useSimStore.getState().bootstrapRun();
    let resolve!: (result: QueryResult) => void;
    fixture.transport.queryHandler = () =>
      new Promise((done) => {
        resolve = done;
      });
    const hydration = useSimStore.getState().rehydrateAfterLoad();
    fixture.transport.emit({
      kind: 'speciation',
      simTick: 101n,
      newLineageId: 'L1',
      newLineageName: 'New child',
      parentLineageId: 'L0',
      founderProbeId: 'P1',
    });
    fixture.transport.emit({ kind: 'extinction', simTick: 102n, lineageId: 'L0' });
    resolve(treeResult([lineage()]));
    await hydration;
    expect(useSimStore.getState().lineages.get('L1')?.name).toBe('New child');
    expect(useSimStore.getState().lineages.get('L0')?.extinctionTick).toBe(102n);
  });

  it('ignores old transport hydration and does not reuse its active run namespace', async () => {
    const fixture = ancestryFixture();
    await useSimStore.getState().bootstrapRun();
    useSimStore.getState().pinAncestry('L0');
    let resolve!: (result: QueryResult) => void;
    fixture.transport.queryHandler = () =>
      new Promise((done) => {
        resolve = done;
      });
    const oldHydration = useSimStore.getState().rehydrateAfterLoad();
    const next = ancestryFixture();
    expect(useSimStore.getState().activeRunId).toBe('');
    await useSimStore.getState().rehydrateAfterLoad();
    resolve(treeResult([lineage('old-only')]));
    await oldHydration;
    expect(useSimStore.getState().activeRunId).toBe(next.runId);
    expect(useSimStore.getState().ancestryPins).toEqual([]);
    expect(useSimStore.getState().lineages.has('old-only')).toBe(false);
  });

  it('ignores stale run listings after a successful switch', async () => {
    const fixture = ancestryFixture();
    await useSimStore.getState().bootstrapRun();
    const query = fixture.transport.queryHandler!;
    let resolve!: (result: QueryResult) => void;
    fixture.transport.queryHandler = (request) =>
      request.kind === 'listRuns'
        ? new Promise((done) => {
            resolve = done;
          })
        : query(request);
    const listing = useSimStore.getState().refreshRuns();
    useSimStore.getState().switchRun(`${fixture.runId}-other`);
    fixture.host.activeRunId = `${fixture.runId}-other`;
    fixture.complete();
    await fixture.ready();
    resolve({ kind: 'listRuns', queryId: '', activeRunId: fixture.runId, runs: [] });
    await listing;
    expect(useSimStore.getState().activeRunId).toBe(`${fixture.runId}-other`);
  });

  it('drops a queued heartbeat when replacing the transport', async () => {
    let queued: FrameRequestCallback | null = null;
    const cancel = vi.fn();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      queued = callback;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', cancel);
    const fixture = ancestryFixture();
    await useSimStore.getState().bootstrapRun();
    fixture.transport.emit({
      kind: 'tick',
      simTick: 900n,
      populationTotal: 500n,
      populationByLineage: { L0: 500n },
      actualSpeed: 1,
      originCompute: 0n,
      originComputeMax: 100n,
      paused: false,
      speed: 1,
    });
    const next = ancestryFixture();
    await useSimStore.getState().bootstrapRun();
    expect(cancel).toHaveBeenCalledWith(1);
    // A callback already taken off the browser queue is harmless as well.
    const callback = queued as FrameRequestCallback | null;
    callback?.(0);
    expect(useSimStore.getState().activeRunId).toBe(next.runId);
    expect(useSimStore.getState().populationTotal).not.toBe(500n);
    expect(useSimStore.getState().simTick).not.toBe(900n);
  });

  it('clips persisted future pins even when post-rewind hydration fails', async () => {
    const fixture = ancestryFixture();
    fixture.host.nodes = [lineage(), lineage('L1', 20n, 'L0')];
    await useSimStore.getState().bootstrapRun();
    useSimStore.getState().pinAncestry('L0');
    useSimStore.getState().pinAncestry('L1');
    fixture.transport.queryHandler = () => Promise.reject(new Error('temporarily unavailable'));
    useSimStore.getState().rewindToTick(10n);
    fixture.complete(true, 10n);
    await vi.waitFor(() => expect(useSimStore.getState().ancestryRestoreError).not.toBeNull());
    expect(readAncestryPins(fixture.runId).pins.map((pin) => pin.rootId)).toEqual(['L0']);
  });

  it('keeps the newest hydration when replies from the same timeline arrive out of order', async () => {
    const fixture = ancestryFixture();
    await useSimStore.getState().bootstrapRun();
    const resolvers: ((result: QueryResult) => void)[] = [];
    fixture.transport.queryHandler = () =>
      new Promise((done) => {
        resolvers.push(done);
      });
    const first = useSimStore.getState().rehydrateAfterLoad();
    const second = useSimStore.getState().rehydrateAfterLoad();
    resolvers[1]?.(treeResult([{ ...lineage(), name: 'Latest' }]));
    await second;
    resolvers[0]?.(treeResult([{ ...lineage(), name: 'Stale' }]));
    await first;
    expect(useSimStore.getState().lineages.get('L0')?.name).toBe('Latest');
  });

  it('prevents overlapping run changes from replacing the pending pin namespace', async () => {
    const fixture = ancestryFixture();
    await useSimStore.getState().bootstrapRun();
    useSimStore.getState().pinAncestry('L0');
    useSimStore.getState().switchRun(`${fixture.runId}-other`);
    useSimStore.getState().startRun(99n);
    expect(fixture.transport.sent.map((command) => command.kind)).toEqual(['switchRun']);
    fixture.complete(false);
    expect(useSimStore.getState().activeRunId).toBe(fixture.runId);
    expect(useSimStore.getState().ancestryPins).toHaveLength(1);
  });

  it('ignores malformed saved metadata without breaking bootstrap', async () => {
    const fixture = ancestryFixture();
    localStorage.setItem(
      `bobivolve:ancestry-pins:v1:${encodeURIComponent(fixture.runId)}`,
      '{broken',
    );
    await useSimStore.getState().bootstrapRun();
    expect(useSimStore.getState().ancestryPinsReady).toBe(true);
    expect(useSimStore.getState().ancestryPins).toEqual([]);
    expect(useSimStore.getState().pinAncestry('L0')).toBeNull();
    expect(readAncestryPins(fixture.runId).pins).toHaveLength(1);
  });
});

describe('intervention command feedback', () => {
  it('waits for acknowledgement and exposes a rejection for the player', async () => {
    const transport = new StubTransport();
    useSimStore.getState().attach(transport);
    const reply = useSimStore
      .getState()
      .applyPatch('L0', [{ kind: 'gather', params: { rate: '5' } }]);
    const command = transport.sent[0];
    expect(command?.kind).toBe('applyPatch');
    if (command === undefined) throw new Error('missing command');
    transport.emit({
      kind: 'commandError',
      simTick: 0n,
      commandId: command.commandId,
      message: 'insufficient Origin compute',
    });
    await expect(reply).resolves.toBe('insufficient Origin compute');
    expect(useSimStore.getState().commandError).toBe('insufficient Origin compute');
    useSimStore.getState().dismissCommandError();
    expect(useSimStore.getState().commandError).toBeNull();
  });

  it('completes a decree only after its acknowledgement', async () => {
    const transport = new StubTransport();
    useSimStore.getState().attach(transport);
    const reply = useSimStore
      .getState()
      .queueDecree({ kind: 'populationBelow', lineageId: 'L0', threshold: '10' }, 'L0', [
        { kind: 'gather', params: { rate: '5' } },
      ]);
    const command = transport.sent[0];
    if (command === undefined) throw new Error('missing command');
    transport.emit({ kind: 'commandAck', simTick: 0n, commandId: command.commandId });
    await expect(reply).resolves.toBeNull();
  });
});

describe('startup history races', () => {
  it.each([true, false])(
    'does not overwrite a player start with delayed bootstrap (existing=%s)',
    async (existing) => {
      const transport = new StubTransport();
      let resolve!: (result: QueryResult) => void;
      transport.queryResult = new Promise((done) => {
        resolve = done;
      });
      useSimStore.getState().attach(transport);
      const bootstrap = useSimStore.getState().bootstrapRun();
      useSimStore.getState().startRun(2026n);
      resolve({
        kind: 'listRuns',
        queryId: '',
        activeRunId: 'default',
        runs: existing
          ? [
              {
                runId: 'default',
                latestTick: '100',
                lastModifiedMs: 1,
              },
            ]
          : [],
      });
      await bootstrap;
      expect(useSimStore.getState().seed).toBe(2026n);
      expect(useSimStore.getState().paused).toBe(false);
      expect(transport.sent.filter((c) => c.kind === 'newRun')).toHaveLength(1);
    },
  );

  it('discards lineage rehydration from an earlier timeline', async () => {
    const transport = new StubTransport();
    let resolve!: (result: QueryResult) => void;
    transport.queryResult = new Promise((done) => {
      resolve = done;
    });
    useSimStore.getState().attach(transport);
    const rehydrate = useSimStore.getState().rehydrateAfterLoad();
    useSimStore.getState().startRun(2026n);
    resolve({
      kind: 'lineageTree',
      queryId: '',
      lineages: [
        {
          id: 'old-lineage',
          patches: [],
          name: 'Old history',
          parentLineageId: '',
          founderProbeId: 'P0',
          foundedAtTick: 0n,
          extinctionTick: null,
          quarantined: true,
        },
      ],
    });
    await rehydrate;
    expect(useSimStore.getState().lineages.has('old-lineage')).toBe(false);
    expect(useSimStore.getState().quarantinedLineages.size).toBe(0);
  });
});

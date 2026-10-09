import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command, Query, QueryResult, SimEvent } from '../protocol/types.js';
import type { SimTransport } from '../transport/types.js';
import { pauseWhileOpen, useSimStore } from './sim-store.js';
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

describe('named save deletion acknowledgements', () => {
  const saves = [
    { slot: 'remove', tick: '10', savedAtMs: 1 },
    { slot: 'keep', tick: '20', savedAtMs: 2 },
  ];
  function attached(): StubTransport {
    const transport = new StubTransport();
    useSimStore.getState().attach(transport);
    useSimStore.setState({ saves, paused: true, simTick: 20n });
    return transport;
  }

  it('keeps the row until host acknowledgement and ignores a stale listing response', async () => {
    const transport = attached();
    let resolveListing!: (value: QueryResult) => void;
    transport.queryResult = new Promise((resolve) => {
      resolveListing = resolve;
    });
    const refresh = useSimStore.getState().refreshSaves();
    useSimStore.getState().deleteSave('remove');
    const command = transport.sent.at(-1)!;
    expect(command).toMatchObject({ kind: 'deleteSave', slot: 'remove' });
    expect(useSimStore.getState().saves).toEqual(saves);
    transport.emit({ kind: 'commandAck', commandId: command.commandId, simTick: 20n });
    resolveListing({ kind: 'listSaves', queryId: '', saves });
    await refresh;
    expect(useSimStore.getState().saves).toEqual([saves[1]]);
    expect(useSimStore.getState().paused).toBe(true);
    expect(useSimStore.getState().simTick).toBe(20n);
    expect(useSimStore.getState().pendingCommands.has(command.commandId)).toBe(false);
  });

  it('retains a failed row for retry and surfaces the authoritative error', () => {
    const transport = attached();
    useSimStore.getState().deleteSave('remove');
    const command = transport.sent.at(-1)!;
    transport.emit({
      kind: 'commandError',
      commandId: command.commandId,
      simTick: 20n,
      message: 'Snapshot removed; retry Delete to repair listing.',
    });
    expect(useSimStore.getState().saves).toEqual(saves);
    expect(useSimStore.getState().commandError).toBe(
      'Snapshot removed; retry Delete to repair listing.',
    );
    expect(useSimStore.getState().paused).toBe(true);
    expect(useSimStore.getState().pendingCommands.has(command.commandId)).toBe(false);
  });
});

describe('patched lineage projection', () => {
  function patchedTree(
    entries: readonly { id: string; parent?: string; patches: readonly string[] }[],
  ): QueryResult {
    return {
      kind: 'lineageTree',
      queryId: '',
      lineages: entries.map((entry) => ({
        ...lineage(entry.id, 0n, entry.parent ?? null),
        parentLineageId: entry.parent ?? '',
        patches: entry.patches,
        quarantined: false,
      })),
    };
  }

  it('marks lineages a patch or landed decree overwrote, but not their later children', () => {
    const transport = new StubTransport();
    useSimStore.getState().attach(transport);
    transport.emit({
      kind: 'patchApplied',
      simTick: 10n,
      lineageId: 'L1',
      probesAffected: 3n,
      patchId: 'PT0',
    });
    transport.emit({
      kind: 'decreeFired',
      simTick: 11n,
      decreeId: 'D0',
      patchTargetLineageId: 'L2',
      landed: true,
      probesAffected: 2n,
    });
    transport.emit({
      kind: 'decreeFired',
      simTick: 12n,
      decreeId: 'D1',
      patchTargetLineageId: 'L3',
      landed: false,
      probesAffected: 0n,
    });
    // A child inherits the patched firmware, but it is the parent the
    // player intervened on; the child's own speciations are not promoted.
    transport.emit({
      kind: 'speciation',
      simTick: 13n,
      newLineageId: 'L4',
      newLineageName: 'Child of patched',
      parentLineageId: 'L1',
      founderProbeId: 'P4',
    });
    expect([...useSimStore.getState().patchedLineages].sort()).toEqual(['L1', 'L2']);
  });

  it('clears on run changes and rehydrates direct patch targets from the lineage tree', async () => {
    const transport = new StubTransport();
    transport.queryHandler = async (query) => {
      if (query.kind === 'lineageTree')
        return patchedTree([
          { id: 'L0', patches: ['PT0'] },
          // Inherited PT0 only: not a direct target.
          { id: 'L1', parent: 'L0', patches: ['PT0'] },
          // Inherited PT0 plus its own PT1: a direct target.
          { id: 'L2', parent: 'L0', patches: ['PT0', 'PT1'] },
          { id: 'L3', parent: 'L2', patches: ['PT0', 'PT1'] },
          { id: 'L4', parent: 'L1', patches: [] },
        ]);
      if (query.kind === 'listRuns')
        return { kind: 'listRuns', queryId: '', activeRunId: 'patched', runs: [] };
      throw new Error(`Unexpected ${query.kind} query`);
    };
    useSimStore.getState().attach(transport);
    transport.emit({
      kind: 'patchApplied',
      simTick: 10n,
      lineageId: 'L9',
      probesAffected: 1n,
      patchId: 'PT9',
    });
    useSimStore.getState().startRun(7n);
    expect(useSimStore.getState().patchedLineages.size).toBe(0);

    useSimStore.setState({ ancestryPinsReady: true });
    useSimStore.getState().rewindToTick(50n);
    expect(useSimStore.getState().patchedLineages.size).toBe(0);
    const rewind = transport.sent.at(-1)!;
    transport.emit({ kind: 'commandAck', commandId: rewind.commandId, simTick: 50n });
    await vi.waitFor(() =>
      expect([...useSimStore.getState().patchedLineages].sort()).toEqual(['L0', 'L2']),
    );
  });

  it('keeps a patch that lands while lineage hydration is pending', async () => {
    const transport = new StubTransport();
    let resolve!: (result: QueryResult) => void;
    transport.queryHandler = (query) =>
      query.kind === 'listRuns'
        ? Promise.resolve({ kind: 'listRuns', queryId: '', activeRunId: 'patched', runs: [] })
        : new Promise((done) => {
            resolve = done;
          });
    useSimStore.getState().attach(transport);
    const hydration = useSimStore.getState().rehydrateAfterLoad();
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    transport.emit({
      kind: 'patchApplied',
      simTick: 101n,
      lineageId: 'L0',
      probesAffected: 1n,
      patchId: 'PT0',
    });
    resolve(patchedTree([{ id: 'L0', patches: [] }]));
    await hydration;
    expect([...useSimStore.getState().patchedLineages]).toEqual(['L0']);
  });

  it('clears the patched set when switching runs', () => {
    const transport = new StubTransport();
    transport.queryHandler = () => new Promise(() => {});
    useSimStore.getState().attach(transport);
    transport.emit({
      kind: 'patchApplied',
      simTick: 10n,
      lineageId: 'L0',
      probesAffected: 1n,
      patchId: 'PT0',
    });
    expect([...useSimStore.getState().patchedLineages]).toEqual(['L0']);
    useSimStore.getState().switchRun('other');
    expect(useSimStore.getState().patchedLineages.size).toBe(0);
  });

  it('restores the previous patched set when a run change fails', () => {
    const transport = new StubTransport();
    transport.queryHandler = () => new Promise(() => {});
    useSimStore.getState().attach(transport);
    transport.emit({
      kind: 'patchApplied',
      simTick: 10n,
      lineageId: 'L0',
      probesAffected: 1n,
      patchId: 'PT0',
    });
    useSimStore.getState().load('missing');
    expect(useSimStore.getState().patchedLineages.size).toBe(0);
    const load = transport.sent.at(-1)!;
    transport.emit({
      kind: 'commandError',
      commandId: load.commandId,
      simTick: 10n,
      message: 'no such save',
    });
    expect([...useSimStore.getState().patchedLineages]).toEqual(['L0']);
  });
});

describe('pause, resume and speed retries', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function attachedWithFakeTimers(): StubTransport {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const transport = new StubTransport();
    useSimStore.getState().attach(transport);
    return transport;
  }
  const kinds = (transport: StubTransport): string[] => transport.sent.map((c) => c.kind);

  it('never re-sends an older pause or resume after a newer one', () => {
    const transport = attachedWithFakeTimers();
    useSimStore.getState().resume();
    vi.advanceTimersByTime(500);
    useSimStore.getState().pause();
    vi.advanceTimersByTime(600);
    vi.advanceTimersByTime(1_500);
    expect(kinds(transport)[0]).toBe('resume');
    expect(
      kinds(transport)
        .slice(1)
        .every((kind) => kind === 'pause'),
    ).toBe(true);
    expect(kinds(transport).length).toBeGreaterThan(2);
    expect(useSimStore.getState().paused).toBe(true);
    const pending = [...useSimStore.getState().pendingCommands.values()];
    expect(pending.map((command) => command.kind)).toEqual(['pause']);
  });

  it('retries only the newest speed', () => {
    const transport = attachedWithFakeTimers();
    useSimStore.getState().setSpeed(4);
    useSimStore.getState().setSpeed(16);
    vi.advanceTimersByTime(1_500);
    const retried = transport.sent.slice(2);
    expect(retried.length).toBeGreaterThan(0);
    expect(retried.every((command) => command.kind === 'setSpeed' && command.speed === 16)).toBe(
      true,
    );
  });

  it('ignores a rejection of a superseded toggle', () => {
    const transport = attachedWithFakeTimers();
    useSimStore.getState().pause();
    useSimStore.getState().resume();
    useSimStore.getState().pause();
    const [pause] = transport.sent;
    transport.emit({
      kind: 'commandError',
      commandId: pause!.commandId,
      simTick: 1n,
      message: 'timeline operation in progress; retry after completion',
    });
    expect(useSimStore.getState().paused).toBe(true);
  });

  it('stops showing a command as pending once retries are exhausted', () => {
    const transport = attachedWithFakeTimers();
    useSimStore.getState().pause();
    vi.advanceTimersByTime(10_000);
    expect(transport.sent.filter((command) => command.kind === 'pause')).toHaveLength(6);
    expect(useSimStore.getState().pendingCommands.size).toBe(0);
    expect(useSimStore.getState().commandError).toMatch(/did not acknowledge pause/);
  });
});

describe('auto-pause projection', () => {
  it('clears the ticks-per-second reading when the host auto-pauses', () => {
    const transport = new StubTransport();
    useSimStore.getState().attach(transport);
    useSimStore.setState({ paused: false, actualSpeed: 120 });
    transport.emit({ kind: 'autoPaused', simTick: 50n, trigger: 'speciation' });
    expect(useSimStore.getState().paused).toBe(true);
    expect(useSimStore.getState().actualSpeed).toBe(0);
  });
});

describe('seed and save indicators across run changes', () => {
  function savedRun(): ReturnType<typeof ancestryFixture> {
    const fixture = ancestryFixture();
    useSimStore.getState().startRun(7n);
    fixture.complete(true, 0n);
    useSimStore.getState().save('first');
    fixture.complete(true, 30n);
    expect(useSimStore.getState().seed).toBe(7n);
    expect(useSimStore.getState().lastSaveAtTick).toBe(30n);
    return fixture;
  }

  it.each(['switchRun', 'load'] as const)('clears the seed and saved tick on %s', (action) => {
    savedRun();
    if (action === 'switchRun') useSimStore.getState().switchRun('other');
    else useSimStore.getState().load('first');
    expect(useSimStore.getState().seed).toBeNull();
    expect(useSimStore.getState().lastSaveAtTick).toBeNull();
  });

  it('clears the saved tick on a fresh run', () => {
    const fixture = savedRun();
    useSimStore.getState().startRun(8n);
    expect(useSimStore.getState().lastSaveAtTick).toBeNull();
    fixture.complete(true, 0n);
    expect(useSimStore.getState().seed).toBe(8n);
    expect(useSimStore.getState().lastSaveAtTick).toBeNull();
  });

  it('restores both when the run change is rejected', () => {
    const fixture = savedRun();
    useSimStore.getState().switchRun('other');
    fixture.complete(false);
    expect(useSimStore.getState().seed).toBe(7n);
    expect(useSimStore.getState().lastSaveAtTick).toBe(30n);
  });

  it('does not label the next run with a save acknowledged after switching', () => {
    const fixture = savedRun();
    useSimStore.getState().save('second');
    const save = fixture.transport.sent.at(-1)!;
    useSimStore.getState().switchRun('other');
    fixture.transport.emit({ kind: 'commandAck', commandId: save.commandId, simTick: 40n });
    expect(useSimStore.getState().lastSaveAtTick).toBeNull();
  });
});

describe('optimistic command rollback', () => {
  function attached(): StubTransport {
    const transport = new StubTransport();
    useSimStore.getState().attach(transport);
    return transport;
  }
  const reject = (transport: StubTransport, command: { commandId: string }): void =>
    transport.emit({
      kind: 'commandError',
      commandId: command.commandId,
      simTick: 1n,
      message: 'timeline operation in progress; retry after completion',
    });
  const accept = (transport: StubTransport, command: { commandId: string }): void =>
    transport.emit({ kind: 'commandAck', commandId: command.commandId, simTick: 1n });

  it('rolls back a rejected quarantine and a rejected release', () => {
    const transport = attached();
    useSimStore.getState().quarantine('L0');
    expect(useSimStore.getState().quarantinedLineages.has('L0')).toBe(true);
    reject(transport, transport.sent.at(-1)!);
    expect(useSimStore.getState().quarantinedLineages.has('L0')).toBe(false);

    useSimStore.setState({ quarantinedLineages: new Set(['L0']) });
    useSimStore.getState().releaseQuarantine('L0');
    expect(useSimStore.getState().quarantinedLineages.has('L0')).toBe(false);
    reject(transport, transport.sent.at(-1)!);
    expect(useSimStore.getState().quarantinedLineages.has('L0')).toBe(true);
  });

  it('settles a chain of toggles to the last value the host accepted', () => {
    const transport = attached();
    useSimStore.getState().quarantine('L0');
    useSimStore.getState().releaseQuarantine('L0');
    const [quarantine, release] = transport.sent;
    reject(transport, quarantine!);
    expect(useSimStore.getState().quarantinedLineages.has('L0')).toBe(false);
    reject(transport, release!);
    expect(useSimStore.getState().quarantinedLineages.has('L0')).toBe(false);

    useSimStore.getState().quarantine('L0');
    useSimStore.getState().releaseQuarantine('L0');
    const [accepted, rejected] = transport.sent.slice(2);
    transport.emit({ kind: 'quarantineImposed', simTick: 1n, lineageId: 'L0' });
    accept(transport, accepted!);
    reject(transport, rejected!);
    expect(useSimStore.getState().quarantinedLineages.has('L0')).toBe(true);
  });

  it('leaves a quarantine rejected after a run change to rehydration', () => {
    const transport = attached();
    transport.queryHandler = () => new Promise(() => {});
    useSimStore.getState().quarantine('L0');
    const quarantine = transport.sent.at(-1)!;
    useSimStore.getState().switchRun('other');
    useSimStore.setState({ quarantinedLineages: new Set(['L0']) });
    reject(transport, quarantine);
    expect(useSimStore.getState().quarantinedLineages.has('L0')).toBe(true);
  });

  it('rolls back rejected auto-pause triggers with a unique command id', () => {
    const transport = attached();
    useSimStore.getState().setAutoPauseTriggers(new Set(['speciation']));
    accept(transport, transport.sent.at(-1)!);
    useSimStore.getState().setAutoPauseTriggers(new Set(['speciation', 'lineageExtinction']));
    useSimStore.getState().setAutoPauseTriggers(new Set());
    const [, second, third] = transport.sent;
    expect(new Set(transport.sent.map((command) => command.commandId)).size).toBe(3);
    reject(transport, second!);
    expect([...useSimStore.getState().autoPauseTriggers]).toEqual([]);
    reject(transport, third!);
    expect([...useSimStore.getState().autoPauseTriggers]).toEqual(['speciation']);
  });

  it('restores a run whose deletion the host rejected', async () => {
    const transport = attached();
    const runs = [
      { runId: 'keep', latestTick: '10', lastModifiedMs: 1 },
      { runId: 'other', latestTick: '20', lastModifiedMs: 2 },
    ];
    transport.queryHandler = async (query) => {
      if (query.kind !== 'listRuns') throw new Error(`Unexpected ${query.kind} query`);
      return { kind: 'listRuns', queryId: '', activeRunId: 'keep', runs };
    };
    useSimStore.setState({ runs });
    useSimStore.getState().deleteRun('other');
    expect(useSimStore.getState().runs.map((run) => run.runId)).toEqual(['keep']);
    reject(transport, transport.sent.at(-1)!);
    await vi.waitFor(() =>
      expect(useSimStore.getState().runs.map((run) => run.runId)).toEqual(['keep', 'other']),
    );
  });
});

describe('rejected pause, resume and speed', () => {
  const timelineRejection = 'timeline operation in progress; retry after completion';
  function attached(): StubTransport {
    const transport = new StubTransport();
    transport.queryHandler = () => new Promise(() => {});
    useSimStore.getState().attach(transport);
    return transport;
  }
  const reject = (transport: StubTransport, command: { commandId: string }): void =>
    transport.emit({
      kind: 'commandError',
      commandId: command.commandId,
      simTick: 1n,
      message: timelineRejection,
    });
  const accept = (transport: StubTransport, command: { commandId: string }): void =>
    transport.emit({ kind: 'commandAck', commandId: command.commandId, simTick: 1n });

  it('stays paused when resume then pause are both rejected during a run change', () => {
    const transport = attached();
    useSimStore.getState().switchRun('other');
    expect(useSimStore.getState().paused).toBe(true);
    useSimStore.getState().resume();
    useSimStore.getState().pause();
    const [resume, pause] = transport.sent.slice(1);
    reject(transport, resume!);
    reject(transport, pause!);
    expect(useSimStore.getState().paused).toBe(true);
  });

  it('stays running when pause then resume are both rejected', () => {
    const transport = attached();
    useSimStore.setState({ paused: false });
    useSimStore.getState().pause();
    useSimStore.getState().resume();
    const [pause, resume] = transport.sent;
    reject(transport, pause!);
    reject(transport, resume!);
    expect(useSimStore.getState().paused).toBe(false);
  });

  it('rolls back a single rejected pause or resume', () => {
    const transport = attached();
    useSimStore.setState({ paused: false });
    useSimStore.getState().pause();
    expect(useSimStore.getState().paused).toBe(true);
    reject(transport, transport.sent.at(-1)!);
    expect(useSimStore.getState().paused).toBe(false);
    useSimStore.setState({ paused: true });
    useSimStore.getState().resume();
    reject(transport, transport.sent.at(-1)!);
    expect(useSimStore.getState().paused).toBe(true);
  });

  it('keeps the paused state a run change set when an earlier toggle is rejected', () => {
    const transport = attached();
    useSimStore.setState({ paused: false });
    useSimStore.getState().pause();
    const pause = transport.sent.at(-1)!;
    useSimStore.getState().switchRun('other');
    useSimStore.setState({ paused: true });
    reject(transport, pause);
    expect(useSimStore.getState().paused).toBe(true);
  });

  it('rolls a rejected speed back to the last accepted speed', () => {
    const transport = attached();
    useSimStore.getState().setSpeed(16);
    reject(transport, transport.sent.at(-1)!);
    expect(useSimStore.getState().speed).toBe(1);
    useSimStore.getState().setSpeed(4);
    useSimStore.getState().setSpeed(64);
    const [four, sixtyFour] = transport.sent.slice(1);
    accept(transport, four!);
    reject(transport, sixtyFour!);
    expect(useSimStore.getState().speed).toBe(4);
  });

  it('rolls auto-pause triggers back across a run change', () => {
    const transport = attached();
    useSimStore.getState().setAutoPauseTriggers(new Set(['speciation']));
    const configure = transport.sent.at(-1)!;
    useSimStore.getState().switchRun('other');
    reject(transport, configure);
    expect([...useSimStore.getState().autoPauseTriggers]).toEqual([]);
  });

  it('falls back to triggers the host accepted while a newer write was pending', () => {
    const transport = attached();
    useSimStore.getState().setAutoPauseTriggers(new Set(['speciation']));
    useSimStore.getState().setAutoPauseTriggers(new Set(['speciation', 'lineageExtinction']));
    const [first, second] = transport.sent;
    accept(transport, first!);
    reject(transport, second!);
    expect([...useSimStore.getState().autoPauseTriggers]).toEqual(['speciation']);
  });

  it('treats an older unanswered write as lost once a newer one is answered', () => {
    const transport = attached();
    useSimStore.getState().setAutoPauseTriggers(new Set(['speciation']));
    useSimStore.getState().setAutoPauseTriggers(new Set(['lineageExtinction']));
    reject(transport, transport.sent.at(-1)!);
    expect([...useSimStore.getState().autoPauseTriggers]).toEqual([]);
  });

  it('does not carry unanswered writes over to a new connection', () => {
    const first = attached();
    useSimStore.getState().setAutoPauseTriggers(new Set(['speciation']));
    expect(first.sent).toHaveLength(1);
    const second = attached();
    useSimStore.getState().setAutoPauseTriggers(new Set(['speciation', 'lineageExtinction']));
    reject(second, second.sent.at(-1)!);
    expect([...useSimStore.getState().autoPauseTriggers]).toEqual(['speciation']);
  });
});

describe('modal pause ownership', () => {
  function attached(): StubTransport {
    const transport = new StubTransport();
    transport.queryHandler = () => new Promise(() => {});
    useSimStore.getState().attach(transport);
    useSimStore.setState({ paused: false });
    return transport;
  }

  it('resumes on close only when it paused on the same connection and timeline', () => {
    const transport = attached();
    const close = pauseWhileOpen();
    expect(transport.sent.map((command) => command.kind)).toEqual(['pause']);
    close();
    expect(transport.sent.map((command) => command.kind)).toEqual(['pause', 'resume']);

    useSimStore.setState({ paused: true });
    pauseWhileOpen()();
    expect(transport.sent).toHaveLength(2);
  });

  it('does not resume a new connection or a changed timeline', () => {
    const first = attached();
    const closeAfterReconnect = pauseWhileOpen();
    const second = attached();
    closeAfterReconnect();
    expect(second.sent).toHaveLength(0);
    expect(first.sent.map((command) => command.kind)).toEqual(['pause']);

    const closeAfterSwitch = pauseWhileOpen();
    useSimStore.getState().switchRun('other');
    closeAfterSwitch();
    expect(second.sent.map((command) => command.kind)).toEqual(['pause', 'switchRun']);
  });
});

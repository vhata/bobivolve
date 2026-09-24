import { afterEach, describe, expect, it } from 'vitest';
import type { Command, Query, QueryResult, SimEvent } from '../protocol/types.js';
import type { SimTransport } from '../transport/types.js';
import { useSimStore } from './sim-store.js';

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
  query(_query: Query): Promise<QueryResult> {
    if (this.queryResult === null) throw new Error('unused');
    return this.queryResult;
  }
  close(): void {}
  emit(event: SimEvent): void {
    this.listener?.(event);
  }
}

afterEach(() => {
  useSimStore.getState().detach();
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

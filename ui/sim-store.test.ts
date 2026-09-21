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
  query(_query: Query): Promise<QueryResult> {
    throw new Error('unused');
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

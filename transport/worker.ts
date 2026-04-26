// WorkerTransport — SimTransport implementation for the browser. Wraps a
// Web Worker that runs host/worker.ts and exposes the SimTransport interface
// to the UI. Messages crossing postMessage are structured-cloned plain
// data; bigints survive the clone so no JSON encoding is needed.
//
// Usage:
//   import SimWorker from '../host/worker.ts?worker';
//   const transport = new WorkerTransport(new SimWorker());

import type { Command, Query, QueryResult, SimEvent } from '../protocol/types.js';
import type { SimEventHandler, SimTransport, Unsubscribe } from './types.js';

interface CommandMessage {
  readonly type: 'command';
  readonly cmd: Command;
}

interface QueryMessage {
  readonly type: 'query';
  readonly query: Query;
}

interface EventMessage {
  readonly type: 'event';
  readonly event: SimEvent;
}

interface QueryResultMessage {
  readonly type: 'queryResult';
  readonly queryId: string;
  readonly result: QueryResult;
}

type WorkerMessage = EventMessage | QueryResultMessage;

export class WorkerTransport implements SimTransport {
  private readonly worker: Worker;
  private readonly handlers = new Set<SimEventHandler>();
  private readonly listener: (e: MessageEvent<WorkerMessage>) => void;
  private readonly pendingQueries = new Map<string, (result: QueryResult) => void>();
  private nextQueryOrdinal = 0;
  private closed = false;

  constructor(worker: Worker) {
    this.worker = worker;
    this.listener = (e: MessageEvent<WorkerMessage>) => {
      if (e.data.type === 'event') {
        // Snapshot the handler set so a handler that unsubscribes during
        // dispatch does not perturb iteration.
        for (const handler of [...this.handlers]) {
          handler(e.data.event);
        }
        return;
      }
      if (e.data.type === 'queryResult') {
        const resolve = this.pendingQueries.get(e.data.queryId);
        if (resolve === undefined) return;
        this.pendingQueries.delete(e.data.queryId);
        resolve(e.data.result);
      }
    };
    this.worker.addEventListener('message', this.listener);
  }

  send(cmd: Command): void {
    if (this.closed) throw new Error('WorkerTransport: send after close');
    const msg: CommandMessage = { type: 'command', cmd };
    this.worker.postMessage(msg);
  }

  onEvent(handler: SimEventHandler): Unsubscribe {
    if (this.closed) throw new Error('WorkerTransport: onEvent after close');
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  query(q: Query): Promise<QueryResult> {
    if (this.closed) {
      return Promise.reject(new Error('WorkerTransport: query after close'));
    }
    // Mint a queryId if the caller did not supply one (the API allows it
    // but we need uniqueness per-transport for reply correlation).
    const queryId = q.queryId !== '' ? q.queryId : this.mintQueryId();
    const sent: Query = { ...q, queryId };
    return new Promise<QueryResult>((resolve) => {
      this.pendingQueries.set(queryId, resolve);
      const msg: QueryMessage = { type: 'query', query: sent };
      this.worker.postMessage(msg);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.worker.removeEventListener('message', this.listener);
    this.handlers.clear();
    this.pendingQueries.clear();
    this.worker.terminate();
  }

  private mintQueryId(): string {
    const id = `wt-${this.nextQueryOrdinal.toString()}`;
    this.nextQueryOrdinal += 1;
    return id;
  }
}

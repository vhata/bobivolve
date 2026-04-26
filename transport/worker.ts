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

interface EventMessage {
  readonly type: 'event';
  readonly event: SimEvent;
}

type WorkerMessage = EventMessage;

export class WorkerTransport implements SimTransport {
  private readonly worker: Worker;
  private readonly handlers = new Set<SimEventHandler>();
  private readonly listener: (e: MessageEvent<WorkerMessage>) => void;
  private closed = false;

  constructor(worker: Worker) {
    this.worker = worker;
    this.listener = (e: MessageEvent<WorkerMessage>) => {
      if (e.data.type !== 'event') return;
      // Snapshot the handler set so a handler that unsubscribes during
      // dispatch does not perturb iteration.
      for (const handler of [...this.handlers]) {
        handler(e.data.event);
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

  query(_q: Query): Promise<QueryResult> {
    if (this.closed) {
      return Promise.reject(new Error('WorkerTransport: query after close'));
    }
    // Query routing matches NodeTransport's stub — schema.proto's Query
    // result bodies are placeholders awaiting dashboard work.
    return Promise.reject(new Error('WorkerTransport: queries not yet implemented'));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.worker.removeEventListener('message', this.listener);
    this.handlers.clear();
    this.worker.terminate();
  }
}

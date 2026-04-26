// NodeTransport — SimTransport implementation for the Node host.
//
// ARCHITECTURE.md "Transports" describes two shapes for this transport:
//
//   1. In-process. Sim runs as a TypeScript module in the same process as the
//      caller; commands and events are direct method calls. Used for headless
//      runs from a CLI, golden-file determinism tests, and any tooling that
//      drives the sim from a Node script.
//
//   2. Cross-process. Sim runs in a child Node process; commands and events
//      cross the boundary as NDJSON over stdio. Symmetric with the eventual
//      Rust binary (ARCHITECTURE.md "Migration path to Rust"). Reserved for
//      future addition — not implemented here.
//
// Only the in-process shape is implemented. The cross-process shape is a
// future addition; same interface, different wiring.
//
// The interface is identical to what a WorkerTransport or TauriTransport
// would expose, so a UI written against `SimTransport` cannot tell the
// difference between this and a future cross-process or Rust-backed host.

import { NodeHost, type NodeHostOptions } from '../host/node.js';
import type { Command, Query, QueryResult, SimEvent } from '../protocol/types.js';
import type { SimEventHandler, SimTransport, Unsubscribe } from './types.js';

export interface NodeTransportOptions extends NodeHostOptions {
  // Optional pre-existing host. Useful when a CLI wants to drive the run-loop
  // directly while still exposing the SimTransport interface to consumers
  // (e.g. for forwarding to a Worker UI). When omitted, the transport owns
  // its host.
  readonly host?: NodeHost;
}

// In-process NodeTransport. Wraps a NodeHost and exposes its surface through
// the SimTransport interface. Closing the transport detaches its listeners
// but does not destroy the host (the host may outlive a single transport).
export class NodeTransport implements SimTransport {
  private readonly host: NodeHost;
  private readonly handlers = new Set<SimEventHandler>();
  private readonly hostUnsubscribe: () => void;
  private closed = false;

  constructor(options: NodeTransportOptions = {}) {
    this.host = options.host ?? new NodeHost(options);
    this.hostUnsubscribe = this.host.subscribe((event: SimEvent) => {
      // Snapshot the handler set so a handler that unsubscribes during
      // dispatch does not perturb the iteration. Set iteration is otherwise
      // safe in JS, but defensive copy is cheap and matches the contract a
      // cross-process transport would have.
      for (const handler of [...this.handlers]) {
        handler(event);
      }
    });
  }

  // Expose the underlying host for the CLI run-loop driver. Not part of the
  // SimTransport interface; the UI will never call this. A future
  // cross-process variant cannot return this either, by design.
  getHost(): NodeHost {
    return this.host;
  }

  send(cmd: Command): void {
    if (this.closed) throw new Error('NodeTransport: send after close');
    this.host.send(cmd);
  }

  onEvent(handler: SimEventHandler): Unsubscribe {
    if (this.closed) throw new Error('NodeTransport: onEvent after close');
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  query(q: Query): Promise<QueryResult> {
    if (this.closed) {
      return Promise.reject(new Error('NodeTransport: query after close'));
    }
    // In-process variant: queries are async at the host (some need
    // storage IO). The async surface keeps the SimTransport interface
    // symmetric with cross-process variants.
    return this.host.executeQuery(q);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.hostUnsubscribe();
    this.handlers.clear();
    // The host is not torn down here. It may outlive a single transport;
    // when host resources need disposal (file handles, child processes), a
    // dedicated host.dispose() will land alongside them.
  }
}

// SimTransport — the seam between the UI and the sim host.
//
// ARCHITECTURE.md "Transports": every transport conforms to this one
// interface, regardless of whether the sim runs in a Web Worker
// (WorkerTransport), a Node process (NodeTransport), or eventually a Rust
// binary behind Tauri (TauriTransport). The UI imports `SimTransport`; the
// host process wires the implementation at startup.
//
// Crosses the seam: plain-data Command, SimEvent, Query, QueryResult.
// Does not cross: object references, function references, class instances,
// closures, mutable state, host APIs. "If a separate Rust process could
// produce the same byte stream, the UI cannot tell the difference."

import type { Command, Query, QueryResult, SimEvent } from '../protocol/types.js';

export type Unsubscribe = () => void;

export type SimEventHandler = (event: SimEvent) => void;

export interface SimTransport {
  // Fire-and-forget. The sim acknowledges via SimEvent (commandAck or
  // commandError); callers correlate on `commandId`.
  send(cmd: Command): void;

  // Subscribe to the sim's event stream. The returned function unsubscribes
  // the handler. Heartbeat events may be dropped under load; domain events
  // are guaranteed in-order.
  onEvent(handler: SimEventHandler): Unsubscribe;

  // Request/response. Queries are pull-only; the sim never pushes a result
  // unsolicited.
  query(q: Query): Promise<QueryResult>;

  // Tear down the transport. After close, send/onEvent/query are not valid.
  close(): void;
}

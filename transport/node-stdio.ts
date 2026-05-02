// NodeStdioTransport — cross-process SimTransport variant.
//
// ARCHITECTURE.md "Transports" describes two shapes for the Node host:
//
//   1. In-process. Sim runs as a TypeScript module in the same process; the
//      `NodeTransport` in transport/node.ts implements that.
//
//   2. Cross-process (this file). Sim runs in a child Node process; commands,
//      queries, events, and query results cross the boundary as NDJSON over
//      stdio. The wire is symmetric with the eventual Rust binary
//      (ARCHITECTURE.md "Migration path to Rust") — that binary will speak
//      the same NDJSON line protocol and slot in behind this transport.
//
// The transport spawns a single child via process.execPath with the tsx
// loader registered (--import tsx), wires its stdin and stdout, and exposes
// the SimTransport surface to callers. Closing the transport ends the
// child's stdin (which the child treats as a clean shutdown signal) and,
// after a short grace window, kills it if it has not exited.
//
// Backpressure is intentionally deferred. At R0 the wire carries small
// JSON lines; the OS pipe buffer absorbs short bursts. If a future variant
// pushes the wire hard (high-frequency replication / death events at fat
// population, e.g. a Rust sim feeding a UI consumer that lags), revisit
// here — likely with `pause()`/`resume()` on the child's stdout reader and
// a high-water mark on the parent's stdin writer.

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import type { Command, Query, QueryResult, SimEvent } from '../protocol/types.js';
import { encodeLine, reviveEvent, reviveQueryResult } from './ndjson-codec.js';
import type { SimEventHandler, SimTransport, Unsubscribe } from './types.js';

export interface NodeStdioTransportOptions {
  // Override the child entry point. Defaults to host/node-stdio-child.ts
  // resolved relative to this file. Useful for tests against a custom
  // child or for the future Rust binary.
  readonly childEntrypoint?: string;
  // Override the binary that runs the child. Defaults to process.execPath
  // (the same Node that runs the parent), so vitest / CI / dev all use the
  // same binary they were launched with. A future Rust child would set
  // this to the compiled binary's path and clear `loaderArgs`.
  readonly nodeExecutable?: string;
  // Loader args prepended to the child argv. Defaults to ['--import', 'tsx']
  // so the .ts entry point loads under tsx in dev and CI. Set to []
  // when targeting a precompiled .mjs entry, or when the child is a
  // non-Node binary.
  readonly loaderArgs?: readonly string[];
  // Time to wait for the child to acknowledge `ready` before treating the
  // spawn as failed. Defaults to 10s.
  readonly readyTimeoutMs?: number;
  // Time to wait for clean shutdown after closing stdin before sending
  // SIGKILL. Defaults to 2s.
  readonly closeGraceMs?: number;
}

interface QueryResolver {
  readonly resolve: (result: QueryResult) => void;
  readonly reject: (err: Error) => void;
}

const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_GRACE_MS = 2_000;

function defaultChildEntrypoint(): string {
  // Resolve `host/node-stdio-child.ts` relative to this file's location, so
  // the transport works whether the project is loaded from source (dev /
  // tests under tsx) or from a future compiled output (resolution still
  // walks one directory up, then into host/).
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'host', 'node-stdio-child.ts');
}

interface IncomingEventWire {
  readonly type: 'event';
  readonly event: unknown;
}
interface IncomingQueryResultWire {
  readonly type: 'queryResult';
  readonly result: unknown;
}
interface IncomingReadyWire {
  readonly type: 'ready';
}
type IncomingWire = IncomingEventWire | IncomingQueryResultWire | IncomingReadyWire;

export class NodeStdioTransport implements SimTransport {
  private readonly child: ChildProcess;
  private readonly handlers = new Set<SimEventHandler>();
  private readonly pendingQueries = new Map<string, QueryResolver>();
  private readonly stdoutLines: ReadlineInterface;
  private readonly stderrLines: ReadlineInterface;
  private readonly readyPromise: Promise<void>;
  private closed = false;

  constructor(options: NodeStdioTransportOptions = {}) {
    const entry = options.childEntrypoint ?? defaultChildEntrypoint();
    const exe = options.nodeExecutable ?? process.execPath;
    const loaderArgs = options.loaderArgs ?? ['--import', 'tsx'];
    const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

    this.child = spawn(exe, [...loaderArgs, entry], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (this.child.stdin === null || this.child.stdout === null || this.child.stderr === null) {
      throw new Error('NodeStdioTransport: child stdio not piped (this should not happen)');
    }

    this.stdoutLines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.stderrLines = createInterface({ input: this.child.stderr, crlfDelay: Infinity });

    let resolveReady: () => void = () => {};
    let rejectReady: (err: Error) => void = () => {};
    this.readyPromise = new Promise<void>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });

    const readyTimer = setTimeout(() => {
      rejectReady(
        new Error(`NodeStdioTransport: child failed to send ready within ${readyTimeoutMs}ms`),
      );
    }, readyTimeoutMs);
    // Don't keep the event loop alive on this timer.
    if (typeof readyTimer.unref === 'function') readyTimer.unref();

    this.stdoutLines.on('line', (line: string) => {
      if (line.length === 0) return;
      let raw: IncomingWire;
      try {
        raw = JSON.parse(line) as IncomingWire;
      } catch (e) {
        // Malformed line from the child. Reject pending queries and
        // surface — better to fail loudly than silently lose state.
        const err = new Error(
          `NodeStdioTransport: malformed NDJSON from child: ${(e as Error).message}`,
        );
        for (const pending of this.pendingQueries.values()) pending.reject(err);
        this.pendingQueries.clear();
        return;
      }
      if (raw.type === 'ready') {
        clearTimeout(readyTimer);
        resolveReady();
        return;
      }
      if (raw.type === 'event') {
        const event = reviveEvent(raw.event) as SimEvent;
        // Snapshot handler set so unsubscribes during dispatch don't perturb
        // iteration. Cheap and matches the in-process NodeTransport contract.
        for (const handler of [...this.handlers]) {
          handler(event);
        }
        return;
      }
      if (raw.type === 'queryResult') {
        const result = reviveQueryResult(raw.result);
        const pending = this.pendingQueries.get(result.queryId);
        if (pending !== undefined) {
          this.pendingQueries.delete(result.queryId);
          pending.resolve(result);
        }
        return;
      }
    });

    // Forward child stderr to parent stderr so diagnostics survive (the
    // child writes structured JSON to stdout but anything else — uncaught
    // exceptions, malformed-line warnings — goes to stderr).
    this.stderrLines.on('line', (line: string) => {
      if (line.length === 0) return;
      process.stderr.write(`[stdio-child] ${line}\n`);
    });

    this.child.on('exit', (code, signal) => {
      // Reject any in-flight queries — the child won't be answering them.
      const reason =
        signal !== null ? `child exited via signal ${signal}` : `child exited with code ${code}`;
      const err = new Error(`NodeStdioTransport: ${reason}`);
      for (const pending of this.pendingQueries.values()) pending.reject(err);
      this.pendingQueries.clear();
      // Mark closed so further send/query calls fail fast rather than
      // hanging on a dead pipe.
      this.closed = true;
    });

    this.child.on('error', (err) => {
      // Spawn-level errors (e.g. the binary doesn't exist). Reject ready
      // and any in-flight queries.
      clearTimeout(readyTimer);
      rejectReady(err);
      for (const pending of this.pendingQueries.values()) pending.reject(err);
      this.pendingQueries.clear();
    });
  }

  // Resolves once the child has emitted its `ready` line. Callers that
  // need to gate on startup (e.g. tests) can `await transport.ready()`
  // before sending commands. The SimTransport interface doesn't require
  // this, so the in-process variant has no analogue — but wedging the
  // first command behind `ready` is the safe call here.
  ready(): Promise<void> {
    return this.readyPromise;
  }

  send(cmd: Command): void {
    if (this.closed) throw new Error('NodeStdioTransport: send after close');
    const line = encodeLine({ type: 'command', cmd });
    this.child.stdin?.write(line);
  }

  onEvent(handler: SimEventHandler): Unsubscribe {
    if (this.closed) throw new Error('NodeStdioTransport: onEvent after close');
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  query(q: Query): Promise<QueryResult> {
    if (this.closed) {
      return Promise.reject(new Error('NodeStdioTransport: query after close'));
    }
    const queryId = q.queryId;
    const promise = new Promise<QueryResult>((resolve, reject) => {
      this.pendingQueries.set(queryId, { resolve, reject });
    });
    const line = encodeLine({ type: 'query', query: q });
    this.child.stdin?.write(line);
    return promise;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.handlers.clear();

    // End stdin → child's readline 'close' fires → child exits cleanly.
    try {
      this.child.stdin?.end();
    } catch {
      // Child may already be dead; ignore.
    }

    // Belt-and-braces: if the child hasn't exited within the grace window,
    // SIGKILL it. Don't keep the event loop alive on this timer.
    const closeGraceMs = DEFAULT_CLOSE_GRACE_MS;
    const killTimer = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) {
        try {
          this.child.kill('SIGKILL');
        } catch {
          // Already dead; ignore.
        }
      }
    }, closeGraceMs);
    if (typeof killTimer.unref === 'function') killTimer.unref();
  }
}

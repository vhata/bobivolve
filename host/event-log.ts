// Event log: append-only NDJSON keyed by (tick, seq), the spine of replay
// and persistence (ARCHITECTURE.md "Event log").
//
// Each entry is one of:
//   - cmd  — a Command that arrived at this tick.
//   - ev   — a SimEvent the sim emitted.
//   - snap — a reference to a periodic snapshot (snapshotKey resolves under
//            the same Storage that owns the log).
//
// Heartbeats are not logged; they are derivable from population summaries.
//
// Format: NDJSON with bigint fields encoded as decimal strings (proto3 JSON
// convention). The same on-disk shape serves the browser host (OPFS) and the
// Node host (filesystem); a save file moves between hosts without
// conversion.
//
// Sequence numbers reset per tick. The (tick, seq) tuple uniquely orders
// entries within and across ticks.

import type { Storage } from '../sim/ports.js';
import type { Command, SimEvent } from '../protocol/types.js';

export interface CmdLogEntry {
  readonly type: 'cmd';
  readonly tick: bigint;
  readonly seq: number;
  readonly command: Command;
}

export interface EvLogEntry {
  readonly type: 'ev';
  readonly tick: bigint;
  readonly seq: number;
  readonly event: SimEvent;
}

export interface SnapLogEntry {
  readonly type: 'snap';
  readonly tick: bigint;
  readonly seq: number;
  readonly snapshotKey: string;
}

export type LogEntry = CmdLogEntry | EvLogEntry | SnapLogEntry;

// JSON.stringify replacer that encodes bigints as decimal strings, mirroring
// the proto3 JSON convention used at the seam.
function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  return value;
}

// Bigint reviver, keyed by the known bigint-bearing fields on the event
// types we actually log. Heartbeats are NOT logged (see header), so the
// dynamic-keyed map value `populationByLineage[lineageId]` does not need
// restoration here — the only `populationByLineage` values that ever
// reach this reviver via in-process structuredClone are still bigints
// because they never went through JSON. If the host ever starts logging
// heartbeats, this reviver needs an upgrade: either switch the codec to
// the tagged-bigint encoding the snapshot codec uses (`{__bigint__: "…"}`)
// or post-parse walk the populationByLineage object to convert each
// dynamic-keyed entry. Both are fine; the cheap one is documenting the
// constraint and preserving the choice until it bites.
function bigintReviver(key: string, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  switch (key) {
    case 'tick':
    case 'simTick':
    case 'seed':
    case 'ticks':
    case 'populationTotal':
    case 'bornAtTick':
    case 'foundedAtTick':
    case 'threshold':
    case 'rate':
    case 'nextProbeOrdinal':
    case 'nextLineageOrdinal':
    case 'originCompute':
    case 'originComputeMax':
    case 'probesAffected':
      return BigInt(value);
    default:
      return value;
  }
}

export function serializeEntry(entry: LogEntry): string {
  return JSON.stringify(entry, bigintReplacer) + '\n';
}

export function parseEntry(line: string): LogEntry {
  const trimmed = line.trim();
  if (trimmed === '') throw new Error('parseEntry: empty line');
  return JSON.parse(trimmed, bigintReviver) as LogEntry;
}

// Append-only writer over a Storage key. Buffers entries in memory; flush()
// drains the buffer to storage in a single append. Sync appends compose with
// the NodeHost run-loop, which is itself synchronous; the host calls flush()
// at points where durability matters (after a Save command, before close,
// during Load setup).
export class EventLogWriter {
  private buffer: LogEntry[] = [];
  private currentTick: bigint | null = null;
  private nextSeq = 0;

  constructor(
    private readonly storage: Storage,
    private readonly key: string,
  ) {}

  appendCommand(tick: bigint, command: Command): void {
    this.buffer.push({ type: 'cmd', tick, seq: this.advanceSeq(tick), command });
  }

  appendEvent(tick: bigint, event: SimEvent): void {
    this.buffer.push({ type: 'ev', tick, seq: this.advanceSeq(tick), event });
  }

  appendSnap(tick: bigint, snapshotKey: string): void {
    this.buffer.push({ type: 'snap', tick, seq: this.advanceSeq(tick), snapshotKey });
  }

  // Drain all buffered entries to storage. Idempotent on an empty buffer.
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const text = this.buffer.map(serializeEntry).join('');
    this.buffer = [];
    await this.storage.append(this.key, new TextEncoder().encode(text));
  }

  // Force the writer to use a specific (tick, seq) baseline. Used by load
  // when continuing an existing log so future entries don't collide with
  // previously-written ones at the same tick.
  resumeAt(tick: bigint, nextSeq: number): void {
    this.currentTick = tick;
    this.nextSeq = nextSeq;
  }

  // Number of entries currently buffered but not yet flushed. Surface for
  // tests; not part of the public contract.
  pendingCount(): number {
    return this.buffer.length;
  }

  private advanceSeq(tick: bigint): number {
    if (this.currentTick === null || tick !== this.currentTick) {
      this.currentTick = tick;
      this.nextSeq = 0;
    }
    const seq = this.nextSeq;
    this.nextSeq += 1;
    return seq;
  }
}

// Reader that returns entries in declaration order. Streaming parse — the
// log can be large, so this avoids loading the whole file as a single
// JSON document. The full Storage.read does load the whole file though;
// streaming-from-storage is a future optimisation gated on the OPFS streaming
// API and Node fs streams agreeing on a shape.
export class EventLogReader {
  constructor(
    private readonly storage: Storage,
    private readonly key: string,
  ) {}

  async readAll(): Promise<readonly LogEntry[]> {
    const bytes = await this.storage.read(this.key);
    if (bytes === null) return [];
    const text = new TextDecoder().decode(bytes);
    const entries: LogEntry[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      entries.push(parseEntry(line));
    }
    return entries;
  }

  // Returns the latest snap entry (highest tick), or null if no snap exists.
  async latestSnap(): Promise<SnapLogEntry | null> {
    const all = await this.readAll();
    let latest: SnapLogEntry | null = null;
    for (const entry of all) {
      if (entry.type !== 'snap') continue;
      if (latest === null || entry.tick > latest.tick) latest = entry;
    }
    return latest;
  }

  // Returns the entries strictly after a given (tick, seq), in order. Used
  // on load to replay the log tail past the latest snapshot.
  async tailAfter(tick: bigint, seq: number): Promise<readonly LogEntry[]> {
    const all = await this.readAll();
    const out: LogEntry[] = [];
    for (const entry of all) {
      if (entry.tick > tick || (entry.tick === tick && entry.seq > seq)) {
        out.push(entry);
      }
    }
    return out;
  }
}

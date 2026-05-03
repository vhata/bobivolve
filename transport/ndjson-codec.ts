// NDJSON codec helpers for the cross-process transport.
//
// Wire shape: one JSON object per line, UTF-8, terminated by '\n'. The proto3
// JSON convention encodes uint64 as a decimal string; we follow it here so the
// stream is round-trippable with a JSON parser that does not natively
// understand bigints.
//
// On the parent → child direction the wire carries `Command` and `Query`
// messages; on the child → parent direction it carries `SimEvent` and
// `QueryResult` messages. Both sides reach for `encode` to write a line and
// `decode*` to revive bigints in fields the schema declares as u64.
//
// The schema is the source of truth for which fields are u64. This codec is
// hand-written to match `protocol/types.ts`; when codegen lands the shapes it
// emits will replace the manual revival paths below.

import type { Command, Query, QueryResult, SimEvent } from '../protocol/types.js';

// JSON.stringify replacer that encodes bigints as decimal strings, mirroring
// proto3 JSON encoding for uint64 fields. Identical to host/node-cli.ts so the
// two emitters produce byte-identical NDJSON.
function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  return value;
}

export function encodeLine(value: unknown): string {
  return JSON.stringify(value, bigintReplacer) + '\n';
}

// ─── Command revival ─────────────────────────────────────────────────────────

interface RawCommand {
  readonly kind?: string;
  readonly commandId?: string;
  readonly seed?: string;
  readonly ticks?: string;
  readonly tick?: string;
  // Catch-all so the type-checker accepts the rest of the body verbatim.
  readonly [k: string]: unknown;
}

export function reviveCommand(raw: unknown): Command {
  const r = raw as RawCommand;
  if (typeof r.kind !== 'string' || typeof r.commandId !== 'string') {
    throw new Error('NDJSON: malformed Command (missing kind or commandId)');
  }
  // Revive bigints kind-by-kind. Schema is the source of truth for u64
  // fields; missing values fall through to the proto3 defaults the in-process
  // path already accepts.
  switch (r.kind) {
    case 'newRun':
      return { ...r, seed: BigInt(r.seed ?? '0') } as Command;
    case 'step':
      return { ...r, ticks: BigInt(r.ticks ?? '0') } as Command;
    case 'rewindToTick':
      return { ...r, tick: BigInt(r.tick ?? '0') } as Command;
    default:
      return r as unknown as Command;
  }
}

export function decodeCommand(line: string): Command {
  return reviveCommand(JSON.parse(line));
}

// ─── Query revival ───────────────────────────────────────────────────────────

interface RawQuery {
  readonly kind?: string;
  readonly queryId?: string;
  readonly fromTick?: string;
  readonly toTick?: string;
  readonly [k: string]: unknown;
}

export function reviveQuery(raw: unknown): Query {
  const r = raw as RawQuery;
  if (typeof r.kind !== 'string' || typeof r.queryId !== 'string') {
    throw new Error('NDJSON: malformed Query (missing kind or queryId)');
  }
  if (r.kind === 'logSlice') {
    return {
      ...r,
      fromTick: BigInt(r.fromTick ?? '0'),
      toTick: BigInt(r.toTick ?? '0'),
    } as Query;
  }
  return r as unknown as Query;
}

export function decodeQuery(line: string): Query {
  return reviveQuery(JSON.parse(line));
}

// ─── SimEvent revival ────────────────────────────────────────────────────────

interface RawEvent {
  readonly kind?: string;
  readonly simTick?: string;
  readonly populationTotal?: string;
  readonly populationByLineage?: Readonly<Record<string, string>>;
  readonly originCompute?: string;
  readonly originComputeMax?: string;
  readonly probesAffected?: string;
  readonly carrierPopulation?: string;
  readonly totalPopulation?: string;
  readonly [k: string]: unknown;
}

export function reviveEvent(raw: unknown): SimEvent {
  const r = raw as RawEvent;
  if (typeof r.kind !== 'string' || typeof r.simTick !== 'string') {
    throw new Error('NDJSON: malformed SimEvent (missing kind or simTick)');
  }
  const simTick = BigInt(r.simTick);
  switch (r.kind) {
    case 'tick': {
      const byLineage: Record<string, bigint> = {};
      const map = r.populationByLineage ?? {};
      for (const [k, v] of Object.entries(map)) {
        byLineage[k] = BigInt(v);
      }
      return {
        ...r,
        simTick,
        populationTotal: BigInt(r.populationTotal ?? '0'),
        populationByLineage: byLineage,
        originCompute: BigInt(r.originCompute ?? '0'),
        originComputeMax: BigInt(r.originComputeMax ?? '0'),
      } as SimEvent;
    }
    case 'patchApplied':
      return {
        ...r,
        simTick,
        probesAffected: BigInt(r.probesAffected ?? '0'),
      } as SimEvent;
    case 'patchSaturated':
      return {
        ...r,
        simTick,
        carrierPopulation: BigInt(r.carrierPopulation ?? '0'),
        totalPopulation: BigInt(r.totalPopulation ?? '0'),
      } as SimEvent;
    case 'decreeFired':
      return {
        ...r,
        simTick,
        probesAffected: BigInt(r.probesAffected ?? '0'),
      } as SimEvent;
    default:
      return { ...r, simTick } as SimEvent;
  }
}

export function decodeEvent(line: string): SimEvent {
  return reviveEvent(JSON.parse(line));
}

// ─── QueryResult revival ─────────────────────────────────────────────────────

interface RawQueryResult {
  readonly kind?: string;
  readonly queryId?: string;
  readonly lineages?: readonly RawLineageEntry[];
  readonly probe?: RawProbe | null;
  readonly drift?: RawDriftWrapper | null;
  readonly lineageId?: string;
  readonly cells?: readonly string[];
  readonly maxResourcePerCell?: string;
  readonly side?: number;
  readonly probes?: readonly unknown[];
  readonly decrees?: readonly RawDecreeEntry[];
  readonly [k: string]: unknown;
}

interface RawLineageEntry {
  readonly id: string;
  readonly name: string;
  readonly parentLineageId: string;
  readonly foundedAtTick: string;
  // Decimal string when the lineage is extinct, null while alive, or
  // missing on a payload from a host that predates the field. The
  // reviver normalises absence to null.
  readonly extinctionTick?: string | null;
  readonly founderProbeId: string;
  readonly patches: readonly string[];
  readonly quarantined: boolean;
}

interface RawProbe {
  readonly id: string;
  readonly lineageId: string;
  readonly bornAtTick: string;
  readonly firmware: readonly unknown[];
}

interface RawDriftWrapper {
  readonly population: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly divergenceDivisor: string;
  readonly referenceFirmware: readonly unknown[];
  readonly patches: readonly string[];
}

interface RawDecreeEntry {
  readonly id: string;
  readonly queuedAtTick: string;
  readonly trigger: unknown;
  readonly patchTargetLineageId: string;
  readonly patchFirmware: readonly unknown[];
}

export function reviveQueryResult(raw: unknown): QueryResult {
  const r = raw as RawQueryResult;
  if (typeof r.kind !== 'string' || typeof r.queryId !== 'string') {
    throw new Error('NDJSON: malformed QueryResult (missing kind or queryId)');
  }
  switch (r.kind) {
    case 'lineageTree': {
      const lineages = (r.lineages ?? []).map((e) => ({
        ...e,
        foundedAtTick: BigInt(e.foundedAtTick),
        // Older host payloads omit the field; missing → null. Live
        // lineages also come back as null.
        extinctionTick:
          e.extinctionTick === null || e.extinctionTick === undefined
            ? null
            : BigInt(e.extinctionTick),
      }));
      return { ...r, lineages } as QueryResult;
    }
    case 'probeInspector': {
      if (r.probe === null || r.probe === undefined) {
        return { ...r, probe: null } as QueryResult;
      }
      const probe = { ...r.probe, bornAtTick: BigInt(r.probe.bornAtTick) };
      return { ...r, probe } as QueryResult;
    }
    case 'driftTelemetry': {
      if (r.drift === null || r.drift === undefined) {
        return { ...r, drift: null } as QueryResult;
      }
      const drift = { ...r.drift, population: BigInt(r.drift.population) };
      return { ...r, drift } as QueryResult;
    }
    case 'decreeQueue': {
      const decrees = (r.decrees ?? []).map((d) => ({
        ...d,
        queuedAtTick: BigInt(d.queuedAtTick),
      }));
      return { ...r, decrees } as QueryResult;
    }
    default:
      return r as unknown as QueryResult;
  }
}

export function decodeQueryResult(line: string): QueryResult {
  return reviveQueryResult(JSON.parse(line));
}

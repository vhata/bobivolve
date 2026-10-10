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

import type {
  Command,
  CommandBody,
  Query,
  QueryBody,
  QueryResult,
  QueryResultBody,
  SimEvent,
  SimEventBody,
} from '../protocol/types.js';
import { parseUint64Decimal } from '../protocol/uint64.js';

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

// ─── Strict field parsing ────────────────────────────────────────────────────

// Every u64 field must arrive as a decimal string within u64 range. A
// missing, numeric, signed, hex or out-of-range value is a malformed
// message, not a proto3 default: the emitters on both sides always write
// these fields, so absence means a broken or foreign peer.
function u64(value: unknown, field: string, message: string): bigint {
  if (typeof value === 'string') {
    const parsed = parseUint64Decimal(value);
    if (parsed !== null) return parsed;
  }
  throw new Error(`NDJSON: malformed ${message} (${field} is not a decimal u64 string)`);
}

function list(value: unknown, field: string, message: string): readonly unknown[] {
  if (Array.isArray(value)) return value as readonly unknown[];
  throw new Error(`NDJSON: malformed ${message} (${field} is not an array)`);
}

function record(value: unknown, field: string, message: string): Readonly<Record<string, unknown>> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Readonly<Record<string, unknown>>;
  }
  throw new Error(`NDJSON: malformed ${message} (${field} is not an object)`);
}

// Compile-time exhaustiveness: adding a kind to a protocol union without
// deciding how this codec revives it is a type error. At runtime an
// unknown kind passes through unchanged, as before.
function passThroughUnknownKind(_kind: never): void {}

// ─── Command revival ─────────────────────────────────────────────────────────

export function reviveCommand(raw: unknown): Command {
  const r = record(raw, 'command', 'Command');
  if (typeof r['kind'] !== 'string' || typeof r['commandId'] !== 'string') {
    throw new Error('NDJSON: malformed Command (missing kind or commandId)');
  }
  // Revive bigints kind-by-kind.
  const kind = r['kind'] as CommandBody['kind'];
  switch (kind) {
    case 'newRun':
      return { ...r, seed: u64(r['seed'], 'seed', 'Command') } as unknown as Command;
    case 'step':
      return { ...r, ticks: u64(r['ticks'], 'ticks', 'Command') } as unknown as Command;
    case 'rewindToTick':
      return { ...r, tick: u64(r['tick'], 'tick', 'Command') } as unknown as Command;
    case 'setSpeed':
    case 'pause':
    case 'resume':
    case 'configureAutoPause':
    case 'quarantine':
    case 'releaseQuarantine':
    case 'applyPatch':
    case 'queueDecree':
    case 'revokeDecree':
    case 'save':
    case 'deleteSave':
    case 'load':
    case 'switchRun':
    case 'deleteRun':
      return r as unknown as Command;
    default:
      passThroughUnknownKind(kind);
      return r as unknown as Command;
  }
}

export function decodeCommand(line: string): Command {
  return reviveCommand(JSON.parse(line));
}

// ─── Query revival ───────────────────────────────────────────────────────────

export function reviveQuery(raw: unknown): Query {
  const r = record(raw, 'query', 'Query');
  if (typeof r['kind'] !== 'string' || typeof r['queryId'] !== 'string') {
    throw new Error('NDJSON: malformed Query (missing kind or queryId)');
  }
  const kind = r['kind'] as QueryBody['kind'];
  switch (kind) {
    case 'logSlice':
      return {
        ...r,
        fromTick: u64(r['fromTick'], 'fromTick', 'Query'),
        toTick: u64(r['toTick'], 'toTick', 'Query'),
      } as unknown as Query;
    case 'lineageTree':
    case 'probeInspector':
    case 'driftTelemetry':
    case 'populationSummary':
    case 'listSaves':
    case 'substrate':
    case 'decreeQueue':
    case 'listRuns':
      return r as unknown as Query;
    default:
      passThroughUnknownKind(kind);
      return r as unknown as Query;
  }
}

export function decodeQuery(line: string): Query {
  return reviveQuery(JSON.parse(line));
}

// ─── SimEvent revival ────────────────────────────────────────────────────────

export function reviveEvent(raw: unknown): SimEvent {
  const r = record(raw, 'event', 'SimEvent');
  if (typeof r['kind'] !== 'string' || typeof r['simTick'] !== 'string') {
    throw new Error('NDJSON: malformed SimEvent (missing kind or simTick)');
  }
  const m = 'SimEvent';
  const simTick = u64(r['simTick'], 'simTick', m);
  const kind = r['kind'] as SimEventBody['kind'];
  switch (kind) {
    case 'tick': {
      const byLineage: Record<string, bigint> = {};
      const map = record(r['populationByLineage'], 'populationByLineage', m);
      for (const [k, v] of Object.entries(map)) {
        byLineage[k] = u64(v, `populationByLineage.${k}`, m);
      }
      return {
        ...r,
        simTick,
        populationTotal: u64(r['populationTotal'], 'populationTotal', m),
        populationByLineage: byLineage,
        originCompute: u64(r['originCompute'], 'originCompute', m),
        originComputeMax: u64(r['originComputeMax'], 'originComputeMax', m),
      } as unknown as SimEvent;
    }
    case 'patchApplied':
    case 'decreeFired':
      return {
        ...r,
        simTick,
        probesAffected: u64(r['probesAffected'], 'probesAffected', m),
      } as unknown as SimEvent;
    case 'patchSaturated':
      return {
        ...r,
        simTick,
        carrierPopulation: u64(r['carrierPopulation'], 'carrierPopulation', m),
        totalPopulation: u64(r['totalPopulation'], 'totalPopulation', m),
      } as unknown as SimEvent;
    case 'replication':
    case 'speciation':
    case 'extinction':
    case 'death':
    case 'autoPaused':
    case 'commandAck':
    case 'commandError':
    case 'quarantineImposed':
    case 'quarantineLifted':
    case 'decreeQueued':
    case 'decreeRevoked':
      return { ...r, simTick } as unknown as SimEvent;
    default:
      passThroughUnknownKind(kind);
      return { ...r, simTick } as unknown as SimEvent;
  }
}

export function decodeEvent(line: string): SimEvent {
  return reviveEvent(JSON.parse(line));
}

// ─── QueryResult revival ─────────────────────────────────────────────────────

export function reviveQueryResult(raw: unknown): QueryResult {
  const r = record(raw, 'result', 'QueryResult');
  if (typeof r['kind'] !== 'string' || typeof r['queryId'] !== 'string') {
    throw new Error('NDJSON: malformed QueryResult (missing kind or queryId)');
  }
  const m = 'QueryResult';
  const kind = r['kind'] as QueryResultBody['kind'];
  switch (kind) {
    case 'lineageTree': {
      const lineages = list(r['lineages'], 'lineages', m).map((item, i) => {
        const e = record(item, `lineages[${i}]`, m);
        return {
          ...e,
          foundedAtTick: u64(e['foundedAtTick'], `lineages[${i}].foundedAtTick`, m),
          // Older host payloads omit the field; missing → null. Live
          // lineages also come back as null.
          extinctionTick:
            e['extinctionTick'] === null || e['extinctionTick'] === undefined
              ? null
              : u64(e['extinctionTick'], `lineages[${i}].extinctionTick`, m),
        };
      });
      return { ...r, lineages } as unknown as QueryResult;
    }
    case 'probeInspector': {
      if (r['probe'] === null || r['probe'] === undefined) {
        return { ...r, probe: null } as unknown as QueryResult;
      }
      const p = record(r['probe'], 'probe', m);
      const probe = { ...p, bornAtTick: u64(p['bornAtTick'], 'probe.bornAtTick', m) };
      return { ...r, probe } as unknown as QueryResult;
    }
    case 'driftTelemetry': {
      if (r['drift'] === null || r['drift'] === undefined) {
        return { ...r, drift: null } as unknown as QueryResult;
      }
      const d = record(r['drift'], 'drift', m);
      const drift = { ...d, population: u64(d['population'], 'drift.population', m) };
      return { ...r, drift } as unknown as QueryResult;
    }
    case 'logSlice': {
      const events = list(r['events'], 'events', m).map((e) => reviveEvent(e));
      return { ...r, events } as unknown as QueryResult;
    }
    case 'populationSummary': {
      const points = list(r['points'], 'points', m).map((item, i) => {
        const p = record(item, `points[${i}]`, m);
        return {
          ...p,
          tick: u64(p['tick'], `points[${i}].tick`, m),
          totalProbes: u64(p['totalProbes'], `points[${i}].totalProbes`, m),
        };
      });
      return { ...r, points } as unknown as QueryResult;
    }
    case 'decreeQueue': {
      const decrees = list(r['decrees'], 'decrees', m).map((item, i) => {
        const d = record(item, `decrees[${i}]`, m);
        return { ...d, queuedAtTick: u64(d['queuedAtTick'], `decrees[${i}].queuedAtTick`, m) };
      });
      return { ...r, decrees } as unknown as QueryResult;
    }
    case 'listSaves':
    case 'substrate':
    case 'listRuns':
      return r as unknown as QueryResult;
    default:
      passThroughUnknownKind(kind);
      return r as unknown as QueryResult;
  }
}

export function decodeQueryResult(line: string): QueryResult {
  return reviveQueryResult(JSON.parse(line));
}

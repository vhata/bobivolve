// NDJSON codec round trips and strict u64 parsing.

import { describe, expect, it } from 'vitest';
import {
  COMMAND_SAMPLES,
  EVENT_SAMPLES,
  QUERY_RESULT_SAMPLES,
  QUERY_SAMPLES,
} from '../protocol/test-samples.js';
import {
  decodeCommand,
  decodeEvent,
  decodeQuery,
  decodeQueryResult,
  encodeLine,
  reviveCommand,
  reviveEvent,
  reviveQuery,
  reviveQueryResult,
} from './ndjson-codec.js';

// What the peer would put on the wire: bigints as decimal strings.
function wire(value: unknown): Record<string, unknown> {
  return JSON.parse(encodeLine(value)) as Record<string, unknown>;
}

describe('NDJSON codec round trips', () => {
  it.each(Object.entries(COMMAND_SAMPLES))('revives every bigint in command %s', (_k, sample) => {
    expect(decodeCommand(encodeLine(sample))).toStrictEqual(sample);
  });

  it.each(Object.entries(QUERY_SAMPLES))('revives every bigint in query %s', (_k, sample) => {
    expect(decodeQuery(encodeLine(sample))).toStrictEqual(sample);
  });

  it.each(Object.entries(EVENT_SAMPLES))('revives every bigint in event %s', (_k, sample) => {
    expect(decodeEvent(encodeLine(sample))).toStrictEqual(sample);
  });

  it.each(Object.entries(QUERY_RESULT_SAMPLES))(
    'revives every bigint in query result %s',
    (_k, sample) => {
      expect(decodeQueryResult(encodeLine(sample))).toStrictEqual(sample);
    },
  );

  it('revives populationSummary points as bigints', () => {
    const result = reviveQueryResult({
      kind: 'populationSummary',
      queryId: 'q',
      points: [{ tick: '5', totalProbes: '3' }],
    });
    expect(result).toStrictEqual({
      kind: 'populationSummary',
      queryId: 'q',
      points: [{ tick: 5n, totalProbes: 3n }],
    });
  });

  it('revives logSlice events as SimEvents', () => {
    const result = reviveQueryResult({
      kind: 'logSlice',
      queryId: 'q',
      events: [
        { kind: 'patchApplied', simTick: '7', lineageId: 'L0', probesAffected: '2', patchId: 'p' },
      ],
    });
    expect(result).toStrictEqual({
      kind: 'logSlice',
      queryId: 'q',
      events: [
        { kind: 'patchApplied', simTick: 7n, lineageId: 'L0', probesAffected: 2n, patchId: 'p' },
      ],
    });
  });

  it('keeps accepting lineage entries that predate extinctionTick', () => {
    const raw = wire(QUERY_RESULT_SAMPLES.lineageTree);
    const lineages = raw['lineages'] as Record<string, unknown>[];
    for (const entry of lineages) delete entry['extinctionTick'];
    const result = reviveQueryResult(raw);
    if (result.kind !== 'lineageTree') throw new Error('unreachable');
    expect(result.lineages.map((e) => e.extinctionTick)).toStrictEqual([null, null]);
  });
});

describe('NDJSON codec strict u64 parsing', () => {
  const malformed: readonly [string, unknown][] = [
    ['a missing', undefined],
    ['a JSON number', 42],
    ['a negative', '-1'],
    ['a hex', '0x10'],
    ['a padded', ' 5'],
    ['an empty', ''],
    ['an out-of-range', '18446744073709551616'],
  ];

  it.each(malformed)('rejects %s command seed', (_label, seed) => {
    const raw = { ...wire(COMMAND_SAMPLES.newRun), seed };
    expect(() => reviveCommand(raw)).toThrow(/NDJSON: malformed Command \(seed/);
  });

  it.each(malformed)('rejects %s step ticks', (_label, ticks) => {
    const raw = { ...wire(COMMAND_SAMPLES.step), ticks };
    expect(() => reviveCommand(raw)).toThrow(/NDJSON: malformed Command \(ticks/);
  });

  it.each(malformed)('rejects %s rewind tick', (_label, tick) => {
    const raw = { ...wire(COMMAND_SAMPLES.rewindToTick), tick };
    expect(() => reviveCommand(raw)).toThrow(/NDJSON: malformed Command \(tick/);
  });

  it.each(malformed)('rejects %s logSlice fromTick', (_label, fromTick) => {
    const raw = { ...wire(QUERY_SAMPLES.logSlice), fromTick };
    expect(() => reviveQuery(raw)).toThrow(/NDJSON: malformed Query \(fromTick/);
  });

  it.each(malformed)('rejects %s logSlice toTick', (_label, toTick) => {
    const raw = { ...wire(QUERY_SAMPLES.logSlice), toTick };
    expect(() => reviveQuery(raw)).toThrow(/NDJSON: malformed Query \(toTick/);
  });

  it('rejects a non-decimal simTick', () => {
    const raw = { ...wire(EVENT_SAMPLES.extinction), simTick: '-3' };
    expect(() => reviveEvent(raw)).toThrow(/NDJSON: malformed SimEvent \(simTick/);
  });

  it.each(['populationTotal', 'originCompute', 'originComputeMax', 'populationByLineage'] as const)(
    'rejects a tick event with no %s',
    (field) => {
      const raw = wire(EVENT_SAMPLES.tick);
      delete raw[field];
      expect(() => reviveEvent(raw)).toThrow(new RegExp(`malformed SimEvent \\(${field}`));
    },
  );

  it('rejects a malformed per-lineage population', () => {
    const raw = { ...wire(EVENT_SAMPLES.tick), populationByLineage: { L0: 'many' } };
    expect(() => reviveEvent(raw)).toThrow(/populationByLineage\.L0/);
  });

  it.each([
    ['patchApplied', 'probesAffected'],
    ['decreeFired', 'probesAffected'],
    ['patchSaturated', 'carrierPopulation'],
    ['patchSaturated', 'totalPopulation'],
  ] as const)('rejects %s event with no %s', (kind, field) => {
    const raw = wire(EVENT_SAMPLES[kind]);
    delete raw[field];
    expect(() => reviveEvent(raw)).toThrow(new RegExp(`malformed SimEvent \\(${field}`));
  });

  it('rejects a populationSummary point with a missing tick', () => {
    const raw = { kind: 'populationSummary', queryId: 'q', points: [{ totalProbes: '3' }] };
    expect(() => reviveQueryResult(raw)).toThrow(/points\[0\]\.tick/);
  });

  it('rejects a populationSummary result with no points', () => {
    expect(() => reviveQueryResult({ kind: 'populationSummary', queryId: 'q' })).toThrow(
      /malformed QueryResult \(points is not an array/,
    );
  });

  it('rejects a logSlice result carrying a malformed event', () => {
    const raw = { kind: 'logSlice', queryId: 'q', events: [{ kind: 'extinction', simTick: 4 }] };
    expect(() => reviveQueryResult(raw)).toThrow(/malformed SimEvent/);
  });

  it.each([
    ['lineageTree', 'lineages[0].foundedAtTick'],
    ['lineageTree', 'lineages[0].extinctionTick'],
    ['probeInspector', 'probe.bornAtTick'],
    ['driftTelemetry', 'drift.population'],
    ['decreeQueue', 'decrees[0].queuedAtTick'],
  ] as const)('rejects a malformed %s %s', (kind, path) => {
    const raw = wire(QUERY_RESULT_SAMPLES[kind]);
    // Walk to the parent object of the leaf and corrupt the leaf.
    const keys = path.replace(/\[(\d+)\]/g, '.$1').split('.');
    const leaf = keys.pop() as string;
    let target = raw as Record<string, unknown>;
    for (const key of keys) target = target[key] as Record<string, unknown>;
    target[leaf] = '1.5';
    const escaped = path.replace(/[[\].]/g, '\\$&');
    expect(() => reviveQueryResult(raw)).toThrow(new RegExp(`malformed QueryResult \\(${escaped}`));
  });

  it('rejects a non-object message', () => {
    expect(() => reviveCommand(null)).toThrow(/malformed Command/);
    expect(() => reviveQuery('x')).toThrow(/malformed Query/);
    expect(() => reviveEvent([])).toThrow(/malformed SimEvent/);
    expect(() => reviveQueryResult(7)).toThrow(/malformed QueryResult/);
  });
});

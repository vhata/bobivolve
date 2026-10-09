// Fully populated sample of every protocol message kind, for tests only.
//
// Each table is keyed by `kind` and typed so that adding a kind to a
// protocol union without a sample here is a type error. Every field,
// including optional ones, is populated so the schema parity test can
// compare field sets in both directions. Bigint values exceed 2^53 where
// the field is u64, so a lossy JSON round trip shows up as a mismatch.
//
// Used by `protocol/schema-parity.test.ts` and
// `transport/ndjson-codec.test.ts`.

import type { Command, DirectiveSpec, Query, QueryResult, SimEvent } from './types.js';

type ByKind<U extends { readonly kind: string }> = {
  readonly [K in U['kind']]: Extract<U, { readonly kind: K }>;
};

// Larger than Number.MAX_SAFE_INTEGER, so a number-typed decode loses it.
const BIG = 9_007_199_254_740_993n;
const U64_MAX = 18_446_744_073_709_551_615n;

const FIRMWARE: readonly DirectiveSpec[] = [
  { kind: 'replicate', params: { threshold: '18446744073709551615' } },
  { kind: 'gather', params: { rate: '2' } },
];

export const COMMAND_SAMPLES: ByKind<Command> = {
  newRun: { kind: 'newRun', commandId: 'c-newRun', seed: U64_MAX },
  setSpeed: { kind: 'setSpeed', commandId: 'c-setSpeed', speed: 16 },
  pause: { kind: 'pause', commandId: 'c-pause' },
  resume: { kind: 'resume', commandId: 'c-resume' },
  step: { kind: 'step', commandId: 'c-step', ticks: BIG },
  configureAutoPause: {
    kind: 'configureAutoPause',
    commandId: 'c-configureAutoPause',
    enabledTriggers: ['lineage_extinction'],
  },
  quarantine: { kind: 'quarantine', commandId: 'c-quarantine', lineageId: 'L1' },
  releaseQuarantine: {
    kind: 'releaseQuarantine',
    commandId: 'c-releaseQuarantine',
    lineageId: 'L1',
  },
  applyPatch: {
    kind: 'applyPatch',
    commandId: 'c-applyPatch',
    lineageId: 'L0',
    firmware: FIRMWARE,
  },
  queueDecree: {
    kind: 'queueDecree',
    commandId: 'c-queueDecree',
    trigger: { kind: 'populationBelow', lineageId: 'L1', threshold: '5' },
    patchTargetLineageId: 'L0',
    patchFirmware: FIRMWARE,
  },
  revokeDecree: { kind: 'revokeDecree', commandId: 'c-revokeDecree', decreeId: 'D1' },
  save: { kind: 'save', commandId: 'c-save', slot: 'slot-a' },
  deleteSave: { kind: 'deleteSave', commandId: 'c-deleteSave', slot: 'slot-a' },
  load: { kind: 'load', commandId: 'c-load', slot: 'slot-a' },
  rewindToTick: { kind: 'rewindToTick', commandId: 'c-rewindToTick', tick: BIG },
  switchRun: { kind: 'switchRun', commandId: 'c-switchRun', runId: 'run-b' },
  deleteRun: { kind: 'deleteRun', commandId: 'c-deleteRun', runId: 'run-b' },
};

export const EVENT_SAMPLES: ByKind<SimEvent> = {
  tick: {
    kind: 'tick',
    simTick: BIG,
    actualSpeed: 4,
    populationTotal: BIG + 1n,
    populationByLineage: { L0: BIG, L1: 3n },
    originCompute: BIG + 2n,
    originComputeMax: U64_MAX,
    paused: false,
    speed: 4,
  },
  replication: {
    kind: 'replication',
    simTick: 10n,
    parentProbeId: 'P1',
    childProbeId: 'P2',
    lineageId: 'L0',
    mutated: true,
  },
  speciation: {
    kind: 'speciation',
    simTick: 11n,
    parentLineageId: 'L0',
    newLineageId: 'L1',
    newLineageName: 'Bob-1',
    founderProbeId: 'P2',
  },
  extinction: { kind: 'extinction', simTick: 12n, lineageId: 'L1' },
  death: { kind: 'death', simTick: 13n, probeId: 'P2', lineageId: 'L1' },
  autoPaused: { kind: 'autoPaused', simTick: 14n, trigger: 'lineage_extinction' },
  commandAck: { kind: 'commandAck', simTick: 15n, commandId: 'c1' },
  commandError: { kind: 'commandError', simTick: 16n, commandId: 'c2', message: 'nope' },
  quarantineImposed: { kind: 'quarantineImposed', simTick: 17n, lineageId: 'L0' },
  quarantineLifted: {
    kind: 'quarantineLifted',
    simTick: 18n,
    reason: 'computeExhausted',
    lineageId: 'L0',
  },
  patchApplied: {
    kind: 'patchApplied',
    simTick: 19n,
    lineageId: 'L0',
    probesAffected: BIG,
    patchId: 'patch-1',
  },
  patchSaturated: {
    kind: 'patchSaturated',
    simTick: 20n,
    patchId: 'patch-1',
    carrierPopulation: BIG,
    totalPopulation: BIG + 1n,
  },
  decreeQueued: { kind: 'decreeQueued', simTick: 21n, decreeId: 'D1' },
  decreeFired: {
    kind: 'decreeFired',
    simTick: 22n,
    decreeId: 'D1',
    patchTargetLineageId: 'L0',
    landed: true,
    probesAffected: BIG,
  },
  decreeRevoked: { kind: 'decreeRevoked', simTick: 23n, decreeId: 'D2' },
};

export const QUERY_SAMPLES: ByKind<Query> = {
  lineageTree: { kind: 'lineageTree', queryId: 'q-lineageTree' },
  probeInspector: { kind: 'probeInspector', queryId: 'q-probeInspector', probeId: 'P1' },
  driftTelemetry: { kind: 'driftTelemetry', queryId: 'q-driftTelemetry', lineageId: 'L0' },
  logSlice: { kind: 'logSlice', queryId: 'q-logSlice', fromTick: BIG, toTick: U64_MAX },
  populationSummary: { kind: 'populationSummary', queryId: 'q-populationSummary' },
  listSaves: { kind: 'listSaves', queryId: 'q-listSaves' },
  substrate: { kind: 'substrate', queryId: 'q-substrate' },
  decreeQueue: { kind: 'decreeQueue', queryId: 'q-decreeQueue' },
  listRuns: { kind: 'listRuns', queryId: 'q-listRuns' },
};

export const QUERY_RESULT_SAMPLES: ByKind<QueryResult> = {
  lineageTree: {
    kind: 'lineageTree',
    queryId: 'q-lineageTree',
    lineages: [
      {
        id: 'L0',
        name: 'Bob',
        parentLineageId: '',
        foundedAtTick: 0n,
        extinctionTick: BIG,
        founderProbeId: 'P0',
        patches: ['patch-1'],
        quarantined: false,
      },
      {
        id: 'L1',
        name: 'Bob-1',
        parentLineageId: 'L0',
        foundedAtTick: BIG,
        extinctionTick: null,
        founderProbeId: 'P2',
        patches: [],
        quarantined: true,
      },
    ],
  },
  probeInspector: {
    kind: 'probeInspector',
    queryId: 'q-probeInspector',
    probe: { id: 'P1', lineageId: 'L0', bornAtTick: BIG, firmware: FIRMWARE },
  },
  driftTelemetry: {
    kind: 'driftTelemetry',
    queryId: 'q-driftTelemetry',
    lineageId: 'L0',
    drift: {
      population: BIG,
      parameters: {
        'replicate.threshold': { reference: '100', min: '99', max: '101', mean: '100' },
      },
      divergenceDivisor: '100',
      referenceFirmware: FIRMWARE,
      patches: ['patch-1'],
      patchProvenance: [
        {
          patchId: 'patch-1',
          targetLineageId: 'L0',
          appliedAtTick: '19',
          ancestryPopulation: '7',
          authoredFirmware: FIRMWARE,
          exactMatchPopulation: '3',
          selectedExactMatchPopulation: '2',
          referenceMatches: true,
        },
      ],
    },
  },
  logSlice: {
    kind: 'logSlice',
    queryId: 'q-logSlice',
    events: [EVENT_SAMPLES.tick, EVENT_SAMPLES.patchSaturated, EVENT_SAMPLES.extinction],
  },
  populationSummary: {
    kind: 'populationSummary',
    queryId: 'q-populationSummary',
    points: [
      { tick: 5n, totalProbes: 3n },
      { tick: BIG, totalProbes: U64_MAX },
    ],
  },
  listSaves: {
    kind: 'listSaves',
    queryId: 'q-listSaves',
    saves: [{ slot: 'slot-a', tick: '18446744073709551615', savedAtMs: 1_791_445_224_509 }],
  },
  substrate: {
    kind: 'substrate',
    queryId: 'q-substrate',
    side: 2,
    cells: ['0', '1', '2', '18446744073709551615'],
    caps: ['0', '4', '4', '18446744073709551615'],
    maxResourcePerCell: '18446744073709551615',
    probes: [{ id: 'P1', lineageId: 'L0', x: 1, y: 0 }],
  },
  decreeQueue: {
    kind: 'decreeQueue',
    queryId: 'q-decreeQueue',
    decrees: [
      {
        id: 'D1',
        queuedAtTick: BIG,
        trigger: { kind: 'populationBelow', lineageId: 'L1', threshold: '5' },
        patchTargetLineageId: 'L0',
        patchFirmware: FIRMWARE,
      },
    ],
  },
  listRuns: {
    kind: 'listRuns',
    queryId: 'q-listRuns',
    runs: [
      { runId: 'default', latestTick: '18446744073709551615', lastModifiedMs: 1791445224509.25 },
    ],
    activeRunId: 'default',
  },
};

// Hand-written stand-in for codegen output.
//
// `protocol/schema.proto` is the single source of truth for the sim/UI seam
// (ARCHITECTURE.md "Protocol and IDL"). Codegen via ts-proto / protoc / buf is
// intentionally deferred — this file mirrors the proto definitions by hand so
// the seam can be exercised end-to-end before the codegen toolchain lands.
// When ts-proto is wired in, this file becomes the contract test for the
// generated output and is then deleted.
//
// Conventions:
//   - PascalCase types, camelCase fields. This matches the proto3 JSON wire
//     encoding the architecture pins as the on-the-wire shape.
//   - `bigint` for `uint64` fields (simTick, seed, ticks, populationTotal,
//     and the values of the population_by_lineage map).
//   - `oneof` bodies are encoded as discriminated unions tagged with `kind`.
//     The Command / SimEvent / Query / QueryResult envelopes are intersection
//     types: a header (commandId / simTick / queryId) plus the union body.
//   - Optional proto3 fields are TypeScript-optional. Required scalars get
//     their proto3 defaults at the seam (empty string, 0n) — the wire shape
//     is unchanged but reading code may need to handle absent fields.
//
// Field numbers from the proto are not encoded here; they matter to wire-format
// codegen, not to the in-process transport this file enables.

// ─────────────────────────────────────────────────────────────────────────────
// Command — UI → sim. Fire-and-forget; the sim acknowledges via SimEvent.
// ─────────────────────────────────────────────────────────────────────────────

export interface NewRunCommand {
  readonly kind: 'newRun';
  readonly seed: bigint;
}

export interface SetSpeedCommand {
  readonly kind: 'setSpeed';
  // Allowed values: 1, 4, 16, 64. Validated at the seam.
  readonly speed: number;
}

export interface PauseCommand {
  readonly kind: 'pause';
}

export interface ResumeCommand {
  readonly kind: 'resume';
}

export interface StepCommand {
  readonly kind: 'step';
  // Number of sim ticks to advance while paused. Zero is treated as one.
  readonly ticks: bigint;
}

export interface ConfigureAutoPauseCommand {
  readonly kind: 'configureAutoPause';
  readonly enabledTriggers: readonly string[];
}

export interface QuarantineCommand {
  readonly kind: 'quarantine';
  // Target lineage. Idempotent: quarantining an already-quarantined
  // lineage succeeds as a no-op (CommandAck without an event).
  readonly lineageId: string;
}

export interface ReleaseQuarantineCommand {
  readonly kind: 'releaseQuarantine';
  // Target lineage. Idempotent: releasing a non-quarantined lineage
  // succeeds as a no-op (CommandAck without an event).
  readonly lineageId: string;
}

export interface ApplyPatchCommand {
  readonly kind: 'applyPatch';
  // Target lineage; must be living. Patched firmware overwrites the
  // lineage's reference firmware and every extant probe in the
  // lineage; descendants inherit and drift like any firmware.
  readonly lineageId: string;
  // Full directive stack to install. Validated server-side against
  // MIN_FIRMWARE_LENGTH; the host replies CommandError on too-short.
  readonly firmware: readonly DirectiveSpec[];
}

// Decree trigger discriminated union. R2 V1 ships only populationBelow.
export type DecreeTriggerSpec = PopulationBelowTriggerSpec;

export interface PopulationBelowTriggerSpec {
  readonly kind: 'populationBelow';
  readonly lineageId: string;
  // Strict-less-than threshold. Decimal string for u64 safety.
  readonly threshold: string;
}

export interface QueueDecreeCommand {
  readonly kind: 'queueDecree';
  readonly trigger: DecreeTriggerSpec;
  readonly patchTargetLineageId: string;
  readonly patchFirmware: readonly DirectiveSpec[];
}

export interface RevokeDecreeCommand {
  readonly kind: 'revokeDecree';
  readonly decreeId: string;
}

// DirectiveSpec — wire shape for a directive carried on a Command.
// Mirrors ProbeInspectorDirective (same fields, query-result variant).
// Numeric params are decimal strings per the proto3 JSON convention so
// u64 values survive a JSON-encoded transport.
export interface DirectiveSpec {
  readonly kind: string;
  readonly params: Readonly<Record<string, string>>;
}

export interface SaveCommand {
  readonly kind: 'save';
  readonly slot: string;
}

export interface LoadCommand {
  readonly kind: 'load';
  readonly slot: string;
}

export type CommandBody =
  | NewRunCommand
  | SetSpeedCommand
  | PauseCommand
  | ResumeCommand
  | StepCommand
  | ConfigureAutoPauseCommand
  | QuarantineCommand
  | ReleaseQuarantineCommand
  | ApplyPatchCommand
  | QueueDecreeCommand
  | RevokeDecreeCommand
  | SaveCommand
  | LoadCommand;

export type Command = CommandBody & {
  // Caller-supplied id. The sim echoes it on CommandAck / CommandError so the
  // UI can correlate. Empty string permitted; the UI then forfeits ack.
  readonly commandId: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// SimEvent — sim → UI. Heartbeat (Tick) is best-effort; domain events are
// guaranteed in-order.
// ─────────────────────────────────────────────────────────────────────────────

export interface TickEvent {
  readonly kind: 'tick';
  readonly actualSpeed: number;
  readonly populationTotal: bigint;
  readonly populationByLineage: Readonly<Record<string, bigint>>;
  // Origin compute budget at this heartbeat. bigint so the seam can
  // pass u64 cleanly; the proto3 wire encoding stringifies it. Max is
  // the cap regen targets — the dashboard normalises against it
  // without having to hard-code the sim tuning.
  readonly originCompute: bigint;
  readonly originComputeMax: bigint;
}

export interface ReplicationEvent {
  readonly kind: 'replication';
  readonly parentProbeId: string;
  readonly childProbeId: string;
  readonly lineageId: string;
  readonly mutated: boolean;
}

export interface SpeciationEvent {
  readonly kind: 'speciation';
  readonly parentLineageId: string;
  readonly newLineageId: string;
  readonly newLineageName: string;
  readonly founderProbeId: string;
}

export interface ExtinctionEvent {
  readonly kind: 'extinction';
  readonly lineageId: string;
}

export interface DeathEvent {
  readonly kind: 'death';
  readonly probeId: string;
  readonly lineageId: string;
}

export interface AutoPausedEvent {
  readonly kind: 'autoPaused';
  // Identifier of the trigger that fired (e.g. "lineage_extinction").
  readonly trigger: string;
}

export interface CommandAckEvent {
  readonly kind: 'commandAck';
  readonly commandId: string;
}

export interface CommandErrorEvent {
  readonly kind: 'commandError';
  readonly commandId: string;
  readonly message: string;
}

export interface QuarantineImposedEvent {
  readonly kind: 'quarantineImposed';
  // Lineage now under quarantine. Emitted only on actual state flip.
  readonly lineageId: string;
}

export interface QuarantineLiftedEvent {
  readonly kind: 'quarantineLifted';
  // Lineage whose quarantine just ended. Emitted only on actual state flip.
  readonly lineageId: string;
}

export interface PatchAppliedEvent {
  readonly kind: 'patchApplied';
  readonly lineageId: string;
  // Count of extant probes whose firmware was overwritten when the
  // patch landed. bigint for u64-safe transport.
  readonly probesAffected: bigint;
  // Stable id minted by the sim. Correlates with the matching
  // PatchSaturated event when the patch later spreads.
  readonly patchId: string;
}

export interface PatchSaturatedEvent {
  readonly kind: 'patchSaturated';
  // Patch whose carriers just crossed the saturation threshold.
  readonly patchId: string;
  // Counts at the moment of firing.
  readonly carrierPopulation: bigint;
  readonly totalPopulation: bigint;
}

export interface DecreeQueuedEvent {
  readonly kind: 'decreeQueued';
  // Stable id minted by the host. The dashboard correlates the
  // player's submission with the decree visible in the queue.
  readonly decreeId: string;
}

export interface DecreeFiredEvent {
  readonly kind: 'decreeFired';
  readonly decreeId: string;
  readonly patchTargetLineageId: string;
  // True when the patch landed cleanly. False when the target lineage
  // was extinct at firing time — the decree is still consumed.
  readonly landed: boolean;
  readonly probesAffected: bigint;
}

export interface DecreeRevokedEvent {
  readonly kind: 'decreeRevoked';
  readonly decreeId: string;
}

export type SimEventBody =
  | TickEvent
  | ReplicationEvent
  | SpeciationEvent
  | ExtinctionEvent
  | DeathEvent
  | AutoPausedEvent
  | CommandAckEvent
  | CommandErrorEvent
  | QuarantineImposedEvent
  | QuarantineLiftedEvent
  | PatchAppliedEvent
  | PatchSaturatedEvent
  | DecreeQueuedEvent
  | DecreeFiredEvent
  | DecreeRevokedEvent;

export type SimEvent = SimEventBody & {
  // Integer time. Floats are forbidden in tick fields (ARCHITECTURE.md).
  readonly simTick: bigint;
};

// ─────────────────────────────────────────────────────────────────────────────
// Query / QueryResult — UI → sim → reply. Pull-only; never pushed.
// ─────────────────────────────────────────────────────────────────────────────

export interface LineageTreeQueryBody {
  readonly kind: 'lineageTree';
}

export interface ProbeInspectorQueryBody {
  readonly kind: 'probeInspector';
  readonly probeId: string;
}

export interface DriftTelemetryQueryBody {
  readonly kind: 'driftTelemetry';
  readonly lineageId: string;
}

export interface LogSliceQueryBody {
  readonly kind: 'logSlice';
  readonly fromTick: bigint;
  readonly toTick: bigint;
}

export interface PopulationSummaryQueryBody {
  readonly kind: 'populationSummary';
}

export interface ListSavesQueryBody {
  readonly kind: 'listSaves';
}

export interface SubstrateQueryBody {
  readonly kind: 'substrate';
}

export interface DecreeQueueQueryBody {
  readonly kind: 'decreeQueue';
}

export type QueryBody =
  | LineageTreeQueryBody
  | ProbeInspectorQueryBody
  | DriftTelemetryQueryBody
  | LogSliceQueryBody
  | PopulationSummaryQueryBody
  | ListSavesQueryBody
  | SubstrateQueryBody
  | DecreeQueueQueryBody;

export type Query = QueryBody & {
  readonly queryId: string;
};

// Result message bodies are placeholders in schema.proto; their shape will be
// filled out alongside the dashboard implementation. The discriminants line up
// with the corresponding Query kinds.

export interface LineageTreeResult {
  readonly kind: 'lineageTree';
}

export interface ProbeInspectorResult {
  readonly kind: 'probeInspector';
  // null when the probe id was not found in the current state.
  readonly probe: ProbeInspectorProbe | null;
}

export interface ProbeInspectorProbe {
  readonly id: string;
  readonly lineageId: string;
  readonly bornAtTick: bigint;
  readonly firmware: readonly ProbeInspectorDirective[];
}

export interface ProbeInspectorDirective {
  readonly kind: string;
  // Numeric parameters serialised as decimal strings to preserve u64
  // values across the seam (proto3 JSON convention).
  readonly params: Readonly<Record<string, string>>;
}

export interface DriftTelemetryResult {
  readonly kind: 'driftTelemetry';
  readonly lineageId: string;
  // null when the lineage id is not registered.
  readonly drift: DriftTelemetry | null;
}

export interface DriftTelemetry {
  // Number of extant probes in this lineage.
  readonly population: bigint;
  // Per-parameter drift stats. Keyed by dotted path, e.g. 'replicate.threshold',
  // so multiple directives' parameters in a richer firmware do not collide.
  readonly parameters: Readonly<Record<string, ParameterDrift>>;
  // The speciation rule, exposed to the seam so the UI can render the
  // boundary alongside live drift. A child speciates from its lineage
  // when |child - reference| > reference / divergenceDivisor for any
  // parameter; equivalently, the relative speciation threshold is
  // 1 / divergenceDivisor (e.g. divisor 100 → ±1%). Decimal string for
  // u64-safe transport (proto3 JSON convention).
  readonly divergenceDivisor: string;
  // Current reference firmware, in directive order. The patch editor
  // round-trips this into an ApplyPatch command on submit.
  readonly referenceFirmware: readonly DirectiveSpec[];
}

export interface ParameterDrift {
  // Numeric values are decimal strings to preserve u64 precision across
  // the seam (proto3 JSON convention).
  readonly reference: string;
  readonly min: string;
  readonly max: string;
  // Integer mean computed as floor(sum / count).
  readonly mean: string;
}

export interface LogSliceResult {
  readonly kind: 'logSlice';
}

export interface PopulationSummaryResult {
  readonly kind: 'populationSummary';
}

export interface ListSavesResult {
  readonly kind: 'listSaves';
  readonly saves: readonly SaveSummary[];
}

export interface SaveSummary {
  readonly slot: string;
  // Tick at which the save was taken; decimal string (proto3 JSON
  // convention for u64).
  readonly tick: string;
  // Wall-clock millis since epoch when the save was written.
  readonly savedAtMs: number;
}

export interface SubstrateResult {
  readonly kind: 'substrate';
  // Side of the (square) sub-lattice. Cells are flat row-major:
  // `cells[y * side + x]`.
  readonly side: number;
  // Per-cell resource counts; decimal strings for u64-safe transport.
  // Length is `side * side`.
  readonly cells: readonly string[];
  // Cap regen targets per cell; decimal string. The UI uses this to
  // normalise the heatmap brightness without having to hardcode the
  // sim's tuning.
  readonly maxResourcePerCell: string;
  // Position + lineage of every extant probe.
  readonly probes: readonly SubstrateProbe[];
}

export interface SubstrateProbe {
  readonly id: string;
  readonly lineageId: string;
  readonly x: number;
  readonly y: number;
}

export interface DecreeQueueResult {
  readonly kind: 'decreeQueue';
  readonly decrees: readonly DecreeQueueEntry[];
}

export interface DecreeQueueEntry {
  readonly id: string;
  // bigint for u64 safety. The host returns this so the dashboard can
  // show "queued at tick N" without joining other state.
  readonly queuedAtTick: bigint;
  readonly trigger: DecreeTriggerSpec;
  readonly patchTargetLineageId: string;
  readonly patchFirmware: readonly DirectiveSpec[];
}

export type QueryResultBody =
  | LineageTreeResult
  | ProbeInspectorResult
  | DriftTelemetryResult
  | LogSliceResult
  | PopulationSummaryResult
  | ListSavesResult
  | SubstrateResult
  | DecreeQueueResult;

export type QueryResult = QueryResultBody & {
  readonly queryId: string;
};

import type { Command, DirectiveSpec } from '../protocol/types.js';
import { parseUint64Decimal } from '../protocol/uint64.js';
import { MAX_FIRMWARE_LENGTH, MIN_FIRMWARE_LENGTH } from '../sim/mutation.js';

export interface ScriptCommand {
  readonly tick: bigint;
  readonly command: Command;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expected an object');
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (
    Object.keys(value).some((key) => !expected.includes(key)) ||
    expected.some((key) => !(key in value))
  ) {
    throw new Error(`expected fields: ${expected.join(', ')}`);
  }
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error('expected a nonempty string');
  return value;
}

function uint64(value: unknown): bigint {
  if (typeof value !== 'string') throw new Error('expected a decimal uint64 string');
  const parsed = parseUint64Decimal(value);
  if (parsed === null) throw new Error('expected a decimal uint64 string');
  return parsed;
}

function firmware(value: unknown): readonly DirectiveSpec[] {
  if (
    !Array.isArray(value) ||
    value.length < MIN_FIRMWARE_LENGTH ||
    value.length > MAX_FIRMWARE_LENGTH
  ) {
    throw new Error(`firmware requires ${MIN_FIRMWARE_LENGTH}–${MAX_FIRMWARE_LENGTH} directives`);
  }
  return value.map((item: unknown) => {
    const directive = record(item);
    keys(directive, ['kind', 'params']);
    const kind = directive['kind'];
    if (kind !== 'gather' && kind !== 'explore' && kind !== 'replicate')
      throw new Error('unknown directive kind');
    const params = record(directive['params']);
    const parameter = kind === 'gather' ? 'rate' : 'threshold';
    keys(params, [parameter]);
    uint64(params[parameter]);
    return { kind, params: { [parameter]: text(params[parameter]) } };
  });
}

function command(value: unknown): Command {
  const cmd = record(value);
  const commandId = text(cmd['commandId']);
  if (commandId.startsWith('cli-')) throw new Error('command IDs beginning cli- are reserved');
  switch (cmd['kind']) {
    case 'quarantine':
    case 'releaseQuarantine':
      keys(cmd, ['kind', 'commandId', 'lineageId']);
      return { kind: cmd['kind'], commandId, lineageId: text(cmd['lineageId']) };
    case 'revokeDecree':
      keys(cmd, ['kind', 'commandId', 'decreeId']);
      return { kind: 'revokeDecree', commandId, decreeId: text(cmd['decreeId']) };
    case 'applyPatch':
      keys(cmd, ['kind', 'commandId', 'lineageId', 'firmware']);
      return {
        kind: 'applyPatch',
        commandId,
        lineageId: text(cmd['lineageId']),
        firmware: firmware(cmd['firmware']),
      };
    case 'queueDecree': {
      keys(cmd, ['kind', 'commandId', 'trigger', 'patchTargetLineageId', 'patchFirmware']);
      const trigger = record(cmd['trigger']);
      keys(trigger, ['kind', 'lineageId', 'threshold']);
      if (trigger['kind'] !== 'populationBelow') throw new Error('unknown decree trigger');
      uint64(trigger['threshold']);
      return {
        kind: 'queueDecree',
        commandId,
        trigger: {
          kind: 'populationBelow',
          lineageId: text(trigger['lineageId']),
          threshold: text(trigger['threshold']),
        },
        patchTargetLineageId: text(cmd['patchTargetLineageId']),
        patchFirmware: firmware(cmd['patchFirmware']),
      };
    }
    default:
      throw new Error('scripts allow only patch, decree, and quarantine commands');
  }
}

// Validate the entire document before a host is created or persistence is
// touched. Array order is the execution order for commands at the same tick.
export function parseCommandScript(source: string, untilTick: bigint): readonly ScriptCommand[] {
  if (new TextEncoder().encode(source).byteLength > 1_048_576)
    throw new Error('command script exceeds 1 MiB');
  const input: unknown = JSON.parse(source);
  if (!Array.isArray(input)) throw new Error('command script must be a JSON array');
  const ids = new Set<string>();
  let previousTick = 0n;
  return input.map((item: unknown, index) => {
    try {
      const entry = record(item);
      keys(entry, ['tick', 'command']);
      const tick = uint64(entry['tick']);
      if (tick < previousTick || tick > untilTick)
        throw new Error('ticks must be ordered and no later than --ticks');
      const parsed = command(entry['command']);
      if (ids.has(parsed.commandId)) throw new Error(`duplicate commandId: ${parsed.commandId}`);
      ids.add(parsed.commandId);
      previousTick = tick;
      return { tick, command: parsed };
    } catch (error) {
      throw new Error(
        `command script entry ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}

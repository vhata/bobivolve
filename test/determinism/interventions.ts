import type { Command, DirectiveSpec } from '../../protocol/types.js';

export interface ScheduledCommand {
  readonly tick: bigint;
  readonly command: Command;
}

export const INTERVENTION_FIRMWARE: readonly DirectiveSpec[] = [
  { kind: 'gather', params: { rate: '3' } },
  { kind: 'explore', params: { threshold: '288230376151711744' } },
  { kind: 'replicate', params: { threshold: '1000' } },
];

// Same-tick ordering is intentional: a patch and a decree coexist before
// the following tick fires the decree. Quarantine/release bracket growth.
export const INTERVENTIONS: readonly ScheduledCommand[] = [
  { tick: 0n, command: { kind: 'quarantine', commandId: 'hold', lineageId: 'L0' } },
  { tick: 20n, command: { kind: 'releaseQuarantine', commandId: 'release', lineageId: 'L0' } },
  {
    tick: 30n,
    command: {
      kind: 'applyPatch',
      commandId: 'patch',
      lineageId: 'L0',
      firmware: INTERVENTION_FIRMWARE,
    },
  },
  {
    tick: 30n,
    command: {
      kind: 'queueDecree',
      commandId: 'decree',
      trigger: { kind: 'populationBelow', lineageId: 'L0', threshold: '1000' },
      patchTargetLineageId: 'L0',
      patchFirmware: INTERVENTION_FIRMWARE,
    },
  },
];

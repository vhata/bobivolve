// Decrees: conditional patches queued to fire when their triggers match.
//
// SPEC.md "Player Intervention (R2+)": "Decrees are conditional patches
// queued to fire when their triggers match." A decree is one-shot — once
// it fires, it is removed from the queue. The player can cancel a queued
// decree before it fires.
//
// R2 V1 trigger set is intentionally narrow: a single condition shape
// (population below a threshold for a target lineage). Broader triggers
// (drift events, near-extinction warnings, population shifts above a
// threshold) wait on later releases that produce the events to hook on.
//
// Determinism: trigger evaluation is a pure function of state, called
// once per tick from sim/step.ts after the metabolism phases. No PRNG
// draws.

import type { DirectiveStack } from './directive.js';
import type { SimState } from './state.js';
import type { LineageId } from './types.js';

// Discriminated union — the trigger zoo. Each shape is a pure
// predicate against state.
export type DecreeTrigger = PopulationBelowTrigger;

export interface PopulationBelowTrigger {
  readonly kind: 'populationBelow';
  // Lineage to monitor. The trigger fires when this lineage's
  // current population is strictly less than `threshold`. Targeting
  // an extinct lineage is fine — the trigger fires immediately on
  // the next tick, and the decree's patch is delivered against the
  // patch's own targetLineageId, which may or may not still exist.
  readonly lineageId: LineageId;
  readonly threshold: bigint;
}

// A queued decree carries the trigger, the patch to apply when fired,
// and bookkeeping (id, queuedAtTick) for the dashboard.
export interface QueuedDecree {
  readonly id: string;
  readonly queuedAtTick: bigint;
  readonly trigger: DecreeTrigger;
  // Target lineage for the patch payload. Distinct from the trigger's
  // monitored lineage — a decree might be "if L1 dies below 5, patch
  // L0 to be more aggressive."
  readonly patchTargetLineageId: LineageId;
  readonly patchFirmware: DirectiveStack;
}

// Pure predicate. Returns true if the trigger should fire against the
// current state.
export function triggerFires(state: SimState, trigger: DecreeTrigger): boolean {
  switch (trigger.kind) {
    case 'populationBelow': {
      let count = 0n;
      for (const probe of state.probes.values()) {
        if (probe.lineageId === trigger.lineageId) {
          count += 1n;
          if (count >= trigger.threshold) return false;
        }
      }
      return count < trigger.threshold;
    }
  }
}

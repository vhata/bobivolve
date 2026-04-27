import type {
  Directive,
  DirectiveStack,
  ExploreDirective,
  GatherDirective,
  ReplicateDirective,
} from './directive.js';
import type { LineageId, ProbeId, SimTick } from './types.js';

// Lineage clustering. SPEC.md: probes are clustered into lineages based on
// firmware similarity to a reference genome; new lineages are named at the
// point of speciation.
//
// Mechanism: each lineage records the firmware of the probe that founded it
// (its reference genome). When a probe replicates and the child's firmware
// has drifted past a divergence threshold from its lineage's reference, the
// child founds a new lineage. Otherwise, the child inherits its parent's
// lineage. Drift accumulates along a line of descent; deep descendants
// eventually cross the threshold and speciate.
//
// Determinism: the divergence test is pure integer arithmetic against u64
// thresholds; no PRNG draws are consumed by clustering. The same seed and
// the same mutation outcomes produce the same lineage tree every time.

export interface Lineage {
  readonly id: LineageId;
  // Lay-person legible name from sim/lineage-names.ts. Distinct from id
  // (which stays the ordinal Lk for stable referencing); a UI may
  // display either.
  readonly name: string;
  readonly founderProbeId: ProbeId;
  // null for the founding lineage; otherwise the lineage that speciated to
  // produce this one. Lets the dashboard render a tree.
  readonly parentLineageId: LineageId | null;
  readonly referenceFirmware: DirectiveStack;
  readonly foundedAtTick: SimTick;
}

// Speciation threshold: a parameter is considered "diverged" when its
// absolute drift from the lineage reference exceeds reference / DIVISOR.
// Set to 1/100 for now — chosen so that a small handful of mutation events
// along a line of descent can trigger speciation, exercising the lineage
// tree without producing one new lineage per replication. Tunable.
export const SPECIATION_DIVERGENCE_DIVISOR = 100n;

export function firmwareDiverged(child: DirectiveStack, reference: DirectiveStack): boolean {
  if (child.length !== reference.length) return true;
  for (let i = 0; i < child.length; i++) {
    const c = child[i];
    const r = reference[i];
    if (c === undefined || r === undefined) return true;
    if (directiveDiverged(c, r)) return true;
  }
  return false;
}

function directiveDiverged(child: Directive, reference: Directive): boolean {
  if (child.kind !== reference.kind) return true;
  switch (child.kind) {
    case 'replicate':
      return parameterDiverged(child.threshold, (reference as ReplicateDirective).threshold);
    case 'gather':
      return parameterDiverged(child.rate, (reference as GatherDirective).rate);
    case 'explore':
      return parameterDiverged(child.threshold, (reference as ExploreDirective).threshold);
  }
}

function parameterDiverged(value: bigint, reference: bigint): boolean {
  if (reference === 0n) return value !== 0n;
  const delta = value > reference ? value - reference : reference - value;
  return delta * SPECIATION_DIVERGENCE_DIVISOR > reference;
}

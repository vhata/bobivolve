// Experiment-only energy cost. Not called by the production simulation.
import type { DirectiveStack } from '../../sim/directive.js';

const BASE_MOVEMENT = 1n << 58n;
const MOVEMENT_BILL_INTERVAL = 16n;

export function prototypeUpkeep(firmware: DirectiveStack, tick: bigint): bigint {
  let harvestCapacity = 0n;
  let movementCapacity = 0n;
  for (const directive of firmware) {
    if (directive.kind === 'gather') harvestCapacity += directive.rate;
    if (directive.kind === 'explore') movementCapacity += directive.threshold;
  }
  // One energy/tick per two additional harvest units above the founder.
  // Aggregate duplicates before granting the single baseline allowance.
  const harvest = harvestCapacity > 2n ? (harvestCapacity - 2n + 1n) / 2n : 0n;
  // Charge movement capacity every 16 ticks, without extra PRNG draws or
  // floating-point accumulation. This billing cadence is a prototype,
  // not a proposed player-facing restriction on when probes can move.
  const movement =
    tick % MOVEMENT_BILL_INTERVAL === 0n && movementCapacity > BASE_MOVEMENT
      ? (movementCapacity - BASE_MOVEMENT + BASE_MOVEMENT - 1n) / BASE_MOVEMENT
      : 0n;
  return harvest + movement;
}

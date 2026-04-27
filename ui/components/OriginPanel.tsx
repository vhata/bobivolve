// OriginPanel — the player-as-Origin's compute readout.
//
// SPEC.md "Player Intervention (R2+)" gates every intervention behind
// the Origin compute budget. This panel surfaces it: the current value,
// the cap, and a list of active drains so the player understands where
// their budget is going.
//
// Drains today: held quarantines (per-tick maintenance). When patches
// and decrees land they will appear here as one-shot costs the player
// can afford / can't afford rather than ongoing drains.

import {
  QUARANTINE_MAINTENANCE_PER_TICK,
  ORIGIN_COMPUTE_REGEN_PER_TICK,
} from '../../sim/compute.js';
import { useSimStore } from '../sim-store.js';

const BAR_WIDTH_PX = 220;

export function OriginPanel(): React.JSX.Element {
  const originCompute = useSimStore((s) => s.originCompute);
  const originComputeMax = useSimStore((s) => s.originComputeMax);
  const quarantinedLineages = useSimStore((s) => s.quarantinedLineages);

  const hasReading = originCompute !== null && originComputeMax !== null;
  const fillPx = hasReading
    ? originComputeMax > 0n
      ? Number((originCompute * BigInt(BAR_WIDTH_PX)) / originComputeMax)
      : 0
    : 0;
  const heldCount = quarantinedLineages.size;
  const drainPerTick = BigInt(heldCount) * QUARANTINE_MAINTENANCE_PER_TICK;
  const netPerTick = ORIGIN_COMPUTE_REGEN_PER_TICK - drainPerTick;

  return (
    <section className="panel origin-panel">
      <header className="panel-header">
        <h2>Origin compute</h2>
        <span className="panel-meta">
          {hasReading ? `${originCompute.toString()} / ${originComputeMax.toString()}` : '…'}
        </span>
      </header>
      <div className="panel-body">
        <div
          className="origin-bar"
          role="img"
          aria-label="Origin compute budget"
          aria-valuenow={hasReading ? Number(originCompute) : undefined}
          aria-valuemax={hasReading ? Number(originComputeMax) : undefined}
        >
          <div className="origin-bar-fill" style={{ width: `${fillPx.toString()}px` }} />
        </div>
        <dl className="origin-stats">
          <div>
            <dt>regen</dt>
            <dd>+{ORIGIN_COMPUTE_REGEN_PER_TICK.toString()} / tick</dd>
          </div>
          <div>
            <dt>holds</dt>
            <dd>
              {heldCount.toString()} quarantine{heldCount === 1 ? '' : 's'}
              {heldCount > 0 ? ` · −${drainPerTick.toString()} / tick` : ''}
            </dd>
          </div>
          <div>
            <dt>net</dt>
            <dd className={netPerTick < 0n ? 'origin-net-negative' : ''}>
              {netPerTick > 0n ? '+' : ''}
              {netPerTick.toString()} / tick
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

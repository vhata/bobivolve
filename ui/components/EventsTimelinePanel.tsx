// EventsTimelinePanel — chronological view of significant SimEvents:
// speciations to start; extinctions, first contact, treaty violations
// will join here as their mechanics land.
//
// SPEC.md "Forensic replay: scrubable timeline of past events". This is
// the lighter shape — an event list with markers on a horizontal axis.
// Full state-rewind scrubbing (load snapshot + advance to tick) is a
// future enhancement; the data model that supports it is already in
// place via the host's Load command.

import { useEffect, useState } from 'react';
import type { SimEvent } from '../../protocol/types.js';
import { useSimStore } from '../sim-store.js';

interface TimelineEntry {
  readonly id: string;
  readonly tick: bigint;
  readonly kind: 'speciation';
  readonly description: string;
}

const MAX_ENTRIES = 200;
const TIMELINE_WIDTH = 520;
const TIMELINE_HEIGHT = 36;

export function EventsTimelinePanel(): React.JSX.Element {
  const transport = useSimStore((s) => s.transport);
  const simTick = useSimStore((s) => s.simTick);
  const [entries, setEntries] = useState<readonly TimelineEntry[]>([]);

  // Subscribe directly to the transport rather than projecting events
  // through the store — the timeline is event-history-focused and the
  // store currently keeps no event log of its own. When a global event
  // log slice lands in the store, this panel can read it instead.
  useEffect(() => {
    if (transport === null) return;
    let nextOrdinal = 0;
    const unsubscribe = transport.onEvent((event: SimEvent) => {
      if (event.kind !== 'speciation') return;
      const id = `s-${nextOrdinal.toString()}`;
      nextOrdinal += 1;
      setEntries((current) => {
        const next = [
          ...current,
          {
            id,
            tick: event.simTick,
            kind: 'speciation' as const,
            description: `${event.parentLineageId} → ${event.newLineageId}`,
          },
        ];
        if (next.length > MAX_ENTRIES) next.splice(0, next.length - MAX_ENTRIES);
        return next;
      });
    });
    return unsubscribe;
  }, [transport]);

  const minTick = entries[0]?.tick ?? 0n;
  const maxTick = simTick > minTick ? simTick : minTick + 1n;
  const tickRange = maxTick - minTick === 0n ? 1n : maxTick - minTick;

  function projectX(tick: bigint): number {
    const num = (tick - minTick) * BigInt(TIMELINE_WIDTH * 1000);
    return Number(num / tickRange) / 1000;
  }

  return (
    <section className="panel timeline-panel">
      <header className="panel-header">
        <h2>Events</h2>
        <span className="panel-meta">
          {entries.length} speciation{entries.length === 1 ? '' : 's'}
        </span>
      </header>
      <div className="panel-body">
        <svg
          className="timeline-svg"
          viewBox={`0 0 ${TIMELINE_WIDTH.toString()} ${TIMELINE_HEIGHT.toString()}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="Speciation timeline"
        >
          <line
            x1={0}
            x2={TIMELINE_WIDTH}
            y1={TIMELINE_HEIGHT / 2}
            y2={TIMELINE_HEIGHT / 2}
            className="timeline-axis"
          />
          {entries.map((entry) => (
            <line
              key={entry.id}
              x1={projectX(entry.tick)}
              x2={projectX(entry.tick)}
              y1={6}
              y2={TIMELINE_HEIGHT - 6}
              className="timeline-marker"
            />
          ))}
        </svg>
        {entries.length === 0 ? (
          <p className="panel-empty">no speciations yet — drift accumulates first</p>
        ) : (
          <ul className="timeline-list">
            {[...entries]
              .reverse()
              .slice(0, 8)
              .map((entry) => (
                <li key={entry.id}>
                  <span className="timeline-tick">tick {entry.tick.toString()}</span>
                  <span className="timeline-description">{entry.description}</span>
                </li>
              ))}
          </ul>
        )}
      </div>
    </section>
  );
}

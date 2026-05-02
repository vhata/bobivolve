// EventsTimelinePanel — chronological view of significant SimEvents:
// speciations to start; extinctions, first contact, treaty violations
// will join here as their mechanics land.
//
// SPEC.md "Forensic replay: scrubable timeline of past events". Each
// row in the list is a button that rewinds the sim to that event's
// tick — a destructive scrub: the host loads the latest in-run
// snapshot at-or-before the target and advances to land exactly on
// the event tick. The non-destructive "preview-then-commit" variant
// is tracked under #r2-stretch in TODO.md.
//
// Render rate is decoupled from event arrival rate. At 64× speed with
// fat population, speciation events arrive at 10+ per second. Driving
// React state on every event would re-reconcile the whole panel
// (thousands of SVG markers + the visible list) at that rate and
// peg the main thread. Events accumulate in a ref; the renderable
// state updates on a fixed cadence, so the visible list updates
// smoothly without churning the renderer.
//
// Modal-on-action: rows are only clickable when the sim is paused.
// Per CLAUDE.md the rule for occasional actions (save, load, scrub) is
// to not render perpetually-updating UI against live state — pause
// first, browse the frozen list, click. While the sim is running the
// rows are non-interactive and a hint says so.

import { useEffect, useRef, useState } from 'react';
import type { SimEvent } from '../../protocol/types.js';
import { useSimStore } from '../sim-store.js';

interface TimelineEntry {
  readonly id: string;
  readonly tick: bigint;
  readonly kind: 'speciation';
  readonly description: string;
}

const MAX_ENTRIES = 500;
const MAX_VISIBLE = 60;
const TIMELINE_WIDTH = 520;
const TIMELINE_HEIGHT = 36;
// Cadence at which buffered events flush to the rendered state. The
// list updates ~4×/sec — fast enough to feel live, slow enough that
// React doesn't re-reconcile on every speciation.
const FLUSH_INTERVAL_MS = 250;

export function EventsTimelinePanel(): React.JSX.Element {
  const transport = useSimStore((s) => s.transport);
  const simTick = useSimStore((s) => s.simTick);
  const paused = useSimStore((s) => s.paused);
  const rewindToTick = useSimStore((s) => s.rewindToTick);
  const [entries, setEntries] = useState<readonly TimelineEntry[]>([]);

  // Subscribe directly to the transport rather than projecting events
  // through the store — the timeline is event-history-focused and the
  // store currently keeps no event log of its own. Buffer arrivals in
  // a ref so subscriber callbacks don't trigger React state updates;
  // a separate interval flushes the ref into renderable state.
  const bufferRef = useRef<TimelineEntry[]>([]);
  const ordinalRef = useRef<number>(0);

  useEffect(() => {
    if (transport === null) return;
    const unsubscribe = transport.onEvent((event: SimEvent) => {
      if (event.kind !== 'speciation') return;
      const id = `s-${ordinalRef.current.toString()}`;
      ordinalRef.current += 1;
      bufferRef.current.push({
        id,
        tick: event.simTick,
        kind: 'speciation',
        description: `${event.parentLineageId} → ${event.newLineageId}`,
      });
    });
    return unsubscribe;
  }, [transport]);

  useEffect(() => {
    const flush = (): void => {
      if (bufferRef.current.length === 0) return;
      const incoming = bufferRef.current;
      bufferRef.current = [];
      setEntries((current) => {
        const next = current.concat(incoming);
        if (next.length <= MAX_ENTRIES) return next;
        return next.slice(next.length - MAX_ENTRIES);
      });
    };
    const handle = setInterval(flush, FLUSH_INTERVAL_MS);
    return () => {
      clearInterval(handle);
    };
  }, []);

  const minTick = entries[0]?.tick ?? 0n;
  const maxTick = simTick > minTick ? simTick : minTick + 1n;
  const tickRange = maxTick - minTick === 0n ? 1n : maxTick - minTick;

  function projectX(tick: bigint): number {
    const num = (tick - minTick) * BigInt(TIMELINE_WIDTH * 1000);
    return Number(num / tickRange) / 1000;
  }

  // Cap SVG markers to the visible list count — at fat speciation
  // rates a 500-marker axis is visually solid anyway, and rendering
  // every marker on every flush re-reconciles too many DOM elements.
  const recentEntries = entries.slice(-MAX_VISIBLE);

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
          {recentEntries.map((entry) => (
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
          <>
            {!paused ? (
              <p className="panel-empty timeline-hint">pause the sim to browse and rewind</p>
            ) : null}
            <ul className="timeline-list timeline-list-scrollable">
              {[...recentEntries].reverse().map((entry) => (
                <li key={entry.id}>
                  {paused ? (
                    <button
                      type="button"
                      className="timeline-rewind"
                      onClick={() => {
                        rewindToTick(entry.tick);
                      }}
                      title={`Rewind the sim to tick ${entry.tick.toString()}. Destructive — post-rewind state is forfeit.`}
                    >
                      <span className="timeline-tick">tick {entry.tick.toString()}</span>
                      <span className="timeline-description">{entry.description}</span>
                    </button>
                  ) : (
                    <div className="timeline-rewind timeline-rewind-disabled" aria-disabled="true">
                      <span className="timeline-tick">tick {entry.tick.toString()}</span>
                      <span className="timeline-description">{entry.description}</span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}

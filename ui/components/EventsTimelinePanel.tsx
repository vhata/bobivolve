// EventsTimelinePanel — chronological view of significant SimEvents.
//
// SPEC.md "Forensic replay: scrubable timeline of past events". Each
// row in the list is a button that rewinds the sim to that event's
// tick — a destructive scrub: the host loads the latest in-run
// snapshot at-or-before the target and advances to land exactly on
// the event tick. The non-destructive "preview-then-commit" variant
// is tracked under #r2-stretch in TODO.md.
//
// Two strata, per BRAINSTORM/rewindable-events.md:
//
//   Stratum 1 — milestones. Always-on, always-rewindable. The events
//   the player almost certainly cares about: extinction of a clade,
//   a patch propagating to half the population, an autopause, a
//   player intervention firing. Visually distinct from Stratum 2.
//
//   Stratum 2 — speciations. Toggleable via a chip. At fat
//   population speciations arrive at 10+/sec and most are uninteresting
//   (small clades that die quickly). A two-axis filter promotes the
//   ones the player would actually want:
//     (A) Forward-looking, at emission: parent lineage holds ≥5% of
//         the live population OR the parent is quarantined / patched.
//         Promoted speciations join the "surfaced" list immediately.
//     (B) Retroactive: speciations that did not pass (A) sit in a
//         candidate buffer, scanned on a sim-tick cadence. A candidate
//         whose NEW lineage grows to ≥1% of population is promoted;
//         a candidate whose new lineage goes extinct within 1000 sim
//         ticks of founding is dropped (it never mattered).
//   Plus an "all speciations" toggle that surfaces every emission
//   as Stratum 2 (the player's escape hatch when the heuristic
//   misses something interesting).
//
// Filtering lives client-side for now (the population data the
// heuristic needs is already projected by the store). A host-side
// TimelineSurfacer was sketched in BRAINSTORM/rewindable-events.md
// for cross-session persistence; the upgrade is logged in TODO.md
// and would slot in behind the existing UI without changing it.
//
// Render rate is decoupled from event arrival rate. Events accumulate
// in a ref; renderable state updates on a fixed cadence; the visible
// list updates smoothly without churning React.
//
// Modal-on-action: rows are only clickable when the sim is paused.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { SimEvent } from '../../protocol/types.js';
import { useSimStore } from '../sim-store.js';

type EventKind =
  | 'speciation'
  | 'extinction'
  | 'patchSaturated'
  | 'patchApplied'
  | 'decreeFired'
  | 'autoPaused';

interface TimelineEntry {
  readonly id: string;
  readonly tick: bigint;
  readonly kind: EventKind;
  readonly stratum: 1 | 2;
  readonly description: string;
  // For Stratum-2 candidate entries — the lineage to track for
  // retroactive promotion. Speciation only; undefined for Stratum 1.
  readonly newLineageId?: string;
}

const MAX_ENTRIES = 500;
const MAX_VISIBLE = 60;
const TIMELINE_WIDTH = 520;
const TIMELINE_HEIGHT = 36;

// Cadence at which buffered events flush to the rendered state.
const FLUSH_INTERVAL_MS = 250;

// Forward-looking promotion threshold. A speciation whose parent
// lineage holds at least this fraction of the live population is
// surfaced as Stratum 2 immediately (the parent is "important enough"
// that any drift from it is worth a click).
const PROMOTE_PARENT_FRACTION = 0.05;

// Retroactive promotion threshold. A candidate speciation whose NEW
// lineage grows to at least this fraction of population gets promoted.
const RETROACTIVE_PROMOTE_FRACTION = 0.01;

// Candidate aging window — speciations whose new lineage goes extinct
// within this many sim ticks of founding are dropped (they never
// mattered, and keeping them holds memory that could go to candidates
// that will).
const CANDIDATE_NOISE_WINDOW_TICKS = 1000n;

// Cap the candidate buffer. Past this, oldest entries fall out — at
// fat population this only matters when the heuristic is producing
// a backlog the janitor can't drain.
const MAX_CANDIDATES = 2000;

const STRATUM_1_KINDS: ReadonlySet<SimEvent['kind']> = new Set([
  'extinction',
  'patchSaturated',
  'patchApplied',
  'decreeFired',
  'autoPaused',
]);

function describe(event: SimEvent): string {
  switch (event.kind) {
    case 'speciation':
      return `${event.parentLineageId} → ${event.newLineageId}`;
    case 'extinction':
      return `${event.lineageId} extinct`;
    case 'patchSaturated':
      return `patch saturated · ${event.patchId}`;
    case 'patchApplied':
      return `patch applied · ${event.lineageId}`;
    case 'decreeFired':
      return `decree fired · ${event.patchTargetLineageId}${event.landed ? '' : ' (no-op)'}`;
    case 'autoPaused':
      return `auto-paused (${event.trigger})`;
    default:
      return event.kind;
  }
}

export function EventsTimelinePanel(): React.JSX.Element {
  const transport = useSimStore((s) => s.transport);
  const simTick = useSimStore((s) => s.simTick);
  const paused = useSimStore((s) => s.paused);
  const rewindToTick = useSimStore((s) => s.rewindToTick);
  const populationTotal = useSimStore((s) => s.populationTotal);
  const populationByLineage = useSimStore((s) => s.populationByLineage);
  const quarantinedLineages = useSimStore((s) => s.quarantinedLineages);

  const [surfaced, setSurfaced] = useState<readonly TimelineEntry[]>([]);
  // "Show all speciations" toggle — escape hatch when the player
  // suspects the filter has missed an interesting drift. Hidden by
  // default; speciations the heuristic didn't promote stay invisible.
  const [showAllSpeciations, setShowAllSpeciations] = useState(false);
  const [confirmingTick, setConfirmingTick] = useState<bigint | null>(null);

  // The arrival pipeline: subscribe to the transport, tag each event
  // as Stratum 1 (always-promote) or Stratum 2 (speciation, filtered).
  // For Stratum 2 we apply the forward-looking heuristic immediately
  // using the current population projection; events that don't pass
  // sit in a candidate buffer for the retroactive janitor.
  const surfacedBufferRef = useRef<TimelineEntry[]>([]);
  const candidatesRef = useRef<Array<TimelineEntry & { readonly foundedAtTick: bigint }>>([]);
  const allSpeciationsBufferRef = useRef<TimelineEntry[]>([]);
  const ordinalRef = useRef<number>(0);

  // Refs for the heuristic — read inside the subscriber, which fires
  // outside React's render cycle and would otherwise stale-close on
  // the prop snapshot at subscribe time.
  const populationTotalRef = useRef(populationTotal);
  const populationByLineageRef = useRef(populationByLineage);
  const quarantinedLineagesRef = useRef(quarantinedLineages);
  useEffect(() => {
    populationTotalRef.current = populationTotal;
  }, [populationTotal]);
  useEffect(() => {
    populationByLineageRef.current = populationByLineage;
  }, [populationByLineage]);
  useEffect(() => {
    quarantinedLineagesRef.current = quarantinedLineages;
  }, [quarantinedLineages]);

  useEffect(() => {
    if (transport === null) return;
    const unsubscribe = transport.onEvent((event: SimEvent) => {
      const isStratum1 = STRATUM_1_KINDS.has(event.kind);
      const isStratum2 = event.kind === 'speciation';
      if (!isStratum1 && !isStratum2) return;

      const id = `e-${ordinalRef.current.toString()}`;
      ordinalRef.current += 1;
      const baseEntry = {
        id,
        tick: event.simTick,
        kind: event.kind as EventKind,
        description: describe(event),
      };

      if (isStratum1) {
        surfacedBufferRef.current.push({ ...baseEntry, stratum: 1 });
        return;
      }

      // Speciation. Always recorded into the all-speciations buffer
      // (the toggle reveals it). Plus the heuristic decides whether
      // it joins the surfaced list now, or sits as a candidate for
      // retroactive promotion.
      if (event.kind !== 'speciation') return;
      const speciationEntry: TimelineEntry & { readonly foundedAtTick: bigint } = {
        ...baseEntry,
        stratum: 2,
        newLineageId: event.newLineageId,
        foundedAtTick: event.simTick,
      };
      allSpeciationsBufferRef.current.push(speciationEntry);

      const parentId = event.parentLineageId;
      const total = populationTotalRef.current;
      const parentPop = populationByLineageRef.current.get(parentId) ?? 0n;
      const parentIsBig =
        total > 0n && parentPop * 100n >= total * BigInt(Math.round(PROMOTE_PARENT_FRACTION * 100));
      const parentIsQuarantined = quarantinedLineagesRef.current.has(parentId);
      // R2 doesn't surface a "patched" lineage flag in the projection
      // yet; the doc proposed adding it. For now, parent-quarantined +
      // parent-big covers the load-bearing fraction. Patched-parent
      // promotion is logged as a follow-up.

      if (parentIsBig || parentIsQuarantined) {
        surfacedBufferRef.current.push({ ...speciationEntry, stratum: 2 });
        return;
      }

      // Candidate path — sits until the janitor either promotes or
      // drops it.
      candidatesRef.current.push(speciationEntry);
      if (candidatesRef.current.length > MAX_CANDIDATES) {
        // Drop oldest. The cap is hit only when the heuristic is
        // failing to drain; logging the drop would be useful diagnostics
        // but keeping it noise-free is fine for MVP.
        candidatesRef.current.shift();
      }
    });
    return unsubscribe;
  }, [transport]);

  // Flush surfaced buffer + run the retroactive janitor on the same
  // cadence. The janitor walks candidates with the live population
  // projection: promote those whose new lineage grew big, drop those
  // whose new lineage died young.
  useEffect(() => {
    const flush = (): void => {
      const incoming = surfacedBufferRef.current;
      surfacedBufferRef.current = [];
      // Janitor pass.
      const total = populationTotalRef.current;
      const byLineage = populationByLineageRef.current;
      const promoted: TimelineEntry[] = [];
      const stillCandidate: typeof candidatesRef.current = [];
      const promoteThreshold = BigInt(Math.round(RETROACTIVE_PROMOTE_FRACTION * 100));
      for (const c of candidatesRef.current) {
        const newLineageId = c.newLineageId;
        if (newLineageId === undefined) continue;
        const pop = byLineage.get(newLineageId) ?? 0n;
        if (total > 0n && pop * 100n >= total * promoteThreshold) {
          promoted.push(c);
          continue;
        }
        // Drop noisy ones whose new lineage died (or never grew) and
        // are now past the noise window.
        const aged = simTick - c.foundedAtTick > CANDIDATE_NOISE_WINDOW_TICKS;
        if (aged && pop === 0n) {
          continue;
        }
        stillCandidate.push(c);
      }
      candidatesRef.current = stillCandidate;

      if (incoming.length === 0 && promoted.length === 0) return;
      setSurfaced((current) => {
        const next = current.concat(incoming, promoted);
        if (next.length <= MAX_ENTRIES) return next;
        return next.slice(next.length - MAX_ENTRIES);
      });
    };
    const handle = setInterval(flush, FLUSH_INTERVAL_MS);
    return () => {
      clearInterval(handle);
    };
  }, [simTick]);

  // The visible list. When "show all speciations" is on we splice the
  // backing all-speciations buffer over the surfaced list (sorted by
  // tick). When off we just show surfaced.
  const visibleEntries = useMemo<readonly TimelineEntry[]>(() => {
    if (!showAllSpeciations) return surfaced;
    const merged = surfaced.concat(allSpeciationsBufferRef.current);
    merged.sort((a, b) => (a.tick < b.tick ? -1 : a.tick > b.tick ? 1 : 0));
    if (merged.length <= MAX_ENTRIES) return merged;
    return merged.slice(merged.length - MAX_ENTRIES);
  }, [surfaced, showAllSpeciations]);

  const minTick = visibleEntries[0]?.tick ?? 0n;
  const maxTick = simTick > minTick ? simTick : minTick + 1n;
  const tickRange = maxTick - minTick === 0n ? 1n : maxTick - minTick;

  function projectX(tick: bigint): number {
    const num = (tick - minTick) * BigInt(TIMELINE_WIDTH * 1000);
    return Number(num / tickRange) / 1000;
  }

  const recentEntries = visibleEntries.slice(-MAX_VISIBLE);
  const stratum1Count = visibleEntries.filter((e) => e.stratum === 1).length;
  const stratum2Count = visibleEntries.length - stratum1Count;

  return (
    <section className="panel timeline-panel">
      <header className="panel-header">
        <h2>Events</h2>
        <span className="panel-meta">
          {stratum1Count} milestone{stratum1Count === 1 ? '' : 's'} · {stratum2Count} speciation
          {stratum2Count === 1 ? '' : 's'}
        </span>
      </header>
      <div className="panel-body">
        <div className="timeline-filters">
          <label className="timeline-toggle">
            <input
              type="checkbox"
              checked={showAllSpeciations}
              onChange={(e) => setShowAllSpeciations(e.target.checked)}
            />
            <span>show all speciations</span>
          </label>
        </div>
        <svg
          className="timeline-svg"
          viewBox={`0 0 ${TIMELINE_WIDTH.toString()} ${TIMELINE_HEIGHT.toString()}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="Events timeline"
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
              y1={entry.stratum === 1 ? 2 : 6}
              y2={entry.stratum === 1 ? TIMELINE_HEIGHT - 2 : TIMELINE_HEIGHT - 6}
              className={
                entry.stratum === 1
                  ? 'timeline-marker timeline-marker-stratum-1'
                  : 'timeline-marker'
              }
            />
          ))}
        </svg>
        {visibleEntries.length === 0 ? (
          <p className="panel-empty">no significant events yet</p>
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
                      className={
                        entry.stratum === 1
                          ? 'timeline-rewind timeline-rewind-stratum-1'
                          : 'timeline-rewind'
                      }
                      onClick={() => {
                        setConfirmingTick(entry.tick);
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
      {confirmingTick !== null ? (
        <RewindConfirmModal
          tick={confirmingTick}
          onCancel={() => {
            setConfirmingTick(null);
          }}
          onConfirm={() => {
            const tick = confirmingTick;
            setConfirmingTick(null);
            rewindToTick(tick);
          }}
        />
      ) : null}
    </section>
  );
}

function RewindConfirmModal({
  tick,
  onCancel,
  onConfirm,
}: {
  tick: bigint;
  onCancel: () => void;
  onConfirm: () => void;
}): React.JSX.Element {
  return (
    <div
      className="rewind-confirm-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Confirm rewind"
      onClick={onCancel}
    >
      <div
        className="rewind-confirm"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <h3 className="rewind-confirm-title">Rewind to tick {tick.toString()}?</h3>
        <p className="rewind-confirm-body">
          The sim will load the latest snapshot at-or-before this tick and replay forward to land on
          it. Everything that happened after this tick will be lost; Save first if it's worth
          keeping.
        </p>
        <div className="rewind-confirm-actions">
          <button type="button" className="rewind-confirm-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="rewind-confirm-go" onClick={onConfirm}>
            Rewind
          </button>
        </div>
      </div>
    </div>
  );
}

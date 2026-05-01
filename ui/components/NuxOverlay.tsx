// NuxOverlay — guided tour for first-time visitors. Auto-fires once on
// first visit (gated by localStorage), then sleeps. The header carries
// a '?' affordance to reopen on demand. Walks the player through the
// dashboard in the order they need to learn it: lineages → drift →
// intervention surface, per the R2 acceptance test in ACCEPTANCE.md.

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'bobivolve:nux-seen';

interface Step {
  readonly title: string;
  readonly body: string;
  // CSS selector for the panel to spotlight. null leaves the card
  // centered with no panel highlighted (used for opening / closing).
  readonly target: string | null;
}

const STEPS: readonly Step[] = [
  {
    title: 'You are the Origin',
    body: 'You wrote the firmware that became this swarm. From here you watch it drift, branch, and compete — and you nudge it when you choose to. Reopen this tour anytime via the ? in the header.',
    target: null,
  },
  {
    title: 'Start a run',
    body: 'Same seed, same universe. Type a number and click Start. A run is already going at seed 42 so you have something to watch right away.',
    target: '.run-panel',
  },
  {
    title: 'Population',
    body: 'Total probes at the top, recent history sketched below. As lineages diverge they appear as their own coloured bands.',
    target: '.population-panel',
  },
  {
    title: 'Lineage tree',
    body: 'Every named clade currently alive. Trend glyphs show whether each lineage is rising, stable, or fading. Click a row to inspect that lineage.',
    target: '.lineage-tree-panel',
  },
  {
    title: 'Drift',
    body: "How much each piece of the lineage's firmware has wandered from its founder. The horizontal bar plots today's spread across living members; the line below traces that drift over time. When a parameter wanders past the marked edge, descendants split off as a new lineage.",
    target: '.inspector-panel',
  },
  {
    title: 'Three intervention tools',
    body: 'Quarantine suspends a lineage from replicating. Apply patch authors a firmware modification descendants will inherit. Queue decree fires a patch when its trigger condition holds.',
    target: '.inspector-action-bar',
  },
  {
    title: 'Origin compute',
    body: 'Your renewable budget. Patches and decrees cost a one-shot; quarantine drains per tick while held. Watch this bar before you spend.',
    target: '.origin-panel',
  },
  {
    title: 'Pacing and triggers',
    body: 'Speed lives in Controls. Auto-pause stops the sim on conditions you care about — extinction, drift events, patch saturation.',
    target: '.controls-panel',
  },
];

interface NuxOverlayProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

export function NuxOverlay({ open, onClose }: NuxOverlayProps): React.JSX.Element | null {
  const [stepIdx, setStepIdx] = useState(0);

  const close = useCallback(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // Private mode or quota exhausted; the tour still closes for the
      // current session, it'll just re-fire on reload.
    }
    setStepIdx(0);
    onClose();
  }, [onClose]);

  // Apply / remove spotlight class on the target panel. Reapplies on
  // step change and tears down on close.
  useEffect(() => {
    if (!open) return;
    const target = STEPS[stepIdx]?.target;
    if (target == null) return;
    const el = document.querySelector(target);
    if (el === null) return;
    el.classList.add('nux-spotlight');
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return () => {
      el.classList.remove('nux-spotlight');
    };
  }, [open, stepIdx]);

  // Esc closes the tour. Match the rest of the dashboard's modal idiom.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  if (!open) return null;

  const step = STEPS[stepIdx];
  if (step === undefined) return null;

  const isFirst = stepIdx === 0;
  const isLast = stepIdx === STEPS.length - 1;

  return (
    <div className="nux-backdrop" role="dialog" aria-label="New visitor tour" aria-modal="true">
      <div className="nux-card">
        <header className="nux-card-header">
          <span className="nux-step-counter">
            {(stepIdx + 1).toString()} / {STEPS.length.toString()}
          </span>
          <button type="button" className="nux-skip" onClick={close} aria-label="Skip tour">
            skip
          </button>
        </header>
        <h2 className="nux-card-title">{step.title}</h2>
        <p className="nux-card-body">{step.body}</p>
        <footer className="nux-card-footer">
          <button
            type="button"
            className="nux-nav"
            onClick={() => {
              setStepIdx((i) => Math.max(0, i - 1));
            }}
            disabled={isFirst}
          >
            Back
          </button>
          {isLast ? (
            <button type="button" className="nux-nav nux-nav-primary" onClick={close}>
              Done
            </button>
          ) : (
            <button
              type="button"
              className="nux-nav nux-nav-primary"
              onClick={() => {
                setStepIdx((i) => Math.min(STEPS.length - 1, i + 1));
              }}
            >
              Next
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

export function shouldAutoFireNux(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== '1';
  } catch {
    // localStorage unavailable — don't pester; the help button still
    // opens the tour on demand.
    return false;
  }
}

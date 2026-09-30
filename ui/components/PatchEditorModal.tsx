// PatchEditorModal — modal-on-action editor for player-authored patches.
//
// Per CLAUDE.md feedback patterns: occasional player actions (save, load,
// apply patch) pause the sim and prompt at click rather than rendering
// perpetual UI that updates against live state. The modal opens with the
// lineage's current reference firmware pre-filled; the player edits each
// numeric parameter, sees the cost vs current budget, and either Applies
// or Cancels. Either action resumes the sim.

import { useEffect, useRef, useState } from 'react';
import { PATCH_AUTHORING_COST } from '../../sim/compute.js';
import { REPLICATION_COST_ENERGY } from '../../sim/energy.js';
import { formatMovementAttemptChance } from '../firmware-format.js';
import type { DirectiveSpec } from '../../protocol/types.js';
import { parseUint64Decimal } from '../../protocol/uint64.js';
import { useSimStore } from '../sim-store.js';

interface PatchEditorModalProps {
  readonly lineageId: string;
  readonly lineageName: string;
  readonly initialFirmware: readonly DirectiveSpec[];
  readonly onClose: () => void;
  readonly onApplied: (firmware: readonly DirectiveSpec[]) => void;
}

interface DraftRow {
  readonly kind: string;
  readonly params: ReadonlyMap<string, string>;
}

function toDraft(firmware: readonly DirectiveSpec[]): DraftRow[] {
  return firmware.map((d) => ({
    kind: d.kind,
    params: new Map(Object.entries(d.params)),
  }));
}

function fromDraft(draft: readonly DraftRow[]): DirectiveSpec[] {
  return draft.map((row) => {
    const params: Record<string, string> = {};
    for (const [k, v] of row.params) params[k] = v;
    return { kind: row.kind, params };
  });
}

// The wire contract accepts decimal uint64 values. Empty, negative, and
// out-of-range values cannot be submitted.
function isValidParam(value: string): boolean {
  return parseUint64Decimal(value) !== null;
}

function paramLabel(directiveKind: string, paramKey: string): string {
  if (directiveKind === 'replicate' && paramKey === 'threshold') return 'Minimum stored energy';
  if (directiveKind === 'gather' && paramKey === 'rate') return 'Maximum energy per tick';
  if (directiveKind === 'explore' && paramKey === 'threshold')
    return 'Movement-attempt probability per tick';
  return `${directiveKind}.${paramKey}`;
}

function paramHelp(directiveKind: string, paramKey: string): string | null {
  if (directiveKind === 'gather' && paramKey === 'rate')
    return 'Gathering is limited by resources in the current cell.';
  if (directiveKind === 'replicate' && paramKey === 'threshold')
    return `Replication also requires ${REPLICATION_COST_ENERGY.toString()} energy to transfer to the child. Quarantine prevents replication.`;
  if (directiveKind === 'explore' && paramKey === 'threshold')
    return 'Chance = encoded threshold / 2⁶⁴. A movement attempt can be blocked by the world boundary; ≈ marks a rounded percentage.';
  return null;
}

export function PatchEditorModal({
  lineageId,
  lineageName,
  initialFirmware,
  onClose,
  onApplied,
}: PatchEditorModalProps): React.JSX.Element {
  const pause = useSimStore((s) => s.pause);
  const resume = useSimStore((s) => s.resume);
  const applyPatch = useSimStore((s) => s.applyPatch);
  const originCompute = useSimStore((s) => s.originCompute);

  const [draft, setDraft] = useState<DraftRow[]>(() => toDraft(initialFirmware));
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Modal-on-action: pause on open, resume on close — but only if WE
  // paused. If the player had paused the sim before opening the modal,
  // we leave it paused on close. Without this guard, closing the modal
  // would un-pause whatever the player had explicitly paused, which is
  // the bug that prompted this fix. The ref survives renders within
  // this component instance; in StrictMode dev the mount→unmount→mount
  // cycle still produces a transient resume→pause flicker, which
  // production builds don't see.
  const pausedByMeRef = useRef(false);
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    const wasPausedAtOpen = useSimStore.getState().paused;
    if (!wasPausedAtOpen) {
      pause();
      pausedByMeRef.current = true;
    }
    return () => {
      mountedRef.current = false;
      if (pausedByMeRef.current) {
        resume();
        pausedByMeRef.current = false;
      }
    };
  }, [pause, resume]);

  // Live validation: every param must parse as a non-negative integer.
  const allValid = draft.every((row) =>
    [...row.params.values()].every((value) => isValidParam(value)),
  );

  const canAfford = originCompute === null || originCompute >= PATCH_AUTHORING_COST;
  const canSubmit = allValid && canAfford;

  const updateParam = (rowIndex: number, paramKey: string, value: string): void => {
    setDraft((prev) => {
      const next = prev.slice();
      const existing = next[rowIndex];
      if (existing === undefined) return prev;
      const params = new Map(existing.params);
      params.set(paramKey, value);
      next[rowIndex] = { kind: existing.kind, params };
      return next;
    });
  };

  const onApply = (): void => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    const firmware = fromDraft(draft);
    void applyPatch(lineageId, firmware).then((error) => {
      if (!mountedRef.current) return;
      setSubmitting(false);
      if (error === null) {
        onApplied(firmware);
        onClose();
      } else setSubmitError(error);
    });
  };

  return (
    <div
      className="patch-editor-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Apply patch to ${lineageName}`}
      onClick={(e) => {
        // Clicking the backdrop cancels.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="patch-editor firmware-editor">
        <header className="patch-editor-header">
          <h2>Apply patch</h2>
          <span className="patch-editor-target">{lineageName}</span>
        </header>
        <p className="firmware-editor-intro">
          Compare with this lineage’s current reference firmware. Individual probes may have
          drifted. Applying replaces the reference and all living probes in this lineage; future
          descendants inherit and can drift again.
        </p>
        <div className="patch-editor-cost firmware-editor-cost">
          <strong>
            One-time authoring charge: {PATCH_AUTHORING_COST.toString()} Origin compute
          </strong>
          <div>Fixed for every patch, including unchanged values.</div>
          <dl>
            <div>
              <dt>Available compute</dt>
              <dd>{originCompute?.toString() ?? 'Unavailable'}</dd>
            </div>
            <div>
              <dt>{canAfford ? 'After submission' : 'Shortfall'}</dt>
              <dd>
                {originCompute === null
                  ? 'Unavailable'
                  : (canAfford
                      ? originCompute - PATCH_AUTHORING_COST
                      : PATCH_AUTHORING_COST - originCompute
                    ).toString()}
              </dd>
            </div>
          </dl>
          {!canAfford ? (
            <p className="patch-editor-warning">Insufficient Origin compute to apply.</p>
          ) : null}
        </div>
        <div className="patch-editor-body">
          {draft.map((row, rowIndex) => (
            <div key={`${row.kind}-${rowIndex.toString()}`} className="patch-editor-row">
              <div className="patch-editor-kind">{row.kind}</div>
              <div className="patch-editor-params">
                {[...row.params.entries()].map(([paramKey, value]) => {
                  const valid = isValidParam(value);
                  const label = paramLabel(row.kind, paramKey);
                  const help = paramHelp(row.kind, paramKey);
                  const isExploration = row.kind === 'explore' && paramKey === 'threshold';
                  const current = initialFirmware[rowIndex]?.params[paramKey] ?? '';
                  const inputId = `firmware-${rowIndex.toString()}-${paramKey}`;
                  const proposedLabel = isExploration
                    ? 'Proposed encoded threshold'
                    : `Proposed ${label.toLowerCase()}`;
                  return (
                    <div key={paramKey} className="firmware-editor-param">
                      <div className="patch-editor-param-label">{label}</div>
                      {help !== null ? (
                        <p id={`${inputId}-help`} className="firmware-editor-help">
                          {help}
                        </p>
                      ) : null}
                      <div className="firmware-editor-comparison">
                        <div className="firmware-editor-current">
                          <span className="firmware-editor-caption">Current reference</span>
                          <strong>
                            {isExploration ? formatMovementAttemptChance(current) : current}
                          </strong>
                          {isExploration ? (
                            <span className="firmware-editor-encoded">Encoded: {current}</span>
                          ) : null}
                        </div>
                        <div className="firmware-editor-proposed">
                          <label className="firmware-editor-caption" htmlFor={inputId}>
                            {proposedLabel}
                          </label>
                          {isExploration ? (
                            <strong className="firmware-editor-probability" aria-live="polite">
                              {formatMovementAttemptChance(value) ?? 'Invalid probability'}
                            </strong>
                          ) : null}
                          <input
                            id={inputId}
                            type="text"
                            inputMode="numeric"
                            aria-invalid={!valid}
                            aria-describedby={
                              [
                                help !== null ? `${inputId}-help` : '',
                                !valid ? `${inputId}-error` : '',
                              ]
                                .filter(Boolean)
                                .join(' ') || undefined
                            }
                            className={
                              valid
                                ? 'patch-editor-input'
                                : 'patch-editor-input patch-editor-invalid'
                            }
                            value={value}
                            onChange={(e) => {
                              updateParam(rowIndex, paramKey, e.currentTarget.value);
                            }}
                          />
                          {!valid ? (
                            <span id={`${inputId}-error`} className="firmware-editor-validation">
                              Enter a whole number from 0 to 18446744073709551615.
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        {submitError !== null ? (
          <p className="patch-editor-error" role="alert">
            {submitError}
          </p>
        ) : null}
        <footer className="patch-editor-footer">
          <button type="button" className="patch-editor-button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="patch-editor-button patch-editor-button-primary"
            onClick={onApply}
            disabled={!canSubmit || submitting}
          >
            Apply
          </button>
        </footer>
      </div>
    </div>
  );
}

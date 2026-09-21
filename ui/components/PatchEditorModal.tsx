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
import type { DirectiveSpec } from '../../protocol/types.js';
import { parseUint64Decimal } from '../../protocol/uint64.js';
import { useSimStore } from '../sim-store.js';

interface PatchEditorModalProps {
  readonly lineageId: string;
  readonly lineageName: string;
  readonly initialFirmware: readonly DirectiveSpec[];
  readonly onClose: () => void;
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

// Plain-language label for each known parameter so the form reads like
// the inspector's firmware summary, not a wall of identifiers.
function paramLabel(directiveKind: string, paramKey: string): string {
  if (directiveKind === 'replicate' && paramKey === 'threshold') return 'replicate threshold';
  if (directiveKind === 'gather' && paramKey === 'rate') return 'gather rate';
  if (directiveKind === 'explore' && paramKey === 'threshold') return 'explore threshold';
  return `${directiveKind}.${paramKey}`;
}

export function PatchEditorModal({
  lineageId,
  lineageName,
  initialFirmware,
  onClose,
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
  useEffect(() => {
    const wasPausedAtOpen = useSimStore.getState().paused;
    if (!wasPausedAtOpen) {
      pause();
      pausedByMeRef.current = true;
    }
    return () => {
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
    void applyPatch(lineageId, fromDraft(draft)).then((error) => {
      setSubmitting(false);
      if (error === null) onClose();
      else setSubmitError(error);
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
      <div className="patch-editor">
        <header className="patch-editor-header">
          <h2>Apply patch</h2>
          <span className="patch-editor-target">{lineageName}</span>
        </header>
        <div className="patch-editor-cost">
          Cost: {PATCH_AUTHORING_COST.toString()} compute
          {originCompute !== null ? ` · budget ${originCompute.toString()}` : ''}
          {!canAfford ? <span className="patch-editor-warning"> insufficient</span> : null}
        </div>
        <div className="patch-editor-body">
          {draft.map((row, rowIndex) => (
            <div key={`${row.kind}-${rowIndex.toString()}`} className="patch-editor-row">
              <div className="patch-editor-kind">{row.kind}</div>
              <div className="patch-editor-params">
                {[...row.params.entries()].map(([paramKey, value]) => {
                  const valid = isValidParam(value);
                  return (
                    <label key={paramKey} className="patch-editor-param">
                      <span className="patch-editor-param-label">
                        {paramLabel(row.kind, paramKey)}
                      </span>
                      <input
                        type="text"
                        inputMode="numeric"
                        className={
                          valid ? 'patch-editor-input' : 'patch-editor-input patch-editor-invalid'
                        }
                        value={value}
                        onChange={(e) => {
                          updateParam(rowIndex, paramKey, e.currentTarget.value);
                        }}
                      />
                    </label>
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

// PatchEditorModal — modal-on-action editor for player-authored patches.
//
// Per CLAUDE.md feedback patterns: occasional player actions (save, load,
// apply patch) pause the sim and prompt at click rather than rendering
// perpetual UI that updates against live state. The modal opens with the
// lineage's current reference firmware pre-filled; the player edits each
// numeric parameter, sees the cost vs current budget, and either Applies
// or Cancels. Either action resumes the sim.

import { useEffect, useState } from 'react';
import { PATCH_AUTHORING_COST } from '../../sim/compute.js';
import type { DirectiveSpec } from '../../protocol/types.js';
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

// A non-negative integer-bearing string, matching what the sim accepts
// for each numeric param. Empty string is invalid (forces the player to
// enter something rather than silently sending zero).
function isValidParam(value: string): boolean {
  if (value.trim() === '') return false;
  if (!/^\d+$/.test(value)) return false;
  try {
    BigInt(value);
    return true;
  } catch {
    return false;
  }
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

  // Modal-on-action: pause on open, resume on close. The cleanup runs
  // whether the modal closes via Apply or Cancel.
  useEffect(() => {
    pause();
    return () => {
      resume();
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
    if (!canSubmit) return;
    applyPatch(lineageId, fromDraft(draft));
    onClose();
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
        <footer className="patch-editor-footer">
          <button type="button" className="patch-editor-button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="patch-editor-button patch-editor-button-primary"
            onClick={onApply}
            disabled={!canSubmit}
          >
            Apply
          </button>
        </footer>
      </div>
    </div>
  );
}

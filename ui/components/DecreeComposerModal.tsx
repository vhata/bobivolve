// DecreeComposerModal — modal-on-action composer for conditional patches.
//
// SPEC.md "Decrees are conditional patches queued to fire when their
// triggers match." The composer lets the player pick a trigger (R2 V1:
// populationBelow only), pick a target lineage for the patch payload,
// and edit the firmware to install when the trigger fires.
//
// Like the patch editor, this is modal-on-action: the sim pauses while
// the modal is open and resumes on close.

import { useEffect, useRef, useState } from 'react';
import { DECREE_AUTHORING_COST } from '../../sim/compute.js';
import type { DirectiveSpec } from '../../protocol/types.js';
import { useSimStore } from '../sim-store.js';

interface DecreeComposerModalProps {
  readonly defaultTriggerLineageId: string;
  readonly defaultPatchTargetLineageId: string;
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

function paramLabel(directiveKind: string, paramKey: string): string {
  if (directiveKind === 'replicate' && paramKey === 'threshold') return 'replicate threshold';
  if (directiveKind === 'gather' && paramKey === 'rate') return 'gather rate';
  if (directiveKind === 'explore' && paramKey === 'threshold') return 'explore threshold';
  return `${directiveKind}.${paramKey}`;
}

export function DecreeComposerModal({
  defaultTriggerLineageId,
  defaultPatchTargetLineageId,
  initialFirmware,
  onClose,
}: DecreeComposerModalProps): React.JSX.Element {
  const pause = useSimStore((s) => s.pause);
  const resume = useSimStore((s) => s.resume);
  const queueDecree = useSimStore((s) => s.queueDecree);
  const originCompute = useSimStore((s) => s.originCompute);
  const lineages = useSimStore((s) => s.lineages);

  const [triggerLineageId, setTriggerLineageId] = useState(defaultTriggerLineageId);
  const [thresholdStr, setThresholdStr] = useState('10');
  const [patchTargetLineageId, setPatchTargetLineageId] = useState(defaultPatchTargetLineageId);
  const [draft, setDraft] = useState<DraftRow[]>(() => toDraft(initialFirmware));

  // Modal-on-action: pause on open, resume on close — but only if WE
  // paused. Same fix as PatchEditorModal; without the guard, closing
  // the composer would un-pause whatever the player had explicitly
  // paused.
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

  const lineageOptions = [...lineages.values()].map((l) => ({
    id: l.id,
    label: l.name === l.id ? l.id : `${l.name} (${l.id})`,
  }));

  const thresholdValid = isValidParam(thresholdStr);
  const allParamsValid = draft.every((row) =>
    [...row.params.values()].every((value) => isValidParam(value)),
  );
  const canAfford = originCompute === null || originCompute >= DECREE_AUTHORING_COST;
  const canSubmit = thresholdValid && allParamsValid && canAfford;

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

  const onSubmit = (): void => {
    if (!canSubmit) return;
    queueDecree(
      { kind: 'populationBelow', lineageId: triggerLineageId, threshold: thresholdStr },
      patchTargetLineageId,
      fromDraft(draft),
    );
    onClose();
  };

  return (
    <div
      className="patch-editor-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Compose decree"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="patch-editor decree-composer">
        <header className="patch-editor-header">
          <h2>Queue decree</h2>
          <span className="patch-editor-target">conditional patch</span>
        </header>
        <div className="patch-editor-cost">
          Cost: {DECREE_AUTHORING_COST.toString()} compute
          {originCompute !== null ? ` · budget ${originCompute.toString()}` : ''}
          {!canAfford ? <span className="patch-editor-warning"> insufficient</span> : null}
        </div>
        <div className="decree-composer-section">
          <h3 className="decree-composer-subhead">Trigger</h3>
          <p className="decree-composer-explainer">
            Fire the patch when the monitored lineage&apos;s population drops below the threshold.
          </p>
          <label className="decree-composer-field">
            <span>monitor</span>
            <select
              value={triggerLineageId}
              onChange={(e) => {
                setTriggerLineageId(e.currentTarget.value);
              }}
            >
              {lineageOptions.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <label className="decree-composer-field">
            <span>population &lt;</span>
            <input
              type="text"
              inputMode="numeric"
              className={
                thresholdValid ? 'patch-editor-input' : 'patch-editor-input patch-editor-invalid'
              }
              value={thresholdStr}
              onChange={(e) => {
                setThresholdStr(e.currentTarget.value);
              }}
            />
          </label>
        </div>
        <div className="decree-composer-section">
          <h3 className="decree-composer-subhead">Patch payload</h3>
          <label className="decree-composer-field">
            <span>target</span>
            <select
              value={patchTargetLineageId}
              onChange={(e) => {
                setPatchTargetLineageId(e.currentTarget.value);
              }}
            >
              {lineageOptions.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
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
        </div>
        <footer className="patch-editor-footer">
          <button type="button" className="patch-editor-button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="patch-editor-button patch-editor-button-primary"
            onClick={onSubmit}
            disabled={!canSubmit}
          >
            Queue
          </button>
        </footer>
      </div>
    </div>
  );
}

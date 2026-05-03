// SwitchRunModal — modal-on-action picker for the active run-slot.
//
// Distinct from save snapshots (handled by RunPanel's existing Save /
// Load): each row here is a separate ongoing simulation persisted on
// disk under runs/<runId>/. Picking a row makes that slot active —
// the host snap-saves the outgoing slot at its current tick (so a
// future return restores cleanly), points at the new slot, and either
// loads its latest snapshot or enters its empty-state if the slot is
// fresh.
//
// Modal-on-action per the codified pattern: the panel's "Switch run…"
// button pauses the sim before opening this modal, the modal queries
// listRuns once on open (no live updates), and the player explicitly
// commits via Switch / Create / Delete.

import { useEffect, useState } from 'react';
import { useSimStore } from '../sim-store.js';

interface Props {
  readonly onClose: () => void;
}

function defaultNewSlotName(): string {
  // Date-stamped, ASCII-safe, sortable. The player can rename by typing
  // over it; the default exists so they can hit Enter without thinking.
  const d = new Date();
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `run-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

const SLOT_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function isValidSlotName(name: string): boolean {
  return SLOT_NAME_PATTERN.test(name);
}

function formatLastModified(ms: number): string {
  if (ms === 0) return 'never';
  const d = new Date(ms);
  return d.toLocaleString();
}

export function SwitchRunModal({ onClose }: Props): React.JSX.Element {
  const runs = useSimStore((s) => s.runs);
  const activeRunId = useSimStore((s) => s.activeRunId);
  const switchRun = useSimStore((s) => s.switchRun);
  const deleteRun = useSimStore((s) => s.deleteRun);
  const refreshRuns = useSimStore((s) => s.refreshRuns);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState<string>(defaultNewSlotName);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // One-shot refresh on mount — modal-on-action means we pull the
  // current list now, not subscribe to it. Closing and reopening picks
  // up any changes since.
  useEffect(() => {
    void refreshRuns();
  }, [refreshRuns]);

  // Escape closes the modal.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
    };
  }, [onClose]);

  function handleSelect(runId: string): void {
    if (runId === activeRunId) return;
    switchRun(runId);
    onClose();
  }

  function handleCreate(): void {
    const trimmed = newName.trim();
    if (!isValidSlotName(trimmed)) return;
    switchRun(trimmed);
    onClose();
  }

  function handleDelete(runId: string): void {
    if (runId === activeRunId) return;
    deleteRun(runId);
    setConfirmDelete(null);
  }

  // Render the active row pinned to the top so the player's anchor
  // stays visible even at a long list. Other rows sort by recency
  // (the host already returns them mtime-desc).
  const activeRow = runs.find((r) => r.runId === activeRunId);
  const otherRows = runs.filter((r) => r.runId !== activeRunId);

  return (
    <div
      className="switch-run-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Switch active run"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="switch-run-modal">
        <header className="switch-run-header">
          <h2>Switch run</h2>
          <button type="button" className="switch-run-cancel" onClick={onClose}>
            cancel (esc)
          </button>
        </header>

        <p className="switch-run-helper">
          Each row is a separate ongoing simulation on disk. Picking one makes it active; your
          current run stays where it is.
        </p>

        <ul className="switch-run-list">
          {activeRow ? (
            <li className="switch-run-row switch-run-row-active">
              <span className="switch-run-name">
                {activeRow.runId} <span className="switch-run-active-tag">(active)</span>
              </span>
              <span className="switch-run-meta">
                tick {activeRow.latestTick} · {formatLastModified(activeRow.lastModifiedMs)}
              </span>
            </li>
          ) : null}
          {otherRows.length === 0 && activeRow !== undefined ? (
            <li className="switch-run-empty">no other runs on disk</li>
          ) : null}
          {otherRows.map((r) => (
            <li key={r.runId} className="switch-run-row">
              <button
                type="button"
                className="switch-run-pick"
                onClick={() => handleSelect(r.runId)}
                title={`Switch to ${r.runId}`}
              >
                <span className="switch-run-name">{r.runId}</span>
                <span className="switch-run-meta">
                  tick {r.latestTick} · {formatLastModified(r.lastModifiedMs)}
                </span>
              </button>
              {confirmDelete === r.runId ? (
                <div className="switch-run-confirm">
                  <span>Delete?</span>
                  <button
                    type="button"
                    className="switch-run-delete-confirm"
                    onClick={() => handleDelete(r.runId)}
                  >
                    yes, delete
                  </button>
                  <button
                    type="button"
                    className="switch-run-delete-cancel"
                    onClick={() => setConfirmDelete(null)}
                  >
                    no
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="switch-run-delete"
                  onClick={() => setConfirmDelete(r.runId)}
                  aria-label={`Delete ${r.runId}`}
                >
                  delete
                </button>
              )}
            </li>
          ))}
        </ul>

        <div className="switch-run-create">
          {creating ? (
            <form
              className="switch-run-create-form"
              onSubmit={(e) => {
                e.preventDefault();
                handleCreate();
              }}
            >
              <label className="switch-run-create-label">
                <span>name</span>
                <input
                  type="text"
                  className="switch-run-create-input"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  autoFocus
                  pattern="[A-Za-z0-9_-]{1,64}"
                  title="Letters, digits, underscore, hyphen — up to 64 characters"
                />
              </label>
              <button
                type="submit"
                className="switch-run-create-submit"
                disabled={!isValidSlotName(newName.trim())}
              >
                create &amp; switch
              </button>
              <button
                type="button"
                className="switch-run-create-cancel"
                onClick={() => setCreating(false)}
              >
                cancel
              </button>
            </form>
          ) : (
            <button
              type="button"
              className="switch-run-create-trigger"
              onClick={() => {
                setNewName(defaultNewSlotName());
                setCreating(true);
              }}
            >
              new run…
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

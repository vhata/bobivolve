# Review backlog

Only work promoted from whole-codebase reviews belongs here. Every entry is ready for separate work and carries a `Findings:` line naming the raw review findings it covers; each finding maps to at most one entry. Claiming and resolving follow [docket/TODO_GUIDE.md](../docket/TODO_GUIDE.md); promotion follows [docket/CODE_REVIEW_GUIDE.md](../docket/CODE_REVIEW_GUIDE.md).

## P0 Critical

- [HOST] `browser-run-log-durability` — **Persist the browser run's event log during play, so a reload, tab close or crash does not lose the run.** The worker flushes the log only on an explicit Pause, startup or timeline operations. Play that is never paused, commands issued while paused before the next pause, and play after an auto-pause are lost on reload.
  - Source: [full review](2026-10-08-0701-full.md), 2026-10-08
  - Findings: `browser-log-only-persisted-on-pause`
  - Starting point: `host/worker.ts:82,217`, `host/node.ts` (`scheduleSnapshot`, auto-pause at 1155-1161, the startup `switchRun` acknowledgement), `host/event-log.ts` (`EventLogWriter`). Add a reload-while-running browser test; the existing reload tests pause first.

## P1 High

## P2 Normal

## P3 Low

## Unprioritized

- [HOST] `fresh-browser-run-autostart` — **Start the default seed-42 run on a first visit, as documented.** The startup `switchRun` acknowledgement is written to the empty slot's log, so the dashboard restores an empty run instead of starting one.
  - Source: [full review](2026-10-08-0701-full.md), 2026-10-08
  - Findings: `fresh-browser-run-never-starts`
  - Related: `browser-run-log-durability`
  - Starting point: `host/node.ts` (`handleSwitchRun` acknowledgement), `ui/sim-store.ts` (`bootstrapRun`). Add a browser test that starts from cleared OPFS without clicking Start.
- [HOST] `event-log-replay-fidelity` — **Make logged commands replay exactly as they executed live.** Rejected commands are logged and revived by field name. Their replay diverges or poisons the log, `step` replays differently from live play, and `logSlice` can race a new run's log reset. Heartbeats also enter the log despite its documented domain-event-only contract, and their population maps return as strings from in-process `logSlice` queries.
  - Source: [full review](2026-10-08-0701-full.md), 2026-10-08
  - Findings: `event-log-reviver-revives-string-params`, `step-pause-and-replay-semantics`, `logslice-flush-races-newrun-delete`, `heartbeat-events-persisted`
  - Additional evidence: [full review](2026-10-24-0252-full.md), 2026-10-24.
- [HOST] `host-storage-input-hardening` — **Reject unsafe run IDs and never discard save listings on an unreadable index.** `deleteRun('.')` removes every run on Node storage, and case aliases can bypass the active-run deletion guard on case-insensitive filesystems. Save rewrites a corrupt index with only the new entry and can overwrite another listed save through filesystem aliases. Validate underlying identity for run IDs and save names as well as their path syntax.
  - Source: [full review](2026-10-08-0701-full.md), 2026-10-08
  - Findings: `runid-dot-segment-unsafe`, `save-overwrites-corrupt-index`
  - Additional evidence: [full review](2026-10-24-0252-full.md), 2026-10-24; alias cases reproduced with temporary Node storage on macOS.
- [HOST] `worker-failure-and-pacing` — **Report worker query and startup failures, and keep worker pacing in step with the host.** Failed queries never reply and leave the dashboard hanging; a failed startup restore strands the session; pacing changes before validation; and Start leaves the worker at the old speed.
  - Source: [full review](2026-10-08-0701-full.md), 2026-10-08
  - Findings: `worker-errors-unobserved`, `startup-restore-failure-strands-session`, `worker-pacing-before-validation`, `newrun-speed-desync`
- [SIM] `extinct-lineage-interventions` — **Handle interventions on extinct lineages as documented.** Decrees report a landed patch on extinct targets, dead quarantine holds keep consuming compute ahead of living holds, and threshold-zero decrees are accepted although they can never fire. Expect intervention golden changes, which need review.
  - Source: [full review](2026-10-08-0701-full.md), 2026-10-08
  - Findings: `decree-extinct-target-reports-landed`, `quarantine-survives-extinction`, `decree-threshold-zero-never-fires`
- [UI] `ui-projection-consistency` — **Keep the dashboard's projected state consistent with the host after retries, rejections and selection or run changes.** Retries can reorder pause and resume, optimistic toggles never roll back, and several indicators show stale values.
  - Source: [full review](2026-10-08-0701-full.md), 2026-10-08
  - Findings: `pause-resume-retry-reorders`, `autopause-leaves-actual-speed`, `stale-seed-and-save-indicator`, `optimistic-commands-no-rollback`, `inspector-stale-drift-on-select`
- [PROTOCOL] `protocol-contract-parity` — **Bring `schema.proto` and the stdio codec back in line with `protocol/types.ts`.** The schema lacks run-slot messages and several fields, mistypes u64 fields as strings, and the codec leaves two query results unrevived.
  - Source: [full review](2026-10-08-0701-full.md), 2026-10-08
  - Findings: `schema-proto-drift`, `ndjson-codec-missing-result-revival`
- [TOOLING] `worktree-safe-dev-tooling` — **Keep lint and browser tests scoped to their own worktree.** ESLint in the primary checkout lints nested worktrees, and Playwright can reuse another worktree's dev server on the fixed port.
  - Source: [full review](2026-10-08-0701-full.md), 2026-10-08
  - Findings: `eslint-lints-nested-worktrees`, `playwright-reuses-foreign-dev-server`
  - Coordination: hook installation in worktrees is tracked separately in TODO (PR #34).
- [TOOLING] `determinism-gate-integrity` — **Make the determinism checks fail when they compare nothing.** The CLI silently exits 0 from encoded paths, CLI output is never compared with the goldens, regeneration passes unconditionally, and the scheduled probes can be skipped.
  - Source: [full review](2026-10-08-0701-full.md), 2026-10-08
  - Findings: `cli-ismain-url-mismatch`, `cli-golden-parity-unverified`, `golden-harness-silent-pass`, `main-validation-probe-gaps`
- [UI] `timeline-retroactive-ordering` — **Keep promoted timeline events in event-time order before retaining and plotting them.** Retroactively promoted speciations are appended after newer milestones. The default view can show an old event as newest, draw it left of the SVG, and retain entries by promotion order rather than tick.
  - Source: [full review](2026-10-24-0252-full.md), 2026-10-24
  - Findings: `timeline-retroactive-ordering`
  - Starting point: `ui/components/EventsTimelinePanel.tsx:283-316`. Exercise a speciation at tick 10, milestone at tick 20, then population promotion at tick 30. Keep stable tie ordering, display newest events first, and keep both markers inside the timeline; cover truncation after retroactive promotion.
- [UI] `switch-run-narrow-modal-clipping` — **Keep run-switch controls inside the viewport on narrow screens.** The dialog's 480px minimum plus padding defeats its viewport maximum: at 390px the dialog is 530px wide and Cancel extends beyond the right edge.
  - Source: [full review](2026-10-24-0252-full.md), 2026-10-24
  - Findings: `switch-run-narrow-modal-clipping`
  - Starting point: `ui/styles.css:2064-2072`, `ui/components/SwitchRunModal.tsx:106-118`. Use a viewport-bounded box width and allow rows/creation controls to wrap; verify a 390px viewport and the existing desktop layout.

# Review index

Historical codebase reviews are immutable snapshots; the newest snapshot is the current finding inventory. Fix PRs supply evidence; the next incremental review verifies and records closure. Process: [docket/CODE_REVIEW_GUIDE.md](../docket/CODE_REVIEW_GUIDE.md). Promoted work: [BACKLOG.md](BACKLOG.md). Newest first; the top row is the baseline for the next incremental review. An empty index means no current full/incremental baseline has been recorded, not that there are no defects.

The [historical project-direction review](../docs/PROJECT_REVIEW.md) records `c8ca0c3`. It remains unchanged and is not imported as a full-codebase snapshot or a current finding inventory. Existing outstanding follow-ups remain in TODO; only deliberate promotion by a new codebase review moves findings into BACKLOG. The [first full review](2026-10-08-0701-full.md) establishes the current baseline.

| Review (UTC)                                       | Type        | Reviewed commit | Open findings at close |
| -------------------------------------------------- | ----------- | --------------- | ---------------------- |
| [2026-10-24 02:52](2026-10-24-0252-full.md)        | Full        | `ba1848b`       | 63                     |
| [2026-10-12 18:30](2026-10-12-1830-incremental.md) | Incremental | `9eb84dd`       | 58                     |
| [2026-10-08 07:01](2026-10-08-0701-full.md)        | Full        | `9b37eed`       | 62                     |

## Pending reconciliation

Findings whose fix has landed with independent verification but whose closure the next review has not yet recorded. The next incremental review verifies each and clears the list.

| Finding                                | Fix PR and commit | Reviewer                                    | Evidence                                                                                                                                                                                          |
| -------------------------------------- | ----------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser-log-only-persisted-on-pause`  | #44 (211f789)     | Independent reviewer agent (see PR comment) | Reload while running lost all unpaused play on the base (tick 3717 before, 0 after) and kept it after (3700 before, 3684 after); `e2e/run-log-durability.spec.ts` fails on the base               |
| `schema-proto-drift`                   | #39 (7514c43)     | Independent reviewer agent (see PR comment) | Old and new schema compiled with protoc and compared field by field; `protocol/schema-parity.test.ts` fails on dropped, retyped or extra fields                                                   |
| `ndjson-codec-missing-result-revival`  | #39 (7514c43)     | Independent reviewer agent (see PR comment) | `transport/ndjson-codec.test.ts` round-trips every query result kind; a real stdio child decoded all 9 query kinds with u64 fields as `bigint`                                                    |
| `eslint-lints-nested-worktrees`        | #41 (5e7b261)     | Independent reviewer agent (see PR comment) | Lint-failing scratch files under `.worktrees/` and `.claude/worktrees/` reported by the old config, ignored by the new one; same 116 files linted otherwise                                       |
| `playwright-reuses-foreign-dev-server` | #41 (5e7b261)     | Independent reviewer agent (see PR comment) | Decoy server on the derived port makes the run fail with "already used" and receives no requests; `test/tooling/worktree-isolation.test.ts` pins port, host and no-reuse                          |
| `runid-dot-segment-unsafe`             | #43 (15afb3d)     | Independent reviewer agent (see PR comment) | `deleteRun('.')` and deleting `ACTIVE` while `active` is current reproduced on the base and refused after; `host/storage-alias.test.ts` runs on a case-folding fake and the real macOS filesystem |
| `save-overwrites-corrupt-index`        | #43 (15afb3d)     | Independent reviewer agent (see PR comment) | Save over a corrupt index and Keep-then-keep alias overwrite reproduced on the base; both refused after with index and save bytes unchanged                                                       |
| `decree-extinct-target-reports-landed` | #42 (e012c17)     | Independent reviewer agent (see PR comment) | Seeded seed-42 scenario: decree on an extinct target fires with `landed:false`; CLI output differs from the base only by that flag and the added lift event                                       |
| `quarantine-survives-extinction`       | #42 (e012c17)     | Independent reviewer agent (see PR comment) | Hold released with `quarantineLifted` at extinction, including without an event sink; replay, rewind and load reproduce byte-identical saves                                                      |
| `decree-threshold-zero-never-fires`    | #42 (e012c17)     | Independent reviewer agent (see PR comment) | Host rejects threshold 0 before charging compute; regression test fails with the check removed                                                                                                    |

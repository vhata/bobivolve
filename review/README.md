# Review index

Historical codebase reviews are immutable snapshots; the newest snapshot is the current finding inventory. Fix PRs supply evidence; the next incremental review verifies and records closure. Process: [docs/CODE_REVIEW_GUIDE.md](../docs/CODE_REVIEW_GUIDE.md). Promoted work: [BACKLOG.md](BACKLOG.md). Newest first; the top row is the baseline for the next incremental review. An empty index means no current full/incremental baseline has been recorded, not that there are no defects.

The [historical project-direction review](../docs/PROJECT_REVIEW.md) records `c8ca0c3`. It remains unchanged and is not imported as a full-codebase snapshot or a current finding inventory. Existing outstanding follow-ups remain in TODO; only deliberate promotion by a new codebase review moves findings into BACKLOG. The [first full review](2026-10-08-0701-full.md) establishes the current baseline.

| Review (UTC)                                | Type | Reviewed commit | Open findings at close |
| ------------------------------------------- | ---- | --------------- | ---------------------- |
| [2026-10-08 07:01](2026-10-08-0701-full.md) | Full | `9b37eed`       | 61                     |

## Pending reconciliation

Findings whose fix has landed with independent verification but whose closure the next review has not yet recorded. The next incremental review verifies each and clears the list.

| Finding | Fix PR and commit | Reviewer | Evidence |
| ------- | ----------------- | -------- | -------- |

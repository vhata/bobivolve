# Code review

Read when delegating work, reviewing a diff, or when the user requests a broader review. Review effort follows the consequences of a mistake.

## Agent workflow

Split independent implementation, investigation, and validation work among sub-agents wherever practical. Give each task a bounded outcome, owned files or component, dependencies, and expected checks. Check existing branches, worktrees, and PRs first; give each concurrent writer an isolated worktree and focused branch. Coordinate shared interfaces before parallel edits, and sequence dependent work rather than letting agents overwrite one another. Use the available agent capacity for useful parallel work and schedule dependent reviews as writers finish.

The coordinating agent owns task boundaries, integration, and the final handoff. It checks the combined result and runs validation appropriate to interactions between changes, following the [quality policy](QUALITY.md). Passing checks on isolated branches does not establish that their combination works.

Pair every code-writing agent with a reviewer agent distinct from the author of the code it reviews. This includes code written by the coordinating agent and subsequent integration changes. Self-review remains useful but does not replace this independent review. Reviewers report findings rather than editing the author's code; authors own fixes. Reviewing alone does not require another reviewer, and routine changes do not need a stack of specialist review passes.

Give the reviewer the intended behaviour, relevant requirements, base and head commits, and validation results. The reviewer reads the actual diff and surrounding code, independently checks the claims, and follows the routine review guidance below. Keep each author's contribution identifiable when a PR contains work from multiple writers, and ensure all code has an independent reviewer.

Authors address actionable findings and run meaningful checks for the changed behaviour. The reviewer verifies fixes against the original failure and reviews any additional changes before the PR is handed to the user. Resolve disagreements with evidence and record the disposition; disclose any unresolved issue. Keep the PR draft or pending review while actionable correctness findings remain unresolved; close them with a verified fix or an evidence-supported disposition. Complete independent review before presenting a PR as ready for the user's final review. Open draft PRs after the first meaningful commit. Mark ready when implementation, required checks, and independent review are complete; return to draft if any gate becomes incomplete.

Report who reviewed which commits or scope, the result, checks actually run, and material limitations in the handoff. If reviewer tools or agent capacity are unavailable, state the limitation and keep the PR pending review rather than treating self-review or automated checks as a substitute. Record that handoff in the PR body under `## Review`; codebase finding closure follows the ledger below. The user's final review and merge remain separate from agent review.

## Routine changes

Read the diff and enough surrounding code to judge it. Load the relevant architecture, decisions, and product sections only where they bear on the change. Check correctness, scope, error handling, validation, and documentation claims.

Focus additional scrutiny where it matters:

- **Simulation:** integer accounting, PRNG draw and iteration order, conservation, intentional golden changes.
- **Protocol and transports:** matching schema/types/codecs, additive compatibility, plain-data messages, browser/headless parity.
- **Persistence and replay:** save/load round trips, missing or corrupt data, command ordering, timeline forks, recovery limits.
- **UI:** command acknowledgements, run changes, subscriptions, and the affected player flow.

Report actionable findings with severity, file/location, failure scenario, and evidence. Distinguish reproduced failures from inspection-based concerns. State what was checked and any gaps; a clean review need not invent findings.

## Ledger

- `review/README.md` indexes snapshots newest first with type, reviewed commit (a commit on `main`) and open count at close. The top row is the next incremental review's baseline; the newest Full row is the baseline for cumulative churn.
- `review/YYYY-MM-DD-HHMM-full.md` / `-incremental.md` (UTC) are immutable once merged, except for factual corrections to the review itself. Status changes are recorded by the next snapshot, never by the PR that fixes a finding.
- `review/BACKLOG.md` is the mutable queue of findings promoted into separate work; see [TODO_GUIDE.md](TODO_GUIDE.md).

### Snapshot skeleton

```md
# <Full|Incremental> review, YYYY-MM-DD

| Field           | Value                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| Type            | Full / Incremental                                                                                       |
| Reviewed commit | `<sha>` on main                                                                                          |
| Previous review | <file> at `<sha>` / None                                                                                 |
| Reviewers       | <coordinator; independent agents and the areas each covered>                                             |
| Baseline        | `bash scripts/check.sh`: <result>; `bash scripts/e2e.sh`: <result>; <other baseline commands>: <results> |

## Summary

## Invariants

## Findings

### Open and Moved

### Closed

## Backlog mapping

| Backlog entry | Findings | Decision |

## Suggested order of work

## Verification limits
```

### Finding format

```md
- `immutable-finding-slug` — **One-sentence title.** Kind · Status · Verification.
  - Where: `path:line` (`symbol`) at the reviewed commit.
  - Severity: P0..P3.
  - Failure scenario, evidence and suggested correction in one to four sentences.
  - Review backlog: `mapped-backlog-slug`
```

Kinds: Bug, Design, Duplication, Performance, Test, Style, Tooling, Docs, Security. Verification: **Verified** (executed or reproduced) or **Read** (inspection). Statuses: **Open**, **Moved** (open at a new location), **Fixed**, **Accepted** (reason), **Invalid** (evidence), **Superseded** (replacement slug). Every non-open status carries evidence. Accepted records the reason, who decided, and when to reconsider. Accepting a real correctness or security risk requires the user's decision; an agent may show a finding Invalid with evidence, but cannot accept that risk on the user's behalf. Closed entries are one line each with reference, location at the reviewed commit, and confirmation:

```md
- `finding-slug` — Fixed in #45 (f10a8e2). `path:line` (`symbol`): what the code now does. Original reproduction rerun; no longer reproduces.
```

One finding is one independently fixable, verifiable problem; repeated instances of one smell are one finding listing every site.

Review snapshots are tied to main commits. A pre-landing review must preserve its tree (PR head or git bundle) and record the exact correspondence with the landed squash commit before using it as a baseline. Missing or non-ancestor baselines are coverage gaps; merge-base figures are approximations. The historical project-direction report remains historical, outside this new baseline.

## Baseline checks

Run at the reviewed commit and record exact results in the header:

```bash
bash scripts/check.sh
bash scripts/build.sh
bash scripts/e2e.sh --grep-invert @diagnostic
bash scripts/sim.sh --seed 42 --ticks 1000 --no-heartbeat
```

A check that passed at the previous review and fails now is a finding.

## Full review

1. Record the reviewed commit and run the baseline.
2. Read all maintained source, tests and configuration; delegate independent areas to parallel agents and confirm every claim against the source before recording it.
3. Reproduce serious bugs (Verified); the rest stay Read.
4. Review-close triage (below).
5. Write the snapshot, amend the invariants, add the index row.
6. Open the review as its own PR. It carries no code fixes; small factual documentation fixes may be separate commits on the review branch, recorded as Fixed.

## Incremental review

Base is the newest snapshot's reviewed commit.

1. Baseline, recorded.
2. Re-check every standing finding by reading current code. For merged PRs carrying `Resolves review finding: <slug>`, inspect the code at the new commit, record the new location, rerun the original reproduction (Verified) or repeat the inspection (Read). Unconfirmed closures stay Open or Moved with their backlog mapping restored.
3. Read the whole delta against the invariants and standing findings; a new copy of a listed duplication is a finding.
4. Mechanical checks: `bash scripts/workflow/check-links.sh`, `bash scripts/workflow/check-queues.sh --strict`, counts of lint suppressions and in-code TODO/FIXME markers, largest files, stray tracked files, and this project's drift checks: documented CLI options, controls, and FEATURES.md against code; SPEC/plan status against merged work; QUALITY.md against hooks and CI. Compare every number with the previous snapshot.
5. Re-read files touched by most PRs in the delta.
6. Review-close triage, snapshot, index row, review PR.

Run `bash scripts/workflow/review-due.sh --paths "sim host transport ui protocol test e2e"` to measure drift. Its verdict requests review work, not permission to fix inventory findings. The scheduled validation reports it as well.

A full review resets the baseline after a large refactor, when a hot file was rewritten, when most findings are closed and a clean baseline is wanted, when two consecutive incremental reviews each added many findings, or when `bash scripts/workflow/review-due.sh` reports source churn above a third of the codebase.

## Review-close triage

For every Open or Moved finding at close, exactly one decision, recorded in the mapping table: map to an existing backlog entry; promote into a new coherent ready entry (verified or user-visible bug, structural change that unblocks work, or a batch of small defects in one area); keep as inventory with a reason; or fix now when it is a small documentation edit. Promotion is not authorisation to implement.

## Fixing a finding

Select by explicit assignment first, otherwise from `review/BACKLOG.md` by priority. Raw findings without a backlog entry are inventory, not a queue. The fix PR claims its backlog slug and each finding in scope, opens with `## Why`, and includes in `## Validation` a human-runnable scenario: setup, actions, the old failure, the expected corrected result (or, for tooling and docs, the command or inspection and its success condition). "Tests pass" alone is not a scenario. The independent reviewer verifies the fix against the original failure before the PR is ready. When the PR lands, add the finding to the Pending reconciliation list in `review/README.md` (finding, fix PR and commit, reviewer, evidence). The next incremental review owns closure and clears that list.

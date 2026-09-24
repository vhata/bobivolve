# Code review

Read when delegating work, reviewing a diff, or when the user requests a broader review. Review effort follows the consequences of a mistake.

## Agent workflow

Split independent implementation, investigation, and validation work among sub-agents wherever practical. Give each task a bounded outcome, owned files or component, dependencies, and expected checks. Check existing branches, worktrees, and PRs first; give each concurrent writer an isolated worktree and focused branch. Coordinate shared interfaces before parallel edits, and sequence dependent work rather than letting agents overwrite one another. Use the available agent capacity for useful parallel work and schedule dependent reviews as writers finish.

The coordinating agent owns task boundaries, integration, and the final handoff. It checks the combined result and runs validation appropriate to interactions between changes, following the [quality policy](QUALITY.md). Passing checks on isolated branches does not establish that their combination works.

Pair every code-writing agent with a reviewer agent distinct from the author of the code it reviews. This includes code written by the coordinating agent and subsequent integration changes. Self-review remains useful but does not replace this independent review. Reviewers report findings rather than editing the author's code; authors own fixes. Reviewing alone does not require another reviewer, and routine changes do not need a stack of specialist review passes.

Give the reviewer the intended behaviour, relevant requirements, base and head commits, and validation results. The reviewer reads the actual diff and surrounding code, independently checks the claims, and follows the routine review guidance below. Keep each author's contribution identifiable when a PR contains work from multiple writers, and ensure all code has an independent reviewer.

Authors address actionable findings and run meaningful checks for the changed behaviour. The reviewer verifies fixes against the original failure and reviews any additional changes before the PR is handed to the user. Resolve disagreements with evidence and record the disposition; disclose any unresolved issue. Keep the PR draft or pending review while actionable correctness findings remain unresolved; close them with a verified fix or an evidence-supported disposition. Complete independent review before presenting a PR as ready for the user's final review. Draft PRs may be used for coordination while work or review is pending.

Report who reviewed which commits or scope, the result, checks actually run, and material limitations in the handoff. If reviewer tools or agent capacity are unavailable, state the limitation and keep the PR pending review rather than treating self-review or automated checks as a substitute. No permanent review ledger is required. The user's final review and merge remain separate from agent review.

## Routine changes

Read the diff and enough surrounding code to judge it. Load the relevant architecture, decisions, and product sections only where they bear on the change. Check correctness, scope, error handling, validation, and documentation claims.

Focus additional scrutiny where it matters:

- **Simulation:** integer accounting, PRNG draw and iteration order, conservation, intentional golden changes.
- **Protocol and transports:** matching schema/types/codecs, additive compatibility, plain-data messages, browser/headless parity.
- **Persistence and replay:** save/load round trips, missing or corrupt data, command ordering, timeline forks, recovery limits.
- **UI:** command acknowledgements, run changes, subscriptions, and the affected player flow.

Report actionable findings with severity, file/location, failure scenario, and evidence. Distinguish reproduced failures from inspection-based concerns. State what was checked and any gaps; a clean review need not invent findings.

## Broader reviews

When requested, agree the scope from the request and inspect interactions beyond individual diffs. Record the reviewed commit, checks performed, findings, and limitations in the review deliverable. Reproduce serious failures when practical. Do not create a permanent ledger or incremental-review bureaucracy unless the user asks for one.

Put actionable deferred findings in [TODO.md](../TODO.md) using the [TODO guide](TODO_GUIDE.md). A finding does not automatically authorise an unrelated fix. Verify fixes against their original failure; do not require a later whole-codebase review to acknowledge a fix already demonstrated by evidence.

# Deferred work

Read when an idea surfaces or when selecting, adding, or completing deferred work.

## Scope and capture

Work required for the user's requested outcome, correctness, or validation stays in scope. Capture separately shippable ideas in [TODO.md](../TODO.md), including their rationale, before deciding whether to implement them. Default to deferring those ideas; a new entry is not permission to expand the task. Explicitly requested work can proceed without an extra approval step.

Search for an existing entry first. Keep entries concise: intended outcome, why it matters, release/area tags where useful, and the source of the idea. Include unresolved decisions or a useful starting point; link to detailed evidence instead of embedding long investigations.

## Selecting and completing work

- Follow the user's selection. Otherwise choose an appropriate unclaimed entry within the requested scope; check open PRs, branches, and worktrees for overlap.
- Honour explicit design gates. The R3 brief requires a design pass with the user before implementation.
- Keep the entry while work is in progress. Remove completed work in its implementation PR; for partial work, leave a clear description of what remains.
- Explain discarded work in the PR rather than silently deleting it.

## One queue

TODO holds concrete follow-ups, bugs, and actionable review findings. Include a review reference when useful; there is no separate review backlog or claim-marker protocol.

[SPEC.md](../SPEC.md#release-roadmap) owns the product roadmap. It describes direction, not a second implementation queue. [ACCEPTANCE.md](../ACCEPTANCE.md) owns release gates and historical acceptance evidence. Do not copy tasks into each document.

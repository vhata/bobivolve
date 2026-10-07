# Bobivolve: agent contract

A real-time evolutionary simulation: the player authors inheritable firmware for self-replicating probes and watches lineages evolve.

## Workflow

- Every unit of work uses a focused branch, isolated worktree, and PR. Use `<queue>/<slug>` (`todo/`, `review/`, `roadmap/`) for queued work, `fix/` or `task/` for direct requests. Worktrees live in ignored `.worktrees/` or the harness's own location. Never commit directly to main.
- Before claiming, run `bash scripts/workflow/claim-check.sh <slug>`; create the branch and worktree immediately with `bash scripts/workflow/start-work.sh <queue> <slug>`. Open a draft PR after the first meaningful commit. Its body starts with `## Why`; exact claims and resolution markers follow the [TODO guide](docs/TODO_GUIDE.md).
- Parallelize independent work through sub-agents in separate writer worktrees with disjoint ownership. Coordinate shared interfaces and sequence dependent work. The coordinator owns integration and serializes queue edits. Run at most two heavy builds, simulations, or browser suites concurrently; mutable dependencies, caches, ports, profiles, and evidence belong to each worktree.
- Pair every code-writing agent, including the coordinator and integration changes, with a separate reviewer. Authors fix findings; reviewers verify fixes. Record reviewer, reviewed commit, disposition, checks, and limits in `## Review` in the PR body. Keep incomplete work or unresolved actionable findings draft; mark ready once implementation, required checks, and independent review are complete. Follow the [review procedure](docs/CODE_REVIEW_GUIDE.md#agent-workflow).
- Keep changes scoped to the requested outcome. Capture separately shippable ideas immediately with a source and `Files TODO: <slug>`, then continue. Report an unrelated P0 immediately and pause for direction.
- Use the standalone entrypoints in `scripts/`; run `scripts/check.sh` before presenting or updating a PR, plus checks required by [QUALITY.md](docs/QUALITY.md). Report actual results and limitations. Empty suites fail.
- The user merges unless explicitly delegated. Rebase rather than merging main into a work branch; force-push only a rebased PR branch with `--force-with-lease`. Ready and eligible to land are separate: landing also requires main as base, current-base green required checks, and landed parents. Release tags, deployment, and publishing require explicit sign-off in the current or preceding turn.
- Commit completed work in focused commits. After landing, inspect `bash scripts/workflow/cleanup-landed.sh` before applying cleanup; never remove dirty worktrees or unmerged work without permission.
- Unattended autonomy does not authorize pushes, merges, or tags. Without push authority save PR bodies in ignored `.feral/`, record load-bearing decisions with undo lines in `AUDIT.md`, and report local-only claims.
- Update documentation when a change makes it inaccurate. Each rule has one authoritative home; link rather than restating it. Keep plans separate from implemented behaviour.

## Process guides

Read only the guide and sections relevant to the task; there is no mandatory whole-repository reading pass.

- **Changing code or validating a PR:** [quality and test policy](docs/QUALITY.md).
- **Capturing, selecting, claiming, or completing deferred work:** [TODO guide](docs/TODO_GUIDE.md). TODO and review backlog are separate queues; never switch queues when the requested one has nothing ready.
- **Delegating work or reviewing a change:** [code review guide](docs/CODE_REVIEW_GUIDE.md). Review depth follows risk.
- **Preparing a release:** [acceptance criteria](ACCEPTANCE.md). Release tags require explicit user sign-off in the current or immediately preceding turns, even under a broad autonomy grant.

## Where to find what

- [README.md](README.md): running the app and current release.
- [ARCHITECTURE.md](ARCHITECTURE.md): current structure, protocol boundary, determinism, and persistence. Read the relevant sections before changing those areas.
- [docs/DECISIONS.md](docs/DECISIONS.md): design rationale and established UI preferences. Read before changing those choices.
- [SPEC.md](SPEC.md): product intent and release roadmap, including unbuilt features. Read when making product or simulation-design changes.
- [FEATURES.md](FEATURES.md): shipped capabilities.
- [TODO.md](TODO.md): staged deferred work and unresolved decisions. [review/](review/README.md): codebase review snapshots and the separate promoted backlog. All five workflow pillars are in force; SPEC remains a roadmap, not a claimable third queue.

Keep this entrypoint short. Add guidance only when it prevents a concrete recurring mistake; put detailed instructions in the relevant guide.

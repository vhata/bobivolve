# Bobivolve: agent contract

A real-time evolutionary simulation: the player authors inheritable firmware for self-replicating probes and watches lineages evolve.

## Workflow

- Use a focused branch and pull request for each unit of work. The user merges unless explicitly delegated. Preserve linear history with squash or rebase; do not merge main into a work branch.
- Use separate worktrees for concurrent work and check existing branches, worktrees, and open PRs before starting overlapping work. Parallel agents are optional, not a routine review requirement.
- Keep changes scoped to the requested outcome, including the fixes and validation it requires. Capture unrelated ideas using the guide below and continue the original task.
- Use the Makefile entrypoints (`make` lists them). Follow the quality guide before presenting a PR; report checks actually run and any limitations.
- Explain the problem, resulting behaviour, and validation in the PR description. Commit the completed work. Do not merge or create a release tag merely because implementation is finished.
- Update documentation when the change makes it inaccurate. Each rule has one authoritative home; link to it rather than restating it. Keep plans visibly separate from implemented behaviour.

## Process guides

Read only the guide and sections relevant to the task; there is no mandatory whole-repository reading pass.

- **Changing code or validating a PR:** [quality and test policy](docs/QUALITY.md).
- **Capturing an idea or selecting/completing deferred work:** [TODO guide](docs/TODO_GUIDE.md).
- **Reviewing a change or the codebase:** [code review guide](docs/CODE_REVIEW_GUIDE.md). Review depth follows risk; additional reviewers and review ledgers are not required for routine work.
- **Preparing a release:** [acceptance criteria](ACCEPTANCE.md). Release tags require explicit user sign-off in the current or immediately preceding turns, even under a broad autonomy grant.

## Where to find what

- [README.md](README.md): running the app and current release.
- [ARCHITECTURE.md](ARCHITECTURE.md): current structure, protocol boundary, determinism, and persistence. Read the relevant sections before changing those areas.
- [docs/DECISIONS.md](docs/DECISIONS.md): design rationale and established UI preferences. Read before changing those choices.
- [SPEC.md](SPEC.md): product intent and release roadmap, including unbuilt features. Read when making product or simulation-design changes.
- [FEATURES.md](FEATURES.md): shipped capabilities.
- [TODO.md](TODO.md): the single queue of deferred work and unresolved design decisions.

Keep this entrypoint short. Add guidance only when it prevents a concrete recurring mistake; put detailed instructions in the relevant guide.

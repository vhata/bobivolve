# Bobivolve: agent contract

A real-time evolutionary simulation: the player authors inheritable firmware for self-replicating probes and watches lineages evolve. Product intent and the release roadmap are in [SPEC.md](SPEC.md); the release gates are in [ACCEPTANCE.md](ACCEPTANCE.md).

<!-- docket:begin -->

## Docket

This project is run with docket. Read [docket/CONTRACT.md](docket/CONTRACT.md) before any work; it is the authoritative workflow, and this section records only this project's settings. The installer keeps this section current: the text above the list is rewritten on every run, the list keeps the values this project has set, and the section may sit anywhere in this file.

- Queue areas: `[SIM]` (sim/), `[HOST]` (host/: simulation host, persistence, worker and CLI), `[UI]` (ui/), `[PROTOCOL]` (protocol/ and transport/: the message contract and codecs), `[DESIGN]` (product and simulation design), `[PERFORMANCE]`, `[TOOLING]` (scripts, CI, hooks, dependencies), `[DOCS]`.
- Concurrency cap: 2 heavy builds, simulations or browser suites at once. Mutable dependencies, caches, ports, profiles and evidence belong to each worktree.
- Merging and releases: the user merges unless they delegate it in that turn; there is no standing delegation. A release is prepared against the gates in [ACCEPTANCE.md](ACCEPTANCE.md), and release tags, deployment and publishing need the user's explicit sign-off in the current or preceding turn, even under a broad autonomy grant.
- Optional pieces in force: the review ledger, stacked PRs and the scheduled validation of main. No roadmap queue: [SPEC.md](SPEC.md) is the roadmap in prose, not a claimable queue.
- Environment: Node 22 from `.nvmrc` and the pnpm version pinned in `package.json`; `scripts/install.sh` installs dependencies and `scripts/setup.sh` the hooks. Run tools through the standalone entrypoints in `scripts/` (`check.sh`, `build.sh`, `e2e.sh`, `sim.sh`), not through ad hoc tool invocations. Browser probes tagged `@diagnostic` are local and opt-in.
- Design gates: R3 implementation needs the user's design pass and an assessment of the [R2 experiment](docs/R2_ENGINEER_LOOP_EXPERIMENT.md) and the [browser session budgets](docs/BROWSER_PERSISTENCE_BUDGET.md) first. Pending work is tracked in [TODO.md](TODO.md).

<!-- docket:end -->

## Where to find what

- [README.md](README.md): running the app and current release.
- [ARCHITECTURE.md](ARCHITECTURE.md): current structure, protocol boundary, determinism, and persistence. Read the relevant sections before changing those areas.
- [docs/DECISIONS.md](docs/DECISIONS.md): design rationale and established UI preferences. Read before changing those choices.
- [docs/QUALITY.md](docs/QUALITY.md): the gates, the test policy and the review inputs.
- [SPEC.md](SPEC.md): product intent and release roadmap, including unbuilt features. Read when making product or simulation-design changes.
- [FEATURES.md](FEATURES.md): shipped capabilities.
- [ACCEPTANCE.md](ACCEPTANCE.md): release-by-release acceptance gates. Read when preparing a release.
- [TODO.md](TODO.md): staged deferred work and unresolved decisions. [review/](review/README.md): codebase review snapshots and the separate promoted backlog.

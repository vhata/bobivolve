# Bobivolve: agent contract

A real-time evolutionary simulation: the player authors inheritable firmware for self-replicating probes and watches lineages evolve. Product intent and the release roadmap are in [SPEC.md](SPEC.md); the release gates are in [ACCEPTANCE.md](ACCEPTANCE.md).

<!-- docket:begin -->
## Docket

This project is run with docket. Read [docket/CONTRACT.md](docket/CONTRACT.md) before any work; it is the authoritative workflow, and this section records only this project's settings. The installer keeps this section current: the text above the list is rewritten on every run, the list keeps the values this project has set.

- Queue areas: `[SIM]` (sim/), `[HOST]` (host/: simulation host, persistence, worker and CLI), `[UI]` (ui/), `[PROTOCOL]` (protocol/ and transport/: the message contract and codecs), `[DESIGN]` (product and simulation design), `[PERFORMANCE]`, `[TOOLING]` (scripts, CI, hooks, dependencies), `[DOCS]`.
- Concurrency cap: 2 heavy builds, simulations or browser suites at once. Mutable dependencies, caches, ports, profiles and evidence belong to each worktree.
- Merging and releases: the user merges unless they delegate it in that turn; there is no standing delegation. A release is prepared against the gates in [ACCEPTANCE.md](ACCEPTANCE.md), and release tags, deployment and publishing need the user's explicit sign-off in the current or preceding turn, even under a broad autonomy grant.
- Optional pieces in force: all of them, including the review ledger, stacked PRs and the scheduled validation of main. [SPEC.md](SPEC.md) is the roadmap in prose, not a claimable roadmap queue.
- Environment: Node 22 from `.nvmrc` and the pnpm version pinned in `package.json`; `scripts/install.sh` installs dependencies and `scripts/setup.sh` the hooks. Run tools through the standalone entrypoints in `scripts/` (`check.sh`, `build.sh`, `e2e.sh`, `sim.sh`), not through ad hoc tool invocations. Browser probes tagged `@diagnostic` are local and opt-in.
- Design gates: R3 implementation needs the user's design pass and an assessment of the R2 experiment and the browser session budgets first; the gates are in [ACCEPTANCE.md](ACCEPTANCE.md).
- Landing and cleanup: ready and eligible to land are separate; landing also needs main as the base, green required checks on the current base and landed parents. After landing, inspect `bash docket/scripts/cleanup-landed.sh` before `--apply`; never remove dirty worktrees or unmerged work without permission.
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

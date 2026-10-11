# Design decisions

Read the relevant entry before changing these choices. Keep durable rationale here; current implementation belongs in [ARCHITECTURE.md](../ARCHITECTURE.md), and proposed work belongs in [TODO.md](../TODO.md).

## Web dashboard and replaceable simulation host

TypeScript, React, and a Web Worker support the dashboard-heavy game and let browser and headless runs share simulation code. The plain-data protocol and Node stdio transport preserve the option of replacing the simulation runtime later. Headless runs already support testing, replay, and experiments; they are not unused porting scaffolding.

A native game engine or immediate Rust implementation would add toolchain and UI work before the game needs it. Invest in boundaries with current consumers; add code generation or another runtime when a concrete need justifies it.

## Snapshots and replay

The seed and command history describe a run; snapshots accelerate reconstruction and stay outside the public protocol. Recovery requires the relevant log and a usable starting state. Named saves currently depend on their own snapshot, so this principle is not a promise that every damaged save can be recovered.

## Prompt on action

For occasional actions such as save/load, pause and prompt when the player clicks, with a sensible default. Resume on the player's terms. Avoid continuously updating slot inputs or permanently visible save lists.

## Filter irrelevant items before compressing relevant ones

When a view gets crowded, hide what the player does not need before flattening the information they do need. Living lineages retain their full nesting depth; dead lineages can be hidden with survivors re-parented to the nearest living ancestor. Substrate filters narrow the visible probe set.

## Full agent workflow — 2026-10-06

The user selected the full repo-workflow model after the workflow audit. Staged TODO entries, exact PR claims, a separate promoted review backlog, immutable review snapshots, and scheduled validation replace the previous one-queue/no-marker/no-ledger policy. Explicit ownership and readiness make concurrent work and handoffs inspectable. Existing task rationale and design gates are preserved; historical review findings are not asserted to remain open or to have current coverage. Hosting protection remains a user-applied proposal.

## Vendored docket workflow — 2026-10-11

The generic workflow (contract, queue and review guides, validators) is vendored under `docket/` by the docket skill's `install.sh` and is never edited here. `AGENTS.md` keeps only this project's settings in its marked Docket section, and the review focus areas, baseline commands and drift checks live in [QUALITY.md](QUALITY.md). One command installs or resyncs the whole directory and `--check` reports any drift, so a fix to a validator reaches this project without a hand merge. The cost is that a project-specific rule can no longer be written into a guide; it goes in the Docket section or the quality doc, which the guides point to.

The regression harness for the workflow scripts (previously this project's own `test.sh` beside them) moved to the skill as `tests/scripts.sh`, where it runs in the skill's CI against the copies vendored here, so `scripts/check.sh` no longer runs it. Running it here would test files this project cannot change; `install.sh --check` is the check that the vendored copies are the tested ones.

`docket/` is listed in `.prettierignore` because the pre-commit hook formats staged Markdown and the vendored files are compared byte for byte, so a formatter rewrite would be reported as drift. The installer-owned Docket section in `AGENTS.md` is written in the shape Prettier produces, so `AGENTS.md` stays formatted. `CLAUDE.md` is a symlink to `AGENTS.md`; the installer recognises it as the import and leaves it alone.

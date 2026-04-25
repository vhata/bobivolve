# Bobivolve Process

Companion to `SPEC.md` and `ARCHITECTURE.md`. Captures development discipline. The disciplines below are stated in general form; the specific tools used to enforce them are implementation choices that may evolve, particularly as new languages enter the codebase.

## Repository shape

- Solo development. Direct to `main`. No pull requests.
- Public repository on GitHub.
- MIT licensed.

## Living documents

Three documents are updated *in the same commit as the change they describe*. A commit that alters player-visible behaviour, or that completes a tracked TODO, without touching the relevant document is a bug to be amended.

- **`README.md`** — what the game is, how to run it, current release, links to `SPEC.md` and `ARCHITECTURE.md` for the technically curious. Lay-person tone, no jargon. Updated when player-visible behaviour changes.
- **`FEATURES.md`** — grouped by release. Each entry one line, marked ✓ shipped or ⋯ in progress. Lay-person legible. Updated when a feature changes status.
- **`TODO.md`** — flat list. Each entry tagged with `#release` and `#area`. Done items deleted, not struck through. Updated when an item is added, completed, or abandoned.

## Tags

Two kinds, in plain prefix style.

- **Release tags** at the close of each release: `r0-petri-dish`, `r1-scarcity`, and so on.
- **Marker tags** at notable in-between moments: `first-replication`, `determinism-test-green`, and the like.

No semver. This is a chronicle, not a published library.

## Engineering disciplines

These rules apply across every language in the codebase, present and future. The tools used to enforce them may evolve; the rules do not.

- **Tests.** New behaviour ships with tests. The full suite passes before every commit.
- **Linting.** Code lints clean before every commit. Warnings are treated as errors. The mechanizable disciplines from `ARCHITECTURE.md` are encoded as lint rules wherever possible (see Code review).
- **Formatting.** Code is auto-formatted before every commit. No formatting churn lands in feature commits.
- **Always green, always current.** A commit that does not pass tests, lint, and format checks does not exist on `main`.

The specific test runner, linter, formatter, and language toolchain are choices that follow the work. Only the disciplines are pinned.

A local hook may run a fast subset (changed files only) for speed; CI runs the full check suite. The hook is for fast feedback during work; CI is the source of truth.

## Pre-commit hooks

Hard strictness. Format, lint, and tests must pass; the commit is refused otherwise.

`--no-verify` is reserved for genuine emergencies — recovery from a corrupt state, escaping a tooling bug — and is never used to defer fixing legitimate failures.

## Continuous integration

GitHub Actions runs the full check suite on every push: format, lint, tests, the determinism golden, and the build. CI failure is a hair-on-fire signal — the rule is "always green on `main`," and a red CI is a bug to be fixed before any further work.

## Code review

Code review is layered. Each layer catches what the cheaper layers cannot.

**Layer 1 — Lint, every commit.** The mechanizable architectural disciplines from `ARCHITECTURE.md` are encoded as lint rules wherever possible: no `Math.random` or `Date.now` (or any nondeterministic stdlib call) in sim code; no imports of host APIs from `/sim`; no float types in tick fields; no class instances or function references appearing in protocol definitions; and so on. The rule: if a discipline can be expressed in lint, it goes in lint. Lint is free, runs every commit, and does not negotiate.

**Layer 2 — Project-aware review.** A custom review agent that reads `SPEC.md`, `ARCHITECTURE.md`, and `PROCESS.md` before looking at the staged changes about to be committed. Catches what lint cannot: seam-contract violations that exceed simple pattern-matching; drift between spec and implementation; missing updates to `FEATURES.md`, `TODO.md`, or `README.md`; naming and abstraction concerns weighed against the project's idioms; principles in this document that the diff has slipped past. Surfaces findings before fixing, so judgment calls stay in the loop. Runs at the end of every meaningful chunk of work, before commit.

This skill is to be authored when R0 implementation begins. Until it exists, the generic `my-code-review` skill is an acceptable but inferior stand-in for this layer.

**Layer 3 — Generic-smell pass.** After the project-aware review, a generic code-review skill (currently `my-code-review`) catches the standard concerns that are not project-specific: duplication, dead code, missing error handling, naming inconsistencies, simplification opportunities. Optional once Layer 2 is reliable; useful in the interim.

**Layer 4 — Multi-agent review at milestones.** `/ultrareview` is invoked at release tags and marker tags for a heavier, multi-perspective pass. User-triggered, billed; reserved for moments where heavyweight scrutiny earns its keep.

**Layer 5 — Adversarial pass, on demand.** When stakes are high — a particularly dense change, or one that crosses the seam in a non-trivial way — a second reviewer reads the first reviewer's findings and asks what was missed.

"Meaningful," for the purpose of Layers 2 and 3 in the daily loop, includes anything touching simulation logic, the protocol, the transports, or non-trivial UI. Doc-only edits, comment-only edits, and trivial configuration tweaks may skip the agent layers; Layer 1 runs unconditionally.

## Parallel work via worktree agents

Worktree-based agent parallelism is a tool, not a default. Use it when both conditions hold:

- The task touches files that do not overlap with the current main-thread work.
- The task is at least fifteen to twenty minutes of focused work.

Below that threshold, merge overhead consumes the gain.

Good candidates: independent sim mechanics once the spine is in place; separate UI panels; cross-cutting refactors that do not conflict with active feature work; documentation polish during implementation; the code review of a finished chunk while the next chunk begins.

Bad candidates: anything that touches the protocol (everything depends on it); foundational scaffolding; work whose boundaries are not yet clear.

---
name: bobivolve-review
description: Project-aware pre-commit review for the Bobivolve repository. Reads SPEC.md, ARCHITECTURE.md, and PROCESS.md, then inspects the staged changes and reports findings the lint layer cannot catch — seam-contract violations, spec/implementation drift, missing living-document updates, naming and abstraction concerns, and PROCESS.md principles the diff has slipped past. Reports only; does not auto-apply fixes. Use when the user asks for a "project-aware review", "Layer 2 review", "bobivolve review", or invokes /bobivolve-review at the end of a meaningful chunk of work before commit. Do not use for doc-only edits, comment-only edits, or trivial config tweaks.
---

# Bobivolve project-aware review (PROCESS.md Layer 2)

You are the Layer 2 reviewer described in `PROCESS.md` under "Code review". You read the canonical brief, then the staged changes, then surface findings. You do not fix. The human decides what to act on.

This is the layer that catches what lint cannot. Do not duplicate the work of Layer 1 (the lint config in `eslint.config.js` already enforces the mechanizable disciplines from `ARCHITECTURE.md`). Do not duplicate the work of Layer 3 (the generic-smell pass). Spend your effort on judgment calls that need the project's idioms in head.

## When to run

Run at the end of a meaningful chunk of work, before commit. "Meaningful" — per `PROCESS.md` — is anything touching:

- simulation logic (`/sim`)
- the protocol (`/protocol`)
- the transports (`/transport`)
- the sim hosts (`/host`)
- non-trivial UI (`/ui`)

Skip the review for doc-only edits, comment-only edits, and trivial configuration tweaks. Layer 1 lint runs unconditionally; this layer does not.

If the user asks for a review and the staged changes are doc-only or trivial, say so and stop. Do not invent findings to justify the run.

## Process

Follow these steps in order. Do not skip the reading step; it is the whole point of this layer.

### 1. Read the canonical brief

Read these three documents in full before looking at any code:

- `SPEC.md` — what the game is. Player role, simulation mechanics, release roadmap, scope.
- `ARCHITECTURE.md` — the sim/UI seam, the IDL, the determinism disciplines, transports, headless capability, three layers, migration path to Rust.
- `PROCESS.md` — living documents, tags, engineering disciplines, layered code review, parallel work via worktree agents.

Also skim `CLAUDE.md` for any project-local instructions, and `FEATURES.md`, `TODO.md`, `README.md` so you know what currently claims to exist.

You are looking for the project's idioms and disciplines, not memorising line numbers. The disciplines in `ARCHITECTURE.md` and `PROCESS.md` are not advisory; they govern the work.

### 2. Identify the diff under review

Default scope is the staged diff about to be committed. If nothing is staged, look at the unstaged working-tree diff against `HEAD`. If both are empty, stop and say so.

Useful commands:

- `git status --short`
- `git diff --cached` for staged changes
- `git diff` for unstaged changes
- `git diff --cached --stat` for a one-line-per-file summary
- `git log -1 --stat HEAD` if context on the most recent commit helps

Read every changed hunk. Read enough of the surrounding file to understand each change in context. For non-trivial changes, read the file from top to bottom at least once.

### 3. Walk the categories below

For each category, ask the listed questions against the diff. Note findings as you go. Do not write the report yet.

#### A. Seam contract (`ARCHITECTURE.md` — "The seam contract", "Protocol and IDL")

Lint catches the simple cases. You catch the rest.

- Does anything new cross the seam that is not a plain-data, IDL-defined message? Object references, function references, class instances, closures, mutable state, host APIs — none of these are permitted across the seam, even if they pass lint.
- Could a separate Rust process emit the same byte stream the UI consumes here? If not, the UI has grown a dependency on something that is not in the protocol.
- Are new protocol messages additive? No field-number reuse, no semantic changes to existing fields, no renumbering. Reserved field numbers stay reserved.
- Does the UI import only from `protocol/` (and the `SimTransport` interface) on the sim side? Direct imports from `/sim`, `/host`, or transport implementation modules are seam violations.
- Are IDs stable strings rather than internal references at the seam? `Map<id, T>` structures must not leak across.
- Has the heartbeat/domain-event/query distinction been honoured? Heartbeats are best-effort; domain events are guaranteed in-order; queries are pull-only.

#### B. Determinism disciplines (`ARCHITECTURE.md` — "Determinism disciplines")

Lint catches `Math.random`, `Date.now`, `performance.now`, and host-API imports inside `/sim`. You catch what survives those rules.

- Does new sim logic introduce any source of nondeterminism that is not a banned identifier? Iteration over a `Set` or `Map` populated in a host-dependent order, `Object.keys` over a structurally-shared object, floating-point operations whose result depends on representation, sort comparators that fall back to insertion order — these are all determinism hazards.
- Are tick fields integer types throughout? `simTick` is `u64` discipline; floats for time are forbidden.
- Does any new mechanic that consumes randomness or compares values do so in a way that survives a port to Rust byte-for-byte? `ARCHITECTURE.md` lists PRNG draws, mutation, lineage clustering, resource diffusion, and contact rolls as the canonical examples; new mechanics inherit the constraint.
- Is the sim core importing only from `/sim` and `/protocol`? Host or transport leakage breaks determinism and the headless capability.
- Does the change come with a determinism test or a deliberate decision not to extend the golden? The CI golden is the contract.

#### C. Three layers and host/transport boundary (`ARCHITECTURE.md` — "Three layers", "Transports", "Headless capability")

- Is anything new placed in the wrong layer? `/sim` is a pure module; `/host` runs the loop and wires the storage adapter; `/transport` is the UI-side transport implementation; `/ui` is React.
- Are new capabilities the sim needs accepted as ports (e.g. `Storage`, `Clock`) rather than imported directly?
- If a new transport-shaped feature lands, does it conform to the `SimTransport` interface? Does it work for both `WorkerTransport` and `NodeTransport`? `NodeTransport` exists for headless runs, CI, and golden-file testing — do not let it rot.

#### D. Spec/implementation drift (`SPEC.md` versus the diff)

- Does the change implement something the spec describes? If yes, is it consistent with the spec's terminology (Probe, Directive, Lineage, Drift, Speciation, Origin, Patch, Decree, Quarantine, Substrate, Sub-lattice, Origin compute)?
- Does the change implement something not described in the spec? If yes, surface it. The spec is the canonical description; out-of-spec features are a flag for the human, not necessarily a bug.
- Does the change implement a release out of order — e.g. R3 contact mechanics inside an R0 push? Surface it.
- Does the change contradict the "Out of Scope" section? Direct probe control, victory screens, multiplayer, and tech trees are not goals of any release.

#### E. Living documents (`PROCESS.md` — "Living documents")

`PROCESS.md` says: "A commit that alters player-visible behaviour, or that completes a tracked TODO, without touching the relevant document is a bug to be amended." This is the single most-likely-to-be-missed item in this layer.

- If the diff alters player-visible behaviour, is `README.md` updated? `README.md` is lay-person tone; check that updates match.
- If the diff changes the status of a feature, is `FEATURES.md` updated? Each entry one line, marked `✓` shipped or `⋯` in progress, lay-person legible.
- If the diff completes, adds, or abandons a TODO, is `TODO.md` updated? Done items deleted, not struck through. Tags remain `#release` and `#area`.
- If the diff is purely internal (e.g. refactor with no player-visible effect), absence of doc updates is fine — say so explicitly so the human can confirm.

#### F. Process disciplines (`PROCESS.md` — "Engineering disciplines", "Pre-commit hooks", "Continuous integration", "Parallel work")

- Does new behaviour ship with tests? `PROCESS.md` requires it.
- Does the diff bundle formatting churn into a feature commit? Formatting is auto-applied on its own; mixing it into a feature commit is a smell.
- If the work is on a worktree-agent branch, is the diff self-contained — touching only files outside the main-thread work? Merge commits are forbidden; rebase must be clean.
- Does the commit message (if visible) reflect the change accurately?

#### G. Naming and abstraction (project idioms)

This is the soft category. Lint will not help; you weigh the call.

- Do new names match the project's vocabulary? Probe, Directive, Lineage, Clade, Drift, Speciation, Origin, Patch, Decree, Quarantine, Substrate, Sub-lattice. Avoid synonyms invented for a single change.
- Do new files sit in the right directory under the proposed layout (`/protocol`, `/sim`, `/host`, `/transport`, `/ui`, `/test`)?
- Are new abstractions earning their keep, or speculative? `ARCHITECTURE.md`'s "Investment principle" allows up-front cost when savings compound — but speculative abstractions that no caller exercises yet are a different thing.
- Are protocol field names snake_case in `.proto` and camelCase on the wire, per the convention in `protocol/schema.proto`?

#### H. Principles the diff may have slipped past

These are easy to miss because they are stated once and then assumed.

- The seed plus the command log is the canonical universe. Snapshots are an implementation-defined performance cache, not part of the IDL. Did anything just leak snapshot shape into the protocol?
- The Node host is the determinism truth; the browser is the bug if they diverge. Does the change preserve this asymmetry?
- "Always green, always current." Does this commit pass tests, lint, and format checks? If not, it does not exist on `main`.
- The sim is computationally tractable in TypeScript through R0–R4 and the porting effort to Rust is reserved for later. Does the change respect that — for example, by not introducing a Rust-only construct or a TypeScript-only construct that would block the port?

### 4. Write the report

Group findings by severity. Do not invent severities; use exactly these three.

- **Blockers.** A discipline from `ARCHITECTURE.md` or `PROCESS.md` has been violated, or the spec has been contradicted, or a living document is missing an update that the rules require. The commit should not land in this state.
- **Concerns.** Judgment calls. The change might be fine, but a human should weigh in. Naming, abstraction, scope-of-change, possible spec drift.
- **Notes.** Observations worth surfacing without arguing for action. Patterns to watch, follow-ups for later.

For each finding:

- One- or two-sentence headline.
- The file and line(s) it touches, in `path:line` form. Use the staged path; if a finding spans a region, use `path:start-end`.
- The discipline or document it ties back to (e.g. "ARCHITECTURE.md — The seam contract", "PROCESS.md — Living documents").
- A short rationale. Not a fix. Not a patch. The human decides what to do.

If a category has no findings, do not include an empty heading. Do say which categories you walked, so the human knows the floor of the review.

Close the report with a one-line verdict:

- "Blockers: N. Concerns: M. Notes: K." — exact counts.
- One sentence on whether you would commit as-is, with the reason.

### 5. Stop

Do not edit files. Do not stage. Do not commit. Do not run the linter or formatter. Do not "helpfully" apply the obvious fix. The whole point of this layer is that judgment calls stay in the loop; auto-fixing is the next layer's mistake to make.

If the user, after reading the report, asks you to fix specific items, that is a separate request. Make those edits; do not bundle in fixes the user did not ask for.

## What this skill is not

- Not a lint replacement. If a finding can be expressed as a lint rule, mention it as a candidate for `eslint.config.js` rather than re-flagging it manually each time.
- Not a generic code review. `my-code-review` (Layer 3) handles duplication, dead code, missing error handling, and the like. If you find a generic smell, mention it briefly and leave the depth to Layer 3.
- Not a multi-agent review. `/ultrareview` (Layer 4) is reserved for milestones.
- Not an adversarial pass. Layer 5 is on demand, when stakes are high.

## Output shape — example

```
Bobivolve Layer 2 review

Categories walked: A, B, C, D, E, F, G, H.

Blockers
- Living document not updated. sim/replication.ts:42-67 implements parameter-drift mutation, which TODO.md tracks as an in-progress R0 item; FEATURES.md still lists it as in-progress and TODO.md still has the entry. PROCESS.md "Living documents": status changes are updated in the same commit.

Concerns
- Naming. sim/replication.ts:14 introduces `mutateGenes`; the project vocabulary in SPEC.md is "directive stack" / "firmware", not "genes". Consider `mutateFirmware` or `mutateDirectiveStack` for consistency.

Notes
- Determinism: sim/replication.ts:51 sorts by string id with a default comparator. Locale-independent here, but worth keeping in mind once non-ASCII ids appear (none today).

Blockers: 1. Concerns: 1. Notes: 1.
Verdict: do not commit until FEATURES.md and TODO.md are updated.
```

The example is illustrative. Do not pad your real reports to match its shape if the diff has fewer findings.

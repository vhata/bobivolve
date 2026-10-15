# Quality and validation

Read when changing code or validating a pull request. Protect simulation correctness, replay, saves, and player workflows with checks appropriate to the change.

## What quality means here

- Simulation: integer accounting, PRNG draw and iteration order, conservation, and replay equivalence; a changed golden is reviewed as an intentional result change, not accepted as noise.
- Protocol and transports: `protocol/types.ts`, `schema.proto` and the codecs agree; changes are additive; messages are plain data; browser and headless runs behave the same.
- Persistence and replay: save and load round trips, missing or corrupt data, command ordering, timeline forks, and the documented recovery limits.
- UI: command acknowledgements, run changes and subscriptions keep the dashboard's projected state consistent with the host in the affected player flow.
- Deliberately manual: visual verification of cosmetic changes, and judgement about whether an emergent outcome is desirable; neither is a correctness assertion.

The determinism and isolation invariants behind these are in [ARCHITECTURE.md](../ARCHITECTURE.md); the substrate and conservation tests assert that diffusion conserves resources; energy conservation is not asserted.

## Existing gates

Executable shell scripts in [scripts/](../scripts/) are the shared entrypoints for local work, hooks, and [CI](../.github/workflows/ci.yml). Each script runs from the repository root regardless of the caller’s directory, forwards arguments to its tool, and propagates failure. `check.sh` runs its gates in order and stops at the first failure. The matching [package.json](../package.json) commands are convenience aliases.

| Command                                                                          | Checks                                                                                               | When                                                                           |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `scripts/check.sh`                                                               | Formatting, ESLint, TypeScript, Vitest (including determinism goldens), queue and link validation    | Before presenting a PR                                                         |
| `docket/scripts/ci.sh`                                                           | Queue validation, Markdown links and anchors, and on pull requests the PR markers against the queues | CI; locally when a change touches the queues, Markdown or a PR body            |
| `docket/scripts/review-due.sh --paths 'sim host transport protocol ui test e2e'` | Review cadence report                                                                                | Scheduled main validation; when deciding whether a codebase review is due      |
| `scripts/build.sh`                                                               | Production dashboard build                                                                           | Before presenting a PR that changes code, dependencies, or build configuration |
| `scripts/e2e.sh`                                                                 | Playwright browser tests                                                                             | When changing the player workflows they exercise                               |
| `scripts/sim.sh --seed 42 --ticks 1000 --no-heartbeat`                           | Headless simulation                                                                                  | When a simulation or host change needs runtime evidence beyond its tests       |

CI runs format, lint, typecheck, tests, and build on PRs and pushes to main. A separate Chromium job runs `scripts/e2e.sh --grep-invert @diagnostic`; `@diagnostic` marks the local performance-profile, screenshot, and browser-persistence measurement probes. Each browser invocation prints a unique `test-results/run.*` evidence directory; failures retain traces and screenshots, and CI uploads `test-results/` for inspection. ESLint fails on warnings; Vitest fails when no tests are collected. The pre-commit hook formats staged files and lints staged code with warnings denied; `docket/` is listed in `.prettierignore` because the vendored files are compared byte for byte, so a formatter rewrite would be drift. The pre-push hook runs typecheck and the full test suite, so commits stay quick while pushes catch type and test failures. Neither hook runs the build or browser suite. Do not describe a check as enforced unless the tooling enforces it.

Fix failures introduced by the change. Report pre-existing failures or environment limitations explicitly; do not claim a passing baseline or silently bypass a failed gate. Hook bypasses are reserved for genuine tooling/recovery problems, with the reason and equivalent checks recorded.

Install or refresh the hooks with `scripts/setup.sh` after changing hook configuration or pulling a hook update. `scripts/install.sh` also installs them through the prepare script.

## Test policy

- Add regression tests for reproducible bugs in simulation, persistence, protocol, or transport behaviour. Test the failure and outcome, rather than copying the implementation.
- Test new deterministic rules and data transformations at their owning layer. Preserve integer accounting, stable PRNG consumption, and replay equivalence.
- For intentional changes to simulation results, explain why goldens change and inspect the difference before updating them. A changed golden is not automatically evidence of nondeterminism.
- Exercise affected UI flows in a browser. Add or update Playwright coverage for meaningful interaction regressions; cosmetic changes can use visual verification without a new test.
- Documentation and trivial configuration changes need no new tests. Check links, claims, and relevant formatting. Existing hooks and CI still apply.
- For tuning, compare representative seeded runs and explain the observed effect. An emergent outcome is not a correctness assertion merely because it occurred in the old version.

Record commands and results under `## Validation` in the PR, with enough detail to reproduce any behaviour-specific check. Once appropriate checks pass, repeat them only when another change or unresolved concern justifies it. Complete the [independent review](../docket/CODE_REVIEW_GUIDE.md#pr-review-every-change) before handing a code PR to the user for final review.

## Workflow validation

The workflow validators are vendored under [docket/scripts/](../docket/scripts/) and never edited here; `bash ~/.claude/skills/docket/install.sh --check` reports drift and `bash ~/.claude/skills/docket/install.sh` resyncs (see [docket/README.md](../docket/README.md)). `scripts/check.sh` runs `docket/scripts/check-queues.sh --strict` and `docket/scripts/check-links.sh`. In CI the `check` job also runs `docket/scripts/ci.sh`, which repeats both and, on pull requests, validates the PR markers against the queues at the base branch tip and the checked-out merge commit, reading the PR body as data from the event payload, or through `gh` when the payload is unusable. The regression harness for the scripts themselves (`tests/scripts.sh`) lives in the skill repository and runs in its CI, not here. Start the PR body with `## Why` and use exact markers from [docket/TODO_GUIDE.md](../docket/TODO_GUIDE.md#markers). Post the independent review as a PR comment, not in the body, which becomes the commit message; successful CI does not establish that review occurred.

The [CI workflow](../.github/workflows/ci.yml) cancels superseded PR runs, while main runs are not cancelled by this concurrency policy. Node's major version is pinned in `.nvmrc`; CI reads it, and local workers should use Node 22. `package.json` and the lockfile pin the package-manager/dependency setup.

## Review inputs

Read by the vendored review guide ([docket/CODE_REVIEW_GUIDE.md](../docket/CODE_REVIEW_GUIDE.md)); a codebase review runs and records exactly what is listed here.

- Focus areas: the list under [What quality means here](#what-quality-means-here) and the invariants in [ARCHITECTURE.md](../ARCHITECTURE.md).
- Baseline commands beyond `bash scripts/check.sh`: `bash scripts/build.sh`; `bash scripts/e2e.sh --grep-invert @diagnostic`; `bash scripts/sim.sh --seed 42 --ticks 1000 --no-heartbeat`. Record each result in the snapshot header.
- Drift measure: `bash docket/scripts/review-due.sh --paths 'sim host transport protocol ui test e2e'`, the same call the scheduled validation makes. Its verdict requests review work, not permission to fix inventory findings.
- Drift checks for an incremental review: documented CLI options, controls and FEATURES.md against the code; SPEC.md and plan status against merged work; this document against the hooks, `scripts/` and `.github/workflows/`; `bash ~/.claude/skills/docket/install.sh --check` for drift in `docket/`.
- Baselines: snapshots are tied to main commits. A pre-landing review must preserve its tree (PR head or git bundle) and record the exact correspondence with the landed squash commit before it is used as a baseline; missing or non-ancestor baselines are coverage gaps, and merge-base figures are approximations. The [historical project-direction review](PROJECT_REVIEW.md) stays historical, outside the current baseline (see [review/README.md](../review/README.md)).
- Dispositions: Accepted records the reason, who decided, and when to reconsider. Accepting a real correctness or security risk is the user's decision; an agent may show a finding Invalid with evidence but cannot accept that risk on the user's behalf.

## Scheduled main validation

[Main validation](../.github/workflows/main-validation.yml) runs daily, on manual dispatch, and on PRs changing its inputs. It runs the shared gates, production build, functional Chromium suite, and bounded headless determinism probes for seeds 0, 42, and 2026 (each twice at 1,000 ticks with heartbeats disabled). Mismatches fail. It reports review drift and preserves evidence even on failure. Diagnostic performance and screenshot probes remain opt-in; this schedule is not proof of long-session capacity or production recovery. The README badge shows the workflow; a missing scheduled run is not a pass.

For a red main push or scheduled run, the same day revert the responsible change or file a P1 entry with the run link and evidence (P0 if it blocks releases). A green fix branch is not recovery: retain the entry until the next main run succeeds. Scheduled checks are not required PR checks.

## Hosting settings

Verified on 2026-10-08: main has branch protection with these settings. Repository merging remains squash-only, with landed head branches deleted automatically. Changes to hosting settings require explicit user authorization.

- Require a pull request and the GitHub Actions checks named `check` and `browser`. Branches need not be up to date with `main` before merging (`strict: false`); the push-to-main CI run and the red-main policy above catch the rare bad combination.
- Require linear history. Conversation resolution is not required. Force pushes and deletions on `main` are allowed for the owner and never used by agents. The rule is not enforced for administrators, which is what permits the direct-to-main exceptions in [docket/CONTRACT.md](../docket/CONTRACT.md).
- Use squash-only merging and deletion of landed head branches, with the PR title as the squash subject and PR body as the commit body.
- Zero GitHub approving reviews is acceptable with agent review recorded in a PR comment; the user retains final review and landing authority.

Verify with `gh api repos/vhata/bobivolve/branches/main/protection`, `gh api repos/vhata/bobivolve/rulesets`, and repository merge settings before describing protection as active. Independent review and successful validation are required for readiness; current-base checks and landed parents additionally determine eligibility to land.

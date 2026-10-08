# Quality and validation

Read when changing code or validating a pull request. Protect simulation correctness, replay, saves, and player workflows with checks appropriate to the change.

## Existing gates

Executable shell scripts in [scripts/](../scripts/) are the shared entrypoints for local work, hooks, and [CI](../.github/workflows/ci.yml). Each script runs from the repository root regardless of the caller’s directory, forwards arguments to its tool, and propagates failure. `check.sh` runs its gates in order and stops at the first failure. The matching [package.json](../package.json) commands are convenience aliases.

| Command                                                | Checks                                                                                                                       | When                                                                           |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `scripts/check.sh`                                     | Formatting, ESLint, TypeScript, Vitest (including determinism goldens), workflow-tool regressions, queue and link validation | Before presenting a PR                                                         |
| `scripts/build.sh`                                     | Production dashboard build                                                                                                   | Before presenting a PR that changes code, dependencies, or build configuration |
| `scripts/e2e.sh`                                       | Playwright browser tests                                                                                                     | When changing the player workflows they exercise                               |
| `scripts/sim.sh --seed 42 --ticks 1000 --no-heartbeat` | Headless simulation                                                                                                          | When a simulation or host change needs runtime evidence beyond its tests       |

CI runs format, lint, typecheck, tests, and build on PRs and pushes to main. A separate Chromium job runs `scripts/e2e.sh --grep-invert @diagnostic`; `@diagnostic` marks the local performance-profile, screenshot, and browser-persistence measurement probes. Each browser invocation prints a unique `test-results/run.*` evidence directory; failures retain traces and screenshots, and CI uploads `test-results/` for inspection. ESLint fails on warnings; Vitest fails when no tests are collected. The pre-commit hook formats staged files and lints staged code with warnings denied. The pre-push hook runs typecheck and the full test suite, so commits stay quick while pushes catch type and test failures. Neither hook runs the build or browser suite. Do not describe a check as enforced unless the tooling enforces it.

Fix failures introduced by the change. Report pre-existing failures or environment limitations explicitly; do not claim a passing baseline or silently bypass a failed gate. Hook bypasses are reserved for genuine tooling/recovery problems, with the reason and equivalent checks recorded.

Install or refresh the hooks with `scripts/setup.sh` after changing hook configuration or pulling a hook update. `scripts/install.sh` also installs them through the prepare script.

## Test policy

- Add regression tests for reproducible bugs in simulation, persistence, protocol, or transport behaviour. Test the failure and outcome, rather than copying the implementation.
- Test new deterministic rules and data transformations at their owning layer. Preserve integer accounting, stable PRNG consumption, and replay equivalence.
- For intentional changes to simulation results, explain why goldens change and inspect the difference before updating them. A changed golden is not automatically evidence of nondeterminism.
- Exercise affected UI flows in a browser. Add or update Playwright coverage for meaningful interaction regressions; cosmetic changes can use visual verification without a new test.
- Documentation and trivial configuration changes need no new tests. Check links, claims, and relevant formatting. Existing hooks and CI still apply.
- For tuning, compare representative seeded runs and explain the observed effect. An emergent outcome is not a correctness assertion merely because it occurred in the old version.

Record commands and results under `## Validation` in the PR, with enough detail to reproduce any behaviour-specific check. Once appropriate checks pass, repeat them only when another change or unresolved concern justifies it. Complete the [independent agent review procedure](CODE_REVIEW_GUIDE.md#agent-workflow) before handing a code PR to the user for final review.

## Workflow validation

`scripts/check.sh` also runs `scripts/workflow/test.sh` (isolated positive/negative claim and queue fixtures), `check-queues.sh --strict`, and `check-links.sh`. CI validates PR markers against the event's exact base and head commits, using the event body as data. Start the PR body with `## Why` and use exact markers from the [TODO guide](TODO_GUIDE.md). Document independent review under `## Review`; successful CI does not establish that review occurred.

The [CI workflow](../.github/workflows/ci.yml) cancels superseded PR runs, while main runs are not cancelled by this concurrency policy. Node's major version is pinned in `.nvmrc`; CI reads it, and local workers should use Node 22. `package.json` and the lockfile pin the package-manager/dependency setup.

## Scheduled main validation

[Main validation](../.github/workflows/main-validation.yml) runs daily, on manual dispatch, and on PRs changing its inputs. It runs the shared gates, production build, functional Chromium suite, and bounded headless determinism probes for seeds 0, 42, and 2026 (each twice at 1,000 ticks with heartbeats disabled). Mismatches fail. It reports review drift and preserves evidence even on failure. Diagnostic performance and screenshot probes remain opt-in; this schedule is not proof of long-session capacity or production recovery. The README badge shows the workflow; a missing scheduled run is not a pass.

For a red main push or scheduled run, the same day revert the responsible change or file a P1 entry with the run link and evidence (P0 if it blocks releases). A green fix branch is not recovery: retain the entry until the next main run succeeds. Scheduled checks are not required PR checks.

## Hosting settings

Verified on 2026-10-08: main has branch protection with these settings. Repository merging remains squash-only, with landed head branches deleted automatically. Changes to hosting settings require explicit user authorization.

- Require a pull request and the GitHub Actions checks named `check` and `browser`. Branches need not be up to date with `main` before merging (`strict: false`); the push-to-main CI run and the red-main policy above catch the rare bad combination.
- Require linear history. Conversation resolution is not required. Force pushes and deletions on `main` are allowed for the owner and never used by agents. The rule is not enforced for administrators, which is what permits the direct-to-main exceptions in [AGENTS.md](../AGENTS.md).
- Use squash-only merging and deletion of landed head branches, with the PR title as the squash subject and PR body as the commit body.
- Zero GitHub approving reviews is acceptable with agent review recorded in `## Review`; the user retains final review and landing authority.

Verify with `gh api repos/vhata/bobivolve/branches/main/protection`, `gh api repos/vhata/bobivolve/rulesets`, and repository merge settings before describing protection as active. Independent review and successful validation are required for readiness; current-base checks and landed parents additionally determine eligibility to land.

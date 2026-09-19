# Quality and validation

Read when changing code or validating a pull request. Protect simulation correctness, replay, saves, and player workflows with checks appropriate to the change.

## Existing gates

The [Makefile](../Makefile) supplies the stable command names; [package.json](../package.json) and [CI](../.github/workflows/ci.yml) implement them.

| Command                                                  | Checks                                                                 | When                                                                           |
| -------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `make check`                                             | Formatting, ESLint, TypeScript, Vitest (including determinism goldens) | Before presenting a PR                                                         |
| `make build`                                             | Production dashboard build                                             | Before presenting a PR that changes code, dependencies, or build configuration |
| `make e2e`                                               | Playwright browser tests                                               | When changing the player workflows they exercise                               |
| `make sim FLAGS="--seed 42 --ticks 1000 --no-heartbeat"` | Headless simulation                                                    | When a simulation or host change needs runtime evidence beyond its tests       |

CI runs format, lint, typecheck, tests, and build on PRs and pushes to main. The pre-commit hook only formats staged files and lints staged code. The pre-push hook runs typecheck and the full test suite, so commits stay quick while pushes catch type and test failures. Neither hook runs the build or browser suite. Do not describe a check as enforced unless the tooling enforces it.

Fix failures introduced by the change. Report pre-existing failures or environment limitations explicitly; do not claim a passing baseline or silently bypass a failed gate. Hook bypasses are reserved for genuine tooling/recovery problems, with the reason and equivalent checks recorded.

Install or refresh the hooks with `pnpm exec simple-git-hooks` after changing hook configuration or pulling a hook update. `pnpm install` also installs them through the prepare script.

## Test policy

- Add regression tests for reproducible bugs in simulation, persistence, protocol, or transport behaviour. Test the failure and outcome, rather than copying the implementation.
- Test new deterministic rules and data transformations at their owning layer. Preserve integer accounting, stable PRNG consumption, and replay equivalence.
- For intentional changes to simulation results, explain why goldens change and inspect the difference before updating them. A changed golden is not automatically evidence of nondeterminism.
- Exercise affected UI flows in a browser. Add or update Playwright coverage for meaningful interaction regressions; cosmetic changes can use visual verification without a new test.
- Documentation and trivial configuration changes need no new tests. Check links, claims, and relevant formatting. Existing hooks and CI still apply.
- For tuning, compare representative seeded runs and explain the observed effect. An emergent outcome is not a correctness assertion merely because it occurred in the old version.

Record commands and results in the PR, with enough detail to reproduce any behaviour-specific check. Once appropriate checks pass, repeat them only when another change or unresolved concern justifies it.

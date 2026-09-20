# Code review

Read when reviewing a diff or when the user requests a broader review. Review effort follows the consequences of a mistake.

## Routine changes

Read the diff and enough surrounding code to judge it. Load the relevant architecture, decisions, and product sections only where they bear on the change. Check correctness, scope, error handling, validation, and documentation claims.

Focus additional scrutiny where it matters:

- **Simulation:** integer accounting, PRNG draw and iteration order, conservation, intentional golden changes.
- **Protocol and transports:** matching schema/types/codecs, additive compatibility, plain-data messages, browser/headless parity.
- **Persistence and replay:** save/load round trips, missing or corrupt data, command ordering, timeline forks, recovery limits.
- **UI:** command acknowledgements, run changes, subscriptions, and the affected player flow.

Report actionable findings with severity, file/location, failure scenario, and evidence. Distinguish reproduced failures from inspection-based concerns. State what was checked and any gaps; a clean review need not invent findings.

A self-review is sufficient for routine changes. Request or use an independent review when complexity or risk warrants it; no fixed stack of specialist, generic, adversarial, or multi-agent passes is required.

## Broader reviews

When requested, agree the scope from the request and inspect interactions beyond individual diffs. Record the reviewed commit, checks performed, findings, and limitations in the review deliverable. Reproduce serious failures when practical. Do not create a permanent ledger or incremental-review bureaucracy unless the user asks for one.

Put actionable deferred findings in [TODO.md](../TODO.md) using the [TODO guide](TODO_GUIDE.md). A finding does not automatically authorise an unrelated fix. Verify fixes against their original failure; do not require a later whole-codebase review to acknowledge a fix already demonstrated by evidence.

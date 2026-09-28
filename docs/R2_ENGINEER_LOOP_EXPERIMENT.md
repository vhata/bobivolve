# R2 engineer-loop experiment

Status: seeded simulation comparison completed on `c8c50fb` (2026-09-21); player study and mechanic selection pending. This is evidence for the [project review](PROJECT_REVIEW.md), not a shipped balance change or an R3 brief.

## Question and method

Can a player distinguish the consequences of two simple firmware policies, and are the resulting lineages few and stable enough to follow? First measure how the existing rules respond to three founder firmwares. Then test whether people can observe, intervene, and explain a consequence in the dashboard.

Run `scripts/r2-experiment.sh` from any directory to reproduce the simulation comparison. It creates fresh core states for seeds 0, 42, and 2026; samples at ticks 1,000, 3,000, and 5,000; and emits one JSON record per sample. It changes only the founder firmware:

| Policy      | Difference from shipped founder                                         |
| ----------- | ----------------------------------------------------------------------- |
| founder     | gather 2 per tick; exploration gate `2^58`; replication threshold 1,000 |
| harvest-4   | gather 4 per tick                                                       |
| mobility-4x | exploration gate `2^60`                                                 |

These are separate seeded worlds, not player patches at a shared tick. Mutation, resource generation, and all other rules remain as shipped. The script reports population, living and total lineage counts, largest and top-ten lineage shares, living clades with at least ten probes, and median extinct-lineage lifetime. No automated threshold treats an emergent outcome as a correctness requirement.

## Observations

| Policy      | Seed | Probes at 1k | Probes at 5k | Living lineages at 5k | Top-ten population share at 5k |
| ----------- | ---: | -----------: | -----------: | --------------------: | -----------------------------: |
| founder     |    0 |          247 |        5,931 |                 2,089 |                           9.3% |
| founder     |   42 |          274 |        5,957 |                 2,198 |                           8.1% |
| founder     | 2026 |          542 |        6,106 |                 1,896 |                          15.8% |
| harvest-4   |    0 |          458 |        5,884 |                 1,587 |                          14.1% |
| harvest-4   |   42 |          298 |        6,099 |                 2,044 |                          10.1% |
| harvest-4   | 2026 |          817 |        6,091 |                 2,146 |                          10.1% |
| mobility-4x |    0 |          987 |        5,879 |                 3,056 |                           7.0% |
| mobility-4x |   42 |          963 |        5,933 |                 3,010 |                           9.2% |
| mobility-4x | 2026 |        1,921 |        6,104 |                 2,589 |                           8.0% |

Both altered policies expand earlier than the shipped founder in all three seeds. By tick 5,000, every policy is near 5,900–6,100 probes, so the early advantage does not imply lasting population dominance. Fourfold mobility produces substantially more living lineages: 2,589–3,056 versus 1,896–2,198 for the baseline. Even the baseline's ten largest clades hold only 8–16% of the population at tick 5,000. These observations support the review's concern that raw lineage identity is too fine-grained for player attention; they do not establish which policy is strategically better.

The experiment cannot measure whether a player understands or cares about a lineage. It also does not price higher harvesting or mobility, so it cannot establish a genuine resource trade-off. Founder variants do not model patch authoring cost, intervention timing, or competition between policies in one run.

## Next player study and decision

Use one new player for a ten-minute session and one returning player for a longer session. Ask each to identify a lineage they care about, make one firmware intervention, state its expected cost and effect, then show what changed and what unintended consequence they noticed. Record the policy chosen, target lineage, tick, what the player predicted, and what evidence they used afterward. Repeat with at least two seeds so one lucky history does not decide the design.

Before implementing a balance mechanic, choose with the player what a policy should cost. Two bounded candidates from the review are a fixed hardware allocation across harvest, movement, and replication, or an upkeep cost for stronger directives. Prototype one candidate and one local predicate only after that choice; compare two viable strategies under both a resource-rich and resource-poor condition. Keep the complete ancestry available while testing a smaller set of prominent, watchable clades. Exit when a player can explain the trade-off, recognise descendants, and diagnose a failed intervention without source-code help.

## Delegated cost-model pass — 2026-09-24

The player delegated design decisions for overnight review. Choose **probe-energy upkeep for stronger firmware capacity** as the next prototype. It preserves existing firmware structure, makes overbuilding expensive in poor cells, and exposes a cost the player can observe locally. A fixed hardware allocation would require a new budget and rebalance every existing directive at once.

`scripts/r2-cost-experiment.sh` runs an experiment-only wrapper around the unchanged simulation. It repeats the founder/harvest-4/mobility-4x comparison for seeds 0, 42, and 2026 in two environments: current resource caps (rich) and caps plus initial resources divided by four (poor). Each condition runs with no added cost and with upkeep. No production code, saved rules, or existing golden changes.

The prototype charges aggregate gather capacity above 2 at one probe-energy unit per additional two units per tick, rounding up. Aggregate exploration thresholds above `2^58` cost one energy per additional baseline unit, rounding up, billed every 16 ticks. Duplicate directives share one baseline allowance. Replication threshold is a reserve target, not capacity, and incurs no surcharge. Charges occur before the existing tick's metabolism/directives; gathering can rescue a negative balance before the death phase. The bill uses absolute simulation tick and consumes no RNG draws. This is an experimental tariff; its globally aligned movement billing can create pulses and needs review before becoming a game rule.

### Recorded outcomes

Baseline `7c26fa4`; Node v26.9.0, macOS arm64. [Raw results](measurements/r2-upkeep-2026-09-24.ndjson) contain 72 samples from 36 runs, at ticks 1,000 and 5,000. These are independent founder worlds, not competing patches in a shared world.

Population at tick 5,000, range across the three seeds:

| Condition | Cost   |     Founder |   Harvest-4 | Mobility-4x |
| --------- | ------ | ----------: | ----------: | ----------: |
| Rich      | Free   | 5,931–6,106 | 5,884–6,099 | 5,879–6,104 |
| Rich      | Upkeep | 2,432–2,995 | 1,750–2,370 | 1,875–2,178 |
| Poor      | Free   |     386–723 |     509–901 | 1,060–1,093 |
| Poor      | Upkeep |     191–340 |     147–261 |     434–524 |

Under upkeep, the founder strategy outpopulates the mobility strategy in all three rich-world seeds; mobility wins in all three poor-world seeds. Both survive. That is a useful environment-dependent trade-off absent from the original unpriced experiment. Harvest-4 loses to founder in every upkeep case, so **do not ship this tariff as balanced**: harvesting needs retuning or a narrower use case. The founder's mutated descendants also incur costs, explaining why its final population changes even though its original firmware is free.

This experiment supports selecting an upkeep model for the next player-facing prototype. It does not prove players understand the cost, establish competitive dominance in a mixed population, or solve clade fragmentation. Population counts are observations, not tests to lock into the simulator.

### Player-facing decisions for review

- **Stable clades:** let the player pin ancestry-root cohorts. Descendants keep the pinned cohort's display identity while full genetic lineage IDs and ancestry remain inspectable. If nested cohorts are pinned, count each probe under its nearest pinned ancestor so totals do not double count. Start with a small fixed set of player-pinned cohorts, not automatic threshold-based renaming or discarded history.
- **Editor units:** gather is maximum energy per tick; explore is movement-attempt probability per tick (`threshold / 2^64`), with exact encoded value available; replication is minimum stored energy. Show current and proposed values, expected upkeep, and the fixed Origin authoring charge before submission. Avoid wall-clock “minutes to recover” because speed varies.
- **Compute exhaustion:** proposed production rule is deterministic oldest-first quarantine maintenance; release and report holds that cannot be funded, then regenerate compute. No silently free holds. This changes current behaviour and requires explicit regression and replay tests in its implementation PR.
- **Provenance:** distinguish “descended from patch P” from “current firmware matches P.” Show both current/reference differences and present carrier population; ancestry alone is not evidence of retained behaviour.
- **One local predicate:** prototype `cellResourceBelow` for exploration after the cost model reaches the dashboard. It reads the probe's current cell before that directive executes, consumes no RNG draw when false, and avoids moving away from an adequate resource cell. Its threshold and interaction with movement upkeep need a separate comparison. It is selected here but is not implemented by this cost-only harness.

The stable-clade slice now ships as **pinned ancestry groups**: up to six roots with names and colours, nearest-pinned-ancestor population counts, and searchable member pages. Living and Phylogeny views retain genetic lineage identities. Groups follow ancestry, not shared firmware, and do not widen intervention targets. Pins are browser/run preferences; named saves do not contain them. This implements the attention aid, not evidence that players can explain a trade-off.

The remaining decisions above are proposed implementation work. Keep the human study below as the next gate; do not expand the R3 implementation until a player can explain the R2 trade-off.

### Human playtest record (not yet conducted)

Recruit one new player for ten minutes and one returning player for a longer session, each across at least two seeds. For each session record: player familiarity, seed, tick, chosen cohort, authored policy, predicted cost/effect, actual outcome, evidence used, and one unintended consequence. Ask the player to locate an affected descendant and distinguish historical authorship from current firmware.

Pass when the player can explain two viable choices, recognise descendants, and diagnose one failed intervention without reading source or receiving the answer from the facilitator. Record confusion verbatim and separate it from the facilitator's interpretation. The automated experiment and browser workflow tests cannot substitute for these observations. No human results are claimed in this document.

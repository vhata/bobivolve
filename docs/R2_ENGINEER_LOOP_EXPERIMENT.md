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

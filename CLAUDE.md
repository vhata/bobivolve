# Bobivolve

A real-time evolutionary simulation. See `SPEC.md` for the full overview.

## Required reading before substantive work

Three documents form the canonical brief. Read all three before any non-trivial task in this repository.

- **`SPEC.md`** — what the game is. Player role, simulation mechanics, release roadmap, scope.
- **`ARCHITECTURE.md`** — how it is built. The sim/UI seam, the IDL, the determinism disciplines, transports, headless capability, the migration path to Rust.
- **`PROCESS.md`** — how we work. Living documents, tags, engineering disciplines, layered code review, worktree-agent parallelism.

The disciplines in `ARCHITECTURE.md` and `PROCESS.md` are not advisory; they govern the work.

## Patterns established by feedback

Four load-bearing patterns the player has explicitly asked for. These live here, in git, so they survive a laptop death; the assistant's auto-memory may carry the same patterns as redundancy but the source of truth is this list.

### Codify new ideas in TODO.md before deciding to implement

When a new feature, polish item, or design idea surfaces in conversation — whether it came from the assistant or the player — the immediate move is an entry in `TODO.md` with the rationale captured at idea-time. _Then_, separately, decide whether to implement now or leave it. Do not ask "should we build this now?" without writing it down first; ideas evaporate, and the in-conversation tradeoff analysis is the most valuable part to preserve. The default is "codify, then defer"; pulling the entry forward is a second decision the player makes deliberately.

### Release tags require explicit sign-off

Even when the player has granted broad autonomy ("dive in", "go with your gut"), creating a release tag (`rN-name`) is a separate decision and requires explicit sign-off in that turn or one of the immediately preceding turns. Living-doc reconciliation, the ship-it commit, and the tag are three separate acts; bundling them all under a generic autonomy grant is overreach. The R0 pattern is correct: living docs and ship commit, then _stop and ask_, then `git tag` only after the player says "tag it" / "ship it" / "I accept it."

### Modal-on-action over perpetual UI

For occasional player actions (save, load, anything similar), do not render UI that continuously updates against live sim state — pause the sim and prompt on the button click, with a sensible suggestion default. Click → pause → ask → act → resume on the player's terms. The Run panel is the canonical example: no live-updating slot input, no always-rendered saves list; both surface only when the player expresses intent.

### Hide irrelevant items over visually compressing relevant ones

When a UI surface gets crowded, filter out what the player does not need to see — do not flatten / collapse / depth-cap the things they do. The lineage tree is the canonical example: dead lineages disappear entirely (re-parent living survivors to the nearest living ancestor); living genealogies render at full nesting depth. The substrate panel's filter row is the same principle applied differently — let the player narrow the visible probe set rather than smashing every dot together.

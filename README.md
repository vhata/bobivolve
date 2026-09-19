# Bobivolve

A real-time evolutionary simulation. You author the firmware for a swarm of self-replicating probes and watch what becomes of it. Lineages drift, compete, dominate, and collapse. You name them, study them, and — from Release 2 onward — patch them.

The setting borrows premises from Dennis E. Taylor's _Bobiverse_ novels: Von Neumann probes, replicative drift, a galaxy with neighbours. The world and the events in it are procedurally generated.

## Status

**Release 2 — The Engineer's Console** (tagged `r2-engineers-console`). The player is now an active participant: author firmware patches, queue conditional decrees, quarantine clades, all gated by a renewable Origin compute budget. The lineage inspector exposes each clade's intervention history; the dashboard adds a phylogeny view alongside the living tree, and forensic replay lets the player rewind the sim to any past speciation event. The R2 design question this release answers is whether the player's role as meta-programmer feels meaningful. **Release 3 — First Contact** is next.

## How to run

The dashboard:

```
scripts/install.sh
scripts/dev.sh
```

Scripts can be invoked from any directory and accept normal command-line arguments. See the workflow list below.

A run starts at seed 42 by default. The Run panel changes the seed; the Controls panel pauses, resumes, and toggles speed (1×, 4×, 16×, 64×). Save and Load persist the current run to the browser's Origin Private File System.

A headless run that emits NDJSON `SimEvent`s to stdout:

```
scripts/sim.sh --seed 42 --ticks 1000 --no-heartbeat
```

Headless save and resume:

```
scripts/sim.sh --seed 42 --ticks 30001 --save-dir ./saves --run-id demo --no-heartbeat
scripts/sim.sh --resume --ticks 60000 --save-dir ./saves --run-id demo --no-heartbeat
```

## Development workflows

Run these executable scripts directly. Dependencies are installed with `scripts/install.sh`; refresh Git hooks after pulling hook changes with `scripts/setup.sh`.

| Script                                       | Purpose                                      |
| -------------------------------------------- | -------------------------------------------- |
| `scripts/dev.sh`                             | Start the dashboard dev server               |
| `scripts/build.sh` / `scripts/preview.sh`    | Build / preview the production dashboard     |
| `scripts/check.sh`                           | Format check, lint, typecheck, and tests     |
| `scripts/format.sh` / `scripts/fmt-check.sh` | Apply / check formatting                     |
| `scripts/lint.sh` / `scripts/typecheck.sh`   | Lint / TypeScript checks                     |
| `scripts/test.sh` / `scripts/e2e.sh`         | Unit and integration / browser tests         |
| `scripts/sim.sh`                             | Headless simulation; pass CLI flags directly |
| `scripts/clean.sh`                           | Remove generated `dist/` output              |

For example, `scripts/test.sh sim/rng.test.ts` runs one test file. Existing pnpm commands remain convenience aliases. See [the quality guide](docs/QUALITY.md) for which checks a change needs.

## For the technically curious

- [`SPEC.md`](SPEC.md) — what the game is.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how it is built.
- [`AGENTS.md`](AGENTS.md) — workflow and task-specific guides.
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — design rationale and UI preferences.
- [`FEATURES.md`](FEATURES.md) — what has shipped.
- [`TODO.md`](TODO.md) — what is next.
- [`ACCEPTANCE.md`](ACCEPTANCE.md) — release-by-release acceptance gates.

## License

MIT. See [`LICENSE`](LICENSE).

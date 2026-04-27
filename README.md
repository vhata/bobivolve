# Bobivolve

A real-time evolutionary simulation. You author the firmware for a swarm of self-replicating probes and watch what becomes of it. Lineages drift, compete, dominate, and collapse. You name them, study them, and — from Release 2 onward — patch them.

The setting borrows premises from Dennis E. Taylor's _Bobiverse_ novels: Von Neumann probes, replicative drift, a galaxy with neighbours. The world and the events in it are procedurally generated.

## Status

**Release 0 — Petri Dish** (tagged `r0-petri-dish`). The simulation core, persistence, and a seven-panel dashboard are in place; lineages drift, speciate, and the tree records descent. There is no death and no scarcity — the design question this release answers is whether firmware-as-data drift produces something interesting on its own. Selection pressure arrives in **Release 1 — Scarcity**.

## How to run

The dashboard:

```
make install
make dev
```

(`make` lists every named workflow; underlying tools may change, names won't.)

A run starts at seed 42 by default. The Run panel changes the seed; the Controls panel pauses, resumes, and toggles speed (1×, 4×, 16×, 64×). Save and Load persist the current run to the browser's Origin Private File System.

A headless run that emits NDJSON `SimEvent`s to stdout:

```
pnpm sim --seed 42 --ticks 1000 --no-heartbeat
```

Headless save and resume:

```
pnpm sim --seed 42 --ticks 30001 --save-dir ./saves --run-id demo --no-heartbeat
pnpm sim --resume --ticks 60000 --save-dir ./saves --run-id demo --no-heartbeat
```

## For the technically curious

- [`SPEC.md`](SPEC.md) — what the game is.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how it is built.
- [`PROCESS.md`](PROCESS.md) — how the work is run.
- [`FEATURES.md`](FEATURES.md) — what has shipped.
- [`TODO.md`](TODO.md) — what is next.
- [`ACCEPTANCE.md`](ACCEPTANCE.md) — release-by-release acceptance gates.

## License

MIT. See [`LICENSE`](LICENSE).

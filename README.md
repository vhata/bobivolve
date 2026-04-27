# Bobivolve

A real-time evolutionary simulation. You author the firmware for a swarm of self-replicating probes and watch what becomes of it. Lineages drift, compete, dominate, and collapse. You name them, study them, and — from Release 2 onward — patch them.

The setting borrows premises from Dennis E. Taylor's _Bobiverse_ novels: Von Neumann probes, replicative drift, a galaxy with neighbours. The world and the events in it are procedurally generated.

## Status

**Release 1 — Scarcity** (tagged `r1-scarcity`). Probes now live on a 32×32 sub-lattice with diffusing resources, carry an energy reservoir that drains each tick, and replicate only when they've gathered enough to fund the cost. Lineages compete for cells; some go extinct. Firmware grew from one directive to three (`gather`, `explore`, `replicate`) and the structural mutations — priority swap, directive loss, directive gain — are unblocked. The R1 design question this release answers is whether selection pressure produces competitive lineage dynamics. **Release 2 — The Engineer's Console** is next.

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

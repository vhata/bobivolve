# Bobivolve

A real-time evolutionary simulation. You author the firmware for a swarm of self-replicating probes and watch what becomes of it. Lineages drift, compete, dominate, and collapse. You name them, study them, and — from Release 2 onward — patch them.

The setting borrows premises from Dennis E. Taylor's _Bobiverse_ novels: Von Neumann probes, replicative drift, a galaxy with neighbours. The world and the events in it are procedurally generated.

## Status

Pre-Release 0. The simulation core, the persistence layer, and the dashboard shell are in place; player-facing panels are landing one at a time.

## How to run

The dashboard:

```
pnpm install
pnpm dev
```

A headless run that emits NDJSON `SimEvent`s to stdout:

```
pnpm sim --seed 42 --ticks 1000 --no-heartbeat
```

## For the technically curious

- [`SPEC.md`](SPEC.md) — what the game is.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how it is built.
- [`PROCESS.md`](PROCESS.md) — how the work is run.
- [`FEATURES.md`](FEATURES.md) — what has shipped.
- [`TODO.md`](TODO.md) — what is next.

## License

MIT. See [`LICENSE`](LICENSE).

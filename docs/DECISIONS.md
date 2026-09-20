# Design decisions

Read the relevant entry before changing these choices. Keep durable rationale here; current implementation belongs in [ARCHITECTURE.md](../ARCHITECTURE.md), and proposed work belongs in [TODO.md](../TODO.md).

## Web dashboard and replaceable simulation host

TypeScript, React, and a Web Worker support the dashboard-heavy game and let browser and headless runs share simulation code. The plain-data protocol and Node stdio transport preserve the option of replacing the simulation runtime later. Headless runs already support testing, replay, and experiments; they are not unused porting scaffolding.

A native game engine or immediate Rust implementation would add toolchain and UI work before the game needs it. Invest in boundaries with current consumers; add code generation or another runtime when a concrete need justifies it.

## Snapshots and replay

The seed and command history describe a run; snapshots accelerate reconstruction and stay outside the public protocol. Recovery requires the relevant log and a usable starting state. Named saves currently depend on their own snapshot, so this principle is not a promise that every damaged save can be recovered.

## Prompt on action

For occasional actions such as save/load, pause and prompt when the player clicks, with a sensible default. Resume on the player's terms. Avoid continuously updating slot inputs or permanently visible save lists.

## Filter irrelevant items before compressing relevant ones

When a view gets crowded, hide what the player does not need before flattening the information they do need. Living lineages retain their full nesting depth; dead lineages can be hidden with survivors re-parented to the nearest living ancestor. Substrate filters narrow the visible probe set.

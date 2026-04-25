// Branded types for sim identifiers.
//
// At the seam (ARCHITECTURE.md), entities are addressed by string ID, never by
// reference. The brands here exist only at compile time — on the wire and in
// snapshots they are plain strings (or, for SimTick / Seed, plain bigints).
// The purpose is to stop a ProbeId from being passed where a LineageId is
// wanted; TypeScript catches it, the runtime does not pay for it.

declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

export type SimTick = Brand<bigint, 'SimTick'>;
export type Seed = Brand<bigint, 'Seed'>;
export type ProbeId = Brand<string, 'ProbeId'>;
export type LineageId = Brand<string, 'LineageId'>;

// Constructor helpers. These are unchecked casts; treat them as the only
// supported way to construct branded values so the brand stays meaningful.
export const SimTick = (n: bigint): SimTick => n as SimTick;
export const Seed = (n: bigint): Seed => n as Seed;
export const ProbeId = (s: string): ProbeId => s as ProbeId;
export const LineageId = (s: string): LineageId => s as LineageId;

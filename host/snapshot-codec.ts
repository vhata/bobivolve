// Snapshot codec: SimStateSnapshot ↔ bytes.
//
// ARCHITECTURE.md: "Snapshot format is whatever the current implementation
// prefers — structured-cloned blobs in TypeScript today, something else in
// Rust later. ... A missing or unreadable snapshot triggers a rebuild-from
// log pass." The format here is JSON with a tagged-object encoding for
// bigints so JSON.parse can reverse it without per-field path knowledge.
// Ugly on disk; round-trippable, which is the only contract that matters
// for an implementation-defined cache.
//
// When the Rust port ships, snapshots written by this codec become
// unreadable; the rebuild-from-log fallback handles the migration. That
// is the bargain ARCHITECTURE.md describes (snapshots are not part of the
// IDL, command logs are).

import type { SimStateSnapshot } from '../sim/state.js';

const BIGINT_TAG = '__bigint__';

interface TaggedBigint {
  readonly [BIGINT_TAG]: string;
}

function isTaggedBigint(value: unknown): value is TaggedBigint {
  return (
    typeof value === 'object' &&
    value !== null &&
    BIGINT_TAG in (value as object) &&
    typeof (value as TaggedBigint)[BIGINT_TAG] === 'string'
  );
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return { [BIGINT_TAG]: value.toString() };
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (isTaggedBigint(value)) return BigInt(value[BIGINT_TAG]);
  return value;
}

export function serializeSnapshot(snap: SimStateSnapshot): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(snap, replacer));
}

export function deserializeSnapshot(bytes: Uint8Array): SimStateSnapshot {
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text, reviver) as SimStateSnapshot;
}

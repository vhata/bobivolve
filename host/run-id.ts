// Run-slot identifier rule, shared by the host's switchRun/deleteRun
// handlers and the CLI's --run-id flag.
//
// A run ID becomes a single directory name under `runs/` in every storage
// adapter, so it must be exactly one path segment. Names starting with `.`
// are reserved: `.` and `..` would resolve to `runs/` itself or its parent,
// and `runs/.active` is the active-run marker. listRuns already hides
// dot-prefixed entries, so no listed slot can carry such a name.
//
// The storage adapters refuse dot segments and separators independently;
// this check is the earlier, user-facing guard.

import { findAliasedName, foldStorageName } from './storage-key.js';

export function isValidRunId(runId: string): boolean {
  return runId !== '' && !runId.startsWith('.') && !/[/\\\0]/.test(runId);
}

// Run-slot identity. A valid run ID is still only a spelling: on a
// filesystem that folds case or Unicode normalization, `ACTIVE` and
// `active` are one directory. The host therefore addresses a slot only
// by its exact spelling, and refuses a new spelling that may alias the
// active run or a listed slot rather than resolving it to the existing
// one. Every adapter gets the same rule, including case-sensitive ones
// (OPFS, most Linux filesystems), where such a pair would be distinct.

// Whether `runId` is spelled differently from `activeRunId` but may name
// the same directory. deleteRun refuses these unconditionally.
export function aliasesRunId(runId: string, activeRunId: string): boolean {
  return runId !== activeRunId && foldStorageName(runId) === foldStorageName(activeRunId);
}

// Returns a known slot ID (the active run or a listed slot) that `runId`
// may alias without matching any known ID exactly. An exact match is the
// slot itself, so it is never an alias, even where an older build left
// two listed slots differing only by case on a case-sensitive adapter.
export function findAliasedRunId(
  knownRunIds: readonly string[],
  runId: string,
): string | undefined {
  if (knownRunIds.includes(runId)) return undefined;
  return findAliasedName(knownRunIds, runId);
}

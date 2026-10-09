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

export function isValidRunId(runId: string): boolean {
  return runId !== '' && !runId.startsWith('.') && !/[/\\\0]/.test(runId);
}

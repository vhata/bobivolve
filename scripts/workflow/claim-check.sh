#!/usr/bin/env bash
# Look for existing claims on one or more work slugs before starting them:
# open pull requests, local and remote branches, worktrees, and merged PRs
# (already done). For a review backlog slug, also checks every finding slug
# it maps.
#
# Usage: claim-check.sh <slug> [slug...]
# Exit 1 when any claim or prior completion is found, 0 when all are free.
# Needs git; uses gh when available and says so when it is not.
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$root"
[ $# -ge 1 ] || { sed -n '2,10p' "$0"; exit 2; }

have_gh=0
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1 && gh repo view >/dev/null 2>&1; then have_gh=1; fi
[ "$have_gh" -eq 1 ] || echo "note: no authenticated gh for this repository (no remote, not logged in, or gh missing); pull requests were NOT checked, so this claim check covers branches and worktrees only"

expand() {
  # Print the slug plus any finding slugs its backlog entry maps.
  echo "$1"
  if [ -f review/BACKLOG.md ]; then
    awk -v slug="$1" '
      /^- / { inblock = ($0 ~ "^- \\[[A-Z][A-Z0-9_-]*\\] `" slug "`") }
      inblock && /^  - Findings:/ { s = $0; while (match(s, /`[^`]+`/)) { print substr(s, RSTART + 1, RLENGTH - 2); s = substr(s, RSTART + RLENGTH) } }
    ' review/BACKLOG.md
  fi
}

claims=0
for requested in "$@"; do
  for slug in $(expand "$requested"); do
    [ "$slug" = "$requested" ] && label="$slug" || label="$slug (finding mapped by $requested)"
    echo "== $label"
    if [ "$have_gh" -eq 1 ]; then
      # Paginate forge records directly: search does not index head branches
      # and indexing delays must not hide newly published body claims.
      # Open PRs: a claim is a body marker naming the slug or a head branch containing it; a bare mention is only a note.
      claim_re="(Claims|Resolves|Partially resolves|Remaining|Files) (TODO|review backlog|review finding|roadmap): $slug(\$|[^a-z0-9-])"
      claimsline="$(gh api --paginate 'repos/{owner}/{repo}/pulls?state=open&per_page=100' \
        --jq ".[] | select((((.body // \"\") | test(\"$claim_re\")) or (.head.ref | contains(\"$slug\")))) | \"  open PR #\\(.number) [\\(if .draft then \"draft\" else \"ready\" end)] \\(.head.ref): \\(.title)\"" || { echo "claim-check: hosted PR query failed; ownership remains unverified" >&2; exit 2; })"
      if [ -n "$claimsline" ]; then echo "$claimsline"; claims=$((claims + 1)); fi
      mentions="$(gh api --paginate 'repos/{owner}/{repo}/pulls?state=open&per_page=100' \
        --jq ".[] | select(((.title | contains(\"$slug\")) or ((.body // \"\") | contains(\"$slug\"))) and (((((.body // \"\") | test(\"$claim_re\")) or (.head.ref | contains(\"$slug\"))) | not))) | \"  note: open PR #\\(.number) mentions this slug: \\(.title)\"" || { echo "claim-check: hosted PR query failed; ownership remains unverified" >&2; exit 2; })"
      [ -n "$mentions" ] && echo "$mentions"
      # Merged PRs: already resolved when a merged body resolves the slug or its head branch carried it.
      done_re="(Resolves|Partially resolves) (TODO|review backlog|review finding|roadmap): $slug(\$|[^a-z0-9-])"
      done_line="$(gh api --paginate 'repos/{owner}/{repo}/pulls?state=closed&per_page=100' \
        --jq ".[] | select(.merged_at != null and ((((.body // \"\") | test(\"$done_re\")) or (.head.ref | contains(\"$slug\"))))) | \"  merged PR #\\(.number) (\\(.merged_at[0:10])) resolved or carried this slug: \\(.title)\"" || { echo "claim-check: hosted PR query failed; ownership remains unverified" >&2; exit 2; })"
      if [ -n "$done_line" ]; then echo "$done_line"; echo "  -> confirm the queue entry is still current (a remainder may have been filed) before claiming"; claims=$((claims + 1)); fi
    fi
    branches="$(git branch -a --list "*${slug}*" --format '%(refname:short)' 2>/dev/null || true)"
    if [ -n "$branches" ]; then echo "$branches" | sed 's/^/  branch: /'; claims=$((claims + 1)); fi
    wts="$(git worktree list | grep -F -- "$slug" || true)"
    if [ -n "$wts" ]; then echo "$wts" | sed 's/^/  worktree: /'; claims=$((claims + 1)); fi
  done
done

if [ "$claims" -gt 0 ]; then
  echo "result: existing claim(s) found. Do not start this work without resolving the overlap."
  exit 1
fi
if [ "$have_gh" -eq 1 ]; then echo "result: no existing claims found (PRs, branches, worktrees)"; else echo "result: no local claims found (PRs NOT checked)"; fi

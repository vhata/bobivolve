#!/usr/bin/env bash
# Look for existing claims on one or more work slugs before starting them:
# open pull requests, local and remote branches, worktrees, and merged PRs
# (already done). For a review backlog slug, also checks every finding slug
# it maps.
#
# Usage: claim-check.sh [--self | --exclude-branch NAME] <slug> [slug...]
#   --self                 recheck from inside the claimed worktree: ignore the
#                          local branch checked out here and its worktree, plus
#                          remote copies and same-repository open PRs of that
#                          branch whose tip is already in its local history
#   --exclude-branch NAME  the same exclusion for a named local branch
# A remote ref or PR with the same branch name but commits you do not have (or
# from a fork) is another worker's claim and is still reported.
# Exit 1 when any claim or prior completion is found, 0 when all are free.
# Needs git; uses gh when available and says so when it is not.
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$root"
usage() { sed -n '2,16p' "$0"; exit 2; }
self=""
while [ $# -gt 0 ]; do
  case "$1" in
    --self)
      self="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
      [ -n "$self" ] || { echo "claim-check: --self needs a checked-out branch, but no branch is checked out here (detached HEAD)" >&2; exit 2; }
      shift ;;
    --exclude-branch)
      [ $# -ge 2 ] && [ -n "$2" ] || usage
      self="$2"; shift 2 ;;
    --) shift; break ;;
    -*) echo "claim-check: unknown argument $1" >&2; usage ;;
    *) break ;;
  esac
done
[ $# -ge 1 ] || usage
case "$self" in *\"*|*\\*) echo "claim-check: unsupported character in branch name $self" >&2; exit 2 ;; esac
self_tip=""; base_tip=""
if [ -n "$self" ]; then
  self_tip="$(git rev-parse --verify --quiet "refs/heads/$self^{commit}" || true)"
  for b in refs/remotes/origin/HEAD refs/remotes/origin/main refs/heads/main; do
    base_tip="$(git rev-parse --verify --quiet "$b^{commit}" || true)"
    [ -z "$base_tip" ] || break
  done
  echo "note: ignoring own branch $self and its worktree, and remote copies or open PRs of it whose tip is already in its local history"
fi
# owned SHA -> 0 when SHA is a commit of the own branch that the base lacks:
# the worker's own push. A tip with foreign commits, or one carrying nothing
# beyond the base, may be another worker's claim under the same name.
owned() {
  [ -n "$self_tip" ] || return 1
  git cat-file -e "$1^{commit}" 2>/dev/null || return 1
  git merge-base --is-ancestor "$1" "$self_tip" || return 1
  if [ -n "$base_tip" ] && git merge-base --is-ancestor "$1" "$base_tip"; then return 1; fi
  return 0
}

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

# Open PRs headed by the own branch name are tagged "own<TAB>sha<TAB>repo<TAB>"
# by jq; drop_own removes them only for this repository and an owned tip.
own_pre=""; own_post=""; this_repo=""; tab="$(printf '\t')"
if [ -n "$self" ] && [ "$have_gh" -eq 1 ]; then
  own_pre="(if .head.ref == \"$self\" then \"own\\t\\(.head.sha)\\t\\(.head.repo.full_name // \"\")\\t\" else \"\" end) + ("
  own_post=")"
  this_repo="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
fi
drop_own() {
  while IFS= read -r line; do
    case "$line" in
      "own$tab"*)
        rest="${line#own"$tab"}"; sha="${rest%%"$tab"*}"; rest="${rest#*"$tab"}"; repo="${rest%%"$tab"*}"; text="${rest#*"$tab"}"
        if [ -n "$this_repo" ] && [ "$repo" = "$this_repo" ] && owned "$sha"; then continue; fi
        printf '%s\n' "$text" ;;
      *) printf '%s\n' "$line" ;;
    esac
  done
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
        --jq ".[] | select((((.body // \"\") | test(\"$claim_re\")) or (.head.ref | contains(\"$slug\")))) | $own_pre\"  open PR #\\(.number) [\\(if .draft then \"draft\" else \"ready\" end)] \\(.head.ref): \\(.title)\"$own_post" | drop_own || { echo "claim-check: hosted PR query failed; ownership remains unverified" >&2; exit 2; })"
      if [ -n "$claimsline" ]; then echo "$claimsline"; claims=$((claims + 1)); fi
      mentions="$(gh api --paginate 'repos/{owner}/{repo}/pulls?state=open&per_page=100' \
        --jq ".[] | select(((.title | contains(\"$slug\")) or ((.body // \"\") | contains(\"$slug\"))) and (((((.body // \"\") | test(\"$claim_re\")) or (.head.ref | contains(\"$slug\"))) | not))) | $own_pre\"  note: open PR #\\(.number) mentions this slug: \\(.title)\"$own_post" | drop_own || { echo "claim-check: hosted PR query failed; ownership remains unverified" >&2; exit 2; })"
      [ -n "$mentions" ] && echo "$mentions"
      # Merged PRs: already resolved when a merged body resolves the slug or its head branch carried it.
      done_re="(Resolves|Partially resolves) (TODO|review backlog|review finding|roadmap): $slug(\$|[^a-z0-9-])"
      done_line="$(gh api --paginate 'repos/{owner}/{repo}/pulls?state=closed&per_page=100' \
        --jq ".[] | select(.merged_at != null and ((((.body // \"\") | test(\"$done_re\")) or (.head.ref | contains(\"$slug\"))))) | \"  merged PR #\\(.number) (\\(.merged_at[0:10])) resolved or carried this slug: \\(.title)\"" || { echo "claim-check: hosted PR query failed; ownership remains unverified" >&2; exit 2; })"
      if [ -n "$done_line" ]; then echo "$done_line"; echo "  -> confirm the queue entry is still current (a remainder may have been filed) before claiming"; claims=$((claims + 1)); fi
    fi
    # Own-branch exclusion compares whole names: refs/heads/<self> always, and
    # refs/remotes/<remote>/<self> only when its tip is owned. Any other branch
    # containing the slug is a claim.
    branches="$(git branch -a --list "*${slug}*" --format '%(refname)%09%(objectname)' 2>/dev/null | while IFS="$tab" read -r ref sha; do
      short="${ref#refs/heads/}"; short="${short#refs/remotes/}"
      if [ -n "$self" ]; then
        [ "$ref" = "refs/heads/$self" ] && continue
        # (an if, not case: bash 3.2 misparses case inside command substitution)
        if [ "${ref#refs/remotes/}" != "$ref" ] && [ "${short#*/}" != "$short" ] && [ "${short#*/}" = "$self" ] && owned "$sha"; then continue; fi
      fi
      printf '%s\n' "$short"
    done || true)"
    if [ -n "$branches" ]; then echo "$branches" | sed 's/^/  branch: /'; claims=$((claims + 1)); fi
    wts="$(git worktree list | grep -F -- "$slug" | awk -v own="[$self]" 'own == "[]" || !index($0, own)' || true)"
    if [ -n "$wts" ]; then echo "$wts" | sed 's/^/  worktree: /'; claims=$((claims + 1)); fi
  done
done

if [ "$claims" -gt 0 ]; then
  echo "result: existing claim(s) found. Do not start this work without resolving the overlap."
  exit 1
fi
if [ "$have_gh" -eq 1 ]; then echo "result: no existing claims found (PRs, branches, worktrees)"; else echo "result: no local claims found (PRs NOT checked)"; fi

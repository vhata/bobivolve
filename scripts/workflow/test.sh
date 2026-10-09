#!/usr/bin/env bash
# Regression checks for ownership and queue gates, using disposable git state.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/scripts/workflow" "$fixture/review" "$fixture/bin"
cp "$root/scripts/workflow/"*.sh "$fixture/scripts/workflow/"
cp "$root/.github/pull_request_template.md" "$fixture/template.md"
cd "$fixture"
git init --quiet
git config user.name 'Workflow fixture'
git config user.email 'workflow-fixture@example.invalid'
git config core.hooksPath /dev/null

pass() {
  label="$1"; shift
  if ! "$@" > "$fixture/result.log" 2>&1; then
    echo "workflow-test: $label unexpectedly failed" >&2
    cat "$fixture/result.log" >&2
    exit 1
  fi
}
reject() {
  label="$1"; expected="$2"; shift 2
  if "$@" > "$fixture/result.log" 2>&1; then
    echo "workflow-test: $label unexpectedly passed" >&2
    exit 1
  fi
  if ! grep -Fq "$expected" "$fixture/result.log"; then
    echo "workflow-test: $label failed for the wrong reason" >&2
    cat "$fixture/result.log" >&2
    exit 1
  fi
}

cat > TODO.md <<'QUEUE'
# TODO

## Ready for separate work

### P2 Normal

- [TOOLS] `claimed-task` **Complete the task.**
  - Source: workflow regression fixture
QUEUE
printf '# Review backlog\n\n## P2 Normal\n' > review/BACKLOG.md
git add TODO.md review/BACKLOG.md
git commit --quiet -m 'Initial fixture queues'
base="$(git rev-parse HEAD)"
printf '## Why\n\nRequested work.\n\nClaims TODO: claimed-task\n' > body.md
pass 'valid queued claim' bash scripts/workflow/check-pr-markers.sh --body body.md --base "$base" --head HEAD --branch todo/claimed-task
pass 'template comments' bash scripts/workflow/check-pr-markers.sh --body template.md --base "$base" --head HEAD --branch task/direct
reject 'missing refs' 'invalid commit ref' bash scripts/workflow/check-pr-markers.sh --body template.md --base missing-base --head missing-head --branch task/direct
printf 'Requested work without a heading.\n' > body.md
reject 'missing heading' 'description has no' bash scripts/workflow/check-pr-markers.sh --body body.md --base "$base" --head HEAD --branch task/direct
printf '## Why\n\nWrong namespace.\n\nClaims roadmap: claimed-task\n' > body.md
reject 'wrong namespace' 'no marker claims or resolves' bash scripts/workflow/check-pr-markers.sh --body body.md --base "$base" --head HEAD --branch todo/claimed-task
# Markers written as list items or quotes are rejected rather than ignored.
printf '## Why\n\nListed marker.\n\n- Claims TODO: claimed-task\n' > body.md
reject 'dash list marker' 'written as a list item or quote' bash scripts/workflow/check-pr-markers.sh --body body.md --base "$base" --head HEAD --branch task/direct
printf '## Why\n\nListed marker.\n\n1. Resolves review backlog: claimed-task\n' > body.md
reject 'numbered list marker' 'written as a list item or quote' bash scripts/workflow/check-pr-markers.sh --body body.md --base "$base" --head HEAD --branch task/direct
printf '## Why\n\nQuoted marker.\n\n> Claims TODO: claimed-task\n' > body.md
reject 'quoted marker' 'written as a list item or quote' bash scripts/workflow/check-pr-markers.sh --body body.md --base "$base" --head HEAD --branch task/direct
printf '## Why\n\nListed marker beside a valid one.\n\nClaims TODO: claimed-task\n+ Files TODO: claimed-task\n' > body.md
reject 'list marker beside a valid one' 'written as a list item or quote' bash scripts/workflow/check-pr-markers.sh --body body.md --base "$base" --head HEAD --branch todo/claimed-task
printf '## Why\n\nProse lists that mention the queues.\n\n- Files TODO entries for later discoveries\n- Resolves the TODO about naming\n\nClaims TODO: claimed-task\n' > body.md
pass 'prose list items' bash scripts/workflow/check-pr-markers.sh --body body.md --base "$base" --head HEAD --branch todo/claimed-task

printf '# TODO\n\n## Needs triage\n\n### P2 Normal\n' > TODO.md
git add TODO.md
git commit --quiet -m 'Resolve fixture task'
printf '## Why\n\nCompleted work.\n\nResolves TODO: claimed-task\n' > body.md
pass 'valid queued resolution' bash scripts/workflow/check-pr-markers.sh --body body.md --base "$base" --head HEAD --branch todo/claimed-task

cat > TODO.md <<'QUEUE'
# TODO

## Needs triage

### P2 Normal

- [TOOLS] `prerequisite` **Resolve the prerequisite.**
  - Source: workflow regression fixture
QUEUE
cat > review/BACKLOG.md <<'QUEUE'
# Review backlog

## P2 Normal

- [TOOLS] `promoted-fix` **Fix reviewed behaviour.**
  - Source: workflow regression fixture
  - Findings: `review-proof`
QUEUE
cp review/BACKLOG.md unblocked.md
pass 'unblocked backlog' bash scripts/workflow/check-queues.sh --strict
printf '  - Blocked by: operator decision\n' >> review/BACKLOG.md
reject 'blocked backlog' 'is marked ready but is Blocked by' bash scripts/workflow/check-queues.sh --strict
cp unblocked.md review/BACKLOG.md
printf '  - Depends on: `prerequisite`\n' >> review/BACKLOG.md
reject 'dependent backlog' 'depends on unresolved' bash scripts/workflow/check-queues.sh --strict

cat > bin/gh <<'GH'
#!/usr/bin/env bash
case "$1 $2" in
  'auth status'|'repo view') exit 0 ;;
  'api --paginate') echo 'API unavailable' >&2; exit 1 ;;
  *) exit 2 ;;
esac
GH
chmod +x bin/gh
reject 'hosted ownership query' 'ownership remains unverified' env PATH="$fixture/bin:$PATH" bash scripts/workflow/claim-check.sh fixture-unclaimed-task

cat > bin/gh <<'GH'
#!/usr/bin/env bash
# Search deliberately returns nothing: branch names and fresh body markers
# need direct, paginated pull records rather than a search-index match.
case "$1 $2" in
  'auth status'|'repo view') exit 0 ;;
  'pr list') exit 0 ;;
  'api --paginate')
    case "$*" in *--search*) exit 0 ;; esac
    case "$3" in
      *'state=open&per_page=100')
        case "$5" in *'note: open PR'*) exit 0 ;; esac
        case "$FIXTURE_PR_KIND" in
          branch) echo '  open PR #42 [draft] task/fixture-unclaimed-task: Unrelated title' ;;
          body) echo '  open PR #43 [draft] task/another-task: Fresh body claim' ;;
        esac ;;
      *'state=closed&per_page=100')
        case "$5" in *'.merged_at != null'*) ;; *) exit 2 ;; esac
        if [ "$FIXTURE_PR_KIND" = merged ]; then
          echo '  merged PR #44 (2026-10-06) resolved or carried this slug: Unrelated title'
        fi ;;
      *) exit 2 ;;
    esac ;;
  *) exit 2 ;;
esac
GH
reject 'branch-only remote claim' 'open PR #42' env PATH="$fixture/bin:$PATH" FIXTURE_PR_KIND=branch bash scripts/workflow/claim-check.sh fixture-unclaimed-task
reject 'fresh body remote claim' 'open PR #43' env PATH="$fixture/bin:$PATH" FIXTURE_PR_KIND=body bash scripts/workflow/claim-check.sh fixture-unclaimed-task
reject 'branch-only merged work' 'merged PR #44' env PATH="$fixture/bin:$PATH" FIXTURE_PR_KIND=merged bash scripts/workflow/claim-check.sh fixture-unclaimed-task
pass 'unclaimed hosted work' env PATH="$fixture/bin:$PATH" FIXTURE_PR_KIND=none bash scripts/workflow/claim-check.sh fixture-unclaimed-task

# Claim recheck from inside the claimed worktree: --self excludes only the
# worker's own branch, its remote-tracking copy, its worktree and its own PR.
mkdir -p "$fixture/nogh"
printf '#!/usr/bin/env bash\nexit 1\n' > "$fixture/nogh/gh"
chmod +x "$fixture/nogh/gh"
nogh="$fixture/nogh:$PATH"
in_dir() { d="$1"; shift; (cd "$d" && "$@"); }
claim="$fixture/scripts/workflow/claim-check.sh"
git worktree add --quiet -b todo/fixture-self-task "$fixture/wt-self" HEAD
git update-ref refs/remotes/origin/todo/fixture-self-task HEAD
reject 'own claim without --self' 'branch: todo/fixture-self-task' in_dir "$fixture/wt-self" env PATH="$nogh" bash "$claim" fixture-self-task
pass 'own claim with --self' in_dir "$fixture/wt-self" env PATH="$nogh" bash "$claim" --self fixture-self-task
pass 'own claim excluded by name' env PATH="$nogh" bash "$claim" --exclude-branch todo/fixture-self-task fixture-self-task
git branch --quiet fix/fixture-self-task HEAD
reject 'other branch with --self' 'branch: fix/fixture-self-task' in_dir "$fixture/wt-self" env PATH="$nogh" bash "$claim" --self fixture-self-task
git branch --quiet -D fix/fixture-self-task
git worktree add --quiet --detach "$fixture/wt-fixture-self-task-other" HEAD
reject 'other worktree with --self' 'wt-fixture-self-task-other' in_dir "$fixture/wt-self" env PATH="$nogh" bash "$claim" --self fixture-self-task
git worktree remove --force "$fixture/wt-fixture-self-task-other"
git -C "$fixture/wt-self" checkout --quiet --detach
reject 'detached --self' 'no branch is checked out' in_dir "$fixture/wt-self" env PATH="$nogh" bash "$claim" --self fixture-self-task
git -C "$fixture/wt-self" checkout --quiet todo/fixture-self-task
cat > bin/gh <<'GH'
#!/usr/bin/env bash
# One open draft PR on the worker's own branch; the claim query must exclude it.
case "$1 $2" in
  'auth status'|'repo view') exit 0 ;;
  'api --paginate')
    case "$3" in
      *'state=open&per_page=100')
        case "$5" in *'note: open PR'*) exit 0 ;; esac
        case "$5" in *'.head.ref != "todo/fixture-self-task"'*) exit 0 ;; esac
        echo '  open PR #45 [draft] todo/fixture-self-task: Own draft' ;;
      *'state=closed&per_page=100') exit 0 ;;
      *) exit 2 ;;
    esac ;;
  *) exit 2 ;;
esac
GH
reject 'own hosted PR without --self' 'open PR #45' in_dir "$fixture/wt-self" env PATH="$fixture/bin:$PATH" bash "$claim" fixture-self-task
pass 'own hosted PR with --self' in_dir "$fixture/wt-self" env PATH="$fixture/bin:$PATH" bash "$claim" --self fixture-self-task
git worktree remove --force "$fixture/wt-self"
git branch --quiet -D todo/fixture-self-task
git update-ref -d refs/remotes/origin/todo/fixture-self-task

head="$(git rev-parse HEAD)"
printf '| Date | Type | Commit |\n| 2026-10-06 | full | `%s` |\n' "$head" > review-index.md
pass 'zero review churn' bash scripts/workflow/review-due.sh --index review-index.md --base "$head"

# A tracked source file deleted in the working tree must not abort the report.
mkdir -p src
printf 'one\ntwo\n' > src/kept.sh
printf 'three\n' > src/deleted.sh
git add src
git commit --quiet -m 'Add fixture sources'
head="$(git rev-parse HEAD)"
printf '| Date | Type | Commit |\n| 2026-10-06 | full | `%s` |\n' "$head" > review-index.md
rm src/deleted.sh
pass 'deleted tracked source' bash scripts/workflow/review-due.sh --index review-index.md --base "$head"
grep -Fq 'verdict: no review due' "$fixture/result.log" || { echo 'workflow-test: deleted tracked source gave no verdict' >&2; cat "$fixture/result.log" >&2; exit 1; }
grep -Fq 'against 2 current source lines' "$fixture/result.log" || { echo 'workflow-test: deleted tracked source miscounted lines' >&2; cat "$fixture/result.log" >&2; exit 1; }
git checkout --quiet -- src/deleted.sh
echo 'workflow-test: ownership and queue regression checks passed'

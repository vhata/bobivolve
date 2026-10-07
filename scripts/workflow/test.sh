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
  'pr list') echo 'API unavailable' >&2; exit 1 ;;
  *) exit 2 ;;
esac
GH
chmod +x bin/gh
reject 'hosted ownership query' 'ownership remains unverified' env PATH="$fixture/bin:$PATH" bash scripts/workflow/claim-check.sh fixture-unclaimed-task

head="$(git rev-parse HEAD)"
printf '| Date | Type | Commit |\n| 2026-10-06 | full | `%s` |\n' "$head" > review-index.md
pass 'zero review churn' bash scripts/workflow/review-due.sh --index review-index.md --base "$head"
echo 'workflow-test: ownership and queue regression checks passed'

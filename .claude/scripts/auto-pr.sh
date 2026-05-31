#!/usr/bin/env bash
# Auto-commit & open/update a PR when Claude stops with uncommitted changes.
set -euo pipefail

REPO_DIR="/Users/danielsakakini/index-hehe"
cd "$REPO_DIR"

# Nothing to do if the working tree is clean
if git diff --quiet && git diff --cached --quiet; then
  exit 0
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)

# Stage tracked files (skip .claude/ internals)
git add index.html stew-night.html accent-map/ scripts/ 2>/dev/null || true

# Only commit if something is actually staged
if ! git diff --cached --quiet; then
  SUMMARY=$(git diff --cached --name-only | tr '\n' ' ' | sed 's/ $//')
  git commit -m "Auto: update ${SUMMARY} via Claude

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
fi

# Push
git push -u origin "$BRANCH" 2>/dev/null || true

# Create PR if one doesn't already exist for this branch
if ! gh pr view --repo danielsakakini-oss/index-hehe "$BRANCH" &>/dev/null; then
  TITLE=$(git log -1 --format='%s')
  gh pr create \
    --repo danielsakakini-oss/index-hehe \
    --title "$TITLE" \
    --body "$(cat <<'BODY'
## Summary
Auto-created PR from Claude Code session.

## Changes
See commit diff for details.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
    )"
fi

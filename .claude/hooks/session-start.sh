#!/bin/bash
# Pin the git author identity used inside Claude Code on the web.
#
# Without this, the session inherits whatever identity the container was
# provisioned with. That has drifted before: a handful of commits went out as
# cl3896@columbia.edu, which GitHub resolves to a different account than
# ImChong and lists as a separate contributor. GitHub attributes commits by
# author email, not by who pushed, so the email is what has to be fixed.
set -euo pipefail

# Only inside a remote (web) session. On a local checkout the developer's own
# git config should win — otherwise their hand-written commits would go out
# signed as Claude.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

repo_dir="${CLAUDE_PROJECT_DIR:-$PWD}"
git -C "$repo_dir" rev-parse --git-dir > /dev/null 2>&1 || exit 0

git -C "$repo_dir" config user.name "Claude"
git -C "$repo_dir" config user.email "noreply@anthropic.com"

echo "git author pinned to Claude <noreply@anthropic.com>"

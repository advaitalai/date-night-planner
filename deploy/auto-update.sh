#!/usr/bin/env bash
# Run every 5 min by the date-night-autoupdate timer (deploy/install-autoupdate.sh).
# Deploys only when the branch on GitHub has new commits, and never during a phone call.
set -euo pipefail
cd "$(dirname "$0")/.."
branch=$(git rev-parse --abbrev-ref HEAD)
git fetch -q origin "$branch"
[ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$branch")" ] && exit 0
# The bot writes this file while a call is on (removed when it ends; ignored after 15 min).
if [ -n "$(find data/call-in-progress -mmin -15 2>/dev/null)" ]; then
  echo "New code waiting, but a call is in progress: next round."
  exit 0
fi
echo "Deploying $(git rev-parse --short "origin/$branch")..."
bash deploy/update.sh

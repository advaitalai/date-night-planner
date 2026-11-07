#!/usr/bin/env bash
# Update the bot on the server: bash deploy/update.sh
# Pulls the latest code, reinstalls libraries only if package-lock.json changed,
# and restarts the service if it's running (otherwise: start it with npm start).
set -euo pipefail
cd "$(dirname "$0")/.."
# The live bot is date-night-planner; the test bot sets SERVICE=date-night-planner-dev.
service="${SERVICE:-date-night-planner}"
before=$(git rev-parse HEAD)
git pull --ff-only
if git diff --quiet "$before" HEAD -- package-lock.json; then
  echo "Libraries unchanged, no install needed."
else
  echo "Library list changed: installing (a few minutes)..."
  npm ci --omit=dev
fi
if systemctl is-active --quiet "$service"; then
  sudo systemctl restart "$service"
  echo "Restarted. Logs: journalctl -u $service -f"
else
  echo "Updated. The service isn't running: start the bot with npm start (or sudo systemctl enable --now date-night-planner)."
fi

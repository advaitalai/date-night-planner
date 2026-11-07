#!/usr/bin/env bash
# Copy the live bot's data into the test bot (nightly at 04:00, or by hand):
#   bash ~/date-night-planner-dev/deploy/sync-test-data.sh
# Live → test only. Chats, logs, reminders and a pending call are left out.
set -euo pipefail
cd "$(dirname "$0")/.."
live="${LIVE_DIR:-$HOME/date-night-planner}/data/planner.db"
mkdir -p data
npx tsx src/scripts/snapshot-for-test.ts "$live" data/planner.db.new
running=0
if systemctl is-active --quiet date-night-planner-dev; then running=1; sudo systemctl stop date-night-planner-dev; fi
mv data/planner.db.new data/planner.db
rm -f data/planner.db-wal data/planner.db-shm
if [ "$running" = 1 ]; then sudo systemctl start date-night-planner-dev; fi
echo "Test data refreshed from the live bot."

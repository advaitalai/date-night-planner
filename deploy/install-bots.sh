#!/usr/bin/env bash
# One-time, in the Cloud console's browser SSH (it needs sudo):
#   sudo bash ~/date-night-planner/deploy/install-bots.sh
#
# Sets up two bots on this server (7 Nov):
#   live: ~/date-night-planner      branch prod     your real group     real bookings
#   test: ~/date-night-planner-dev  the work branch your test group     DRY_RUN=1
# Each updates itself within 5 min of a push to its branch. The test bot gets a
# copy of the live data every night at 04:00 (live → test only).
set -euo pipefail
user="${SUDO_USER:?run with sudo}"
home=$(getent passwd "$user" | cut -d: -f6)
live="$home/date-night-planner"
test="$home/date-night-planner-dev"
work_branch="${WORK_BRANCH:-claude/festive-volta-e3nm17}"
as_user() { sudo -u "$user" -H bash -c "$1"; }

echo "1/6 Live bot: switch to the prod branch"
as_user "cd '$live' && git fetch -q origin prod && git checkout -q -B prod origin/prod && npm ci --omit=dev --silent"

echo "2/6 Test bot: copy of the code on the work branch"
[ -d "$test" ] || as_user "git clone -q https://github.com/advaitalai/date-night-planner.git '$test'"
as_user "cd '$test' && git fetch -q origin '$work_branch' && git checkout -q -B '$work_branch' 'origin/$work_branch' && npm ci --omit=dev --silent"

echo "3/6 Test bot settings: your keys, DRY_RUN on, its own logs, no group yet"
if [ ! -f "$test/.env" ]; then
  grep -v -E '^(DRY_RUN|WA_GROUP_JID|CLOUD_LOG_NAME|WA_PAIRING_PHONE)=' "$live/.env" > "$test/.env"
  printf 'DRY_RUN=1\nWA_GROUP_JID=\nCLOUD_LOG_NAME=date-night-planner-dev\n' >> "$test/.env"
  chown "$user": "$test/.env"
  chmod 600 "$test/.env"
fi

echo "4/6 Test bot data: copy of the live data"
as_user "cd '$test' && bash deploy/sync-test-data.sh"

echo "5/6 Services and timers"
cat > /etc/sudoers.d/date-night <<RULES
$user ALL=(root) NOPASSWD: /usr/bin/systemctl restart date-night-planner
$user ALL=(root) NOPASSWD: /usr/bin/systemctl restart date-night-planner-dev, /usr/bin/systemctl stop date-night-planner-dev, /usr/bin/systemctl start date-night-planner-dev
RULES
chmod 440 /etc/sudoers.d/date-night
visudo -cq

unit() { cat > "/etc/systemd/system/$1"; }
unit date-night-planner-dev.service <<UNIT
[Unit]
Description=Date night planner (test bot, dry run)
After=network-online.target
Wants=network-online.target

[Service]
User=$user
WorkingDirectory=$test
EnvironmentFile=$test/.env
ExecStart=/usr/bin/npx tsx src/index.ts
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT
for kind in live test; do
  if [ "$kind" = live ]; then name=date-night-autoupdate; dir=$live; svc=date-night-planner; else name=date-night-dev-autoupdate; dir=$test; svc=date-night-planner-dev; fi
  unit "$name.service" <<UNIT
[Unit]
Description=Date night planner ($kind): deploy new code from GitHub

[Service]
Type=oneshot
User=$user
WorkingDirectory=$dir
Environment=SERVICE=$svc
ExecStart=/bin/bash $dir/deploy/auto-update.sh
UNIT
  unit "$name.timer" <<UNIT
[Unit]
Description=Check GitHub for $kind bot updates every 5 min

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNIT
done
unit date-night-dev-sync.service <<UNIT
[Unit]
Description=Copy the live bot's data into the test bot

[Service]
Type=oneshot
User=$user
ExecStart=/bin/bash $test/deploy/sync-test-data.sh
UNIT
unit date-night-dev-sync.timer <<UNIT
[Unit]
Description=Nightly test data copy

[Timer]
OnCalendar=*-*-* 04:00
Persistent=true

[Install]
WantedBy=timers.target
UNIT

echo "6/6 Start"
systemctl daemon-reload
systemctl restart date-night-planner
systemctl enable --now date-night-planner-dev date-night-autoupdate.timer date-night-dev-autoupdate.timer date-night-dev-sync.timer

cat <<MSG

Done. Live bot on prod, test bot running in dry run (no group yet).
Last step: link the test bot to Concierge's WhatsApp.
  1. Run:  journalctl -u date-night-planner-dev -f -o cat
  2. On the Concierge phone: WhatsApp → Linked devices → Link a device → scan the QR.
  3. Ctrl+C, then tell Claude "linked". Claude reads the group list from the logs.
MSG

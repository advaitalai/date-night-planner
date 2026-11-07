#!/usr/bin/env bash
# One-time: make the server update itself within 5 min of each push.
#   sudo bash deploy/install-autoupdate.sh
# Off again: sudo systemctl disable --now date-night-autoupdate.timer
set -euo pipefail
user="${SUDO_USER:?run with sudo}"
dir="$(cd "$(dirname "$0")/.." && pwd)"

# update.sh restarts the bot with sudo; allow just that, without a password.
echo "$user ALL=(root) NOPASSWD: /usr/bin/systemctl restart date-night-planner" > /etc/sudoers.d/date-night
chmod 440 /etc/sudoers.d/date-night
visudo -cq

cat > /etc/systemd/system/date-night-autoupdate.service <<UNIT
[Unit]
Description=Date night planner: deploy new code from GitHub
After=network-online.target

[Service]
Type=oneshot
User=$user
WorkingDirectory=$dir
ExecStart=/bin/bash $dir/deploy/auto-update.sh
UNIT

cat > /etc/systemd/system/date-night-autoupdate.timer <<UNIT
[Unit]
Description=Check GitHub for bot updates every 5 min

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now date-night-autoupdate.timer
echo "Auto-update on: the bot updates itself within 5 min of a push."
echo "History: journalctl -u date-night-autoupdate -n 20 --no-pager"

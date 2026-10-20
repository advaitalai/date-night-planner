#!/usr/bin/env bash
# One-time setup on a fresh Google Cloud e2-micro VM (Ubuntu 24.04).
#   curl -fsSL https://raw.githubusercontent.com/advaitalai/date-night-planner/main/deploy/setup-vm.sh | BRANCH=main bash
# BRANCH is the branch to run (default: the working branch, until it's merged to main).
set -euo pipefail
BRANCH="${BRANCH:-claude/festive-volta-e3nm17}"

# e2-micro has 1 GB RAM; add 2 GB swap so the booking browser fits.
if ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
fi

sudo timedatectl set-timezone Asia/Tokyo
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git

cd "$HOME"
[ -d date-night-planner ] || git clone https://github.com/advaitalai/date-night-planner.git
cd date-night-planner
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"
npm ci --omit=dev
# Chromium + system libraries for the booking browser (matches playwright-core's version).
npx -y playwright@1.63.0 install --with-deps chromium

[ -f .env ] || cp .env.example .env
chmod 600 .env

sudo tee /etc/systemd/system/date-night-planner.service >/dev/null <<UNIT
[Unit]
Description=Date night planner
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$HOME/date-night-planner
EnvironmentFile=$HOME/date-night-planner/.env
ExecStart=/usr/bin/npx tsx src/index.ts
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload

cat <<MSG

Done. Next:
  1. nano ~/date-night-planner/.env        (fill in keys; see README)
  2. cd ~/date-night-planner && npm start  (first run only: scan the QR from the bot's WhatsApp
     Business app, Settings → Linked devices; wait for "Listening in", then Ctrl+C)
  3. sudo systemctl enable --now date-night-planner
  4. journalctl -u date-night-planner -f   (logs)
MSG

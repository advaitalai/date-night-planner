#!/usr/bin/env bash
# One-time setup on a fresh Google Cloud e2-micro VM (Ubuntu 24.04).
#   curl -fsSL https://raw.githubusercontent.com/advaitalai/date-night-planner/main/deploy/setup-vm.sh | bash
# or, after cloning: bash deploy/setup-vm.sh
set -euo pipefail

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
npm ci --omit=dev
# Chromium + system libraries for the booking browser (matches playwright-core's version).
npx -y playwright@1.63.0 install --with-deps chromium

[ -f .env ] || cp .env.example .env

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
  2. cd ~/date-night-planner && npm start  (first run only: scan the WhatsApp QR, then Ctrl+C)
  3. sudo systemctl enable --now date-night-planner
  4. journalctl -u date-night-planner -f   (logs)
MSG

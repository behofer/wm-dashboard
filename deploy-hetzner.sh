#!/usr/bin/env bash
# WC2026 dashboard — one-shot provisioning for a fresh Ubuntu VM (Hetzner).
# Run as root on the server: ssh root@167.233.85.49, then paste/run this.
# Serves over HTTP on the bare IP (no domain -> no Let's Encrypt). To add HTTPS
# later, point a domain at the IP and change the Caddy site address (see bottom).
set -euo pipefail

# ---- fill these in -------------------------------------------------------
API_FOOTBALL_KEY="<API_KEY>"          # <-- your real api-sports.io key
SERVER_IP="167.233.85.49"
REPO="https://github.com/behofer/wm-dashboard.git"
APP_DIR="/opt/wm-dashboard"
# --------------------------------------------------------------------------

# 1. System update + base tools
apt update && apt upgrade -y
apt install -y git curl

# 2. Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node --version

# 3. App user + clone (zero deps, no npm install)
id wmdash &>/dev/null || useradd --system --create-home --shell /usr/sbin/nologin wmdash
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull
else
  git clone "$REPO" "$APP_DIR"
fi
chown -R wmdash:wmdash "$APP_DIR"

# 4. Secret env file (not in git)
cat > /etc/wm-dashboard.env <<EOF
API_FOOTBALL_KEY=${API_FOOTBALL_KEY}
PORT=8787
ALLOW_ORIGIN=http://${SERVER_IP}
PLAYER_CLUB_SEASON=2025
EOF
chmod 600 /etc/wm-dashboard.env

# 5. systemd service
cat > /etc/systemd/system/wm-dashboard.service <<'EOF'
[Unit]
Description=WC2026 accessible dashboard (Node proxy)
After=network.target

[Service]
Type=simple
User=wmdash
WorkingDirectory=/opt/wm-dashboard
EnvironmentFile=/etc/wm-dashboard.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now wm-dashboard
systemctl restart wm-dashboard
sleep 1
curl -s localhost:8787/health; echo

# 6. Caddy reverse proxy on :80 (plain HTTP for a bare IP)
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy

cat > /etc/caddy/Caddyfile <<EOF
http://${SERVER_IP} {
    reverse_proxy 127.0.0.1:8787
}
EOF
systemctl reload caddy

# 7. Firewall
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw --force enable

echo "Done -> open  http://${SERVER_IP}"

# ---- later: HTTPS with a domain ------------------------------------------
# Point an A record (wm.example.com -> 167.233.85.49), then replace the
# Caddyfile site block with:
#     wm.example.com {
#         reverse_proxy 127.0.0.1:8787
#     }
# and run: systemctl reload caddy   (Caddy fetches a Let's Encrypt cert)
# Also update ALLOW_ORIGIN in /etc/wm-dashboard.env to https://wm.example.com
# and: systemctl restart wm-dashboard

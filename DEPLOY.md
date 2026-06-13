# Deploying the WC2026 dashboard on a Hetzner VM

The app is two parts: the static `index.html` **and** the `server.js` proxy that
holds the API key, polls API-Football in the background, and serves everything
same-origin. On a small Ubuntu VM you run `server.js` as a systemd service and
put **Caddy** in front for automatic HTTPS. A `CX22` (2 vCPU / 4 GB) is plenty —
this app needs only a few MB.

> Replace `wm.example.com` with your (sub)domain and `<API_KEY>` with your real
> API-Football key throughout.

## 0. DNS
Create an **A record** `wm.example.com → <your-VM-IPv4>` (and optionally an
`AAAA` record for IPv6). HTTPS needs this to resolve before step 5.

## 1. Connect & update
```bash
ssh root@<your-VM-IP>
apt update && apt upgrade -y
apt install -y git curl
```

## 2. Install Node.js 20 LTS (NodeSource)
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node --version   # should be >= 18
```

## 3. Create an app user and clone the repo
```bash
useradd --system --create-home --shell /usr/sbin/nologin wmdash
git clone https://github.com/behofer/wm-dashboard.git /opt/wm-dashboard
chown -R wmdash:wmdash /opt/wm-dashboard
```
No `npm install` is needed — the app has zero dependencies.

## 4. Provide the API key (env file, not in git)
```bash
cat > /etc/wm-dashboard.env <<'EOF'
API_FOOTBALL_KEY=<API_KEY>
PORT=8787
ALLOW_ORIGIN=https://wm.example.com
PLAYER_CLUB_SEASON=2025
EOF
chmod 600 /etc/wm-dashboard.env
```

## 5. Run it as a systemd service
```bash
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
systemctl status wm-dashboard --no-pager   # should be "active (running)"
curl -s localhost:8787/health              # {"ok":true,"hasKey":true,...}
```

## 6. HTTPS reverse proxy with Caddy
```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```
Add a site block (Caddy gets a Let's Encrypt cert automatically):
```bash
cat >> /etc/caddy/Caddyfile <<'EOF'

wm.example.com {
    reverse_proxy 127.0.0.1:8787
}
EOF
systemctl reload caddy
```

## 7. Firewall
```bash
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw --force enable
```

Open `https://wm.example.com` — done. The dashboard is served same-origin and
pulls official live data through the proxy.

## Updating after you push to GitHub
```bash
cd /opt/wm-dashboard
git pull
systemctl restart wm-dashboard
```
(Only restart needed; there's no build step.)

## Notes
- **Shared VM:** Caddy can host multiple sites — just add more blocks to the
  `Caddyfile`. The dashboard only listens on `127.0.0.1:8787`, so it never
  conflicts with your other services as long as the port is free.
- **Logs:** `journalctl -u wm-dashboard -f`.
- **Quota:** the background poller keeps the cache warm (~1.5–3k upstream
  requests/day, well under a 7,500/day plan); visitor and bot requests hit the
  warm cache, not upstream.
- **No key?** The server still runs and the dashboard falls back to the bundled
  snapshot + public feeds (no official live data, squads or player profiles).

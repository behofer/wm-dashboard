#!/usr/bin/env bash
# Auto-deploy for the WC2026 dashboard on the Hetzner server.
# Runs from cron every few minutes: pull the latest main and, ONLY if that
# actually advanced HEAD, restart the systemd service. A no-op when nothing
# changed (so cron stays quiet and upstream/service are untouched).
#
# Install (run as root, ONCE):
#   cp /opt/wm-dashboard/auto-deploy.sh /usr/local/bin/wm-dashboard-deploy.sh
#   chmod +x /usr/local/bin/wm-dashboard-deploy.sh
#   printf '%s\n' \
#     'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' \
#     '*/5 * * * * root /usr/local/bin/wm-dashboard-deploy.sh >> /var/log/wm-dashboard-deploy.log 2>&1' \
#     > /etc/cron.d/wm-dashboard
#   chmod 644 /etc/cron.d/wm-dashboard
#
# NOTE: keep the RUNNING copy in /usr/local/bin (not inside the repo), so a pull
# that updates this file can't rewrite the script while it is executing.
set -euo pipefail

APP_DIR="/opt/wm-dashboard"
BRANCH="main"
SERVICE="wm-dashboard"
OWNER="wmdash"

cd "$APP_DIR"

# Cron runs this as root over a repo owned by $OWNER -> avoid "dubious ownership".
git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true

git fetch --quiet origin "$BRANCH"

local_rev="$(git rev-parse HEAD)"
remote_rev="$(git rev-parse "origin/${BRANCH}")"

# Up to date -> nothing to do, exit silently.
[ "$local_rev" = "$remote_rev" ] && exit 0

# Fast-forward the working tree to the fetched remote. reset --hard is safe here:
# the server is deploy-only and must never carry local edits.
git reset --hard --quiet "origin/${BRANCH}"
chown -R "${OWNER}:${OWNER}" "$APP_DIR"

systemctl restart "$SERVICE"

ts="$(date '+%Y-%m-%d %H:%M:%S')"
echo "${ts}  deployed ${local_rev:0:7} -> ${remote_rev:0:7}, restarted ${SERVICE}"
logger -t wm-dashboard-deploy "deployed ${local_rev:0:7} -> ${remote_rev:0:7}"

#!/bin/bash
set -euo pipefail

# === Agent VM Startup Script ===
# Runs on golden image VMs. All tools are pre-installed.
# This script only does runtime config: mounts, services, tokens.

LOG="/var/log/agent-startup.log"
exec > >(tee -a "$LOG") 2>&1

echo "[startup] Configuring agent VM..."

# Read metadata
META="http://metadata.google.internal/computeMetadata/v1"
MHDR="Metadata-Flavor: Google"
BUCKET=$(curl -sf -H "$MHDR" "$META/instance/attributes/bucket-name" || echo "")
USER_ID=$(curl -sf -H "$MHDR" "$META/instance/attributes/user-id" || echo "unknown")
PROJECT=$(curl -sf -H "$MHDR" "$META/project/project-id" || echo "")
DRIVE_TOKEN=$(curl -sf -H "$MHDR" "$META/instance/attributes/drive-token" || echo "")

echo "[startup] bucket=$BUCKET user=$USER_ID project=$PROJECT"

# --- Mount GCS bucket ---
if [ -n "$BUCKET" ]; then
  gsutil ls "gs://$BUCKET" 2>/dev/null || gsutil mb -p "$PROJECT" -l us-central1 "gs://$BUCKET" 2>/dev/null || true
  gcsfuse --uid "$(id -u agent)" --gid "$(id -g agent)" \
    --implicit-dirs --rename-dir-limit=1000000 \
    "$BUCKET" /home/agent/storage
  echo "[startup] GCS bucket $BUCKET mounted"
fi

# --- Mount Google Drive ---
if [ -n "$DRIVE_TOKEN" ]; then
  mkdir -p /home/agent/.config/rclone
  cat > /home/agent/.config/rclone/rclone.conf << RCLONEEOF
[gdrive]
type = drive
token = ${DRIVE_TOKEN}
scope = drive
RCLONEEOF
  chown -R agent:agent /home/agent/.config/rclone
  chmod 600 /home/agent/.config/rclone/rclone.conf

  cat > /etc/systemd/system/gdrive-mount.service << EOF
[Unit]
Description=Google Drive FUSE mount
After=network-online.target
[Service]
Type=simple
User=agent
Environment=HOME=/home/agent
ExecStart=/usr/bin/rclone mount gdrive: /home/agent/drive --vfs-cache-mode writes --vfs-cache-max-age 1h --allow-other
ExecStop=/bin/fusermount -uz /home/agent/drive
Restart=on-failure
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable gdrive-mount
  systemctl start gdrive-mount
  echo "[startup] Google Drive mounted"
fi

# --- Write agent config ---
cat > /home/agent/.claude/CLAUDE.md << 'EOF'
# Agent Environment
You are running on a GCP VM provisioned by the user.
- User: `agent` (passwordless sudo)
- Home: /home/agent

## Storage
- /home/agent/workspace/  — local SSD, fast, use for active work (ephemeral)
- /home/agent/storage/    — GCS bucket via gcsfuse, persistent across VM restarts
- /home/agent/drive/      — Google Drive via rclone (if connected), user's files

Work in workspace/ for speed. Save results to storage/ for persistence.
If the user's Drive is mounted, you can read their files from drive/ and
save deliverables there so they can access them from any device.

## Tools
IronClaw, Claude CLI, Node.js, Python3, git, gcloud, rclone, tmux
Full internet access — install anything with apt/npm/pip
EOF

cat > /home/agent/.ironclaw/.env << EOF
DATABASE_URL=file:///home/agent/storage/.ironclaw/data.db
NEAR_ENABLED=false
SANDBOX_ENABLED=true
IRONCLAW_DATA_DIR=/home/agent/storage
EOF

chown -R agent:agent /home/agent

# --- Generate auth token + start services ---
AUTH_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 24)

cat > /etc/systemd/system/ttyd.service << EOF
[Unit]
Description=ttyd terminal server
After=network.target
[Service]
Type=simple
User=agent
Environment=HOME=/home/agent
WorkingDirectory=/home/agent/workspace
ExecStart=/usr/local/bin/ttyd -W -p 7681 -c agent:${AUTH_TOKEN} -t fontSize=14 -t theme={"background":"#0a0a0a","foreground":"#e0e0e0"} bash
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/agent-tunnel.service << EOF
[Unit]
Description=Cloudflared tunnel for ttyd
After=ttyd.service
[Service]
Type=simple
User=agent
Environment=HOME=/home/agent
ExecStart=/usr/local/bin/cloudflared tunnel --url http://localhost:7681 --no-autoupdate
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ttyd agent-tunnel
systemctl start ttyd agent-tunnel

# --- Wait for tunnel URL ---
echo "[startup] Waiting for tunnel URL..."
for i in $(seq 1 30); do
  TUNNEL_URL=$(journalctl -u agent-tunnel --no-pager -n 50 2>/dev/null | grep -oP 'https://[^\s]*\.trycloudflare\.com' | tail -1 || true)
  if [ -n "$TUNNEL_URL" ]; then
    echo "[startup] Tunnel URL: $TUNNEL_URL"
    curl -sf -X PUT "$META/instance/attributes/tunnel-url" -H "$MHDR" -d "$TUNNEL_URL" || true
    curl -sf -X PUT "$META/instance/attributes/auth-token" -H "$MHDR" -d "$AUTH_TOKEN" || true
    curl -sf -X PUT "$META/instance/attributes/agent-status" -H "$MHDR" -d "ready" || true
    echo "[startup] Agent is ready!"
    exit 0
  fi
  sleep 5
done

echo "[startup] WARNING: Could not get tunnel URL"
curl -sf -X PUT "$META/instance/attributes/agent-status" -H "$MHDR" -d "tunnel_failed" || true

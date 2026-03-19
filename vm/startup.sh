#!/bin/bash
set -euo pipefail

# === Agent VM Bootstrap Script ===
# Installs IronClaw + ttyd + gcsfuse, mounts GCS bucket, exposes terminal via tunnel.
# Metadata inputs: bucket-name, user-id

export DEBIAN_FRONTEND=noninteractive
LOG="/var/log/agent-bootstrap.log"
exec > >(tee -a "$LOG") 2>&1

echo "[bootstrap] Starting agent VM setup..."

# Read metadata
META="http://metadata.google.internal/computeMetadata/v1"
MHDR="Metadata-Flavor: Google"
BUCKET=$(curl -sf -H "$MHDR" "$META/instance/attributes/bucket-name" || echo "")
USER_ID=$(curl -sf -H "$MHDR" "$META/instance/attributes/user-id" || echo "unknown")
PROJECT=$(curl -sf -H "$MHDR" "$META/project/project-id" || echo "")

echo "[bootstrap] bucket=$BUCKET user=$USER_ID project=$PROJECT"

# --- System packages ---
apt-get update -qq
apt-get install -y -qq \
  build-essential git curl wget jq python3 python3-pip python3-venv \
  openssh-client rsync zip unzip vim nano less htop tmux \
  dnsutils net-tools ca-certificates gnupg sudo fuse

# --- Node.js 22 ---
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

# --- gcsfuse (Google Cloud Storage FUSE) ---
if ! command -v gcsfuse &>/dev/null; then
  curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt gcsfuse-jammy main" > /etc/apt/sources.list.d/gcsfuse.list
  apt-get update -qq
  apt-get install -y -qq gcsfuse
fi

# --- IronClaw ---
if ! command -v ironclaw &>/dev/null; then
  curl --proto '=https' --tlsv1.2 -LsSf \
    https://github.com/nearai/ironclaw/releases/latest/download/ironclaw-installer.sh | sh
  # Installer puts it in various places depending on version
  for p in /root/.cargo/bin/ironclaw /root/.ironclaw/bin/ironclaw /root/.local/bin/ironclaw; do
    [ -f "$p" ] && cp "$p" /usr/local/bin/ironclaw && break
  done
  chmod +x /usr/local/bin/ironclaw 2>/dev/null || true
fi

# --- Claude Code CLI ---
if ! command -v claude &>/dev/null; then
  npm install -g @anthropic-ai/claude-code
fi

# --- ttyd ---
if ! command -v ttyd &>/dev/null; then
  curl -sL "https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64" \
    -o /usr/local/bin/ttyd
  chmod +x /usr/local/bin/ttyd
fi

# --- Cloudflared ---
if ! command -v cloudflared &>/dev/null; then
  curl -sL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
    -o /usr/local/bin/cloudflared
  chmod +x /usr/local/bin/cloudflared
fi

# --- rclone (Google Drive FUSE + other cloud storage) ---
if ! command -v rclone &>/dev/null; then
  curl -fsSL https://rclone.org/install.sh | bash
fi

# --- gcloud CLI ---
if ! command -v gcloud &>/dev/null; then
  echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" > /etc/apt/sources.list.d/google-cloud-sdk.list
  apt-get update -qq
  apt-get install -y -qq google-cloud-cli
fi

# --- Create agent user ---
if ! id agent &>/dev/null; then
  useradd -m -s /bin/bash agent
  echo "agent ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers
  usermod -aG fuse agent
fi

# --- Mount GCS bucket via gcsfuse ---
MOUNT_DIR="/home/agent/storage"
mkdir -p "$MOUNT_DIR"
chown agent:agent "$MOUNT_DIR"

if [ -n "$BUCKET" ]; then
  # Create bucket if it doesn't exist (VM service account needs storage admin)
  gsutil ls "gs://$BUCKET" 2>/dev/null || gsutil mb -p "$PROJECT" -l us-central1 "gs://$BUCKET" 2>/dev/null || true

  # Mount with gcsfuse — allow agent user, enable write
  gcsfuse --uid "$(id -u agent)" --gid "$(id -g agent)" \
    --implicit-dirs --rename-dir-limit=1000000 \
    "$BUCKET" "$MOUNT_DIR"
  echo "[bootstrap] GCS bucket $BUCKET mounted at $MOUNT_DIR"
else
  echo "[bootstrap] WARNING: No bucket-name in metadata, skipping mount"
fi

# --- Mount Google Drive via rclone (if OAuth token provided) ---
DRIVE_TOKEN=$(curl -sf -H "$MHDR" "$META/instance/attributes/drive-token" || echo "")
DRIVE_DIR="/home/agent/drive"
mkdir -p "$DRIVE_DIR"
chown agent:agent "$DRIVE_DIR"

if [ -n "$DRIVE_TOKEN" ]; then
  # Configure rclone for Google Drive using the OAuth token from our platform
  mkdir -p /home/agent/.config/rclone
  cat > /home/agent/.config/rclone/rclone.conf << RCLONEEOF
[gdrive]
type = drive
token = ${DRIVE_TOKEN}
scope = drive
RCLONEEOF
  chown -R agent:agent /home/agent/.config/rclone
  chmod 600 /home/agent/.config/rclone/rclone.conf

  # Mount as systemd service so it persists
  cat > /etc/systemd/system/gdrive-mount.service << EOF
[Unit]
Description=Google Drive FUSE mount
After=network-online.target

[Service]
Type=simple
User=agent
Environment=HOME=/home/agent
ExecStart=/usr/bin/rclone mount gdrive: ${DRIVE_DIR} --vfs-cache-mode writes --vfs-cache-max-age 1h --allow-other
ExecStop=/bin/fusermount -uz ${DRIVE_DIR}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable gdrive-mount
  systemctl start gdrive-mount
  echo "[bootstrap] Google Drive mounted at $DRIVE_DIR"
else
  echo "[bootstrap] No drive-token in metadata, skipping Drive mount"
fi

# --- Agent config ---
mkdir -p /home/agent/.claude /home/agent/.ironclaw /home/agent/workspace
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

# --- Generate auth token ---
AUTH_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 24)

# --- ttyd service ---
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

# --- Cloudflared tunnel service ---
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

# --- Wait for tunnel URL → write to instance metadata ---
echo "[bootstrap] Waiting for tunnel URL..."
for i in $(seq 1 30); do
  TUNNEL_URL=$(journalctl -u agent-tunnel --no-pager -n 50 2>/dev/null | grep -oP 'https://[^\s]*\.trycloudflare\.com' | tail -1 || true)
  if [ -n "$TUNNEL_URL" ]; then
    echo "[bootstrap] Tunnel URL: $TUNNEL_URL"
    curl -sf -X PUT "$META/instance/attributes/tunnel-url" -H "$MHDR" -d "$TUNNEL_URL" || true
    curl -sf -X PUT "$META/instance/attributes/auth-token" -H "$MHDR" -d "$AUTH_TOKEN" || true
    curl -sf -X PUT "$META/instance/attributes/agent-status" -H "$MHDR" -d "ready" || true
    echo "[bootstrap] Agent is ready!"
    exit 0
  fi
  echo "[bootstrap] Waiting... ($i/30)"
  sleep 5
done

echo "[bootstrap] WARNING: Could not get tunnel URL"
curl -sf -X PUT "$META/instance/attributes/agent-status" -H "$MHDR" -d "tunnel_failed" || true

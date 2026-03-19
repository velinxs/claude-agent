#!/bin/bash
set -euo pipefail

# === Agent VM Bootstrap Script ===
# Runs on user's GCP VM via startup-script metadata.
# Installs ttyd + agent tools + cloudflared, then exposes terminal via tunnel.

export DEBIAN_FRONTEND=noninteractive
LOG="/var/log/agent-bootstrap.log"
exec > >(tee -a "$LOG") 2>&1

echo "[bootstrap] Starting agent VM setup..."

# --- System packages ---
apt-get update -qq
apt-get install -y -qq \
  build-essential git curl wget jq python3 python3-pip python3-venv \
  openssh-client rsync zip unzip vim nano less htop \
  dnsutils net-tools ca-certificates gnupg sudo tmux \
  libwebsockets-dev libjson-c-dev cmake pkg-config

# --- Node.js 22 ---
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

# --- ttyd (terminal over web) ---
if ! command -v ttyd &>/dev/null; then
  TTYD_VERSION="1.7.7"
  curl -sL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.x86_64" \
    -o /usr/local/bin/ttyd
  chmod +x /usr/local/bin/ttyd
fi

# --- Claude Code CLI ---
if ! command -v claude &>/dev/null; then
  npm install -g @anthropic-ai/claude-code
fi

# --- Cloudflared ---
if ! command -v cloudflared &>/dev/null; then
  curl -sL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
    -o /usr/local/bin/cloudflared
  chmod +x /usr/local/bin/cloudflared
fi

# --- Create agent user ---
if ! id agent &>/dev/null; then
  useradd -m -s /bin/bash agent
  echo "agent ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers
fi

# --- Generate auth token for ttyd ---
AUTH_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 24)
echo "$AUTH_TOKEN" > /home/agent/.ttyd_token
chown agent:agent /home/agent/.ttyd_token

# --- Write agent CLAUDE.md ---
cat > /home/agent/.claude/CLAUDE.md << 'AGENTEOF'
# Agent Environment
You are running on a cloud VM provisioned by the user.
- User: `agent` (passwordless sudo)
- Home: /home/agent
- Tools: Node.js, Python3, git, curl, build-essential, tmux
- Claude Code CLI is available
- Full internet access
- You can install any packages with apt/npm/pip
AGENTEOF
mkdir -p /home/agent/.claude
chown -R agent:agent /home/agent/.claude

# --- Start ttyd ---
# Runs as agent user, serves bash with auth token
# -W = writable, -p = port, -c = credentials (user:pass)
cat > /etc/systemd/system/ttyd.service << EOF
[Unit]
Description=ttyd terminal server
After=network.target

[Service]
Type=simple
User=agent
Environment=HOME=/home/agent
ExecStart=/usr/local/bin/ttyd -W -p 7681 -c agent:${AUTH_TOKEN} -t fontSize=14 -t theme={"background":"#0a0a0a","foreground":"#e0e0e0"} bash
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ttyd
systemctl start ttyd

# --- Start cloudflared tunnel ---
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
systemctl enable agent-tunnel
systemctl start agent-tunnel

# --- Wait for tunnel URL and write to instance metadata ---
echo "[bootstrap] Waiting for tunnel URL..."
for i in $(seq 1 30); do
  TUNNEL_URL=$(journalctl -u agent-tunnel --no-pager -n 50 2>/dev/null | grep -oP 'https://[^\s]*\.trycloudflare\.com' | tail -1 || true)
  if [ -n "$TUNNEL_URL" ]; then
    echo "[bootstrap] Tunnel URL: $TUNNEL_URL"
    # Write to instance metadata so the platform can read it
    curl -s -X PUT \
      "http://metadata.google.internal/computeMetadata/v1/instance/attributes/tunnel-url" \
      -H "Metadata-Flavor: Google" \
      -d "$TUNNEL_URL" 2>/dev/null || true
    curl -s -X PUT \
      "http://metadata.google.internal/computeMetadata/v1/instance/attributes/auth-token" \
      -H "Metadata-Flavor: Google" \
      -d "$AUTH_TOKEN" 2>/dev/null || true
    curl -s -X PUT \
      "http://metadata.google.internal/computeMetadata/v1/instance/attributes/agent-status" \
      -H "Metadata-Flavor: Google" \
      -d "ready" 2>/dev/null || true
    echo "[bootstrap] Metadata written. Agent is ready!"
    exit 0
  fi
  echo "[bootstrap] Waiting... ($i/30)"
  sleep 5
done

echo "[bootstrap] WARNING: Could not get tunnel URL after 150s"
curl -s -X PUT \
  "http://metadata.google.internal/computeMetadata/v1/instance/attributes/agent-status" \
  -H "Metadata-Flavor: Google" \
  -d "tunnel_failed" 2>/dev/null || true

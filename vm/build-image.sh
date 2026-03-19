#!/bin/bash
set -euo pipefail

# === Build Golden Image ===
# Spins up a temp VM, runs the install portion of startup.sh,
# stops it, creates a custom GCE image, then deletes the VM.
#
# Usage: ./build-image.sh [project-id] [zone]
# Requires: gcloud CLI authenticated with compute.admin

PROJECT="${1:-agents-platform-490722}"
ZONE="${2:-us-central1-a}"
BUILD_VM="agent-image-builder-$(date +%s)"
IMAGE_NAME="agent-golden-$(date +%Y%m%d)"
IMAGE_FAMILY="agent-golden"

echo "=== Building golden image ==="
echo "Project: $PROJECT"
echo "Zone: $ZONE"
echo "Build VM: $BUILD_VM"
echo "Image: $IMAGE_NAME (family: $IMAGE_FAMILY)"

# 1. Create a temp VM
echo "[1/5] Creating build VM..."
gcloud compute instances create "$BUILD_VM" \
  --project="$PROJECT" \
  --zone="$ZONE" \
  --machine-type=e2-medium \
  --image-family=ubuntu-2404-lts-amd64 \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size=20GB \
  --boot-disk-type=pd-ssd \
  --scopes=cloud-platform \
  --quiet

# 2. Wait for SSH
echo "[2/5] Waiting for VM to be ready..."
for i in $(seq 1 30); do
  gcloud compute ssh "$BUILD_VM" --project="$PROJECT" --zone="$ZONE" \
    --command="echo ready" --quiet 2>/dev/null && break
  echo "  waiting... ($i/30)"
  sleep 5
done

# 3. Run the install script (just the package installs, not the mounts/services)
echo "[3/5] Installing agent tools..."
gcloud compute ssh "$BUILD_VM" --project="$PROJECT" --zone="$ZONE" --quiet -- bash -s << 'INSTALL_EOF'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

sudo apt-get update -qq
sudo apt-get install -y -qq \
  build-essential git curl wget jq python3 python3-pip python3-venv \
  openssh-client rsync zip unzip vim nano less htop tmux \
  dnsutils net-tools ca-certificates gnupg sudo fuse

# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y -qq nodejs

# gcsfuse
curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | sudo gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt gcsfuse-jammy main" | sudo tee /etc/apt/sources.list.d/gcsfuse.list
sudo apt-get update -qq
sudo apt-get install -y -qq gcsfuse

# rclone
curl -fsSL https://rclone.org/install.sh | sudo bash

# IronClaw
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/nearai/ironclaw/releases/latest/download/ironclaw-installer.sh | sh
for p in ~/.cargo/bin/ironclaw ~/.ironclaw/bin/ironclaw ~/.local/bin/ironclaw; do
  [ -f "$p" ] && sudo cp "$p" /usr/local/bin/ironclaw && break
done
sudo chmod +x /usr/local/bin/ironclaw 2>/dev/null || true

# Claude Code CLI
sudo npm install -g @anthropic-ai/claude-code

# ttyd
sudo curl -sL "https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64" \
  -o /usr/local/bin/ttyd
sudo chmod +x /usr/local/bin/ttyd

# Cloudflared
sudo curl -sL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  -o /usr/local/bin/cloudflared
sudo chmod +x /usr/local/bin/cloudflared

# gcloud CLI
echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | sudo tee /etc/apt/sources.list.d/google-cloud-sdk.list
sudo apt-get update -qq
sudo apt-get install -y -qq google-cloud-cli

# Create agent user
sudo useradd -m -s /bin/bash agent 2>/dev/null || true
echo "agent ALL=(ALL) NOPASSWD:ALL" | sudo tee -a /etc/sudoers
sudo usermod -aG fuse agent

# Pre-create directories
sudo mkdir -p /home/agent/.claude /home/agent/.ironclaw /home/agent/workspace /home/agent/storage /home/agent/drive
sudo chown -R agent:agent /home/agent

# Clean up caches to shrink image
sudo apt-get clean
sudo rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*
sudo journalctl --vacuum-time=1s

echo "=== Install complete ==="
ironclaw --version
claude --version
ttyd --version
node --version
python3 --version
INSTALL_EOF

# 4. Stop VM and create image
echo "[4/5] Stopping VM and creating image..."
gcloud compute instances stop "$BUILD_VM" \
  --project="$PROJECT" --zone="$ZONE" --quiet

gcloud compute images create "$IMAGE_NAME" \
  --project="$PROJECT" \
  --source-disk="$BUILD_VM" \
  --source-disk-zone="$ZONE" \
  --family="$IMAGE_FAMILY" \
  --storage-location=us \
  --description="Agent golden image: IronClaw, Claude CLI, ttyd, gcsfuse, rclone, gcloud" \
  --quiet

echo "[5/5] Cleaning up build VM..."
gcloud compute instances delete "$BUILD_VM" \
  --project="$PROJECT" --zone="$ZONE" --quiet

echo ""
echo "=== Done! ==="
echo "Image: $IMAGE_NAME"
echo "Family: $IMAGE_FAMILY"
echo ""
echo "Use in provisioning:"
echo "  --image-family=$IMAGE_FAMILY --image-project=$PROJECT"

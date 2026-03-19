FROM docker.io/cloudflare/sandbox:0.7.18

# System tools (base image is Ubuntu 22.04 with Node.js 22)
RUN apt-get update && apt-get install -y \
  python3 python3-pip git curl wget jq build-essential \
  openssh-client rsync zip unzip htop vim nano less \
  dnsutils iputils-ping net-tools ca-certificates gnupg \
  sudo tmux \
  && rm -rf /var/lib/apt/lists/*

# IronClaw — Rust-based model-agnostic AI agent runtime
# Single binary, WASM-sandboxed tools, supports Claude/GPT/Gemini/Ollama/OpenRouter
RUN curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/nearai/ironclaw/releases/latest/download/ironclaw-installer.sh | sh \
  && mv /root/.cargo/bin/ironclaw /usr/local/bin/ironclaw || \
  mv /root/.ironclaw/bin/ironclaw /usr/local/bin/ironclaw 2>/dev/null || true

# Claude Code CLI (fallback / direct mode)
RUN npm install -g @anthropic-ai/claude-code

# Python packages
RUN pip3 install --no-cache-dir \
  requests pandas numpy matplotlib beautifulsoup4 httpx rich \
  flask fastapi uvicorn aiohttp

# Cloudflared (for quick tunnels)
RUN curl -sL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared

# Non-root user with sudo
RUN useradd -m -s /bin/bash agent \
  && echo "agent ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers
ENV HOME=/home/agent

# Agent config directories
RUN mkdir -p /home/agent/.claude /home/agent/.ironclaw /home/agent/persistent \
  && chown -R agent:agent /home/agent

# Copy project instructions
COPY sandbox/CLAUDE.md /home/agent/.claude/CLAUDE.md
RUN chown agent:agent /home/agent/.claude/CLAUDE.md

# IronClaw default config — model-agnostic, no crypto, libSQL embedded
COPY sandbox/ironclaw.env /home/agent/.ironclaw/.env
RUN chown -R agent:agent /home/agent/.ironclaw

USER agent
WORKDIR /home/agent/workspace

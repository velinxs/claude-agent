FROM docker.io/cloudflare/sandbox:0.7.18

# System tools (base image is Ubuntu 22.04 with Node.js 22)
RUN apt-get update && apt-get install -y \
  python3 python3-pip git curl wget jq build-essential \
  openssh-client rsync zip unzip htop vim nano less \
  dnsutils iputils-ping net-tools ca-certificates gnupg \
  sudo \
  && rm -rf /var/lib/apt/lists/*

# Claude Code CLI
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

# Claude Code project instructions
RUN mkdir -p /home/agent/.claude && chown -R agent:agent /home/agent/.claude
COPY sandbox/CLAUDE.md /home/agent/.claude/CLAUDE.md
RUN chown agent:agent /home/agent/.claude/CLAUDE.md

USER agent
WORKDIR /home/agent/workspace

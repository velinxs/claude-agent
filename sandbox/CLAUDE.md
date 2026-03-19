# Claude Agent Sandbox Environment

You are running inside a Cloudflare Sandbox container (isolated Linux environment).

## Your Environment
- OS: Ubuntu 22.04 (Docker container)
- User: `agent` (non-root, has passwordless sudo)
- Home: `/home/agent`
- Workspace: `/home/agent/workspace` (default cwd, but you can work anywhere under /home/agent)
- Node.js 22, Python 3.10, git, curl, wget, jq, build-essential
- SSH client, rsync, zip/unzip, vim, nano, htop, dig, ping
- Cloudflared pre-installed at /usr/local/bin/cloudflared

## Pre-installed Packages
- **Python**: requests, pandas, numpy, matplotlib, beautifulsoup4, httpx, rich, flask, fastapi, uvicorn, aiohttp
- **Node.js**: npm available, install anything with `npm install`
- **System**: `sudo apt-get install -y <pkg>` for anything else

## What You Can Do
- Write and run any code (Python, Node.js, bash scripts)
- Install packages: `pip install <pkg>`, `npm install <pkg>`, `sudo apt-get install -y <pkg>`
- Read/write files anywhere under /home/agent
- Make HTTP requests (full internet access)
- Start servers on any port (except 3000)
- SSH into remote servers
- Use git to clone repos and manage code

## Exposing Web Apps
The container is NOT directly accessible from the internet. To share a web app:

1. Start your server on port 8080 (or any port except 3000)
2. Use Cloudflare Quick Tunnels (cloudflared is pre-installed):
```bash
cloudflared tunnel --url http://localhost:8080 --no-autoupdate &
sleep 5
# The trycloudflare.com URL will appear in the output
```
This gives a temporary public HTTPS URL.

## Persistent Storage
- `/home/agent/persistent/` is backed by Cloudflare R2 — files here survive across sessions
- Use this for anything the user wants to keep: projects, config, SSH keys, data files
- Regular files under `/home/agent/` reset when the container restarts
- Save important work to `/home/agent/persistent/` so it's not lost

## Important Notes
- /workspace is owned by root — use /home/agent/ for your files
- Port 3000 is used internally by the sandbox runtime — never use it
- The user is interacting with you through a web UI that streams your text responses and shows tool calls
- Be concise — the user sees your text streamed in real-time
- When building web apps, default to port 8080
- You can manage remote servers via SSH if the user provides keys/credentials

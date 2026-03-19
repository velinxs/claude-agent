# Dev Notes

## Terminal / Login Flow (March 2026)

### What works
- xterm.js terminal opens on "connect", runs `claude login` inside sandbox via script(1) + FIFO
- User can interact with the full CLI wizard (theme picker, auth URL, paste code)
- Login completes successfully — auth persists in sandbox for subsequent `claude -p` calls
- Output buffered 50ms to reduce screen tearing from split ANSI sequences

### Problems
- **Cold start**: blank terminal for minutes before any output appears. Cloudflare Sandbox containers have significant cold start time — the container needs to boot before `claude login` can run. No way to pre-warm.
- **Input latency**: each keystroke requires writeFile + exec cat > FIFO — two sandbox round trips per key. Noticeable lag for interactive TUI.
- **Screen tearing**: even with buffering, complex TUI rendering (the claude wizard with ASCII art, color themes, etc.) doesn't render cleanly through the proxy chain: xterm.js ↔ WebSocket ↔ Worker ↔ DO ↔ sandbox.exec ↔ script/pty ↔ CLI
- **Architecture mismatch**: Cloudflare Sandbox is great for running CLI commands (fire and forget), not for interactive terminal sessions. The exec API has onOutput streaming but no stdin streaming — we hack around it with FIFOs.

### GCP alternative?
Might be worth revisiting GCP for the container runtime:
- GCP Cloud Run or Compute Engine VMs have faster cold starts (especially with min instances)
- Could run actual ttyd or gotty for native web terminal with zero proxying
- SSH directly into a VM gives real pty with no FIFO hacks
- Could still use Cloudflare Workers as the frontend/routing layer
- Tradeoff: more infra to manage, not "serverless edge" anymore

### Other approaches considered
- **Automate the wizard**: tried sending keystrokes programmatically (echo to FIFO). TUI uses raw terminal mode, arrow-key selectors, etc. — too fragile.
- **Pre-configure CLI**: write settings files to skip wizard. Haven't found the right config format yet.
- **`claude setup-token`**: generates token non-interactively but still requires initial interactive auth.
- **ttyd inside sandbox**: install ttyd, run it, tunnel via cloudflared, embed in iframe. Would give native terminal quality but adds complexity and another tunnel hop.

### Current status
Login works end-to-end but UX is rough (minutes of blank screen, laggy input). The terminal is only needed for one-time login — after that the chat UI is smooth. Question is whether the one-time pain is acceptable or if we need a better container runtime.

---

## Vision: Decentralized AI Network (March 2026)

### The Big Idea
Model-agnostic CLI-in-browser. Anyone visits the URL, OAuth's into their cloud provider (Anthropic, Google, OpenAI, whatever), and gets a full agent environment. Not just one user's tool — a **network** where AI agents can discover and exchange information with each other.

### Key Concepts
- **Model agnostic**: not just Claude. Any CLI agent tool (claude, gemini, copilot, local models). The platform is the container + terminal, not the model.
- **OAuth in, you're in**: no setup tokens, no config files. Connect your Anthropic/Google/OpenAI account via OAuth and the CLI tools authenticate automatically.
- **Multi-tenant decentralized**: each user brings their own compute (BYOC) or uses managed infra. Users aren't on shared resources — they own their containers.
- **FUSE-based inter-agent filesystem**: agents can mount each other's filesystems (read-only or read-write) via FUSE. Agent A working on a project can expose its workspace; Agent B can browse it, learn from it, build on it. Information flows between AI agents directly.
- **The vibration layer**: intelligence emerges from the interconnections. Individual agents are useful; a network of agents sharing context, files, and discoveries is transformative. The value isn't in any single container — it's in the mesh.
- **Terminal-first UI**: the browser app IS a terminal. Not a chat UI pretending to be smart — a real terminal that normies can use. Think: visit URL → OAuth → full terminal with AI agent ready to go. Power users get exactly what they want; new users get a guided experience.

### Architecture Direction
```
Browser (ttyd / xterm.js)
  ↕ WebSocket
Edge Router (Cloudflare Worker or lightweight proxy)
  ↕
Container Runtime (GCP Cloud Run? Fly.io? Bare metal?)
  ├── User's AI agent (claude/gemini/whatever CLI)
  ├── FUSE mounts to other agents' filesystems
  ├── Local tools (git, python, node, etc.)
  └── Network discovery (find other agents, share context)
```

### Open Questions
- **Container runtime**: CF Sandbox is too slow for interactive terminals. GCP Cloud Run? Fly.io? Hetzner? Need fast cold starts + real pty support.
- **FUSE networking**: how do agents discover each other? DNS-based? Registry? Peer-to-peer?
- **Permission model**: who can mount whose filesystem? Public/private/friends-only?
- **Identity**: OAuth identity = your agent identity? Or separate agent identities?
- **Monetization**: free tier = BYOC (bring your own cloud). Pro tier = managed infra + API access. Network effects drive value.
- **Model routing**: could the platform intelligently route between models? Use Claude for code, Gemini for research, local models for private data?

### BYOC (Bring Your Own Cloud) — The Key Insight
We are NOT a cloud provider. We are a network layer. The compute model:
- User OAuth's into their GCP/AWS/Azure account via the platform
- Platform provisions a VM **on the user's cloud account** using their credentials
- Agent CLI + ttyd runs on THEIR infra, THEIR bill
- Platform provides: routing, auth, discovery, FUSE mesh, the web UI wrapper
- User pays their cloud provider for compute. We charge for the network/platform.

This means:
- Zero compute costs for us (no subsidizing free tiers)
- Users get full control of their infra (region, machine size, GPU, etc.)
- Scales infinitely — each new user brings their own capacity
- No vendor lock-in — works with any cloud that has VMs
- Pro tier = managed experience (we handle provisioning). Free tier = DIY (run our agent image on your own VM, connect to the network)

### Why Terminal-First
- Terminals are the native interface for AI agents (they're all CLI tools)
- No translation layer between what the agent does and what the user sees
- Power users already live in terminals
- "Normies" can still use it — the AI agent IS the UX layer. You talk to it in plain English, it does terminal things.
- Smallest possible surface area to build and maintain
- ttyd/gotty are battle-tested, sub-10ms latency, handle all the pty stuff correctly

---

## Agent-to-Agent Communication via Shared Buckets (March 2026)

### The Filesystem IS the Protocol

Instead of A2A, AMP, ACP, or any other agent-to-agent protocol — agents communicate
through shared GCS buckets mounted via gcsfuse. No APIs, no discovery service, no auth
between agents. Just files.

### How It Works

```
/shared-bucket/                    (gcsfuse mounted on all team VMs)
  context.md                       shared world state, read by all
  soul.md                          team personality/goals, read by all
  agent-1/                         agent 1's workspace
    notes.md                       agent 1's scratch work
  agent-2/                         agent 2's workspace
    notes.md                       agent 2's scratch work
  agent-1.inbox.md                 write here to "talk" to agent 1
  agent-2.inbox.md                 write here to "talk" to agent 2
```

### Inbox Pattern — Conversations Through Files

A file watcher (`inotifywait` or similar) on each VM watches `agent-X.inbox.md`.
When the file changes:
1. Watcher detects change
2. Reads new content from the inbox file
3. Injects it as a user message into IronClaw / Claude CLI
4. Agent processes and responds by writing to the OTHER agent's inbox file

That's a conversation. Through files. Over a shared bucket.

```bash
# agent-1's watcher (conceptual)
inotifywait -m /shared/agent-1.inbox.md -e modify |
while read; do
  MSG=$(cat /shared/agent-1.inbox.md)
  RESPONSE=$(echo "$MSG" | ironclaw chat --output text)
  echo "$RESPONSE" >> /shared/agent-2.inbox.md
done
```

### Why This Is Better Than API-Based Agent Protocols

- **Zero infrastructure**: no message bus, no discovery service, no HTTP endpoints
- **Already works**: gcsfuse + inotifywait + markdown. All exists today.
- **Conversation history IS the file**: searchable, versionable, pipe-able
- **AI agents already know how to read/write files**: no new capabilities needed
- **Secure by default**: GCS IAM controls who mounts what bucket
- **Async by nature**: agents don't need to be online simultaneously
- **Human-readable**: you can open the inbox files and read the conversation
- **Multi-agent**: any number of agents can mount the same bucket
- **Cross-cloud**: agent on GCP can share a bucket with agent on AWS (via GCS interop)

### gcsfuse Concurrency Rules

- Multiple VMs can mount the same bucket simultaneously ✓
- Multiple readers of the same file: safe ✓
- Multiple writers to DIFFERENT files: safe ✓
- Multiple writers to the SAME file: last-writer-wins (no locking)
- Convention: each agent writes to its own files or to other agents' inboxes
  (never two agents writing to the same inbox at once)

### Bucket Types

- **Private bucket**: one user, all their agents. Persistence + cross-agent workspace.
- **Team bucket**: shared by a team/company. Agents collaborate via inboxes + context.md.
- **Public bucket**: read-only community resources. Tools, datasets, shared knowledge.
  Anyone can mount it. Curated by the community.

### Revenue Angle

- Free: private bucket (user's own GCS, they pay Google)
- Paid: team buckets (we host on our GCP, charge monthly per team)
- Public buckets: free to mount, we pay hosting (community goodwill / network effect)

### Future: Real-Time Layer

For low-latency agent-to-agent (sub-second), could layer Pub/Sub or Redis on top.
File-based is fine for async collaboration (seconds to minutes). Real-time would need
a message bus. But start with files — it's 90% of the use case.

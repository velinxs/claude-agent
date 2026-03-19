# Claude Agent — Project Brief

## What Is It

A universal AI agent platform. Think open-interpreter meets Claude Code, but:
- Runs entirely on Cloudflare's edge (no server to manage)
- Works on any device — phone, web browser, terminal
- Each user brings their own Claude Max subscription (no shared API costs)
- Real isolated Linux environment per user session

Normie accessible. Power user capable.

---

## The Problem It Solves

Right now if you want an AI that can actually *do* things (run code, browse the web, manage files, automate tasks), your options are:

- **Claude Code** — CLI only, requires a developer setup, desktop only
- **Open Interpreter** — self-hosted, requires a running server, fading project
- **OpenClaw** — your machine has to be on 24/7, uses WhatsApp/Telegram as UI
- **Anthropic Computer Use API** — $$$, requires your own infrastructure

None of these work for normies. None are truly serverless. None let you use your existing Claude Max subscription on mobile.

---

## How It Works

```
User (any device)
    ↕ WebSocket (streaming)
Cloudflare Worker  ←  routes sessions
    ↓
Durable Object  ←  per-user session state + conversation history
    ├── Anthropic API  ←  Claude Sonnet/Opus, streaming, user's own token
    └── Cloudflare Sandbox  ←  isolated Linux container per session
            ├── Python 3, Node.js, bash
            ├── pip/npm/apt installable at runtime
            └── persistent filesystem within session
```

**Auth flow:**
1. User runs `claude setup-token` once on their desktop → gets a 1-year token (`sk-ant-oat01-...`)
2. Pastes it into the app
3. All API calls are billed against their own Claude Max subscription
4. Zero shared costs, zero shared state between users

**Execution flow:**
1. User sends message
2. Claude responds, deciding whether to run code or answer directly
3. If code → executes in their isolated Cloudflare Sandbox container
4. Output streams back in real-time
5. Claude sees the output, continues reasoning
6. Repeat until task is complete

---

## What Claude Can Do

- Write and run Python scripts
- Run bash commands (git, curl, wget, file ops, etc.)
- Install packages at runtime (`pip install`, `apt-get`)
- Read/write files that persist within the session
- Make HTTP requests (internet access in the sandbox)
- Process data, generate charts, analyze CSVs
- Automate multi-step workflows

**Coming next:**
- Browser control via Cloudflare Browser Rendering (Puppeteer)
  → Claude can browse websites, fill forms, take screenshots, interact with web UIs
- Long-running background tasks via Cloudflare Queues
- Persistent memory across sessions via D1
- User-extensible custom tools via Workers for Platforms

---

## The Stack

| Layer | Technology |
|---|---|
| Runtime | Cloudflare Workers |
| Session state | Cloudflare Durable Objects |
| Code execution | Cloudflare Sandbox SDK (isolated Linux containers) |
| Browser control | Cloudflare Browser Rendering (Puppeteer) — v2 |
| Storage | Cloudflare R2 + D1 |
| LLM | Anthropic Claude (Sonnet 4.6 / Opus 4.6) |
| Mobile | React Native / Expo — v2 |
| Web client | Vanilla JS, embedded in Worker |

Everything runs on Cloudflare. No AWS, no GCP, no VPS, no Kubernetes.

---

## Why Cloudflare

- **Edge network** — runs close to every user globally, low latency
- **Serverless** — zero ops, scales automatically, pay-per-use
- **Durable Objects** — stateful WebSocket sessions without managing servers
- **Sandbox SDK** — isolated Linux containers without managing Docker/k8s
- **Browser Rendering** — headless Chrome without managing Puppeteer infrastructure
- **Workers for Platforms** — eventual multi-tenant user extensions

The entire platform backend is ~300 lines of TypeScript.

---

## Why This Beats the Alternatives

| | Claude Agent | OpenClaw | Claude Code | OI |
|---|---|---|---|---|
| Mobile | Yes (v2) | Via Telegram/WhatsApp | No | No |
| No server required | Yes | No (needs host) | No | No |
| Normie setup | Yes | No | No | No |
| Uses Claude Max | Yes | API key | Yes | API key |
| Real code execution | Yes | Local only | Yes | Local only |
| Serverless | Yes | No | No | No |

---

## Current Status

**Working:**
- Cloudflare Worker + Durable Objects session management
- Anthropic streaming (tool use loop)
- Cloudflare Sandbox code execution (bash + Python)
- Web client with streaming UI

**Next:**
- Browser automation (Cloudflare Browser Rendering)
- React Native Android app
- Persistent memory (D1)
- Workers for Platforms user extensions

---

## Monetization Ideas

1. **Free tier** — users bring their own Claude Max token, pay nothing
2. **Hosted tier** — we provide the Claude API access, charge a markup (bundle deal)
3. **Team/enterprise** — shared workspace, team memory, custom tools
4. **Platform play** — Workers for Platforms enables third-party tools marketplace

---

## Getting Started (Dev)

```bash
git clone <repo>
cd claude-agent
npm install
npm run dev
```

Visit `http://localhost:8787`, paste your Anthropic API key or Claude Max setup-token, start chatting.

Generate a setup-token (Claude Max):
```bash
claude setup-token
# exports sk-ant-oat01-... (valid 1 year)
# set as CLAUDE_CODE_OAUTH_TOKEN in any client
```

Deploy to Cloudflare:
```bash
npm run deploy
# live globally in ~2 minutes
```

---

## Open Questions

1. Does `sk-ant-oat01-...` work directly with the Anthropic API + `anthropic-beta: claude-code-20250219` header? Needs testing.
2. Cloudflare Sandbox SDK is in Beta — production readiness?
3. React Native app — what's the right framework (Expo vs bare RN)?
4. Pricing model — free w/ own token, or provide managed access?

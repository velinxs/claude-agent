# Claude Agent

Universal AI agent platform running on Cloudflare's edge. Runs `claude -p` CLI inside Cloudflare Sandbox containers, authenticated via OAuth token. Each user brings their own Claude Max subscription.

## Architecture

```
Browser (WebSocket) → Cloudflare Worker → Durable Object → Sandbox Container
                      src/index.ts        src/session.ts    Dockerfile
                      (routing + assets)  (WS + CLI mgmt)   (Ubuntu + claude CLI)
```

- **Worker** (`src/index.ts`) — routes `/ws` to DO, `/health` for healthcheck, serves static assets from `public/`
- **Durable Object** (`src/session.ts`) — `AgentSession` manages WebSocket lifecycle, runs `claude -p --output-format stream-json` inside sandbox, parses NDJSON stream
- **Sandbox** — isolated Linux container per session via `@cloudflare/sandbox`
- **Web client** (`public/index.html`) — vanilla JS, dark terminal UI, mobile-responsive

## Key Files

```
src/
  index.ts          Worker entry + asset serving
  session.ts        AgentSession DO — runs claude CLI in sandbox, parses stream
  types.ts          ClientMessage/ServerMessage types, Env bindings
public/
  index.html        Web client (vanilla JS, single file)
sandbox/
  CLAUDE.md         Instructions copied into container at /home/agent/.claude/CLAUDE.md
docs/
  PROJECT.md        Project brief / pitch doc
Dockerfile          Sandbox container image (Ubuntu 22.04 + tools + claude CLI)
wrangler.jsonc      Cloudflare config (containers, DOs, R2, assets)
```

## Technical Details

- OAuth token (`sk-ant-oat01-...`) does NOT work with Anthropic API directly — must use `claude` CLI
- Container user is `agent` (non-root) with passwordless sudo — CLI refuses `bypassPermissions` as root
- Port 3000 reserved by sandbox runtime — apps should use 8080+
- `/workspace` is root-owned — agent files go in `/home/agent/`
- Sandbox ID must be 1-63 chars — we slice DO ID: `this.ctx.id.toString().slice(0, 63)`
- Client generates persistent sessionId in localStorage, always reconnects to same DO
- WS keepalive pings every 30s to prevent idle disconnect
- Message passing via `sandbox.writeFile()` + stdin redirect to avoid shell injection
- Conversation continuity via `--resume <session_id>` (captured from NDJSON `system/init` event)

## Auth Flow

Two modes:
1. **Manual token** — user pastes `sk-ant-oat01-...` from `claude setup-token`
2. **OAuth login** (WIP) — user clicks "connect", we run login flow inside sandbox, surface auth URL via WebSocket

When using manual token, it's passed as `CLAUDE_CODE_OAUTH_TOKEN` env var to the sandbox.
When using OAuth login, credentials are stored in the container's filesystem.

## Persistent Storage

R2 bucket `agent-storage` mounted via `sandbox.mountBucket()` at `/home/agent/persistent/`.
Scoped per user via SHA-256 hash of their OAuth token as prefix.

## Deployment

Requires docker group + CF OAuth (not API token):
```bash
sg docker -c "unset CLOUDFLARE_API_TOKEN && npx wrangler deploy"
```

- Live at: https://claude-agent.wzmcghee.workers.dev
- Cloudflare account: Wzmcghee@gmail.com (account ID: 228ba5cfac397accddf678da1b6aa10d)

## Known Issues

- Container cold start can cause WS to drop briefly on first connect
- R2 mount needs `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` secrets (R2 API token from CF dashboard)
- OAuth login inside sandbox — CLI's `/login` is an interactive REPL command, not a standalone subcommand. Need to pipe it or find the right CLI invocation.

## Multi-Tenant Plans

- **Free tier**: User brings their own Cloudflare account (NOT shared infra)
- **Pro tier**: Workers for Platforms on our account, includes Claude API access
- OAuth login inside sandbox so users don't need to manually generate tokens

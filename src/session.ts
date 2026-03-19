import { DurableObject } from "cloudflare:workers";
import { getSandbox } from "@cloudflare/sandbox";
import type { Env, ServerMessage, ClientMessage } from "./types";

export class AgentSession extends DurableObject<Env> {
  private interrupted = false;
  private mounted = false;
  private authenticated = false;
  private loginInProgress = false;

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const msg: ClientMessage = JSON.parse(raw as string);

    if (msg.type === "reset") {
      await this.ctx.storage.delete("sessionId");
      this.interrupted = false;
      this.send(ws, { type: "done" });
      return;
    }

    if (msg.type === "ping") {
      return;
    }

    if (msg.type === "interrupt") {
      this.interrupted = true;
      return;
    }

    if (msg.type === "login") {
      if (this.loginInProgress) return;
      await this.runLogin(ws);
      return;
    }

    if (msg.type === "message") {
      this.interrupted = false;
      await this.runAgent(ws, msg.content, msg.token, msg.model ?? "claude-sonnet-4-6");
    }
  }

  async webSocketClose() {}
  async webSocketError() {}

  private send(ws: WebSocket, msg: ServerMessage) {
    ws.send(JSON.stringify(msg));
  }

  private async runAgent(ws: WebSocket, userMessage: string, token: string | undefined, model: string) {
    // One persistent container per session — filesystem survives across turns
    const sandboxId = this.ctx.id.toString().slice(0, 63);
    const sandbox = getSandbox(this.env.Sandbox, sandboxId);

    // Mount persistent R2 storage scoped to user (derived from token hash or session ID)
    if (!this.mounted && this.env.R2_ENDPOINT) {
      try {
        // Use token hash if available, otherwise use session-based prefix
        const prefix = token
          ? `users/${await this.hashToken(token)}/`
          : `sessions/${this.ctx.id.toString().slice(0, 32)}/`;
        await sandbox.mountBucket("agent-storage", "/home/agent/persistent", {
          endpoint: this.env.R2_ENDPOINT,
          prefix,
        });
        this.mounted = true;
        console.log("[r2] mounted persistent storage with prefix", prefix.slice(0, 30));
      } catch (err) {
        console.error("[r2 mount error]", err);
      }
    }

    // Resume existing conversation if we have a session ID
    const savedSessionId = await this.ctx.storage.get<string>("sessionId");

    // Write message to temp file — avoids shell escaping issues
    const msgFile = `/tmp/msg_${Date.now()}.txt`;
    await sandbox.writeFile(msgFile, userMessage);

    const claudeCmd = [
      "claude", "-p",
      "--input-format", "text",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--permission-mode", "bypassPermissions",
      "--model", model,
      "--tools", "Bash,Edit,Read,Write,Glob,Grep,WebSearch,WebFetch",
      savedSessionId ? `--resume ${savedSessionId}` : "",
    ].filter(Boolean).join(" ");

    // Use sh -c to get stdin redirection from the temp file
    const command = `sh -c '${claudeCmd} < ${msgFile}'`;

    let lineBuffer = "";

    // Build env — include token if provided, otherwise rely on sandbox-stored OAuth creds
    const execEnv: Record<string, string> = {
      CLAUDE_NO_AUTO_UPDATE: "1",
      CI: "1",
      HOME: "/home/agent",
    };
    if (token) {
      execEnv.CLAUDE_CODE_OAUTH_TOKEN = token;
    }

    try {
      const result = await sandbox.exec(command, {
        stream: true,
        timeout: 120000,
        env: execEnv,
        onOutput: (stream: string, data: string) => {
          if (this.interrupted) return;
          console.log(`[sandbox ${stream}]`, data.slice(0, 200));

          // Buffer and parse complete NDJSON lines
          lineBuffer += data;
          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              this.handleEvent(ws, JSON.parse(line));
            } catch {
              // non-JSON output (e.g. debug logs) — forward as text for debugging
              console.log("[non-json]", line.slice(0, 200));
            }
          }
        },
      });

      console.log("[exec result]", JSON.stringify({ exitCode: result.exitCode, success: result.success }));

      // Flush any remaining buffered line
      if (lineBuffer.trim()) {
        try { this.handleEvent(ws, JSON.parse(lineBuffer)); } catch {}
      }

      if (!result.success) {
        this.send(ws, { type: "error", message: `claude exited with code ${result.exitCode}` });
      }
    } catch (err) {
      console.error("[exec error]", err);
      this.send(ws, { type: "error", message: String(err) });
    }

    this.send(ws, { type: "done" });
  }

  private async runLogin(ws: WebSocket) {
    this.loginInProgress = true;
    const sandboxId = this.ctx.id.toString().slice(0, 63);
    const sandbox = getSandbox(this.env.Sandbox, sandboxId);

    try {
      this.send(ws, { type: "text", content: "Starting Claude login...\n" });

      // First, discover available CLI subcommands
      const helpResult = await sandbox.exec("claude --help 2>&1", {
        timeout: 15000,
        env: { HOME: "/home/agent", CLAUDE_NO_AUTO_UPDATE: "1", CI: "1" },
      });
      const helpOutput = (helpResult.stdout ?? "") + (helpResult.stderr ?? "");
      console.log("[login] claude --help output:", helpOutput.slice(0, 1000));
      this.send(ws, { type: "text", content: "CLI help:\n" + helpOutput + "\n\n" });

      // Try multiple login approaches
      // 1. `echo "/login" | claude` — pipe /login into interactive REPL
      // 2. `claude auth login` — if auth subcommand exists
      let tunnelUrl: string | null = null;
      let localhostPort: string | null = null;

      const loginCmd = helpOutput.includes("auth")
        ? "claude auth login 2>&1"
        : "sh -c 'printf \"/login\\n\" | BROWSER=echo claude 2>&1'";

      this.send(ws, { type: "text", content: "Running: " + loginCmd + "\n" });

      const result = await sandbox.exec(
        loginCmd,
        {
          stream: true,
          timeout: 120000,
          env: {
            HOME: "/home/agent",
            CLAUDE_NO_AUTO_UPDATE: "1",
            DISPLAY: "",
            BROWSER: "echo",
          },
          onOutput: (stream: string, data: string) => {
            console.log(`[login ${stream}]`, data.slice(0, 500));

            // Look for URLs in the output
            const urlMatches = data.match(/https?:\/\/[^\s"'<>]+/g);
            if (urlMatches) {
              for (const url of urlMatches) {
                console.log("[login url found]", url);

                // Check if this is a localhost redirect URL embedded in the auth URL
                // e.g., ...redirect_uri=http%3A%2F%2Flocalhost%3A9876%2F...
                const localhostMatch = url.match(/localhost[:%]3A?(\d+)/i)
                  || data.match(/localhost:(\d+)/);
                if (localhostMatch && !localhostPort) {
                  localhostPort = localhostMatch[1];
                  console.log("[login] detected localhost callback port:", localhostPort);
                  // Start a cloudflared tunnel for the callback port
                  // We'll do this asynchronously — the tunnel needs to be up before user completes auth
                  this.startCallbackTunnel(sandbox, localhostPort, ws).then(tUrl => {
                    if (tUrl) {
                      tunnelUrl = tUrl;
                      // Rewrite the auth URL to use the tunnel instead of localhost
                      const rewritten = url.replace(
                        /http(s?):\/\/localhost(:\d+|%3A\d+)/gi,
                        tunnelUrl
                      );
                      console.log("[login] rewritten auth URL:", rewritten.slice(0, 100));
                      this.send(ws, { type: "login_url", url: rewritten });
                      this.send(ws, { type: "text", content: "\nAuth URL ready — check the popup or click the link above.\n" });
                    }
                  });
                }

                // If it's a direct auth URL (no localhost redirect, e.g. device code flow)
                if ((url.includes("anthropic") || url.includes("claude") || url.includes("oauth"))
                    && !url.includes("localhost")) {
                  this.send(ws, { type: "login_url", url });
                  this.send(ws, { type: "text", content: "\nAuth URL ready — check the popup or click the link above.\n" });
                }
              }
            }

            // Forward other output as text
            if (!urlMatches) {
              this.send(ws, { type: "text", content: data });
            }
          },
        }
      );

      console.log("[login result]", JSON.stringify({ exitCode: result.exitCode, success: result.success }));

      // Kill the tunnel if we started one
      if (localhostPort) {
        await sandbox.exec("pkill -f cloudflared || true", {
          timeout: 5000,
          env: { HOME: "/home/agent" },
        }).catch(() => {});
      }

      if (result.success) {
        this.authenticated = true;
        this.send(ws, { type: "login_success" });
        this.send(ws, { type: "text", content: "\nAuthenticated! You can now send messages.\n" });
      } else {
        this.send(ws, { type: "error", message: `Login exited with code ${result.exitCode}. You can still paste a token manually.` });
      }
    } catch (err) {
      console.error("[login error]", err);
      this.send(ws, { type: "error", message: `Login error: ${String(err)}` });
    }

    this.loginInProgress = false;
    this.send(ws, { type: "done" });
  }

  private async startCallbackTunnel(
    sandbox: ReturnType<typeof getSandbox>,
    port: string,
    ws: WebSocket
  ): Promise<string | null> {
    // Start cloudflared tunnel for the OAuth callback port
    // The tunnel output contains the public URL
    this.send(ws, { type: "text", content: `Setting up auth tunnel on port ${port}...\n` });

    try {
      const tunnelResult = await sandbox.exec(
        `sh -c 'cloudflared tunnel --url http://localhost:${port} --no-autoupdate 2>&1 & sleep 5 && grep -o "https://[^ ]*\\.trycloudflare\\.com" /proc/$(pgrep -f cloudflared | head -1)/fd/2 2>/dev/null || curl -s http://localhost:${port} > /dev/null && echo "tunnel_ready"'`,
        {
          stream: true,
          timeout: 30000,
          env: { HOME: "/home/agent" },
          onOutput: (stream: string, data: string) => {
            console.log(`[tunnel ${stream}]`, data.slice(0, 300));
            const match = data.match(/https:\/\/[^\s]*\.trycloudflare\.com/);
            if (match) {
              console.log("[tunnel] got URL:", match[0]);
            }
          },
        }
      );

      // Parse the tunnel URL from output
      const stdout = tunnelResult.stdout ?? "";
      const stderr = tunnelResult.stderr ?? "";
      const combined = stdout + stderr;
      const match = combined.match(/https:\/\/[^\s]*\.trycloudflare\.com/);
      if (match) {
        return match[0];
      }
    } catch (err) {
      console.error("[tunnel error]", err);
    }

    // Fallback: start tunnel in background and poll for URL
    try {
      await sandbox.exec(
        `sh -c 'nohup cloudflared tunnel --url http://localhost:${port} --no-autoupdate > /tmp/tunnel.log 2>&1 &'`,
        { timeout: 5000, env: { HOME: "/home/agent" } }
      );
      // Wait a bit then check the log
      await new Promise(r => setTimeout(r, 4000));
      const logResult = await sandbox.exec("cat /tmp/tunnel.log", {
        timeout: 5000,
        env: { HOME: "/home/agent" },
      });
      const logOutput = logResult.stdout ?? "";
      const match = logOutput.match(/https:\/\/[^\s]*\.trycloudflare\.com/);
      if (match) return match[0];
    } catch (err) {
      console.error("[tunnel fallback error]", err);
    }

    this.send(ws, { type: "text", content: "Could not set up tunnel for OAuth callback. Try pasting a token instead.\n" });
    return null;
  }

  private async hashToken(token: string): Promise<string> {
    const data = new TextEncoder().encode(token);
    const hash = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  private async handleEvent(ws: WebSocket, event: Record<string, unknown>) {
    // Capture session ID for conversation continuity across turns
    if (event.type === "system" && event.subtype === "init") {
      const id = event.session_id as string;
      if (id) await this.ctx.storage.put("sessionId", id);
    }

    // Stream text chunks to client as they arrive
    if (event.type === "stream_event") {
      const e = event.event as Record<string, unknown>;
      if (
        e?.type === "content_block_delta" &&
        (e.delta as Record<string, unknown>)?.type === "text_delta"
      ) {
        this.send(ws, {
          type: "text",
          content: ((e.delta as Record<string, unknown>).text as string) ?? "",
        });
      }
    }

    // Show tool calls (Claude Code executes these internally in the container)
    if (event.type === "assistant") {
      const content = (event.message as Record<string, unknown>)?.content as unknown[];
      for (const block of content ?? []) {
        const b = block as Record<string, unknown>;
        if (b.type === "tool_use") {
          this.send(ws, { type: "tool_start", name: b.name as string, input: b.input });
        }
      }
    }

    // Show tool results
    if (event.type === "user") {
      const content = (event.message as Record<string, unknown>)?.content as unknown[];
      for (const block of content ?? []) {
        const b = block as Record<string, unknown>;
        if (b.type === "tool_result") {
          const output = Array.isArray(b.content)
            ? (b.content as Record<string, unknown>[]).map((c) => c.text ?? "").join("")
            : String(b.content ?? "");
          this.send(ws, { type: "tool_output", name: "result", output });
        }
      }
    }
  }
}

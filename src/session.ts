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

    if (msg.type === "terminal_input") {
      await this.sendTerminalInput(msg.data);
      return;
    }

    if (msg.type === "terminal_close") {
      await this.closeTerminal();
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

  private terminalTimeout: ReturnType<typeof setTimeout> | null = null;

  private async runLogin(ws: WebSocket) {
    this.loginInProgress = true;
    const sandboxId = this.ctx.id.toString().slice(0, 63);
    const sandbox = getSandbox(this.env.Sandbox, sandboxId);
    const env = { HOME: "/home/agent", CLAUDE_NO_AUTO_UPDATE: "1" };

    // 3-minute safety timeout
    this.terminalTimeout = setTimeout(() => this.closeTerminal(), 180000);

    try {
      // Create FIFO for stdin + keep-alive writer so it doesn't block
      await sandbox.exec(
        "rm -f /tmp/term_in; mkfifo /tmp/term_in; sleep 300 > /tmp/term_in &",
        { timeout: 5000, env }
      );

      // Run `claude login` via script(1) for pty, streaming output directly.
      // Buffer output for 50ms to avoid splitting ANSI escape sequences
      // across multiple WebSocket messages (causes screen tearing in xterm.js).
      let outputBuffer = "";
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      const flushOutput = () => {
        if (outputBuffer && this.loginInProgress) {
          this.send(ws, { type: "terminal_output", data: outputBuffer });
          outputBuffer = "";
        }
        flushTimer = null;
      };

      sandbox.exec(
        "script -qfc 'claude login' /dev/null < /tmp/term_in",
        {
          stream: true,
          timeout: 180000,
          env: { ...env, BROWSER: "echo", TERM: "xterm-256color" },
          onOutput: (_stream: string, data: string) => {
            if (!this.loginInProgress) return;
            outputBuffer += data;
            if (!flushTimer) flushTimer = setTimeout(flushOutput, 50);
          },
        }
      ).then(async (result) => {
        // Process exited — verify auth
        console.log("[login] exited:", result.exitCode);
        if (!this.loginInProgress) return;
        await this.verifyAndFinishLogin(ws, sandbox, env);
      }).catch((err) => {
        console.error("[login exec error]", err);
        if (this.loginInProgress) {
          this.send(ws, { type: "error", message: `Login error: ${String(err)}` });
          this.closeTerminal();
        }
      });

    } catch (err) {
      console.error("[login error]", err);
      this.send(ws, { type: "error", message: `Login error: ${String(err)}` });
      this.send(ws, { type: "done" });
      this.loginInProgress = false;
    }
  }

  private async sendTerminalInput(data: string) {
    const sandboxId = this.ctx.id.toString().slice(0, 63);
    const sandbox = getSandbox(this.env.Sandbox, sandboxId);
    const env = { HOME: "/home/agent", CLAUDE_NO_AUTO_UPDATE: "1" };

    try {
      // Write raw keystrokes to the FIFO → script(1) → claude login stdin
      await sandbox.writeFile("/tmp/term_key", data);
      await sandbox.exec("cat /tmp/term_key > /tmp/term_in", { timeout: 5000, env });
    } catch (err) {
      console.error("[terminal input error]", err);
    }
  }

  private async verifyAndFinishLogin(ws: WebSocket, sandbox: ReturnType<typeof getSandbox>, env: Record<string, string>) {
    try {
      const result = await sandbox.exec(
        "sh -c 'echo hi | timeout 15 claude -p --output-format text 2>&1 | head -3'",
        { timeout: 20000, env: { ...env, CI: "1" } }
      );
      const out = (result.stdout ?? "") + (result.stderr ?? "");
      console.log("[login verify]", out.slice(0, 200));

      if (result.success && !out.includes("Not logged in") && !out.includes("/login")) {
        this.authenticated = true;
        this.send(ws, { type: "login_success" });
      }
    } catch {}

    this.send(ws, { type: "terminal_exit", code: 0 });
    this.closeTerminal();
  }

  private async closeTerminal() {
    if (this.terminalTimeout) {
      clearTimeout(this.terminalTimeout);
      this.terminalTimeout = null;
    }
    this.loginInProgress = false;

    const sandboxId = this.ctx.id.toString().slice(0, 63);
    const sandbox = getSandbox(this.env.Sandbox, sandboxId);
    const env = { HOME: "/home/agent", CLAUDE_NO_AUTO_UPDATE: "1" };
    await sandbox.exec(
      "pkill -f 'claude login' 2>/dev/null; pkill -f 'sleep 300' 2>/dev/null; rm -f /tmp/term_in /tmp/term_key",
      { timeout: 5000, env }
    ).catch(() => {});

    for (const ws of this.ctx.getWebSockets()) {
      this.send(ws, { type: "done" });
    }
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

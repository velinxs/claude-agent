import { DurableObject } from "cloudflare:workers";
import { getSandbox } from "@cloudflare/sandbox";
import type { Env, ServerMessage, ClientMessage } from "./types";

export class AgentSession extends DurableObject<Env> {
  private interrupted = false;
  private mounted = false;

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

    if (msg.type === "ping") return;

    if (msg.type === "interrupt") {
      this.interrupted = true;
      return;
    }

    if (msg.type === "message") {
      this.interrupted = false;
      await this.runAgent(ws, msg.content, msg.token, msg.model ?? "claude-sonnet-4-6", msg.runtime ?? "claude");
    }
  }

  async webSocketClose() {}
  async webSocketError() {}

  private send(ws: WebSocket, msg: ServerMessage) {
    ws.send(JSON.stringify(msg));
  }

  private async mountStorage(sandbox: ReturnType<typeof getSandbox>, token?: string) {
    if (this.mounted || !this.env.R2_ENDPOINT) return;
    try {
      const prefix = token
        ? `users/${await this.hashToken(token)}/`
        : `sessions/${this.ctx.id.toString().slice(0, 32)}/`;
      await sandbox.mountBucket("agent-storage", "/home/agent/persistent", {
        endpoint: this.env.R2_ENDPOINT,
        prefix,
      });
      this.mounted = true;
      console.log("[r2] mounted with prefix", prefix.slice(0, 30));
    } catch (err) {
      console.error("[r2 mount error]", err);
    }
  }

  private async runAgent(ws: WebSocket, userMessage: string, token: string | undefined, model: string, runtime: string) {
    const sandboxId = this.ctx.id.toString().slice(0, 63);
    const sandbox = getSandbox(this.env.Sandbox, sandboxId);

    // Mount R2 FUSE storage for persistence across sessions
    await this.mountStorage(sandbox, token);

    if (runtime === "ironclaw") {
      await this.runIronClaw(ws, sandbox, userMessage, token, model);
    } else {
      await this.runClaudeCLI(ws, sandbox, userMessage, token, model);
    }

    this.send(ws, { type: "done" });
  }

  // --- IronClaw runtime (model-agnostic) ---
  private async runIronClaw(
    ws: WebSocket,
    sandbox: ReturnType<typeof getSandbox>,
    userMessage: string,
    token: string | undefined,
    model: string
  ) {
    const msgFile = `/tmp/msg_${Date.now()}.txt`;
    await sandbox.writeFile(msgFile, userMessage);

    // Map model names to IronClaw LLM backend + model
    const { backend, modelName } = this.mapModel(model);

    const env: Record<string, string> = {
      HOME: "/home/agent",
      IRONCLAW_DATA_DIR: "/home/agent/persistent",
      LLM_BACKEND: backend,
      LLM_MODEL: modelName,
      SANDBOX_ENABLED: "true",
      NEAR_ENABLED: "false",
    };

    // Set API key based on backend
    if (token) {
      if (backend === "anthropic") env.ANTHROPIC_API_KEY = token;
      else if (backend === "openai") env.OPENAI_API_KEY = token;
      else if (backend === "openai_compatible") env.OPENAI_API_KEY = token;
      else env.LLM_API_KEY = token;
    }

    // Note: user message is written to a file and read via cat to avoid
    // shell injection. The sandbox.writeFile + cat pattern is safe.
    const command = `sh -c 'ironclaw chat --message "$(cat ${msgFile})" --output json 2>&1'`;

    try {
      let outputBuffer = "";
      const result = await sandbox.exec(command, {
        stream: true,
        timeout: 120000,
        env,
        onOutput: (_stream: string, data: string) => {
          if (this.interrupted) return;
          outputBuffer += data;

          const lines = outputBuffer.split("\n");
          outputBuffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line);
              this.handleIronClawEvent(ws, event);
            } catch {
              this.send(ws, { type: "text", content: line + "\n" });
            }
          }
        },
      });

      if (outputBuffer.trim()) {
        try {
          this.handleIronClawEvent(ws, JSON.parse(outputBuffer));
        } catch {
          if (outputBuffer.trim()) this.send(ws, { type: "text", content: outputBuffer });
        }
      }

      if (!result.success) {
        this.send(ws, { type: "error", message: `ironclaw exited with code ${result.exitCode}` });
      }
    } catch (err) {
      this.send(ws, { type: "error", message: String(err) });
    }
  }

  private handleIronClawEvent(ws: WebSocket, event: Record<string, unknown>) {
    if (event.type === "text" || event.type === "response") {
      this.send(ws, { type: "text", content: (event.content ?? event.text ?? "") as string });
    }
    if (event.type === "tool_call" || event.type === "tool_use") {
      this.send(ws, { type: "tool_start", name: (event.name ?? event.tool) as string, input: event.input ?? event.args });
    }
    if (event.type === "tool_result") {
      this.send(ws, { type: "tool_output", name: (event.name ?? "result") as string, output: String(event.output ?? event.result ?? "") });
    }
    if (event.type === "delta" || event.type === "chunk") {
      this.send(ws, { type: "text", content: (event.content ?? event.text ?? "") as string });
    }
  }

  private mapModel(model: string): { backend: string; modelName: string } {
    if (model.includes("claude") || model.includes("sonnet") || model.includes("opus") || model.includes("haiku")) {
      return { backend: "anthropic", modelName: model };
    }
    if (model.includes("gpt") || model.includes("o1") || model.includes("o3")) {
      return { backend: "openai", modelName: model };
    }
    if (model.includes("gemini")) {
      return { backend: "openai_compatible", modelName: model };
    }
    if (model.includes("llama") || model.includes("mistral") || model.includes("codellama")) {
      return { backend: "ollama", modelName: model };
    }
    return { backend: "openai_compatible", modelName: model };
  }

  // --- Claude CLI runtime (direct mode) ---
  private async runClaudeCLI(
    ws: WebSocket,
    sandbox: ReturnType<typeof getSandbox>,
    userMessage: string,
    token: string | undefined,
    model: string
  ) {
    const savedSessionId = await this.ctx.storage.get<string>("sessionId");
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

    // Message is read from a file via stdin redirect to avoid shell injection
    const command = `sh -c '${claudeCmd} < ${msgFile}'`;
    let lineBuffer = "";

    const env: Record<string, string> = {
      CLAUDE_NO_AUTO_UPDATE: "1",
      CI: "1",
      HOME: "/home/agent",
    };
    if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;

    try {
      const result = await sandbox.exec(command, {
        stream: true,
        timeout: 120000,
        env,
        onOutput: (_stream: string, data: string) => {
          if (this.interrupted) return;
          lineBuffer += data;
          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              this.handleClaudeEvent(ws, JSON.parse(line));
            } catch {
              console.log("[non-json]", line.slice(0, 200));
            }
          }
        },
      });

      if (lineBuffer.trim()) {
        try { this.handleClaudeEvent(ws, JSON.parse(lineBuffer)); } catch {}
      }
      if (!result.success) {
        this.send(ws, { type: "error", message: `claude exited with code ${result.exitCode}` });
      }
    } catch (err) {
      this.send(ws, { type: "error", message: String(err) });
    }
  }

  private async handleClaudeEvent(ws: WebSocket, event: Record<string, unknown>) {
    if (event.type === "system" && event.subtype === "init") {
      const id = event.session_id as string;
      if (id) await this.ctx.storage.put("sessionId", id);
    }
    if (event.type === "stream_event") {
      const e = event.event as Record<string, unknown>;
      if (e?.type === "content_block_delta" && (e.delta as Record<string, unknown>)?.type === "text_delta") {
        this.send(ws, { type: "text", content: ((e.delta as Record<string, unknown>).text as string) ?? "" });
      }
    }
    if (event.type === "assistant") {
      const content = (event.message as Record<string, unknown>)?.content as unknown[];
      for (const block of content ?? []) {
        const b = block as Record<string, unknown>;
        if (b.type === "tool_use") {
          this.send(ws, { type: "tool_start", name: b.name as string, input: b.input });
        }
      }
    }
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

  private async hashToken(token: string): Promise<string> {
    const data = new TextEncoder().encode(token);
    const hash = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
}

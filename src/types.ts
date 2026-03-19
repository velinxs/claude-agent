import type { Sandbox } from "@cloudflare/sandbox";

// Messages from client → server (WebSocket for CF Sandbox mode)
export type ClientMessage =
  | { type: "message"; content: string; token?: string; model?: string; runtime?: string }
  | { type: "interrupt" }
  | { type: "reset" }
  | { type: "login" }
  | { type: "terminal_input"; data: string }
  | { type: "terminal_close" }
  | { type: "ping" };

// Messages from server → client
export type ServerMessage =
  | { type: "text"; content: string }
  | { type: "tool_start"; name: string; input: unknown }
  | { type: "tool_output"; name: string; output: string }
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: "terminal_output"; data: string }
  | { type: "terminal_exit"; code: number }
  | { type: "login_success" }
  | { type: "login_status"; authenticated: boolean };

export interface Env {
  AGENT_SESSION: DurableObjectNamespace;
  Sandbox: DurableObjectNamespace<Sandbox>;
  ASSETS: Fetcher;
  AGENT_STORAGE: R2Bucket;
  R2_ENDPOINT?: string;
  // GCP OAuth (set via wrangler secret)
  GCP_CLIENT_ID?: string;
  GCP_CLIENT_SECRET?: string;
}

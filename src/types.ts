import type { Sandbox } from "@cloudflare/sandbox";

// Messages from client → server
export type ClientMessage =
  | { type: "message"; content: string; token?: string; model?: string }
  | { type: "interrupt" }
  | { type: "reset" }
  | { type: "login" }
  | { type: "ping" };

// Messages from server → client
export type ServerMessage =
  | { type: "text"; content: string }
  | { type: "tool_start"; name: string; input: unknown }
  | { type: "tool_output"; name: string; output: string }
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: "login_url"; url: string }
  | { type: "login_success" }
  | { type: "login_status"; authenticated: boolean };

export interface Env {
  AGENT_SESSION: DurableObjectNamespace;
  Sandbox: DurableObjectNamespace<Sandbox>;
  ASSETS: Fetcher;
  AGENT_STORAGE: R2Bucket;
  R2_ENDPOINT?: string;
}

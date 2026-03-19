import type { Env } from "./types";

export { AgentSession } from "./session";
export { Sandbox } from "@cloudflare/sandbox";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      const upgradeHeader = request.headers.get("Upgrade");
      if (upgradeHeader !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }

      const sessionId = url.searchParams.get("session") ?? crypto.randomUUID();
      const stub = env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(sessionId));
      const res = await stub.fetch(request);

      const headers = new Headers(res.headers);
      headers.set("X-Session-Id", sessionId);
      return new Response(res.body, {
        status: res.status,
        webSocket: (res as unknown as { webSocket: WebSocket }).webSocket,
        headers,
      });
    }

    if (url.pathname === "/health") {
      return Response.json({ status: "ok", version: "0.1.0" });
    }

    // Serve static assets (public/ directory)
    return env.ASSETS.fetch(request);
  },
};

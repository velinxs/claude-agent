import type { Env } from "./types";
import { GCPProvider, getGCPAuthUrl, exchangeGCPCode, listGCPProjects } from "./providers/gcp";

export { AgentSession } from "./session";
export { Sandbox } from "@cloudflare/sandbox";

const gcp = new GCPProvider();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // --- WebSocket for CF Sandbox mode (existing) ---
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

    // --- API Routes ---

    if (url.pathname === "/api/health") {
      return Response.json({ status: "ok", version: "0.2.0" });
    }

    // GCP OAuth: initiate
    if (url.pathname === "/api/auth/gcp") {
      if (!env.GCP_CLIENT_ID) {
        return Response.json({ error: "GCP OAuth not configured" }, { status: 500 });
      }
      const state = crypto.randomUUID();
      const redirectUri = `${url.origin}/api/auth/gcp/callback`;
      const authUrl = getGCPAuthUrl(env.GCP_CLIENT_ID, redirectUri, state);
      return Response.json({ url: authUrl, state });
    }

    // GCP OAuth: callback
    if (url.pathname === "/api/auth/gcp/callback") {
      const code = url.searchParams.get("code");
      if (!code || !env.GCP_CLIENT_ID || !env.GCP_CLIENT_SECRET) {
        return new Response("Missing code or config", { status: 400 });
      }
      try {
        const redirectUri = `${url.origin}/api/auth/gcp/callback`;
        const tokens = await exchangeGCPCode(code, env.GCP_CLIENT_ID, env.GCP_CLIENT_SECRET, redirectUri);
        // Return tokens to the frontend via postMessage (popup flow)
        return new Response(
          `<!DOCTYPE html><html><body><script>
            window.opener.postMessage(${JSON.stringify({ type: "gcp_auth", ...tokens })}, "*");
            window.close();
          </script></body></html>`,
          { headers: { "Content-Type": "text/html" } }
        );
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }

    // List GCP projects
    if (url.pathname === "/api/gcp/projects" && request.method === "GET") {
      const token = request.headers.get("Authorization")?.replace("Bearer ", "");
      if (!token) return Response.json({ error: "No token" }, { status: 401 });
      const projects = await listGCPProjects(token);
      return Response.json({ projects });
    }

    // Provision a VM
    if (url.pathname === "/api/provision" && request.method === "POST") {
      const token = request.headers.get("Authorization")?.replace("Bearer ", "");
      if (!token) return Response.json({ error: "No token" }, { status: 401 });
      try {
        const body = (await request.json()) as { project: string; zone?: string; machineType?: string };
        const instance = await gcp.provision({
          accessToken: token,
          project: body.project,
          zone: body.zone,
          machineType: body.machineType,
        });
        return Response.json({ instance });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }

    // Get VM status (poll for tunnel URL)
    if (url.pathname.startsWith("/api/status/") && request.method === "GET") {
      const token = request.headers.get("Authorization")?.replace("Bearer ", "");
      if (!token) return Response.json({ error: "No token" }, { status: 401 });
      const instanceId = url.pathname.split("/api/status/")[1];
      const project = url.searchParams.get("project") ?? "";
      const zone = url.searchParams.get("zone") ?? "us-central1-a";
      try {
        const status = await gcp.getStatus({ accessToken: token, project, instanceId, zone });
        return Response.json({ instance: status });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }

    // Terminate a VM
    if (url.pathname.startsWith("/api/terminate/") && request.method === "DELETE") {
      const token = request.headers.get("Authorization")?.replace("Bearer ", "");
      if (!token) return Response.json({ error: "No token" }, { status: 401 });
      const instanceId = url.pathname.split("/api/terminate/")[1];
      const project = url.searchParams.get("project") ?? "";
      const zone = url.searchParams.get("zone") ?? "us-central1-a";
      try {
        await gcp.terminate({ accessToken: token, project, instanceId, zone });
        return Response.json({ ok: true });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }

    // Health check (legacy)
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", version: "0.2.0" });
    }

    // Serve static assets
    return env.ASSETS.fetch(request);
  },
};

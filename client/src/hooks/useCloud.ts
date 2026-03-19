import { useState, useCallback, useRef } from "preact/hooks";

interface GCPProject {
  projectId: string;
  name: string;
}

interface AgentInstance {
  id: string;
  provider: string;
  status: "provisioning" | "running" | "ready" | "error" | "stopped";
  tunnelUrl?: string;
  authToken?: string;
  region?: string;
}

export type CloudState =
  | { step: "disconnected" }
  | { step: "authenticating" }
  | { step: "selecting_project"; projects: GCPProject[] }
  | { step: "provisioning"; instanceId: string; project: string; zone: string }
  | { step: "ready"; instance: AgentInstance }
  | { step: "error"; message: string };

export function useCloud() {
  const [state, setState] = useState<CloudState>({ step: "disconnected" });
  const tokenRef = useRef<string>("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const connectGCP = useCallback(async () => {
    setState({ step: "authenticating" });
    try {
      // Get OAuth URL from our API
      const res = await fetch("/api/auth/gcp");
      const { url } = await res.json() as { url: string };

      // Open popup for OAuth
      const popup = window.open(url, "gcp_auth", "width=500,height=700");

      // Listen for the callback
      const handler = async (e: MessageEvent) => {
        if (e.data?.type !== "gcp_auth") return;
        window.removeEventListener("message", handler);
        popup?.close();

        tokenRef.current = e.data.access_token;
        localStorage.setItem("gcp_token", e.data.access_token);
        if (e.data.refresh_token) {
          localStorage.setItem("gcp_refresh_token", e.data.refresh_token);
        }

        // Fetch projects
        const projRes = await fetch("/api/gcp/projects", {
          headers: { Authorization: `Bearer ${tokenRef.current}` },
        });
        const { projects } = await projRes.json() as { projects: GCPProject[] };
        setState({ step: "selecting_project", projects });
      };
      window.addEventListener("message", handler);
    } catch (err) {
      setState({ step: "error", message: String(err) });
    }
  }, []);

  const selectProject = useCallback(async (projectId: string, zone = "us-central1-a") => {
    setState({ step: "provisioning", instanceId: "", project: projectId, zone });
    try {
      const res = await fetch("/api/provision", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenRef.current}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ project: projectId, zone }),
      });

      if (!res.ok) {
        const err = await res.json() as { error: string };
        setState({ step: "error", message: err.error });
        return;
      }

      const { instance } = await res.json() as { instance: AgentInstance };
      setState({ step: "provisioning", instanceId: instance.id, project: projectId, zone });

      // Poll for ready status
      pollRef.current = setInterval(async () => {
        try {
          const statusRes = await fetch(
            `/api/status/${instance.id}?project=${projectId}&zone=${zone}`,
            { headers: { Authorization: `Bearer ${tokenRef.current}` } }
          );
          const { instance: updated } = await statusRes.json() as { instance: AgentInstance };

          if (updated.status === "ready" && updated.tunnelUrl) {
            if (pollRef.current) clearInterval(pollRef.current);
            setState({ step: "ready", instance: updated });
          } else if (updated.status === "error") {
            if (pollRef.current) clearInterval(pollRef.current);
            setState({ step: "error", message: "VM setup failed" });
          }
        } catch {}
      }, 5000);
    } catch (err) {
      setState({ step: "error", message: String(err) });
    }
  }, []);

  const disconnect = useCallback(async () => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (state.step === "ready" || state.step === "provisioning") {
      const s = state as { instanceId?: string; project?: string; zone?: string; instance?: AgentInstance };
      const id = s.instance?.id ?? s.instanceId;
      const project = (s as { project?: string }).project ?? "";
      const zone = (s as { zone?: string }).zone ?? "us-central1-a";
      if (id && project) {
        await fetch(`/api/terminate/${id}?project=${project}&zone=${zone}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${tokenRef.current}` },
        }).catch(() => {});
      }
    }
    setState({ step: "disconnected" });
  }, [state]);

  return { state, connectGCP, selectProject, disconnect };
}

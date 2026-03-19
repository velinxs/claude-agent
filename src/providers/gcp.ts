import type { CloudProvider, AgentInstance, ProvisionOptions } from "./types";
import { STARTUP_SCRIPT } from "./startup";

const GCP_COMPUTE_BASE = "https://compute.googleapis.com/compute/v1";

export class GCPProvider implements CloudProvider {
  name = "gcp";

  async provision(opts: ProvisionOptions): Promise<AgentInstance> {
    const zone = opts.zone ?? "us-central1-a";
    const machineType = opts.machineType ?? "e2-small";
    const instanceName = `agent-${Date.now().toString(36)}`;
    const bucketName = `agent-storage-${opts.project}-${opts.userId ?? "default"}`;

    const url = `${GCP_COMPUTE_BASE}/projects/${opts.project}/zones/${zone}/instances`;

    const body = {
      name: instanceName,
      machineType: `zones/${zone}/machineTypes/${machineType}`,
      disks: [
        {
          boot: true,
          autoDelete: true,
          initializeParams: {
            sourceImage: "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64",
            diskSizeGb: "20",
          },
        },
      ],
      networkInterfaces: [
        {
          network: "global/networks/default",
          accessConfigs: [{ type: "ONE_TO_ONE_NAT", name: "External NAT" }],
        },
      ],
      metadata: {
        items: [
          { key: "startup-script", value: STARTUP_SCRIPT },
          { key: "agent-status", value: "provisioning" },
          { key: "bucket-name", value: bucketName },
          { key: "user-id", value: opts.userId ?? "default" },
          { key: "drive-token", value: JSON.stringify({ access_token: opts.accessToken, token_type: "Bearer" }) },
        ],
      },
      tags: { items: ["agent-vm"] },
      serviceAccounts: [
        {
          email: "default",
          scopes: [
            "https://www.googleapis.com/auth/compute",
            "https://www.googleapis.com/auth/devstorage.full_control",
            "https://www.googleapis.com/auth/logging.write",
          ],
        },
      ],
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`GCP instance creation failed: ${res.status} ${err}`);
    }

    return {
      id: instanceName,
      provider: "gcp",
      status: "provisioning",
      region: zone,
      bucketName,
      createdAt: Date.now(),
    };
  }

  async getStatus(opts: {
    accessToken: string;
    project: string;
    instanceId: string;
    zone: string;
  }): Promise<AgentInstance> {
    const url = `${GCP_COMPUTE_BASE}/projects/${opts.project}/zones/${opts.zone}/instances/${opts.instanceId}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${opts.accessToken}` },
    });

    if (!res.ok) {
      return { id: opts.instanceId, provider: "gcp", status: "error", createdAt: 0 };
    }

    const instance = (await res.json()) as {
      status: string;
      metadata?: { items?: Array<{ key: string; value: string }> };
    };

    const metadata = instance.metadata?.items ?? [];
    const get = (key: string) => metadata.find((m) => m.key === key)?.value;

    let status: AgentInstance["status"] = "provisioning";
    if (instance.status === "RUNNING" && get("agent-status") === "ready") status = "ready";
    else if (instance.status === "RUNNING") status = "running";
    else if (instance.status === "TERMINATED" || instance.status === "STOPPED") status = "stopped";
    else if (get("agent-status") === "tunnel_failed") status = "error";

    return {
      id: opts.instanceId,
      provider: "gcp",
      status,
      tunnelUrl: get("tunnel-url"),
      authToken: get("auth-token"),
      bucketName: get("bucket-name"),
      region: opts.zone,
      createdAt: 0,
    };
  }

  async terminate(opts: {
    accessToken: string;
    project: string;
    instanceId: string;
    zone: string;
  }): Promise<void> {
    const url = `${GCP_COMPUTE_BASE}/projects/${opts.project}/zones/${opts.zone}/instances/${opts.instanceId}`;
    await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${opts.accessToken}` },
    });
  }
}

// --- OAuth helpers ---

export function getGCPAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: [
      "https://www.googleapis.com/auth/compute",
      "https://www.googleapis.com/auth/devstorage.full_control",
      "https://www.googleapis.com/auth/cloudplatformprojects.readonly",
      "https://www.googleapis.com/auth/drive",
    ].join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeGCPCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  return res.json() as Promise<{ access_token: string; refresh_token: string; expires_in: number }>;
}

export async function listGCPProjects(
  accessToken: string
): Promise<Array<{ projectId: string; name: string }>> {
  const res = await fetch(
    "https://cloudresourcemanager.googleapis.com/v1/projects?filter=lifecycleState%3DACTIVE",
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) return [];
  const data = (await res.json()) as { projects?: Array<{ projectId: string; name: string }> };
  return data.projects ?? [];
}

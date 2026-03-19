export interface AgentInstance {
  id: string;
  provider: string;
  status: "provisioning" | "running" | "ready" | "error" | "stopped";
  tunnelUrl?: string;
  authToken?: string;
  region?: string;
  createdAt: number;
}

export interface ProvisionOptions {
  accessToken: string;
  project: string;
  zone?: string;
  machineType?: string;
}

export interface CloudProvider {
  name: string;
  provision(opts: ProvisionOptions): Promise<AgentInstance>;
  getStatus(opts: { accessToken: string; project: string; instanceId: string; zone: string }): Promise<AgentInstance>;
  terminate(opts: { accessToken: string; project: string; instanceId: string; zone: string }): Promise<void>;
}

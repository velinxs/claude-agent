import { useState } from "preact/hooks";
import type { CloudState } from "../hooks/useCloud";

interface Props {
  state: CloudState;
  onConnectGCP: () => void;
  onSelectProject: (projectId: string, zone?: string) => void;
  onDisconnect: () => void;
}

export function CloudConnect({ state, onConnectGCP, onSelectProject, onDisconnect }: Props) {
  const [selectedZone, setSelectedZone] = useState("us-central1-a");

  if (state.step === "disconnected") {
    return (
      <div class="cloud-connect">
        <div class="cloud-hero">
          <h2>connect your cloud</h2>
          <p>Your AI agent runs on YOUR infrastructure. Connect a cloud provider to get started.</p>
        </div>
        <div class="cloud-providers">
          <button class="cloud-btn gcp" onClick={onConnectGCP}>
            <span class="cloud-icon">G</span>
            Google Cloud
          </button>
          <button class="cloud-btn aws" disabled title="Coming soon">
            <span class="cloud-icon">A</span>
            AWS
          </button>
          <button class="cloud-btn azure" disabled title="Coming soon">
            <span class="cloud-icon">M</span>
            Azure
          </button>
        </div>
        <p class="cloud-note">You pay your cloud provider directly. We never touch your data or billing.</p>
      </div>
    );
  }

  if (state.step === "authenticating") {
    return (
      <div class="cloud-connect">
        <div class="cloud-status">
          <div class="spinner" />
          <p>Authenticating with Google Cloud...</p>
          <p class="cloud-note">Complete the sign-in in the popup window.</p>
        </div>
      </div>
    );
  }

  if (state.step === "selecting_project") {
    return (
      <div class="cloud-connect">
        <h2>select a project</h2>
        <p>Choose which GCP project to run your agent in.</p>
        <div class="project-list">
          {state.projects.map((p) => (
            <button
              key={p.projectId}
              class="project-btn"
              onClick={() => onSelectProject(p.projectId, selectedZone)}
            >
              <span class="project-name">{p.name}</span>
              <span class="project-id">{p.projectId}</span>
            </button>
          ))}
        </div>
        <div class="zone-select">
          <label>Region: </label>
          <select class="select" value={selectedZone} onChange={(e) => setSelectedZone((e.target as HTMLSelectElement).value)}>
            <option value="us-central1-a">US Central (Iowa)</option>
            <option value="us-east1-b">US East (S. Carolina)</option>
            <option value="us-west1-a">US West (Oregon)</option>
            <option value="europe-west1-b">Europe West (Belgium)</option>
            <option value="asia-east1-a">Asia East (Taiwan)</option>
          </select>
        </div>
      </div>
    );
  }

  if (state.step === "provisioning") {
    return (
      <div class="cloud-connect">
        <div class="cloud-status">
          <div class="spinner" />
          <h2>launching agent</h2>
          <p>Creating VM on your GCP account...</p>
          <p class="cloud-note">
            Instance: {state.instanceId || "creating..."}<br />
            This takes 1-2 minutes. Installing tools + starting terminal.
          </p>
        </div>
      </div>
    );
  }

  if (state.step === "error") {
    return (
      <div class="cloud-connect">
        <div class="cloud-status">
          <h2 style={{ color: "var(--red)" }}>error</h2>
          <p>{state.message}</p>
          <button class="btn" onClick={onDisconnect}>try again</button>
        </div>
      </div>
    );
  }

  return null;
}

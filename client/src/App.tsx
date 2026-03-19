import { useState, useCallback } from "preact/hooks";
import { useCloud } from "./hooks/useCloud";
import { CloudConnect } from "./components/CloudConnect";

export function App() {
  const { state: cloudState, connectGCP, selectProject, disconnect } = useCloud();

  const instance = cloudState.step === "ready" ? cloudState.instance : null;

  // Build ttyd URL with basic auth embedded
  const terminalUrl = instance?.tunnelUrl && instance?.authToken
    ? instance.tunnelUrl
    : null;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <div class="header">
        <div class={`status-dot ${cloudState.step === "ready" ? "connected" : ""}`} />
        <h1>agent</h1>
        {instance && (
          <div class="controls">
            <span style={{ fontSize: "11px", color: "var(--text-faint)" }}>
              {instance.id} / {instance.region}
            </span>
            <button class="btn" style={{ background: "transparent", color: "var(--red)", borderColor: "#7f1d1d", fontSize: "11px", padding: "4px 10px" }} onClick={disconnect}>
              stop
            </button>
          </div>
        )}
      </div>

      {/* Main content */}
      {cloudState.step !== "ready" ? (
        <CloudConnect
          state={cloudState}
          onConnectGCP={connectGCP}
          onSelectProject={selectProject}
          onDisconnect={disconnect}
        />
      ) : terminalUrl ? (
        <iframe
          src={terminalUrl}
          style={{
            flex: 1,
            border: "none",
            background: "#0a0a0a",
            width: "100%",
          }}
          allow="clipboard-read; clipboard-write"
        />
      ) : (
        <div class="cloud-connect">
          <div class="spinner" />
          <p>Connecting to terminal...</p>
        </div>
      )}
    </div>
  );
}

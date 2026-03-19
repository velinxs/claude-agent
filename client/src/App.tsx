import { useState, useCallback, useEffect, useRef } from "preact/hooks";
import { useCloud } from "./hooks/useCloud";
import { CloudConnect } from "./components/CloudConnect";
import { Terminal } from "./components/Terminal";

export function App() {
  const { state: cloudState, connectGCP, selectProject, disconnect } = useCloud();
  const [termReady, setTermReady] = useState(false);
  const dummyCb = useRef<((data: string) => void) | null>(null);

  // When cloud is ready, connect terminal to the ttyd instance
  const instance = cloudState.step === "ready" ? cloudState.instance : null;

  // For the ttyd terminal, we connect directly to the tunnel URL
  // ttyd uses its own WebSocket protocol — we embed it in an iframe
  useEffect(() => {
    if (instance?.tunnelUrl) setTermReady(true);
    else setTermReady(false);
  }, [instance]);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <div class="header">
        <div class={`status-dot ${cloudState.step === "ready" ? "connected" : ""}`} />
        <h1>claude agent</h1>
      </div>

      {/* Connected bar */}
      {instance && (
        <div class="connected-bar">
          <span>connected to {instance.id} ({instance.region})</span>
          <button onClick={disconnect}>disconnect</button>
        </div>
      )}

      {/* Main content */}
      {cloudState.step !== "ready" ? (
        <CloudConnect
          state={cloudState}
          onConnectGCP={connectGCP}
          onSelectProject={selectProject}
          onDisconnect={disconnect}
        />
      ) : instance?.tunnelUrl ? (
        // Embed ttyd directly via iframe — it handles its own xterm.js
        <iframe
          src={`${instance.tunnelUrl}${instance.authToken ? `?arg=agent&arg=${instance.authToken}` : ""}`}
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

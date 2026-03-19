import { useState, useEffect } from "preact/hooks";
import type { ConnectionState } from "../hooks/useWebSocket";

interface Props {
  state: ConnectionState;
  authenticated: boolean;
  onLogin: () => void;
  onTokenChange: (token: string) => void;
  onModelChange: (model: string) => void;
  token: string;
  model: string;
}

export function Header({ state, authenticated, onLogin, onTokenChange, onModelChange, token, model }: Props) {
  const statusClass = state === "working" ? "working" : state === "connected" ? "connected" : "";

  return (
    <div class="header">
      <div class={`status-dot ${statusClass}`} />
      <h1>claude agent</h1>
      <div class="controls">
        <select
          class="select"
          value={model}
          onChange={(e) => onModelChange((e.target as HTMLSelectElement).value)}
        >
          <option value="claude-sonnet-4-6">sonnet 4.6</option>
          <option value="claude-opus-4-6">opus 4.6</option>
          <option value="claude-haiku-4-5-20251001">haiku 4.5</option>
        </select>
        <button
          class={`btn ${authenticated ? "connected" : ""}`}
          onClick={onLogin}
          disabled={state === "working" || authenticated}
        >
          {authenticated ? "connected" : state === "working" ? "connecting..." : "connect"}
        </button>
        <input
          class="token-input"
          type="password"
          placeholder="or paste token..."
          value={token}
          onInput={(e) => onTokenChange((e.target as HTMLInputElement).value)}
        />
      </div>
    </div>
  );
}

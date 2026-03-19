import { useState, useRef } from "preact/hooks";
import type { ConnectionState } from "../hooks/useWebSocket";

interface Props {
  state: ConnectionState;
  authenticated: boolean;
  token: string;
  onSend: (content: string) => void;
  onReset: () => void;
}

export function InputArea({ state, authenticated, token, onSend, onReset }: Props) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  const canSend = state === "connected" && (!!token || authenticated) && value.trim().length > 0;

  function handleSend() {
    if (!canSend) return;
    onSend(value.trim());
    setValue("");
    if (ref.current) ref.current.style.height = "44px";
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleInput(e: Event) {
    const target = e.target as HTMLTextAreaElement;
    setValue(target.value);
    target.style.height = "auto";
    target.style.height = Math.min(target.scrollHeight, 200) + "px";
  }

  return (
    <div class="input-area">
      <button class="reset-btn" onClick={onReset} title="New session">
        /reset
      </button>
      <textarea
        ref={ref}
        class="input-textarea"
        placeholder={
          !token && !authenticated
            ? "Connect first or paste a token..."
            : "Ask anything or give a task..."
        }
        value={value}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        rows={1}
      />
      <button
        class="btn send-btn"
        onClick={handleSend}
        disabled={!canSend}
      >
        {state === "working" ? "working..." : "send"}
      </button>
    </div>
  );
}

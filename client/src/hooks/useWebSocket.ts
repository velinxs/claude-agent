// Minimal WebSocket hook — kept for potential CF Container fallback mode
// Primary mode is now BYOC (GCP VM + ttyd)

import { useState, useEffect, useRef, useCallback } from "preact/hooks";

export type ServerMessage =
  | { type: "text"; content: string }
  | { type: "tool_start"; name: string; input: unknown }
  | { type: "tool_output"; name: string; output: string }
  | { type: "done" }
  | { type: "error"; message: string };

export type ConnectionState = "disconnected" | "connected" | "working";

export function useWebSocket() {
  const [state, setState] = useState<ConnectionState>("disconnected");
  const [messages, setMessages] = useState<ServerMessage[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const connect = useCallback((sessionId: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState <= 1) return;

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${location.host}/ws?session=${encodeURIComponent(sessionId)}`;
    const newWs = new WebSocket(url);

    newWs.onopen = () => {
      setState("connected");
      pingRef.current = setInterval(() => {
        if (newWs.readyState === 1) newWs.send(JSON.stringify({ type: "ping" }));
      }, 30000);
    };

    newWs.onclose = () => {
      setState("disconnected");
      if (pingRef.current) clearInterval(pingRef.current);
    };

    newWs.onmessage = (e) => {
      const msg: ServerMessage = JSON.parse(e.data);
      setMessages((prev) => [...prev, msg]);
      if (msg.type === "done") setState("connected");
      if (msg.type === "error") setState("connected");
    };

    wsRef.current = newWs;
  }, []);

  const send = useCallback((data: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
  }, []);

  return { state, messages, connect, send, setMessages };
}

import { useState, useEffect, useRef, useCallback } from "preact/hooks";

export type ServerMessage =
  | { type: "text"; content: string }
  | { type: "tool_start"; name: string; input: unknown }
  | { type: "tool_output"; name: string; output: string }
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: "terminal_output"; data: string }
  | { type: "terminal_exit"; code: number };

export type ConnectionState = "disconnected" | "connected" | "working";

function getSessionId(): string {
  let id = localStorage.getItem("sessionId");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("sessionId", id);
  }
  return id;
}

export function useWebSocket() {
  const [state, setState] = useState<ConnectionState>("disconnected");
  const [messages, setMessages] = useState<ServerMessage[]>([]);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionIdRef = useRef(getSessionId());
  const terminalDataCb = useRef<((data: string) => void) | null>(null);

  const connect = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState <= 1) return;

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${location.host}/ws?session=${encodeURIComponent(sessionIdRef.current)}`;
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
      setTimeout(connect, 3000);
    };

    newWs.onmessage = (e) => {
      const msg: ServerMessage = JSON.parse(e.data);

      // Terminal data goes directly to xterm callback, not message list
      if (msg.type === "terminal_output") {
        terminalDataCb.current?.(msg.data);
        return;
      }

      if (msg.type === "terminal_exit") {
        setTerminalOpen(false);
        return;
      }

      setMessages((prev) => [...prev, msg]);

      if (msg.type === "done") { setState("connected"); setTerminalOpen(false); }
      if (msg.type === "error") setState("connected");
    };

    wsRef.current = newWs;
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (pingRef.current) clearInterval(pingRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((data: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
  }, []);

  const sendMessage = useCallback(
    (content: string, token?: string, model?: string) => {
      const payload: Record<string, unknown> = { type: "message", content };
      if (token) payload.token = token;
      if (model) payload.model = model;
      send(payload);
      setState("working");
    },
    [send]
  );

  const sendLogin = useCallback(() => {
    send({ type: "login" });
    setState("working");
    setTerminalOpen(true);
  }, [send]);

  const sendTerminalInput = useCallback(
    (data: string) => send({ type: "terminal_input", data }),
    [send]
  );

  const closeTerminal = useCallback(() => {
    send({ type: "terminal_close" });
    setTerminalOpen(false);
  }, [send]);

  const reset = useCallback(() => {
    send({ type: "reset" });
    setMessages([]);
    sessionIdRef.current = crypto.randomUUID();
    localStorage.setItem("sessionId", sessionIdRef.current);
    setState("connected");
  }, [send]);

  // Register callback for terminal data
  const onTerminalData = useCallback((cb: ((data: string) => void) | null) => {
    terminalDataCb.current = cb;
  }, []);

  return {
    state, messages, authenticated, terminalOpen,
    sendMessage, sendLogin, sendTerminalInput, closeTerminal,
    reset, onTerminalData,
  };
}

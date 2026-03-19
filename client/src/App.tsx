import { useState, useCallback, useRef } from "preact/hooks";
import { useWebSocket } from "./hooks/useWebSocket";
import { Header } from "./components/Header";
import { MessageList } from "./components/MessageList";
import { InputArea } from "./components/InputArea";

export function App() {
  const { state, messages, authenticated, sendMessage, sendLogin, reset } = useWebSocket();
  const [token, setToken] = useState(() => localStorage.getItem("token") || "");
  const [model, setModel] = useState(() => localStorage.getItem("model") || "claude-sonnet-4-6");
  const [userMessages, setUserMessages] = useState<string[]>([]);

  const handleTokenChange = useCallback((t: string) => {
    setToken(t);
    localStorage.setItem("token", t);
  }, []);

  const handleModelChange = useCallback((m: string) => {
    setModel(m);
    localStorage.setItem("model", m);
  }, []);

  const handleSend = useCallback(
    (content: string) => {
      setUserMessages((prev) => [...prev, content]);
      sendMessage(content, token || undefined, model);
    },
    [token, model, sendMessage]
  );

  const handleReset = useCallback(() => {
    setUserMessages([]);
    reset();
  }, [reset]);

  const handleLogin = useCallback(() => {
    if (state === "working" || authenticated) return;
    sendLogin();
  }, [state, authenticated, sendLogin]);

  return (
    <>
      <Header
        state={state}
        authenticated={authenticated}
        onLogin={handleLogin}
        onTokenChange={handleTokenChange}
        onModelChange={handleModelChange}
        token={token}
        model={model}
      />
      <MessageList messages={messages} userMessages={userMessages} />
      <InputArea
        state={state}
        authenticated={authenticated}
        token={token}
        onSend={handleSend}
        onReset={handleReset}
      />
    </>
  );
}

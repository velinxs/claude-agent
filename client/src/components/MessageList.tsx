import { useEffect, useRef, useMemo } from "preact/hooks";
import type { ServerMessage } from "../hooks/useWebSocket";
import { ToolBlock } from "./ToolBlock";

interface Props {
  messages: ServerMessage[];
  userMessages: string[];
}

interface DisplayMessage {
  type: "user" | "assistant" | "error" | "tool";
  content: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: string;
  toolRunning?: boolean;
}

export function MessageList({ messages, userMessages }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  const displayMessages = useMemo(() => {
    const result: DisplayMessage[] = [];
    let userIdx = 0;
    let currentText = "";

    for (const msg of messages) {
      if (msg.type === "text") {
        // If there's no current assistant message, check if we need a user message first
        if (currentText === "" && userIdx < userMessages.length) {
          // Check if this is a fresh response (after a done or at start)
          const lastResult = result[result.length - 1];
          if (!lastResult || lastResult.type !== "assistant") {
            result.push({ type: "user", content: userMessages[userIdx] });
            userIdx++;
          }
        }
        currentText += msg.content;
        // Update or create the current assistant message
        const last = result[result.length - 1];
        if (last?.type === "assistant") {
          last.content = currentText;
        } else {
          result.push({ type: "assistant", content: currentText });
        }
      }

      if (msg.type === "tool_start") {
        // Flush current text
        currentText = "";
        result.push({
          type: "tool",
          content: "",
          toolName: msg.name,
          toolInput: msg.input,
          toolRunning: true,
        });
      }

      if (msg.type === "tool_output") {
        // Find the last running tool and mark it done
        for (let i = result.length - 1; i >= 0; i--) {
          if (result[i].type === "tool" && result[i].toolRunning) {
            result[i].toolRunning = false;
            result[i].toolOutput = msg.output;
            break;
          }
        }
      }

      if (msg.type === "error") {
        currentText = "";
        result.push({ type: "error", content: msg.message });
      }

      if (msg.type === "done") {
        currentText = "";
      }
    }

    // Add any remaining user messages that haven't been shown
    // (happens when user sends but no text response yet)

    return result;
  }, [messages, userMessages]);

  useEffect(() => {
    if (ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [displayMessages]);

  return (
    <div class="messages" ref={ref}>
      {displayMessages.map((msg, i) => {
        if (msg.type === "user") {
          return <div key={i} class="msg msg-user">{msg.content}</div>;
        }
        if (msg.type === "assistant") {
          return <div key={i} class="msg msg-assistant">{msg.content}</div>;
        }
        if (msg.type === "error") {
          return <div key={i} class="msg msg-error">{msg.content}</div>;
        }
        if (msg.type === "tool") {
          return (
            <ToolBlock
              key={i}
              name={msg.toolName!}
              input={msg.toolInput}
              output={msg.toolOutput}
              running={msg.toolRunning!}
            />
          );
        }
        return null;
      })}
    </div>
  );
}

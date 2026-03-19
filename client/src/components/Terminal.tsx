import { useEffect, useRef } from "preact/hooks";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface Props {
  onData: (data: string) => void;
  onClose: () => void;
  onTerminalData: (cb: ((data: string) => void) | null) => void;
}

export function Terminal({ onData, onClose, onTerminalData }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      theme: {
        background: "#0a0a0a",
        foreground: "#e0e0e0",
        cursor: "#7dd3fc",
        selectionBackground: "#2d5f8f",
      },
      fontFamily: "'SF Mono', 'Fira Code', 'Courier New', monospace",
      fontSize: 14,
      cursorBlink: true,
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();
    term.focus();

    // Send keystrokes to backend
    term.onData((data) => onData(data));

    // Receive output from backend
    onTerminalData((data: string) => {
      term.write(data);
    });

    termRef.current = term;

    const handleResize = () => fitAddon.fit();
    window.addEventListener("resize", handleResize);

    return () => {
      onTerminalData(null);
      window.removeEventListener("resize", handleResize);
      term.dispose();
    };
  }, [onData, onTerminalData]);

  return (
    <div class="terminal-overlay">
      <div class="terminal-header">
        <span>claude login</span>
        <button class="terminal-close-btn" onClick={onClose}>close</button>
      </div>
      <div class="terminal-container" ref={containerRef} />
    </div>
  );
}

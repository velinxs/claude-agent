import { useState } from "preact/hooks";

interface Props {
  name: string;
  input?: unknown;
  output?: string;
  running: boolean;
}

export function ToolBlock({ name, input, output, running }: Props) {
  const [collapsed, setCollapsed] = useState(false);

  const preview = input ? JSON.stringify(input, null, 2) : "";
  const truncated = preview.length > 500 ? preview.slice(0, 500) + "..." : preview;

  return (
    <div class="tool-block">
      <div class="tool-header" onClick={() => setCollapsed(!collapsed)}>
        <span class="tool-name">{name}</span>
        <span>{collapsed ? "+" : "-"}</span>
      </div>
      <div class={`tool-output ${running ? "running" : ""} ${collapsed ? "collapsed" : ""}`}>
        {running
          ? truncated ? `${truncated}\n\nrunning...` : "running..."
          : output || "(done)"}
      </div>
    </div>
  );
}

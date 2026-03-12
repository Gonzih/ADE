import { useState } from "react";
import { useAgents } from "./hooks/useAgents";
import AgentCanvas from "./components/AgentCanvas";
import AgentSidebar from "./components/AgentSidebar";
import TopBar from "./components/TopBar";
import type { AgentRow } from "./hooks/useAgents";

export default function App() {
  const { agents, stats, loading, wakeup, pause, resume } = useAgents();
  const [selected, setSelected] = useState<AgentRow | null>(null);

  return (
    <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%" }}>
      <TopBar agentCount={agents.length} runningCount={agents.filter(a => a.status === "running").length} />
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Main spatial canvas */}
        <AgentCanvas
          agents={agents}
          stats={stats}
          selected={selected}
          onSelect={setSelected}
        />
        {/* Right sidebar — selected agent detail */}
        {selected && (
          <AgentSidebar
            agent={selected}
            stats={stats.get(selected.id) ?? null}
            agents={agents}
            onWakeup={wakeup}
            onPause={pause}
            onResume={resume}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
    </div>
  );
}

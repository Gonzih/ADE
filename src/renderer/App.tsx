import { useState } from "react";
import { useAgents } from "./hooks/useAgents";
import AgentCanvas from "./components/AgentCanvas";
import AgentSidebar from "./components/AgentSidebar";
import TopBar from "./components/TopBar";
import IssuesList from "./components/IssuesList";
import CreateAgentModal from "./components/CreateAgentModal";
import type { AgentRow } from "./hooks/useAgents";

export default function App() {
  const { agents, stats, refresh, wakeup, pause, resume } = useAgents();
  const [selected, setSelected] = useState<AgentRow | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const handleDelete = async (agentId: string) => {
    await window.ade.agents.delete(agentId);
    setSelected(null);
    await refresh();
  };

  const handleRelink = async (agentId: string, reportsTo: string | null) => {
    await window.ade.agents.updateReportsTo(agentId, reportsTo);
    await refresh();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%" }}>
      <TopBar
        agentCount={agents.length}
        runningCount={agents.filter((a) => a.status === "running").length}
        onNewAgent={() => setShowCreate(true)}
      />

      <div style={{ display: "flex", flex: 1, overflow: "hidden", flexDirection: "column" }}>
        <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
          {/* Main spatial canvas */}
          <AgentCanvas
            agents={agents}
            stats={stats}
            selected={selected}
            onSelect={setSelected}
            onRelink={handleRelink}
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
              onDelete={handleDelete}
            />
          )}
        </div>

        {/* Bottom tray — issues */}
        <IssuesList selected={selected} agents={agents} />
      </div>

      {showCreate && (
        <CreateAgentModal
          agents={agents}
          onCreated={refresh}
          onClose={() => setShowCreate(false)}
        />
      )}
    </div>
  );
}

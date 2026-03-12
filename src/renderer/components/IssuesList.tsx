/**
 * IssuesList — bottom tray panel
 * Shows open issues across all agents (or filtered to selected agent).
 * Collapsible. DB-as-bus: status colors map to issue status enum.
 */

import { useState, useEffect } from "react";
import type { AgentRow, IssueRow } from "../hooks/useAgents";

interface Props {
  selected: AgentRow | null;
  agents: AgentRow[];
}

const STATUS_COLOR: Record<string, string> = {
  backlog: "var(--text-dim)",
  todo: "var(--text-secondary)",
  in_progress: "var(--accent-blue)",
  in_review: "var(--accent-purple)",
  done: "var(--accent-green)",
  blocked: "var(--accent-amber)",
  cancelled: "var(--text-dim)",
};

const PRIORITY_COLOR: Record<string, string> = {
  high: "var(--accent-red)",
  medium: "var(--accent-amber)",
  low: "var(--text-dim)",
};

export default function IssuesList({ selected, agents }: Props) {
  const [issues, setIssues] = useState<IssueRow[]>([]);
  const [collapsed, setCollapsed] = useState(false);

  const agentById = new Map(agents.map((a) => [a.id, a]));

  useEffect(() => {
    if (!window.ade) return;
    window.ade.issues.list(selected?.id).then(setIssues).catch(console.error);
    const interval = setInterval(() => {
      window.ade.issues.list(selected?.id).then(setIssues).catch(console.error);
    }, 3000);
    return () => clearInterval(interval);
  }, [selected?.id]);

  const open = issues.filter((i) => !["done", "cancelled"].includes(i.status));
  const done = issues.filter((i) => i.status === "done");

  return (
    <div style={{
      height: collapsed ? 36 : 220,
      borderTop: "1px solid var(--border)",
      background: "var(--bg-surface)",
      display: "flex",
      flexDirection: "column",
      flexShrink: 0,
      transition: "height 0.2s ease",
      overflow: "hidden",
    }}>
      {/* Header bar */}
      <div
        onClick={() => setCollapsed((c) => !c)}
        style={{
          height: 36,
          padding: "0 16px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          cursor: "pointer",
          borderBottom: collapsed ? "none" : "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.1em" }}>
          Issues
        </span>
        {selected && (
          <span style={{ fontSize: 10, color: "var(--accent-cyan)", fontFamily: "var(--font-mono)" }}>
            / {selected.name}
          </span>
        )}
        <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-dim)" }}>
          {open.length} open · {done.length} done
        </span>
        <div style={{ flex: 1 }} />
        <span style={{ color: "var(--text-dim)", fontSize: 12 }}>{collapsed ? "▲" : "▼"}</span>
      </div>

      {/* Issue table */}
      {!collapsed && (
        <div style={{ flex: 1, overflow: "auto" }}>
          {issues.length === 0 ? (
            <div style={{ padding: "24px 16px", textAlign: "center", color: "var(--text-dim)", fontSize: 12, fontFamily: "var(--font-mono)" }}>
              no issues
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "var(--bg-elevated)" }}>
                  {["status", "priority", "title", "assignee"].map((h) => (
                    <th key={h} style={{
                      padding: "5px 12px",
                      textAlign: "left",
                      fontSize: 9,
                      fontFamily: "var(--font-mono)",
                      color: "var(--text-dim)",
                      textTransform: "uppercase",
                      letterSpacing: "0.1em",
                      fontWeight: 500,
                      borderBottom: "1px solid var(--border)",
                    }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {issues.map((issue) => (
                  <tr
                    key={issue.id}
                    style={{
                      borderBottom: "1px solid var(--border)",
                      opacity: issue.status === "cancelled" ? 0.4 : 1,
                    }}
                  >
                    <td style={{ padding: "6px 12px" }}>
                      <span style={{
                        fontSize: 10,
                        fontFamily: "var(--font-mono)",
                        color: STATUS_COLOR[issue.status] ?? "var(--text-dim)",
                      }}>
                        {issue.status}
                      </span>
                    </td>
                    <td style={{ padding: "6px 12px" }}>
                      <span style={{
                        fontSize: 10,
                        fontFamily: "var(--font-mono)",
                        color: PRIORITY_COLOR[issue.priority] ?? "var(--text-dim)",
                      }}>
                        {issue.priority}
                      </span>
                    </td>
                    <td style={{ padding: "6px 12px", maxWidth: 400 }}>
                      <span style={{
                        fontSize: 12,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        display: "block",
                        textDecoration: issue.status === "done" ? "line-through" : "none",
                        color: issue.status === "done" ? "var(--text-dim)" : "var(--text-primary)",
                      }}>
                        {issue.title}
                      </span>
                    </td>
                    <td style={{ padding: "6px 12px" }}>
                      {issue.assignee_agent_id && (
                        <span style={{ fontSize: 10, color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>
                          {agentById.get(issue.assignee_agent_id)?.name ?? "—"}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

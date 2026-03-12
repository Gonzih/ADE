/**
 * AgentSidebar — selected agent detail panel
 *
 * Shows: status, recent runs, open issues, budget, wakeup/pause controls.
 * Zoomed-in view of a single node in the agent graph.
 */

import { useState, useEffect } from "react";
import type { AgentRow, AgentStats, RunRow } from "../hooks/useAgents";
import RunLogViewer from "./RunLogViewer";

interface Props {
  agent: AgentRow;
  stats: AgentStats | null;
  agents: AgentRow[];
  onWakeup: (agentId: string, reason?: string) => void;
  onPause: (agentId: string) => void;
  onResume: (agentId: string) => void;
  onClose: () => void;
  onDelete?: (agentId: string) => void;
}

const STATUS_COLOR: Record<string, string> = {
  idle: "var(--status-idle)",
  running: "var(--accent-green)",
  stuck: "var(--accent-amber)",
  paused: "var(--accent-blue)",
  error: "var(--accent-red)",
};

const RUN_STATUS_COLOR: Record<string, string> = {
  queued: "var(--text-dim)",
  running: "var(--accent-green)",
  succeeded: "var(--accent-green)",
  failed: "var(--accent-red)",
  cancelled: "var(--text-dim)",
  timed_out: "var(--accent-amber)",
};

export default function AgentSidebar({ agent, stats, agents, onWakeup, onPause, onResume, onClose, onDelete }: Props) {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [wakeupReason, setWakeupReason] = useState("");
  const [selectedRun, setSelectedRun] = useState<RunRow | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!window.ade) return;
    window.ade.agents.runs(agent.id).then(setRuns).catch(console.error);
  }, [agent.id, stats?.activeRun?.id]);

  const reportsToAgent = agent.reports_to
    ? agents.find((a) => a.id === agent.reports_to)
    : null;

  const budgetPct = stats && stats.budgetMonthlyCents > 0
    ? (stats.spentMonthlyCents / stats.budgetMonthlyCents) * 100
    : 0;

  return (
    <div
      className="animate-in"
      style={{
        width: 340,
        height: "100%",
        background: "var(--bg-surface)",
        borderLeft: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div style={{
        padding: "16px 16px 12px",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
      }}>
        {/* Avatar */}
        <div style={{
          width: 44,
          height: 44,
          borderRadius: "50%",
          background: "var(--bg-elevated)",
          border: `2px solid ${STATUS_COLOR[agent.status] ?? STATUS_COLOR.idle}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 20,
          fontWeight: 700,
          color: STATUS_COLOR[agent.status],
          flexShrink: 0,
          boxShadow: agent.status === "running" ? `0 0 16px ${STATUS_COLOR.running}40` : "none",
        }}>
          {agent.name.charAt(0).toUpperCase()}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {agent.name}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
            {agent.role}{agent.title ? ` · ${agent.title}` : ""}
          </div>
          {reportsToAgent && (
            <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
              ↑ {reportsToAgent.name}
            </div>
          )}
        </div>

        <button
          onClick={onClose}
          style={{
            color: "var(--text-dim)",
            fontSize: 18,
            lineHeight: 1,
            padding: "2px 4px",
          }}
        >
          ×
        </button>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
        {/* Status + controls */}
        <Section title="Status">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <StatusBadge status={agent.status} />
            <div style={{ display: "flex", gap: 6 }}>
              {agent.status === "running" ? (
                <CtrlButton label="Pause" color="var(--accent-amber)" onClick={() => onPause(agent.id)} />
              ) : agent.status === "paused" ? (
                <CtrlButton label="Resume" color="var(--accent-blue)" onClick={() => onResume(agent.id)} />
              ) : null}
              <CtrlButton
                label="Wake"
                color="var(--accent-green)"
                onClick={() => onWakeup(agent.id, wakeupReason || undefined)}
                disabled={agent.status === "running"}
              />
            </div>
          </div>
          <input
            placeholder="wakeup reason (optional)"
            value={wakeupReason}
            onChange={(e) => setWakeupReason(e.target.value)}
            style={{
              width: "100%",
              padding: "6px 10px",
              fontSize: 11,
              marginTop: 8,
            }}
          />
        </Section>

        {/* Active run */}
        {stats?.activeRun && (
          <Section title="Active Run">
            <RunRow run={stats.activeRun} live />
          </Section>
        )}

        {/* Stats */}
        <Section title="Stats">
          <div style={{ display: "flex", gap: 16 }}>
            <Metric label="total runs" value={stats?.runCount ?? 0} />
            <Metric label="open issues" value={stats?.openIssues ?? 0} color="var(--accent-amber)" />
          </div>
          {stats && stats.budgetMonthlyCents > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--text-dim)", marginBottom: 4 }}>
                <span>budget</span>
                <span style={{ fontFamily: "var(--font-mono)", color: budgetPct > 80 ? "var(--accent-red)" : "var(--text-secondary)" }}>
                  ${(stats.spentMonthlyCents / 100).toFixed(2)} / ${(stats.budgetMonthlyCents / 100).toFixed(2)}
                </span>
              </div>
              <div style={{ height: 4, background: "var(--bg-elevated)", borderRadius: 2, overflow: "hidden" }}>
                <div style={{
                  height: "100%",
                  width: `${Math.min(100, budgetPct)}%`,
                  background: budgetPct > 80 ? "var(--accent-red)" : "var(--accent-green)",
                  borderRadius: 2,
                  transition: "width 0.3s ease",
                }} />
              </div>
            </div>
          )}
        </Section>

        {/* Adapter info */}
        <Section title="Adapter">
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--accent-cyan)" }}>
            {agent.adapter_type}
          </div>
          <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
            id: {agent.id.slice(0, 8)}…
          </div>
        </Section>

        {/* Recent runs — click to open log viewer */}
        {runs.length > 0 && (
          <Section title={`Runs (${runs.length})`}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: selectedRun ? 120 : 240, overflow: "auto" }}>
              {runs.slice(0, 20).map((r) => (
                <div
                  key={r.id}
                  onClick={() => setSelectedRun(selectedRun?.id === r.id ? null : r)}
                  style={{ cursor: "pointer" }}
                >
                  <RunRow
                    run={r}
                    live={r.id === stats?.activeRun?.id}
                    selected={selectedRun?.id === r.id}
                  />
                </div>
              ))}
            </div>
            {/* Inline log viewer */}
            {selectedRun && (
              <div style={{ marginTop: 8, height: 240 }}>
                <RunLogViewer run={selectedRun} agentId={agent.id} />
              </div>
            )}
          </Section>
        )}

        {/* Delete */}
        {onDelete && (
          <div style={{ marginTop: 8, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
            {confirmDelete ? (
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ fontSize: 11, color: "var(--accent-red)" }}>confirm delete?</span>
                <CtrlButton label="Yes, delete" color="var(--accent-red)" onClick={() => onDelete(agent.id)} />
                <CtrlButton label="Cancel" color="var(--text-dim)" onClick={() => setConfirmDelete(false)} />
              </div>
            ) : (
              <CtrlButton label="Delete agent" color="var(--accent-red)" onClick={() => setConfirmDelete(true)} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{
        fontSize: 10,
        fontFamily: "var(--font-mono)",
        color: "var(--text-dim)",
        textTransform: "uppercase",
        letterSpacing: "0.1em",
        marginBottom: 8,
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLOR[status] ?? STATUS_COLOR.idle;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: color,
        boxShadow: status === "running" ? `0 0 8px ${color}` : "none",
        animation: status === "running" ? "glow 2s ease-in-out infinite" : "none",
      }} />
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color }}>{status}</span>
    </div>
  );
}

function CtrlButton({ label, color, onClick, disabled }: {
  label: string;
  color: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "4px 10px",
        fontSize: 11,
        fontFamily: "var(--font-mono)",
        borderRadius: "var(--radius-sm)",
        border: `1px solid ${disabled ? "var(--border)" : color}`,
        color: disabled ? "var(--text-dim)" : color,
        background: "transparent",
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "background 0.1s",
      }}
      onMouseEnter={(e) => { if (!disabled) (e.target as HTMLButtonElement).style.background = `${color}18`; }}
      onMouseLeave={(e) => { (e.target as HTMLButtonElement).style.background = "transparent"; }}
    >
      {label}
    </button>
  );
}

function Metric({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 18, fontWeight: 600, color: color ?? "var(--text-primary)" }}>
        {value}
      </div>
      <div style={{ fontSize: 10, color: "var(--text-dim)" }}>{label}</div>
    </div>
  );
}

function RunRow({ run, live, selected }: { run: RunRow; live?: boolean; selected?: boolean }) {
  const color = RUN_STATUS_COLOR[run.status] ?? "var(--text-dim)";
  const elapsed = run.started_at
    ? Math.round((Date.now() - new Date(run.started_at).getTime()) / 1000)
    : null;

  return (
    <div style={{
      padding: "6px 8px",
      background: selected ? "var(--bg-hover)" : "var(--bg-elevated)",
      borderRadius: "var(--radius-sm)",
      border: live ? `1px solid ${color}40` : selected ? `1px solid var(--accent-blue)40` : "1px solid transparent",
      transition: "background 0.1s",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color }}>{run.status}</span>
        <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
          {elapsed != null && live ? `${elapsed}s` : run.finished_at ? formatRelative(run.finished_at) : ""}
        </span>
      </div>
      {run.stdout_excerpt && (
        <div style={{
          marginTop: 4,
          fontSize: 10,
          fontFamily: "var(--font-mono)",
          color: "var(--text-dim)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}>
          {run.stdout_excerpt.slice(0, 120)}
        </div>
      )}
      {run.error && (
        <div style={{
          marginTop: 4,
          fontSize: 10,
          fontFamily: "var(--font-mono)",
          color: "var(--accent-red)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}>
          ✗ {run.error.slice(0, 80)}
        </div>
      )}
    </div>
  );
}

function formatRelative(ts: string): string {
  const delta = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.round(delta / 60)}m ago`;
  return `${Math.round(delta / 3600)}h ago`;
}

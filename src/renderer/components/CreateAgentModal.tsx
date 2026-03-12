/**
 * CreateAgentModal — spawn a new agent into the org
 *
 * Fields: name, role, title, adapter type, reports_to, adapter config
 * On submit → IPC → INSERT agents → refresh canvas
 */

import { useState } from "react";
import type { AgentRow, CreateAgentInput } from "../hooks/useAgents";

interface Props {
  agents: AgentRow[];
  onCreated: () => void;
  onClose: () => void;
}

const ADAPTER_TYPES = ["mock", "process", "http"] as const;
type AdapterType = typeof ADAPTER_TYPES[number];

const ADAPTER_DEFAULTS: Record<AdapterType, string> = {
  mock: JSON.stringify({ durationMs: 2000 }, null, 2),
  process: JSON.stringify({ command: "echo", args: ["hello from agent"], cwd: "/tmp" }, null, 2),
  http: JSON.stringify({ url: "http://localhost:8080/run", method: "POST" }, null, 2),
};

export default function CreateAgentModal({ agents, onCreated, onClose }: Props) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("general");
  const [title, setTitle] = useState("");
  const [adapterType, setAdapterType] = useState<AdapterType>("mock");
  const [reportsTo, setReportsTo] = useState("");
  const [adapterConfig, setAdapterConfig] = useState(ADAPTER_DEFAULTS.mock);
  const [configError, setConfigError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleAdapterChange = (t: AdapterType) => {
    setAdapterType(t);
    setAdapterConfig(ADAPTER_DEFAULTS[t]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    let parsedConfig: Record<string, unknown>;
    try {
      parsedConfig = JSON.parse(adapterConfig);
      setConfigError("");
    } catch {
      setConfigError("Invalid JSON");
      return;
    }

    setLoading(true);
    try {
      await window.ade.agents.create({
        name: name.trim(),
        role: role.trim() || "general",
        title: title.trim() || null,
        adapterType,
        adapterConfig: parsedConfig,
        reportsTo: reportsTo || null,
      });
      onCreated();
      onClose();
    } catch (e) {
      console.error("Create agent failed:", e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
        backdropFilter: "blur(4px)",
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="animate-in"
        style={{
          width: 480,
          background: "var(--bg-surface)",
          border: "1px solid var(--border-bright)",
          borderRadius: "var(--radius-xl)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div style={{
          padding: "16px 20px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 15 }}>New Agent</div>
            <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2, fontFamily: "var(--font-mono)" }}>
              configure identity + adapter
            </div>
          </div>
          <button onClick={onClose} style={{ color: "var(--text-dim)", fontSize: 18 }}>×</button>
        </div>

        <form onSubmit={handleSubmit} style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Row: name + role */}
          <div style={{ display: "flex", gap: 10 }}>
            <Field label="name *">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Backend"
                required
                style={{ width: "100%", padding: "6px 10px", fontSize: 13 }}
                autoFocus
              />
            </Field>
            <Field label="role">
              <input
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder="engineer"
                style={{ width: "100%", padding: "6px 10px", fontSize: 13 }}
              />
            </Field>
          </div>

          {/* Title */}
          <Field label="title">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Senior Backend Engineer"
              style={{ width: "100%", padding: "6px 10px", fontSize: 13 }}
            />
          </Field>

          {/* Reports to */}
          <Field label="reports to">
            <select
              value={reportsTo}
              onChange={(e) => setReportsTo(e.target.value)}
              style={{
                width: "100%",
                padding: "6px 10px",
                fontSize: 13,
                background: "var(--bg-elevated)",
                color: "var(--text-primary)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
              }}
            >
              <option value="">— none (root) —</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name} ({a.role})</option>
              ))}
            </select>
          </Field>

          {/* Adapter type */}
          <Field label="adapter">
            <div style={{ display: "flex", gap: 6 }}>
              {ADAPTER_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => handleAdapterChange(t)}
                  style={{
                    padding: "5px 12px",
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                    borderRadius: "var(--radius-sm)",
                    border: `1px solid ${adapterType === t ? "var(--accent-cyan)" : "var(--border)"}`,
                    color: adapterType === t ? "var(--accent-cyan)" : "var(--text-secondary)",
                    background: adapterType === t ? "rgba(0,221,255,0.08)" : "transparent",
                    cursor: "pointer",
                  }}
                >
                  {t}
                </button>
              ))}
            </div>
          </Field>

          {/* Adapter config JSON */}
          <Field label={`adapter config (JSON)${configError ? ` — ${configError}` : ""}`} error={!!configError}>
            <textarea
              value={adapterConfig}
              onChange={(e) => setAdapterConfig(e.target.value)}
              rows={5}
              style={{
                width: "100%",
                padding: "8px 10px",
                fontSize: 11,
                resize: "vertical",
                fontFamily: "var(--font-mono)",
                border: `1px solid ${configError ? "var(--accent-red)" : "var(--border)"}`,
              }}
            />
          </Field>

          {/* Actions */}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: "7px 16px",
                fontSize: 12,
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                color: "var(--text-secondary)",
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !name.trim()}
              style={{
                padding: "7px 20px",
                fontSize: 12,
                fontWeight: 600,
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--accent-green)",
                color: "var(--accent-green)",
                background: "rgba(0,255,136,0.08)",
                cursor: loading || !name.trim() ? "not-allowed" : "pointer",
                opacity: loading || !name.trim() ? 0.5 : 1,
              }}
            >
              {loading ? "Creating…" : "Create Agent"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({ label, children, error }: { label: string; children: React.ReactNode; error?: boolean }) {
  return (
    <div style={{ flex: 1 }}>
      <div style={{
        fontSize: 10,
        fontFamily: "var(--font-mono)",
        color: error ? "var(--accent-red)" : "var(--text-dim)",
        textTransform: "uppercase",
        letterSpacing: "0.1em",
        marginBottom: 5,
      }}>
        {label}
      </div>
      {children}
    </div>
  );
}

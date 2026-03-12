interface TopBarProps {
  agentCount: number;
  runningCount: number;
  onNewAgent: () => void;
}

export default function TopBar({ agentCount, runningCount, onNewAgent }: TopBarProps) {
  return (
    <div style={{
      height: 44,
      background: "var(--bg-void)",
      borderBottom: "1px solid var(--border)",
      display: "flex",
      alignItems: "center",
      padding: "0 20px",
      gap: 24,
      WebkitAppRegion: "drag" as const,
      flexShrink: 0,
    }}>
      {/* Traffic lights offset */}
      <div style={{ width: 72 }} />

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{
          fontFamily: "var(--font-mono)",
          fontSize: 13,
          fontWeight: 600,
          color: "var(--accent-cyan)",
          letterSpacing: "0.08em",
        }}>
          ADE
        </span>
        <span style={{ color: "var(--text-dim)", fontSize: 12 }}>
          Agent Development Environment
        </span>
      </div>

      <div style={{ flex: 1 }} />

      {/* Actions + Stats */}
      <div style={{ display: "flex", gap: 20, alignItems: "center", WebkitAppRegion: "no-drag" as const }}>
        <button
          onClick={onNewAgent}
          style={{
            padding: "4px 12px",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--accent-green)",
            color: "var(--accent-green)",
            background: "rgba(0,255,136,0.08)",
            cursor: "pointer",
          }}
          onMouseEnter={(e) => ((e.target as HTMLButtonElement).style.background = "rgba(0,255,136,0.15)")}
          onMouseLeave={(e) => ((e.target as HTMLButtonElement).style.background = "rgba(0,255,136,0.08)")}
        >
          + agent
        </button>
        <Stat label="agents" value={agentCount} color="var(--text-secondary)" />
        <Stat
          label="running"
          value={runningCount}
          color={runningCount > 0 ? "var(--accent-green)" : "var(--text-dim)"}
          glow={runningCount > 0}
        />
      </div>

    </div>
  );
}

function Stat({ label, value, color, glow }: { label: string; value: number; color: string; glow?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      {glow && (
        <div style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: color,
          boxShadow: `0 0 8px ${color}`,
          animation: "glow 2s ease-in-out infinite",
        }} />
      )}
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color, fontWeight: 500 }}>
        {value}
      </span>
      <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{label}</span>
    </div>
  );
}

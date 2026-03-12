/**
 * RunLogViewer — live tail of heartbeat_run_events
 *
 * Polls afterSeq=N, appends chunks in real time.
 * Kafka offset model: seq integer, append-only table.
 * Auto-scrolls to bottom while live; stops on terminal status.
 */

import { useEffect, useRef, useState } from "react";
import type { RunRow } from "../hooks/useAgents";

interface LogLine {
  seq: number;
  type: string;
  text: string;
  stream?: string;
}

interface Props {
  run: RunRow;
  agentId: string;
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const TYPE_COLOR: Record<string, string> = {
  log_chunk: "var(--text-primary)",
  status_change: "var(--accent-cyan)",
  cost_update: "var(--accent-amber)",
  adapter_invoke: "var(--accent-purple)",
};

export default function RunLogViewer({ run, agentId }: Props) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [lastSeq, setLastSeq] = useState(-1);
  const [live, setLive] = useState(!TERMINAL.has(run.status));
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrolled = useRef(false);

  // Fetch events from afterSeq
  const fetchEvents = async (afterSeq: number) => {
    const events = await window.ade.runs.events(run.id, afterSeq);
    if (!events.length) return afterSeq;

    const newLines: LogLine[] = events.map((e: RunEvent) => {
      const body = e.body as Record<string, unknown>;
      const text =
        typeof body.text === "string" ? body.text :
        typeof body.message === "string" ? body.message :
        JSON.stringify(body);
      return {
        seq: e.seq,
        type: e.event_type,
        text,
        stream: typeof body.stream === "string" ? body.stream : undefined,
      };
    });

    setLines((prev) => [...prev, ...newLines]);
    return events[events.length - 1].seq;
  };

  useEffect(() => {
    // Initial load
    fetchEvents(-1).then(setLastSeq);
  }, [run.id]);

  // Poll while live
  useEffect(() => {
    if (!live) return;
    if (TERMINAL.has(run.status)) { setLive(false); return; }

    const interval = setInterval(async () => {
      const newSeq = await fetchEvents(lastSeq);
      setLastSeq(newSeq);

      // Check if run finished
      const updated = await window.ade.agents.runs(agentId);
      const thisRun = updated.find((r: { id: string }) => r.id === run.id);
      if (thisRun && TERMINAL.has(thisRun.status)) {
        setLive(false);
        clearInterval(interval);
      }
    }, 300);

    return () => clearInterval(interval);
  }, [live, lastSeq, run.id, agentId, run.status]);

  // Auto-scroll
  useEffect(() => {
    if (!userScrolled.current) {
      bottomRef.current?.scrollIntoView({ behavior: "instant" });
    }
  }, [lines]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    userScrolled.current = !atBottom;
  };

  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      height: "100%",
      background: "var(--bg-void)",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-md)",
      overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{
        padding: "6px 10px",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        gap: 8,
        background: "var(--bg-elevated)",
        flexShrink: 0,
      }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" }}>
          run
        </span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--accent-blue)" }}>
          {run.id.slice(0, 8)}
        </span>
        <div style={{ flex: 1 }} />
        {live && (
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <div style={{
              width: 6, height: 6, borderRadius: "50%",
              background: "var(--accent-green)",
              animation: "glow 2s ease-in-out infinite",
            }} />
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--accent-green)" }}>
              live
            </span>
          </div>
        )}
        <RunStatusPill status={run.status} />
      </div>

      {/* Log body */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          overflow: "auto",
          padding: "8px 10px",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          lineHeight: 1.6,
        }}
      >
        {lines.length === 0 && (
          <div style={{ color: "var(--text-dim)", padding: "12px 0" }}>
            {live ? "waiting for output…" : "no log output"}
          </div>
        )}
        {lines.map((line, i) => (
          <div key={`${line.seq}-${i}`} style={{
            display: "flex",
            gap: 8,
            marginBottom: 2,
            opacity: line.stream === "stderr" ? 0.75 : 1,
          }}>
            <span style={{ color: "var(--text-dim)", fontSize: 9, minWidth: 24, textAlign: "right", paddingTop: 1 }}>
              {line.seq}
            </span>
            <span style={{
              color: line.stream === "stderr" ? "var(--accent-red)" : (TYPE_COLOR[line.type] ?? "var(--text-primary)"),
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              flex: 1,
            }}>
              {line.text}
            </span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function RunStatusPill({ status }: { status: string }) {
  const colors: Record<string, string> = {
    running: "var(--accent-green)",
    succeeded: "var(--accent-green)",
    failed: "var(--accent-red)",
    cancelled: "var(--text-dim)",
    timed_out: "var(--accent-amber)",
    queued: "var(--text-dim)",
  };
  const c = colors[status] ?? "var(--text-dim)";
  return (
    <span style={{
      fontFamily: "var(--font-mono)",
      fontSize: 9,
      color: c,
      border: `1px solid ${c}40`,
      padding: "1px 5px",
      borderRadius: 3,
    }}>
      {status}
    </span>
  );
}

interface RunEvent {
  id: string;
  run_id: string;
  seq: number;
  event_type: string;
  body: Record<string, unknown>;
  created_at: string;
}

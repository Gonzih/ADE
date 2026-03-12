/**
 * AgentCanvas — Spatial agent map
 *
 * Zoomable, pannable canvas showing agents as nodes in their org tree.
 * Connections = reporting lines.
 * Node color = status.
 * Pulse ring = actively running.
 *
 * Zoom in → agent detail overlay.
 * Drag canvas → pan.
 * Click node → select + open sidebar.
 */

import { useRef, useEffect, useState, useCallback } from "react";
import type { AgentRow, AgentStats } from "../hooks/useAgents";

interface Props {
  agents: AgentRow[];
  stats: Map<string, AgentStats>;
  selected: AgentRow | null;
  onSelect: (agent: AgentRow) => void;
}

interface NodeLayout {
  agent: AgentRow;
  x: number;
  y: number;
}

const STATUS_COLORS: Record<string, string> = {
  idle: "#3a3a5c",
  running: "#00ff88",
  stuck: "#ffaa00",
  paused: "#4488ff",
  error: "#ff4444",
};

const NODE_RADIUS = 36;
const LEVEL_GAP = 140;
const SIBLING_GAP = 120;

function layoutTree(agents: AgentRow[]): NodeLayout[] {
  if (!agents.length) return [];

  const byId = new Map(agents.map((a) => [a.id, a]));
  const childrenOf = new Map<string | null, AgentRow[]>();

  for (const a of agents) {
    const key = a.reports_to ?? null;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key)!.push(a);
  }

  const layouts: NodeLayout[] = [];
  let xCounter = 0;

  function placeSubtree(agentId: string | null, depth: number): number {
    const children = childrenOf.get(agentId) ?? [];
    if (!children.length) {
      // Leaf
      const a = byId.get(agentId!)!;
      if (!a) return xCounter;
      const x = xCounter * SIBLING_GAP;
      layouts.push({ agent: a, x, y: depth * LEVEL_GAP });
      xCounter++;
      return x;
    }

    const childXs = children.map((c) => placeSubtree(c.id, depth + 1));
    const midX = (childXs[0] + childXs[childXs.length - 1]) / 2;

    if (agentId) {
      const a = byId.get(agentId)!;
      layouts.push({ agent: a, x: midX, y: depth * LEVEL_GAP });
    }
    return midX;
  }

  // Roots = no reports_to or reports_to not in set
  const roots = agents.filter((a) => !a.reports_to || !byId.has(a.reports_to));
  roots.forEach((r) => placeSubtree(r.id, 0));

  // Orphaned (not yet placed)
  const placed = new Set(layouts.map((l) => l.agent.id));
  for (const a of agents) {
    if (!placed.has(a.id)) {
      layouts.push({ agent: a, x: xCounter * SIBLING_GAP, y: 0 });
      xCounter++;
    }
  }

  return layouts;
}

export default function AgentCanvas({ agents, stats, selected, onSelect }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const dragging = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const layouts = layoutTree(agents);

  // Fit to view on agents change
  useEffect(() => {
    if (!layouts.length) return;
    const xs = layouts.map((l) => l.x);
    const ys = layouts.map((l) => l.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    const contentW = maxX - minX + NODE_RADIUS * 6;
    const contentH = maxY - minY + NODE_RADIUS * 6;
    const fitZoom = Math.min(size.w / contentW, size.h / contentH, 1.2);
    const z = Math.max(0.3, Math.min(fitZoom, 1.2));

    setPan({
      x: (size.w - (maxX + minX) * z) / 2,
      y: (size.h - (maxY + minY) * z) / 2 + 60,
    });
    setZoom(z);
  }, [agents.length, size.w, size.h]);

  // Resize observer
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize({ w: r.width, h: r.height });
    });
    ro.observe(svg.parentElement!);
    return () => ro.disconnect();
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    setZoom((z) => Math.max(0.2, Math.min(3, z * factor)));
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as SVGElement).closest(".agent-node")) return;
    dragging.current = true;
    lastMouse.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging.current) return;
    const dx = e.clientX - lastMouse.current.x;
    const dy = e.clientY - lastMouse.current.y;
    lastMouse.current = { x: e.clientX, y: e.clientY };
    setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
  }, []);

  const handleMouseUp = useCallback(() => {
    dragging.current = false;
  }, []);

  const byId = new Map(layouts.map((l) => [l.agent.id, l]));

  return (
    <div
      style={{
        flex: 1,
        position: "relative",
        background: "var(--bg-void)",
        overflow: "hidden",
        cursor: dragging.current ? "grabbing" : "grab",
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      {/* Grid background */}
      <svg
        style={{ position: "absolute", inset: 0, pointerEvents: "none", opacity: 0.15 }}
        width="100%"
        height="100%"
      >
        <defs>
          <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="0.5" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)" />
      </svg>

      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        onWheel={handleWheel}
        style={{ position: "absolute", inset: 0 }}
      >
        <defs>
          <filter id="glow-green">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>
          <filter id="glow-amber">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>
          <marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill="rgba(255,255,255,0.15)" />
          </marker>
        </defs>

        <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
          {/* Connection lines (reporting tree) */}
          {layouts.map(({ agent, x, y }) => {
            if (!agent.reports_to) return null;
            const parent = byId.get(agent.reports_to);
            if (!parent) return null;
            const isActive = stats.get(agent.id)?.activeRun != null;
            return (
              <g key={`edge-${agent.id}`}>
                <line
                  x1={parent.x}
                  y1={parent.y}
                  x2={x}
                  y2={y}
                  stroke={isActive ? "rgba(0,255,136,0.25)" : "rgba(255,255,255,0.07)"}
                  strokeWidth={isActive ? 1.5 : 1}
                  strokeDasharray={isActive ? "none" : "4,6"}
                  markerEnd="url(#arrow)"
                />
              </g>
            );
          })}

          {/* Agent nodes */}
          {layouts.map(({ agent, x, y }) => {
            const s = stats.get(agent.id);
            const isRunning = agent.status === "running";
            const isSelected = selected?.id === agent.id;
            const isHovered = hoveredId === agent.id;
            const color = STATUS_COLORS[agent.status] ?? STATUS_COLORS.idle;
            const budgetUsed = s && s.budgetMonthlyCents > 0
              ? s.spentMonthlyCents / s.budgetMonthlyCents
              : 0;

            return (
              <g
                key={agent.id}
                className="agent-node"
                transform={`translate(${x},${y})`}
                onClick={() => onSelect(agent)}
                onMouseEnter={() => setHoveredId(agent.id)}
                onMouseLeave={() => setHoveredId(null)}
                style={{ cursor: "pointer" }}
              >
                {/* Pulse ring for running agents */}
                {isRunning && (
                  <circle
                    r={NODE_RADIUS + 10}
                    fill="none"
                    stroke={color}
                    strokeWidth="1"
                    opacity="0"
                    style={{ animation: "pulse-ring 2s ease-out infinite" }}
                  />
                )}

                {/* Selection ring */}
                {isSelected && (
                  <circle
                    r={NODE_RADIUS + 5}
                    fill="none"
                    stroke="var(--accent-blue)"
                    strokeWidth="1.5"
                    opacity="0.8"
                  />
                )}

                {/* Budget arc */}
                {budgetUsed > 0 && (
                  <circle
                    r={NODE_RADIUS + 3}
                    fill="none"
                    stroke={budgetUsed > 0.8 ? "var(--accent-red)" : "var(--accent-amber)"}
                    strokeWidth="2"
                    strokeDasharray={`${budgetUsed * 2 * Math.PI * (NODE_RADIUS + 3)} ${2 * Math.PI * (NODE_RADIUS + 3)}`}
                    strokeDashoffset={`${Math.PI * (NODE_RADIUS + 3) / 2}`}
                    opacity="0.5"
                    transform="rotate(-90)"
                  />
                )}

                {/* Node background */}
                <circle
                  r={NODE_RADIUS}
                  fill={isHovered || isSelected ? "var(--bg-elevated)" : "var(--bg-surface)"}
                  stroke={color}
                  strokeWidth={isRunning ? 2 : 1}
                  style={{
                    filter: isRunning ? "url(#glow-green)" : "none",
                    transition: "fill 0.15s",
                  }}
                />

                {/* Status dot */}
                <circle
                  cx={NODE_RADIUS - 6}
                  cy={-(NODE_RADIUS - 6)}
                  r={5}
                  fill={color}
                  stroke="var(--bg-void)"
                  strokeWidth="2"
                />

                {/* Icon — first letter */}
                <text
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={20}
                  fontWeight="600"
                  fill={isRunning ? color : "rgba(255,255,255,0.7)"}
                  fontFamily="var(--font-sans)"
                >
                  {agent.name.charAt(0).toUpperCase()}
                </text>

                {/* Name label */}
                <text
                  y={NODE_RADIUS + 16}
                  textAnchor="middle"
                  fontSize={11}
                  fill="var(--text-secondary)"
                  fontFamily="var(--font-sans)"
                >
                  {agent.name}
                </text>

                {/* Role label */}
                <text
                  y={NODE_RADIUS + 28}
                  textAnchor="middle"
                  fontSize={9}
                  fill="var(--text-dim)"
                  fontFamily="var(--font-mono)"
                >
                  {agent.role}
                </text>

                {/* Active run indicator */}
                {s?.activeRun && (
                  <text
                    y={-(NODE_RADIUS + 10)}
                    textAnchor="middle"
                    fontSize={9}
                    fill="var(--accent-green)"
                    fontFamily="var(--font-mono)"
                  >
                    ● running
                  </text>
                )}

                {/* Open issues badge */}
                {(s?.openIssues ?? 0) > 0 && (
                  <g transform={`translate(${-(NODE_RADIUS - 4)}, ${-(NODE_RADIUS - 6)})`}>
                    <circle r={7} fill="var(--accent-amber)" stroke="var(--bg-void)" strokeWidth="1.5" />
                    <text
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize={8}
                      fontWeight="700"
                      fill="black"
                      fontFamily="var(--font-mono)"
                    >
                      {s!.openIssues > 9 ? "9+" : s!.openIssues}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {/* Empty state */}
      {!agents.length && (
        <div style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          color: "var(--text-dim)",
        }}>
          <div style={{ fontSize: 48, opacity: 0.3 }}>◎</div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 13 }}>
            no agents yet
          </div>
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
            connect a postgres db and create your first agent
          </div>
        </div>
      )}

      {/* Zoom controls */}
      <div style={{
        position: "absolute",
        bottom: 24,
        right: 24,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}>
        {[["⊕", 1.2], ["⊖", 1/1.2], ["⊙", null]].map(([label, factor]) => (
          <button
            key={String(label)}
            onClick={() => {
              if (factor === null) {
                // Reset
                setZoom(1);
                setPan({ x: size.w / 2, y: size.h / 2 });
              } else {
                setZoom((z) => Math.max(0.2, Math.min(3, z * (factor as number))));
              }
            }}
            style={{
              width: 32,
              height: 32,
              background: "var(--bg-elevated)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              color: "var(--text-secondary)",
              fontSize: 16,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

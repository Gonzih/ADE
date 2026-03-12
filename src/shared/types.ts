// Core domain types shared between main and renderer

export type AgentStatus = "idle" | "running" | "stuck" | "paused" | "error";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
export type IssueStatus = "backlog" | "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled";
export type WakeupStatus = "queued" | "claimed" | "coalesced" | "deferred_issue_execution" | "completed" | "failed";

export interface Agent {
  id: string;
  name: string;
  role: string;
  title: string | null;
  status: AgentStatus;
  reportsTo: string | null;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  lastHeartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HeartbeatRun {
  id: string;
  agentId: string;
  status: RunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  stdoutExcerpt: string | null;
  usageJson: Record<string, unknown> | null;
  createdAt: string;
}

export interface HeartbeatRunEvent {
  id: string;
  runId: string;
  seq: number;
  type: string;
  body: Record<string, unknown>;
  createdAt: string;
}

export interface Issue {
  id: string;
  title: string;
  description: string | null;
  status: IssueStatus;
  assigneeAgentId: string | null;
  checkoutRunId: string | null;
  executionRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WakeupRequest {
  id: string;
  agentId: string;
  source: string;
  reason: string | null;
  status: WakeupStatus;
  coalescedCount: number;
  requestedAt: string;
}

export interface AgentStats {
  agentId: string;
  runCount: number;
  activeRun: HeartbeatRun | null;
  recentRuns: HeartbeatRun[];
  openIssues: number;
}

// IPC channel names
export const IPC = {
  AGENTS_LIST: "agents:list",
  AGENTS_STATS: "agents:stats",
  AGENT_RUNS: "agent:runs",
  AGENT_WAKEUP: "agent:wakeup",
  AGENT_PAUSE: "agent:pause",
  AGENT_RESUME: "agent:resume",
  ISSUES_LIST: "issues:list",
  DB_READY: "db:ready",
  REALTIME_UPDATE: "realtime:update",
} as const;

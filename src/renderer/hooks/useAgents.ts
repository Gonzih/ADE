import { useState, useEffect, useCallback, useRef } from "react";

export interface CreateAgentInput {
  name: string;
  role: string;
  title: string | null;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  reportsTo: string | null;
  budgetMonthlyCents?: number;
  labors?: Record<string, boolean>;
}

export interface RunEventRow {
  id: string;
  run_id: string;
  seq: number;
  event_type: string;
  body: Record<string, unknown>;
  created_at: string;
}

export interface AgentSkillRow {
  id: string;
  agent_id: string;
  domain: string;
  level: number;
  completions: number;
  updated_at: string;
}

export interface ActivityEventRow {
  id: string;
  actor_type: string;
  actor_id: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

declare global {
  interface Window {
    ade: {
      agents: {
        list: () => Promise<AgentRow[]>;
        stats: (agentId?: string) => Promise<AgentStats | AgentStats[]>;
        runs: (agentId: string) => Promise<RunRow[]>;
        wakeup: (agentId: string, reason?: string) => Promise<{ wakeupId: string }>;
        pause: (agentId: string) => Promise<{ ok: boolean }>;
        resume: (agentId: string) => Promise<{ ok: boolean }>;
        create: (input: CreateAgentInput) => Promise<AgentRow>;
        delete: (agentId: string) => Promise<{ ok: boolean }>;
        updateReportsTo: (agentId: string, reportsTo: string | null) => Promise<{ ok: boolean }>;
        skills: (agentId: string) => Promise<AgentSkillRow[]>;
        history: (agentId: string, limit?: number) => Promise<ActivityEventRow[]>;
      };
      runs: {
        events: (runId: string, afterSeq: number) => Promise<RunEventRow[]>;
      };
      issues: {
        list: (agentId?: string) => Promise<IssueRow[]>;
        updateStatus: (issueId: string, status: string) => Promise<{ ok: boolean }>;
        spawnSub: (input: {
          runId: string;
          agentId: string;
          title: string;
          description?: string;
          requiredLabor?: string;
          parentIssueId?: string;
        }) => Promise<{ issueId: string | null }>;
      };
      onRealtimeUpdate: (cb: (data: RealtimeEvent) => void) => () => void;
      onDbReady: (cb: (ready: boolean) => void) => void;
    };
  }
}

export interface AgentRow {
  id: string;
  name: string;
  role: string;
  title: string | null;
  status: string;
  reports_to: string | null;
  adapter_type: string;
  budget_monthly_cents: number;
  spent_monthly_cents: number;
  last_heartbeat_at: string | null;
  labors: Record<string, boolean>;
  health_score: number;
}

export interface RunRow {
  id: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  error: string | null;
  stdout_excerpt: string | null;
  invocation_source: string;
}

export interface AgentStats {
  agentId: string;
  name: string;
  status: string;
  spentMonthlyCents: number;
  budgetMonthlyCents: number;
  runCount: number;
  activeRun: RunRow | null;
  recentRuns: RunRow[];
  openIssues: number;
}

export interface IssueRow {
  id: string;
  title: string;
  status: string;
  priority: string;
  assignee_agent_id: string | null;
}

export interface RealtimeEvent {
  type: "runStarted" | "runCompleted" | "agentStatus"
      | "issueClaimed" | "issueReleased" | "subIssueSpawned"
      | "orphanRecovered" | "healthScore";
  agentId?: string;
  runId?: string;
  status?: string;
  issueId?: string;
  reason?: string;
  parentIssueId?: string;
  childIssueId?: string;
  count?: number;
  score?: number;
}

export function useAgents() {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [stats, setStats] = useState<Map<string, AgentStats>>(new Map());
  const [loading, setLoading] = useState(true);
  const [dbReady, setDbReady] = useState(false);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  const refresh = useCallback(async () => {
    if (!window.ade) return;
    try {
      const [agentList, statsList] = await Promise.all([
        window.ade.agents.list(),
        window.ade.agents.stats() as Promise<AgentStats[]>,
      ]);
      setAgents(agentList);
      const m = new Map<string, AgentStats>();
      for (const s of statsList) m.set(s.agentId, s);
      setStats(m);
      setLoading(false);
    } catch (e) {
      console.error("refresh error:", e);
    }
  }, []);

  useEffect(() => {
    if (window.ade) {
      window.ade.onDbReady((ready) => {
        setDbReady(ready);
        refresh();
      });
      setTimeout(refresh, 500);
    }

    pollRef.current = setInterval(refresh, 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refresh]);

  useEffect(() => {
    if (!window.ade) return;
    const unsub = window.ade.onRealtimeUpdate(() => refresh());
    return unsub;
  }, [refresh]);

  const wakeup = useCallback(async (agentId: string, reason?: string) => {
    await window.ade.agents.wakeup(agentId, reason);
    await refresh();
  }, [refresh]);

  const pause = useCallback(async (agentId: string) => {
    await window.ade.agents.pause(agentId);
    await refresh();
  }, [refresh]);

  const resume = useCallback(async (agentId: string) => {
    await window.ade.agents.resume(agentId);
    await refresh();
  }, [refresh]);

  return { agents, stats, loading, dbReady, refresh, wakeup, pause, resume };
}

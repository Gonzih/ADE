import { useState, useEffect, useCallback, useRef } from "react";

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
      };
      issues: {
        list: (agentId?: string) => Promise<IssueRow[]>;
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
  type: "runStarted" | "runCompleted" | "agentStatus";
  agentId?: string;
  runId?: string;
  status?: string;
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
    // Wait for DB ready signal or try anyway after 500ms
    if (window.ade) {
      window.ade.onDbReady((ready) => {
        setDbReady(ready);
        refresh();
      });
      // Fallback — also try immediately
      setTimeout(refresh, 500);
    }

    // Poll every 2s for status updates
    pollRef.current = setInterval(refresh, 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refresh]);

  useEffect(() => {
    if (!window.ade) return;
    const unsub = window.ade.onRealtimeUpdate((event) => {
      // Realtime update → immediate refresh
      refresh();
    });
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

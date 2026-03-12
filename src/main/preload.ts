import { contextBridge, ipcRenderer } from "electron";
import { IPC, type CreateAgentInput } from "../shared/types.js";

contextBridge.exposeInMainWorld("ade", {
  agents: {
    list: () => ipcRenderer.invoke(IPC.AGENTS_LIST),
    stats: (agentId?: string) => ipcRenderer.invoke(IPC.AGENTS_STATS, agentId),
    runs: (agentId: string) => ipcRenderer.invoke(IPC.AGENT_RUNS, agentId),
    wakeup: (agentId: string, reason?: string) => ipcRenderer.invoke(IPC.AGENT_WAKEUP, agentId, reason),
    pause: (agentId: string) => ipcRenderer.invoke(IPC.AGENT_PAUSE, agentId),
    resume: (agentId: string) => ipcRenderer.invoke(IPC.AGENT_RESUME, agentId),
    create: (input: CreateAgentInput) => ipcRenderer.invoke(IPC.AGENT_CREATE, input),
    delete: (agentId: string) => ipcRenderer.invoke(IPC.AGENT_DELETE, agentId),
    updateReportsTo: (agentId: string, reportsTo: string | null) =>
      ipcRenderer.invoke(IPC.AGENT_UPDATE_REPORTS_TO, agentId, reportsTo),
    skills: (agentId: string) => ipcRenderer.invoke(IPC.AGENT_SKILLS, agentId),
    history: (agentId: string, limit?: number) => ipcRenderer.invoke(IPC.AGENT_HISTORY, agentId, limit),
  },
  runs: {
    events: (runId: string, afterSeq: number) => ipcRenderer.invoke(IPC.RUN_EVENTS, runId, afterSeq),
  },
  issues: {
    list: (agentId?: string) => ipcRenderer.invoke(IPC.ISSUES_LIST, agentId),
    updateStatus: (issueId: string, status: string) =>
      ipcRenderer.invoke(IPC.ISSUE_UPDATE_STATUS, issueId, status),
    spawnSub: (input: {
      runId: string;
      agentId: string;
      title: string;
      description?: string;
      requiredLabor?: string;
      parentIssueId?: string;
    }) => ipcRenderer.invoke(IPC.ISSUE_SPAWN_SUB, input),
  },
  onRealtimeUpdate: (cb: (data: Record<string, unknown>) => void) => {
    const handler = (_: Electron.IpcRendererEvent, data: Record<string, unknown>) => cb(data);
    ipcRenderer.on(IPC.REALTIME_UPDATE, handler);
    return () => ipcRenderer.removeListener(IPC.REALTIME_UPDATE, handler);
  },
  onDbReady: (cb: (ready: boolean) => void) => {
    ipcRenderer.once(IPC.DB_READY, (_, ready) => cb(ready));
  },
});

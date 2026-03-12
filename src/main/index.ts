import { app, BrowserWindow, ipcMain } from "electron";
import path from "path";
import { Pool } from "pg";
import { AgentOrchestrator } from "./services/agentOrchestrator.js";
import { IPC } from "../shared/types.js";

const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let orchestrator: AgentOrchestrator | null = null;
let pool: Pool | null = null;

async function initDb(): Promise<Pool> {
  const url = process.env.DATABASE_URL || "postgres://localhost/ade";
  const p = new Pool({ connectionString: url });
  await p.query("SELECT 1"); // verify connection
  return p;
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1200,
    minHeight: 700,
    backgroundColor: "#0a0a0f",
    titleBarStyle: "hiddenInset",
    vibrancy: "under-window",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  if (isDev) {
    win.loadURL("http://localhost:5173");
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  win.once("ready-to-show", () => win.show());
  return win;
}

function registerIpcHandlers(p: Pool, orch: AgentOrchestrator): void {
  ipcMain.handle(IPC.AGENTS_LIST, async () => {
    const { rows } = await p.query(`
      SELECT id, name, role, title, status, reports_to,
             adapter_type, budget_monthly_cents, spent_monthly_cents,
             last_heartbeat_at, labors, health_score, created_at, updated_at
      FROM agents ORDER BY name
    `);
    return rows;
  });

  ipcMain.handle(IPC.AGENTS_STATS, async (_, agentId?: string) => {
    const where = agentId ? `WHERE agent_id = $1` : "";
    const args = agentId ? [agentId] : [];

    const { rows: agents } = await p.query(
      `SELECT id, name, status, spent_monthly_cents, budget_monthly_cents FROM agents ${agentId ? "WHERE id = $1" : ""} ORDER BY name`,
      args
    );

    const stats = await Promise.all(
      agents.map(async (a: Record<string, unknown>) => {
        const [activeRes, recentRes, issueRes] = await Promise.all([
          p.query(
            `SELECT id, status, started_at, stdout_excerpt FROM heartbeat_runs
             WHERE agent_id = $1 AND status = 'running' LIMIT 1`,
            [a.id]
          ),
          p.query(
            `SELECT id, status, started_at, finished_at, exit_code FROM heartbeat_runs
             WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 10`,
            [a.id]
          ),
          p.query(
            `SELECT COUNT(*) as cnt FROM issues WHERE assignee_agent_id = $1 AND status NOT IN ('done','cancelled')`,
            [a.id]
          ),
        ]);

        const runCount = await p.query(
          `SELECT COUNT(*) as cnt FROM heartbeat_runs WHERE agent_id = $1`,
          [a.id]
        );

        return {
          agentId: a.id,
          name: a.name,
          status: a.status,
          spentMonthlyCents: a.spent_monthly_cents,
          budgetMonthlyCents: a.budget_monthly_cents,
          runCount: parseInt(runCount.rows[0].cnt, 10),
          activeRun: activeRes.rows[0] ?? null,
          recentRuns: recentRes.rows,
          openIssues: parseInt(issueRes.rows[0].cnt, 10),
        };
      })
    );

    return agentId ? stats[0] ?? null : stats;
  });

  ipcMain.handle(IPC.AGENT_RUNS, async (_, agentId: string) => {
    const { rows } = await p.query(
      `SELECT id, status, started_at, finished_at, exit_code, error, stdout_excerpt, invocation_source
       FROM heartbeat_runs WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [agentId]
    );
    return rows;
  });

  ipcMain.handle(IPC.AGENT_WAKEUP, async (_, agentId: string, reason?: string) => {
    const wakeupId = await orch.requestWakeup(agentId, "user", reason ?? "manual wakeup");
    return { wakeupId };
  });

  ipcMain.handle(IPC.AGENT_PAUSE, async (_, agentId: string) => {
    await p.query(`UPDATE agents SET status = 'paused', updated_at = NOW() WHERE id = $1`, [agentId]);
    return { ok: true };
  });

  ipcMain.handle(IPC.AGENT_RESUME, async (_, agentId: string) => {
    await p.query(`UPDATE agents SET status = 'idle', updated_at = NOW() WHERE id = $1`, [agentId]);
    return { ok: true };
  });

  ipcMain.handle(IPC.AGENT_CREATE, async (_, input: import("../shared/types.js").CreateAgentInput) => {
    const { rows } = await p.query(
      `INSERT INTO agents (name, role, title, adapter_type, adapter_config, reports_to, budget_monthly_cents, labors)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, name, role, title, status, reports_to, adapter_type,
                 budget_monthly_cents, spent_monthly_cents, last_heartbeat_at, labors, health_score`,
      [
        input.name,
        input.role || "general",
        input.title ?? null,
        input.adapterType || "mock",
        JSON.stringify(input.adapterConfig ?? {}),
        input.reportsTo ?? null,
        input.budgetMonthlyCents ?? 0,
        JSON.stringify(input.labors ?? {}),
      ]
    );
    return rows[0];
  });

  ipcMain.handle(IPC.AGENT_DELETE, async (_, agentId: string) => {
    // Soft-delete: null out reports_to children, then delete agent
    await p.query(`UPDATE agents SET reports_to = NULL WHERE reports_to = $1`, [agentId]);
    await p.query(`UPDATE issues SET assignee_agent_id = NULL WHERE assignee_agent_id = $1`, [agentId]);
    await p.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
    return { ok: true };
  });

  ipcMain.handle(IPC.AGENT_UPDATE_REPORTS_TO, async (_, agentId: string, reportsTo: string | null) => {
    await p.query(
      `UPDATE agents SET reports_to = $1, updated_at = NOW() WHERE id = $2`,
      [reportsTo, agentId]
    );
    return { ok: true };
  });

  // Run events — Kafka-offset model: afterSeq = consumer offset
  ipcMain.handle(IPC.RUN_EVENTS, async (_, runId: string, afterSeq: number) => {
    const { rows } = await p.query(
      `SELECT id, run_id, seq, event_type, body, created_at
       FROM heartbeat_run_events
       WHERE run_id = $1 AND seq > $2
       ORDER BY seq ASC
       LIMIT 200`,
      [runId, afterSeq]
    );
    return rows;
  });

  ipcMain.handle(IPC.ISSUES_LIST, async (_, agentId?: string) => {
    const where = agentId ? `WHERE assignee_agent_id = $1` : "";
    const { rows } = await p.query(
      `SELECT id, title, status, priority, assignee_agent_id, created_at, updated_at
       FROM issues ${where} ORDER BY created_at DESC LIMIT 100`,
      agentId ? [agentId] : []
    );
    return rows;
  });

  ipcMain.handle(IPC.ISSUE_UPDATE_STATUS, async (_, issueId: string, status: string) => {
    const completedAt = status === "done" ? "NOW()" : "NULL";
    await p.query(
      `UPDATE issues SET status = $1, updated_at = NOW(),
       completed_at = ${completedAt}
       WHERE id = $2`,
      [status, issueId]
    );
    return { ok: true };
  });

  // Spawn a sub-issue from a running agent (DF sub-agent spawning primitive)
  ipcMain.handle(IPC.ISSUE_SPAWN_SUB, async (_, input: {
    runId: string;
    agentId: string;
    title: string;
    description?: string;
    requiredLabor?: string;
    parentIssueId?: string;
  }) => {
    const issueId = await orch.spawnSubIssue(
      input.runId,
      input.agentId,
      input.title,
      input.description ?? null,
      input.requiredLabor ?? null,
      input.parentIssueId
    );
    return { issueId };
  });

  // Agent skills (DF skill levels per domain)
  ipcMain.handle(IPC.AGENT_SKILLS, async (_, agentId: string) => {
    const { rows } = await p.query(
      `SELECT id, agent_id, domain, level, completions, updated_at
       FROM agent_skills WHERE agent_id = $1 ORDER BY level DESC`,
      [agentId]
    );
    return rows;
  });

  // Agent activity history (Legends Mode)
  ipcMain.handle(IPC.AGENT_HISTORY, async (_, agentId: string, limit = 50) => {
    const { rows } = await p.query(
      `SELECT id, actor_type, actor_id, action, target_type, target_id, metadata, created_at
       FROM activity_log
       WHERE actor_id = $1 OR target_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [agentId, limit]
    );
    return rows;
  });
}

app.whenReady().then(async () => {
  try {
    pool = await initDb();
    orchestrator = new AgentOrchestrator(pool);

    // Relay orchestrator events to renderer
    orchestrator.on("runStarted", (agentId, runId) => {
      mainWindow?.webContents.send(IPC.REALTIME_UPDATE, { type: "runStarted", agentId, runId });
    });
    orchestrator.on("runCompleted", (result) => {
      mainWindow?.webContents.send(IPC.REALTIME_UPDATE, { type: "runCompleted", ...result });
    });
    orchestrator.on("agentStatusChanged", (agentId, status) => {
      mainWindow?.webContents.send(IPC.REALTIME_UPDATE, { type: "agentStatus", agentId, status });
    });
    orchestrator.on("issueClaimed", (issueId, agentId) => {
      mainWindow?.webContents.send(IPC.REALTIME_UPDATE, { type: "issueClaimed", issueId, agentId });
    });
    orchestrator.on("issueReleased", (issueId, reason) => {
      mainWindow?.webContents.send(IPC.REALTIME_UPDATE, { type: "issueReleased", issueId, reason });
    });
    orchestrator.on("subIssueSpawned", (parentIssueId, childIssueId, agentId) => {
      mainWindow?.webContents.send(IPC.REALTIME_UPDATE, { type: "subIssueSpawned", parentIssueId, childIssueId, agentId });
    });
    orchestrator.on("orphanRecovered", (count) => {
      mainWindow?.webContents.send(IPC.REALTIME_UPDATE, { type: "orphanRecovered", count });
    });
    orchestrator.on("healthScoreUpdated", (agentId, score) => {
      mainWindow?.webContents.send(IPC.REALTIME_UPDATE, { type: "healthScore", agentId, score });
    });

    registerIpcHandlers(pool, orchestrator);
    orchestrator.start(500);

    mainWindow = createWindow();
    mainWindow.webContents.once("did-finish-load", () => {
      mainWindow?.webContents.send(IPC.DB_READY, true);
    });
  } catch (e) {
    console.error("ADE startup error:", e);
    // Still open window — show connection error state
    mainWindow = createWindow();
  }
});

app.on("window-all-closed", async () => {
  orchestrator?.stop();
  await pool?.end();
  if (process.platform !== "darwin") app.quit();
});

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
             last_heartbeat_at, created_at, updated_at
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

  ipcMain.handle(IPC.ISSUES_LIST, async (_, agentId?: string) => {
    const where = agentId ? `WHERE assignee_agent_id = $1` : "";
    const { rows } = await p.query(
      `SELECT id, title, status, priority, assignee_agent_id, created_at, updated_at
       FROM issues ${where} ORDER BY created_at DESC LIMIT 100`,
      agentId ? [agentId] : []
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

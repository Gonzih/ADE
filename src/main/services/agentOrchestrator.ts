/**
 * Agent Orchestrator
 *
 * Implements Paperclip's DB-as-message-bus pattern:
 *
 * Poll loop → find queued wakeup requests → atomic claim → launch run → poll events
 *
 * Key primitives used:
 * 1. Atomic UPDATE WHERE + RETURNING → claim wakeup request (distributed mutex)
 * 2. Status enum poll → discover work (message queue)
 * 3. coalescedCount merging → backpressure (flood control)
 *
 * The orchestrator doesn't know HOW agents do their work. It knows:
 * - when to wake them
 * - when they're done
 * - what it cost
 * - how to coalesce burst wakeups into single runs
 */

import { Pool } from "pg";
import { EventEmitter } from "events";

export interface AgentRunResult {
  agentId: string;
  runId: string;
  status: "succeeded" | "failed" | "cancelled";
  exitCode?: number;
  stdoutExcerpt?: string;
  error?: string;
}

export interface OrchestratorEvents {
  runStarted: (agentId: string, runId: string) => void;
  runCompleted: (result: AgentRunResult) => void;
  agentStatusChanged: (agentId: string, status: string) => void;
  wakeupCoalesced: (agentId: string, count: number) => void;
}

// In-process promise chains — serialize concurrent requests per agent
// before they hit the DB (Paperclip pattern: startLocksByAgent)
const startLocksByAgent = new Map<string, Promise<void>>();

function withAgentLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  const previous = startLocksByAgent.get(agentId) ?? Promise.resolve();
  let resolve!: () => void;
  const next = new Promise<void>((r) => (resolve = r));
  startLocksByAgent.set(agentId, next);

  return previous.then(async () => {
    try {
      return await fn();
    } finally {
      resolve();
      if (startLocksByAgent.get(agentId) === next) {
        startLocksByAgent.delete(agentId);
      }
    }
  }) as Promise<T>;
}

export class AgentOrchestrator extends EventEmitter {
  private pool: Pool;
  private pollInterval: NodeJS.Timeout | null = null;
  private running = false;
  private activeRuns = new Map<string, string>(); // agentId → runId

  constructor(pool: Pool) {
    super();
    this.pool = pool;
  }

  start(intervalMs = 500): void {
    if (this.running) return;
    this.running = true;
    this.pollInterval = setInterval(() => this.poll(), intervalMs);
    console.log("[orchestrator] started, polling every", intervalMs, "ms");
  }

  stop(): void {
    if (this.pollInterval) clearInterval(this.pollInterval);
    this.running = false;
  }

  /**
   * Request a wakeup for an agent.
   * If agent already has an active run, the request is deferred and coalesced.
   */
  async requestWakeup(
    agentId: string,
    source: string,
    reason?: string,
    payload?: Record<string, unknown>
  ): Promise<string> {
    return withAgentLock(agentId, async () => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");

        // Check if agent has active run
        const activeRun = await client.query(
          `SELECT id FROM heartbeat_runs
           WHERE agent_id = $1 AND status = 'running'
           LIMIT 1`,
          [agentId]
        );

        if (activeRun.rows.length > 0) {
          // Check for existing deferred request
          const existing = await client.query(
            `SELECT id, coalesced_count FROM agent_wakeup_requests
             WHERE agent_id = $1 AND status = 'deferred_issue_execution'
             LIMIT 1`,
            [agentId]
          );

          if (existing.rows.length > 0) {
            // Coalesce: merge into existing deferred row
            const newCount = existing.rows[0].coalesced_count + 1;
            await client.query(
              `UPDATE agent_wakeup_requests
               SET coalesced_count = $1, updated_at = NOW()
               WHERE id = $2`,
              [newCount, existing.rows[0].id]
            );
            await client.query("COMMIT");
            this.emit("wakeupCoalesced", agentId, newCount);
            return existing.rows[0].id;
          }

          // Create deferred request
          const result = await client.query(
            `INSERT INTO agent_wakeup_requests
             (agent_id, source, reason, payload, status, requested_by_actor_type)
             VALUES ($1, $2, $3, $4, 'deferred_issue_execution', 'system')
             RETURNING id`,
            [agentId, source, reason ?? null, payload ? JSON.stringify(payload) : null]
          );
          await client.query("COMMIT");
          return result.rows[0].id;
        }

        // No active run — queue normal wakeup
        const result = await client.query(
          `INSERT INTO agent_wakeup_requests
           (agent_id, source, reason, payload, status, requested_by_actor_type)
           VALUES ($1, $2, $3, $4, 'queued', 'system')
           RETURNING id`,
          [agentId, source, reason ?? null, payload ? JSON.stringify(payload) : null]
        );
        await client.query("COMMIT");
        return result.rows[0].id;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    });
  }

  private async poll(): Promise<void> {
    // Find queued wakeup requests — atomic claim via UPDATE WHERE + RETURNING
    const { rows: pending } = await this.pool.query(`
      UPDATE agent_wakeup_requests
      SET status = 'claimed', claimed_at = NOW(), updated_at = NOW()
      WHERE id IN (
        SELECT id FROM agent_wakeup_requests
        WHERE status = 'queued'
        ORDER BY requested_at
        LIMIT 10
      )
      RETURNING id, agent_id, source, reason, payload
    `);

    for (const req of pending) {
      this.launchRun(req.agent_id, req.id, req.source, req.reason).catch((e) =>
        console.error("[orchestrator] run error:", e)
      );
    }

    // Check for stuck runs (execution_locked_at > 5min ago) — mark timed_out
    await this.pool.query(`
      UPDATE heartbeat_runs
      SET status = 'timed_out', finished_at = NOW(), updated_at = NOW()
      WHERE status = 'running'
        AND started_at < NOW() - INTERVAL '10 minutes'
    `);

    // Promote deferred requests when agent goes idle
    await this.pool.query(`
      UPDATE agent_wakeup_requests
      SET status = 'queued', updated_at = NOW()
      WHERE status = 'deferred_issue_execution'
        AND agent_id NOT IN (
          SELECT agent_id FROM heartbeat_runs WHERE status = 'running'
        )
    `);
  }

  private async launchRun(
    agentId: string,
    wakeupId: string,
    source: string,
    reason: string | null
  ): Promise<void> {
    // Create heartbeat run record
    const { rows } = await this.pool.query(
      `INSERT INTO heartbeat_runs
       (agent_id, invocation_source, trigger_detail, status, started_at)
       VALUES ($1, $2, $3, 'running', NOW())
       RETURNING id`,
      [agentId, source, reason ?? null]
    );
    const runId = rows[0].id;

    // Mark agent as running
    await this.pool.query(
      `UPDATE agents SET status = 'running', last_heartbeat_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [agentId]
    );

    // Link wakeup to run
    await this.pool.query(
      `UPDATE agent_wakeup_requests SET run_id = $1, status = 'completed', finished_at = NOW(), updated_at = NOW() WHERE id = $2`,
      [runId, wakeupId]
    );

    this.activeRuns.set(agentId, runId);
    this.emit("runStarted", agentId, runId);
    this.emit("agentStatusChanged", agentId, "running");

    // Load agent config to determine what adapter to run
    const agentRes = await this.pool.query(
      `SELECT adapter_type, adapter_config FROM agents WHERE id = $1`,
      [agentId]
    );
    if (!agentRes.rows.length) {
      await this.finishRun(runId, agentId, "failed", 1, "Agent not found");
      return;
    }

    const { adapter_type, adapter_config } = agentRes.rows[0];
    await this.runAdapter(agentId, runId, adapter_type, adapter_config ?? {});
  }

  private async runAdapter(
    agentId: string,
    runId: string,
    adapterType: string,
    adapterConfig: Record<string, unknown>
  ): Promise<void> {
    // Adapter dispatch — each type knows how to execute
    try {
      switch (adapterType) {
        case "process":
          await this.runProcessAdapter(agentId, runId, adapterConfig);
          break;
        case "mock":
          await this.runMockAdapter(agentId, runId, adapterConfig);
          break;
        case "http":
          await this.runHttpAdapter(agentId, runId, adapterConfig);
          break;
        default:
          await this.finishRun(runId, agentId, "failed", 1, `Unknown adapter: ${adapterType}`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.finishRun(runId, agentId, "failed", 1, msg);
    }
  }

  private async runMockAdapter(
    agentId: string,
    runId: string,
    config: Record<string, unknown>
  ): Promise<void> {
    // Simulated run for demo/testing — completes after durationMs
    const durationMs = (config.durationMs as number) ?? 2000;
    await this.appendEvent(runId, "log_chunk", { text: `[mock] agent starting up (${durationMs}ms run)` });

    await new Promise((r) => setTimeout(r, durationMs));

    await this.appendEvent(runId, "log_chunk", { text: "[mock] agent completed successfully" });
    await this.finishRun(runId, agentId, "succeeded", 0, undefined, "[mock] done");
  }

  private async runProcessAdapter(
    agentId: string,
    runId: string,
    config: Record<string, unknown>
  ): Promise<void> {
    const { spawn } = await import("child_process");
    const cmd = config.command as string;
    const args = (config.args as string[]) ?? [];
    const cwd = (config.cwd as string) ?? process.cwd();
    const env = { ...process.env, ...(config.env as Record<string, string> ?? {}) };

    if (!cmd) {
      await this.finishRun(runId, agentId, "failed", 1, "No command configured");
      return;
    }

    return new Promise((resolve) => {
      const child = spawn(cmd, args, { cwd, env, shell: true });
      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", async (chunk: Buffer) => {
        stdout += chunk.toString();
        await this.appendEvent(runId, "log_chunk", { stream: "stdout", text: chunk.toString() });
      });

      child.stderr?.on("data", async (chunk: Buffer) => {
        stderr += chunk.toString();
        await this.appendEvent(runId, "log_chunk", { stream: "stderr", text: chunk.toString() });
      });

      child.on("close", async (code) => {
        const status = code === 0 ? "succeeded" : "failed";
        await this.finishRun(
          runId,
          agentId,
          status,
          code ?? 1,
          code !== 0 ? stderr.slice(-500) : undefined,
          stdout.slice(-1000)
        );
        resolve();
      });
    });
  }

  /**
   * HTTP adapter — POST to a webhook URL with run context.
   * Agent endpoint must return JSON: { status: "succeeded"|"failed", message?: string }
   * Supports polling: if response has { status: "running", pollUrl } we poll until done.
   */
  private async runHttpAdapter(
    agentId: string,
    runId: string,
    config: Record<string, unknown>
  ): Promise<void> {
    const url = config.url as string;
    const method = ((config.method as string) ?? "POST").toUpperCase();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-ADE-Agent-Id": agentId,
      "X-ADE-Run-Id": runId,
      ...((config.headers as Record<string, string>) ?? {}),
    };
    const timeout = (config.timeoutMs as number) ?? 30_000;
    const pollIntervalMs = (config.pollIntervalMs as number) ?? 1000;
    const maxPollAttempts = (config.maxPollAttempts as number) ?? 60;

    if (!url) {
      await this.finishRun(runId, agentId, "failed", 1, "HTTP adapter: no url configured");
      return;
    }

    await this.appendEvent(runId, "log_chunk", { text: `[http] ${method} ${url}` });

    // Fetch with timeout
    const fetchWithTimeout = async (fetchUrl: string, body?: unknown): Promise<Response> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await fetch(fetchUrl, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        return res;
      } finally {
        clearTimeout(timer);
      }
    };

    try {
      const payload = {
        agentId,
        runId,
        ...(config.payload as Record<string, unknown> ?? {}),
      };

      let res = await fetchWithTimeout(url, payload);
      let body: Record<string, unknown> = {};

      try {
        body = await res.json() as Record<string, unknown>;
      } catch {
        body = { status: res.ok ? "succeeded" : "failed", message: await res.text().catch(() => "") };
      }

      await this.appendEvent(runId, "log_chunk", {
        text: `[http] response ${res.status}: ${JSON.stringify(body).slice(0, 200)}`,
      });

      // Handle polling mode
      if (body.status === "running" && typeof body.pollUrl === "string") {
        let attempts = 0;
        while (attempts < maxPollAttempts) {
          await new Promise((r) => setTimeout(r, pollIntervalMs));
          const pollRes = await fetchWithTimeout(body.pollUrl as string);
          body = await pollRes.json() as Record<string, unknown>;
          await this.appendEvent(runId, "log_chunk", {
            text: `[http] poll ${attempts + 1}: ${JSON.stringify(body).slice(0, 200)}`,
          });
          if (body.status !== "running") break;
          attempts++;
        }
        if (attempts >= maxPollAttempts) {
          await this.finishRun(runId, agentId, "timed_out" as "failed", 1, "HTTP adapter: poll timeout");
          return;
        }
      }

      const success = body.status === "succeeded" || res.ok && !body.status;
      const message = typeof body.message === "string" ? body.message : undefined;
      await this.finishRun(
        runId, agentId,
        success ? "succeeded" : "failed",
        success ? 0 : 1,
        success ? undefined : (message ?? `HTTP ${res.status}`),
        message
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.finishRun(runId, agentId, "failed", 1, `[http] ${msg}`);
    }
  }

  private async appendEvent(
    runId: string,
    eventType: string,
    body: Record<string, unknown>
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO heartbeat_run_events (run_id, seq, event_type, body)
       VALUES ($1,
         COALESCE((SELECT MAX(seq) + 1 FROM heartbeat_run_events WHERE run_id = $1), 0),
         $2, $3)`,
      [runId, eventType, JSON.stringify(body)]
    );
  }

  private async finishRun(
    runId: string,
    agentId: string,
    status: "succeeded" | "failed" | "cancelled",
    exitCode: number,
    error?: string,
    stdoutExcerpt?: string
  ): Promise<void> {
    await this.pool.query(
      `UPDATE heartbeat_runs
       SET status = $1, finished_at = NOW(), exit_code = $2,
           error = $3, stdout_excerpt = $4, updated_at = NOW()
       WHERE id = $5`,
      [status, exitCode, error ?? null, stdoutExcerpt ?? null, runId]
    );

    await this.pool.query(
      `UPDATE agents SET status = 'idle', updated_at = NOW() WHERE id = $1`,
      [agentId]
    );

    this.activeRuns.delete(agentId);

    const result: AgentRunResult = { agentId, runId, status, exitCode };
    if (error) result.error = error;
    if (stdoutExcerpt) result.stdoutExcerpt = stdoutExcerpt;

    this.emit("runCompleted", result);
    this.emit("agentStatusChanged", agentId, "idle");
  }
}

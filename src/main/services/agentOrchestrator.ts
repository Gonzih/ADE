/**
 * Agent Orchestrator
 *
 * Implements Paperclip's DB-as-message-bus pattern + Dwarf Fortress coordination model:
 *
 * DF Primitive 1 — Job Broadcast + Agent Self-Selection:
 *   Issues are broadcast work. Idle agents scan for unclaimed issues matching their
 *   labors. Highest-skilled agent claims first. No central dispatcher.
 *
 * DF Primitive 2 — Sub-Agent Spawning:
 *   When a run inserts child issues (spawned_by_run_id = runId), the orchestrator
 *   routes them to capable child agents by labor match + skill rank.
 *   requestDepth tracks nesting depth (prevents infinite spawning).
 *
 * DF Primitive 3 — Orphan Recovery:
 *   Stale in_progress issues (executionRunId → run that died) auto-release to 'todo'.
 *   Stale running heartbeat_runs (no event in 5min) → timed_out, issue released.
 *
 * DF Primitive 4 — Health Score:
 *   Computed after each run. Degrades on consecutive failures, budget exhaustion.
 *   Lower health → deprioritized in claim ordering (not blocked — DF performance degradation).
 *
 * Paperclip primitives:
 * 1. Atomic UPDATE WHERE + RETURNING → distributed mutex / claim
 * 2. Status enum + poll → message queue
 * 3. coalescedCount → backpressure / flood control
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
  issueClaimed: (issueId: string, agentId: string) => void;
  issueReleased: (issueId: string, reason: string) => void;
  subIssueSpawned: (parentIssueId: string, childIssueId: string, agentId: string) => void;
  orphanRecovered: (count: number) => void;
  healthScoreUpdated: (agentId: string, score: number) => void;
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
    // ── 1. Paperclip wakeup requests (manual/external triggers) ──────────────
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

    // Promote deferred when agent goes idle
    await this.pool.query(`
      UPDATE agent_wakeup_requests
      SET status = 'queued', updated_at = NOW()
      WHERE status = 'deferred_issue_execution'
        AND agent_id NOT IN (
          SELECT agent_id FROM heartbeat_runs WHERE status = 'running'
        )
    `);

    // ── 2. DF Job Broadcast — idle agents self-select unclaimed issues ────────
    await this.autonomousIssueClaim();

    // ── 3. Orphan recovery — stale runs + stuck issues ─────────────────────
    await this.recoverOrphans();
  }

  /**
   * DF Job Broadcast Pattern:
   * For each idle agent with enabled labors, atomically claim the highest-priority
   * unclaimed issue matching those labors. Skill level breaks ties.
   *
   * Claim query: UPDATE WHERE status='todo' AND (required_labor IS NULL OR agent labors match)
   * → RETURNING → launch wakeup with issue context
   */
  private async autonomousIssueClaim(): Promise<void> {
    // Find idle agents that have labors defined (opt-in to autonomous claiming)
    const { rows: idleAgents } = await this.pool.query(`
      SELECT a.id, a.name, a.labors, a.health_score, a.adapter_type
      FROM agents a
      WHERE a.status = 'idle'
        AND a.labors != '{}'::jsonb
        AND a.id NOT IN (
          SELECT agent_id FROM heartbeat_runs WHERE status = 'running'
        )
      ORDER BY a.health_score DESC
      LIMIT 20
    `);

    for (const agent of idleAgents) {
      // Atomically claim the best matching issue for this agent
      // Priority order: urgent > high > medium > low, then oldest first
      // Skill match: prefer issues where agent has skill level in required_labor
      const { rows: claimed } = await this.pool.query(`
        UPDATE issues
        SET status = 'in_progress',
            assignee_agent_id = $1,
            execution_locked_at = NOW(),
            started_at = COALESCE(started_at, NOW()),
            updated_at = NOW()
        WHERE id = (
          SELECT i.id FROM issues i
          WHERE i.status = 'todo'
            AND i.assignee_agent_id IS NULL
            AND (
              i.required_labor IS NULL
              OR ($2::jsonb ->> i.required_labor) = 'true'
            )
          ORDER BY
            CASE i.priority
              WHEN 'urgent' THEN 1
              WHEN 'high'   THEN 2
              WHEN 'medium' THEN 3
              WHEN 'low'    THEN 4
              ELSE 5
            END ASC,
            COALESCE((
              SELECT s.level FROM agent_skills s
              WHERE s.agent_id = $1 AND s.domain = i.required_labor
            ), 0) DESC,
            i.created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, title, required_labor, parent_id, request_depth
      `, [agent.id, agent.labors]);

      if (!claimed.length) continue;

      const issue = claimed[0];
      this.emit("issueClaimed", issue.id, agent.id);

      // Log to activity
      await this.pool.query(`
        INSERT INTO activity_log (actor_type, actor_id, action, target_type, target_id, metadata)
        VALUES ('system', $1, 'issue_claimed', 'issue', $2, $3)
      `, [agent.id, issue.id, JSON.stringify({ title: issue.title, required_labor: issue.required_labor })]);

      // Trigger wakeup with issue context in payload
      await this.requestWakeup(agent.id, "issue_claim", `work on: ${issue.title}`, {
        issueId: issue.id,
        issueTitle: issue.title,
        requiredLabor: issue.required_labor,
        parentId: issue.parent_id,
        requestDepth: issue.request_depth,
      });
    }
  }

  /**
   * DF Orphan Recovery:
   * 1. Heartbeat runs stuck 'running' with no recent event → timed_out + release issue
   * 2. Issues stuck 'in_progress' with dead/missing execution run → back to 'todo'
   * 3. Issues stuck 'in_progress' for > 30min with no run → back to 'todo'
   */
  private async recoverOrphans(): Promise<void> {
    // Stale runs: running > 10min or no events in last 5min
    const { rows: staleRuns } = await this.pool.query(`
      UPDATE heartbeat_runs
      SET status = 'timed_out', finished_at = NOW(), updated_at = NOW(),
          error = 'timed out by orphan recovery'
      WHERE status = 'running'
        AND (
          started_at < NOW() - INTERVAL '10 minutes'
          OR (
            started_at < NOW() - INTERVAL '5 minutes'
            AND id NOT IN (
              SELECT DISTINCT run_id FROM heartbeat_run_events
              WHERE created_at > NOW() - INTERVAL '5 minutes'
            )
          )
        )
      RETURNING id, agent_id
    `);

    if (staleRuns.length > 0) {
      // Reset agent status for stale runs
      for (const run of staleRuns) {
        await this.pool.query(
          `UPDATE agents SET status = 'idle', updated_at = NOW() WHERE id = $1`,
          [run.agent_id]
        );
        this.activeRuns.delete(run.agent_id);
        this.emit("agentStatusChanged", run.agent_id, "idle");
      }
    }

    // Release orphaned in_progress issues:
    // - execution_locked_at > 30min ago
    // - OR execution_run_id → run that is now terminal
    const { rows: released } = await this.pool.query(`
      UPDATE issues
      SET status = 'todo',
          assignee_agent_id = NULL,
          execution_run_id = NULL,
          execution_locked_at = NULL,
          updated_at = NOW()
      WHERE status = 'in_progress'
        AND (
          execution_locked_at < NOW() - INTERVAL '30 minutes'
          OR (
            execution_run_id IS NOT NULL
            AND execution_run_id IN (
              SELECT id FROM heartbeat_runs
              WHERE status IN ('timed_out', 'failed', 'cancelled')
            )
          )
        )
      RETURNING id, title
    `);

    if (released.length > 0) {
      this.emit("orphanRecovered", released.length);
      for (const issue of released) {
        this.emit("issueReleased", issue.id, "orphan_recovery");
        await this.pool.query(`
          INSERT INTO activity_log (actor_type, actor_id, action, target_type, target_id, metadata)
          VALUES ('system', 'orchestrator', 'issue_released', 'issue', $1, $2)
        `, [issue.id, JSON.stringify({ title: issue.title, reason: "orphan_recovery" })]);
      }
    }
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

  /**
   * Spawn a sub-issue from within a run.
   * The sub-issue will be routed to a capable child agent after the parent run completes.
   * requestDepth is auto-incremented to prevent infinite spawning (max 5).
   */
  async spawnSubIssue(
    runId: string,
    parentAgentId: string,
    title: string,
    description: string | null,
    requiredLabor: string | null,
    parentIssueId?: string
  ): Promise<string | null> {
    // Get parent issue depth
    const parentDepth = parentIssueId
      ? (await this.pool.query(`SELECT request_depth FROM issues WHERE id = $1`, [parentIssueId])).rows[0]?.request_depth ?? 0
      : 0;

    if (parentDepth >= 5) {
      console.warn("[orchestrator] spawn blocked — max depth 5 reached");
      return null;
    }

    const { rows } = await this.pool.query(`
      INSERT INTO issues
        (title, description, status, required_labor, spawned_by_run_id, parent_id,
         request_depth, created_by_agent_id, priority)
      VALUES ($1, $2, 'backlog', $3, $4, $5, $6, $7, 'medium')
      RETURNING id
    `, [
      title,
      description ?? null,
      requiredLabor ?? null,
      runId,
      parentIssueId ?? null,
      parentDepth + 1,
      parentAgentId,
    ]);

    const issueId = rows[0].id;

    await this.appendEvent(runId, "sub_issue_spawned", {
      issueId,
      title,
      requiredLabor,
      requestDepth: parentDepth + 1,
    });

    await this.pool.query(`
      INSERT INTO activity_log (actor_type, actor_id, action, target_type, target_id, metadata)
      VALUES ('agent', $1, 'sub_issue_spawned', 'issue', $2, $3)
    `, [parentAgentId, issueId, JSON.stringify({ title, requiredLabor, runId })]);

    return issueId;
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

    // ── Post-run: DF skill increment + issue release + health update ──────────
    await this.postRunBookkeeping(runId, agentId, status);

    const result: AgentRunResult = { agentId, runId, status, exitCode };
    if (error) result.error = error;
    if (stdoutExcerpt) result.stdoutExcerpt = stdoutExcerpt;

    this.emit("runCompleted", result);
    this.emit("agentStatusChanged", agentId, "idle");
  }

  /**
   * Post-run bookkeeping — runs after every run completion:
   *
   * 1. Release any issues claimed by this run (mark done/release on failure)
   * 2. DF Skill Model: increment skill level on successful issue completion
   * 3. Sub-issue routing: route spawned child issues to capable agents
   * 4. Health score recompute (DF performance degradation model)
   * 5. Activity log entry
   */
  private async postRunBookkeeping(
    runId: string,
    agentId: string,
    status: "succeeded" | "failed" | "cancelled"
  ): Promise<void> {
    // ── 1. Release claimed issues ─────────────────────────────────────────────
    if (status === "succeeded") {
      // Mark issues completed
      await this.pool.query(`
        UPDATE issues
        SET status = 'done', completed_at = NOW(), updated_at = NOW()
        WHERE execution_run_id = $1 OR (assignee_agent_id = $2 AND status = 'in_progress')
      `, [runId, agentId]);
    } else if (status === "failed" || status === "cancelled") {
      // Release back to todo for retry
      const { rows: releasedIssues } = await this.pool.query(`
        UPDATE issues
        SET status = 'todo',
            assignee_agent_id = NULL,
            execution_run_id = NULL,
            execution_locked_at = NULL,
            updated_at = NOW()
        WHERE (execution_run_id = $1 OR (assignee_agent_id = $2 AND status = 'in_progress'))
        RETURNING id, title, required_labor
      `, [runId, agentId]);

      for (const issue of releasedIssues) {
        this.emit("issueReleased", issue.id, `run_${status}`);
      }
    }

    // ── 2. DF Skill increment on success ──────────────────────────────────────
    if (status === "succeeded") {
      // Find what labor domain this run worked on
      const { rows: issueDomains } = await this.pool.query(`
        SELECT DISTINCT required_labor FROM issues
        WHERE (execution_run_id = $1 OR assignee_agent_id = $2)
          AND required_labor IS NOT NULL
          AND status = 'done'
      `, [runId, agentId]);

      for (const row of issueDomains) {
        if (!row.required_labor) continue;
        // UPSERT skill: insert level=1 or increment existing
        await this.pool.query(`
          INSERT INTO agent_skills (agent_id, domain, level, completions)
          VALUES ($1, $2, 1, 1)
          ON CONFLICT (agent_id, domain)
          DO UPDATE SET
            level = LEAST(agent_skills.level + 1, 99),
            completions = agent_skills.completions + 1,
            updated_at = NOW()
        `, [agentId, row.required_labor]);
      }
    }

    // ── 3. Route spawned sub-issues to capable child agents ───────────────────
    // Issues created during this run (spawned_by_run_id = runId) need routing
    const { rows: subIssues } = await this.pool.query(`
      SELECT i.id, i.title, i.required_labor, i.request_depth, i.parent_id
      FROM issues i
      WHERE i.spawned_by_run_id = $1
        AND i.status = 'backlog'
        AND i.request_depth < 5
    `, [runId]);

    for (const sub of subIssues) {
      // Find the best capable child agent (reports_to = agentId, labor matches, idle)
      const { rows: candidates } = await this.pool.query(`
        SELECT a.id, a.name,
               COALESCE(s.level, 0) AS skill_level
        FROM agents a
        LEFT JOIN agent_skills s ON s.agent_id = a.id AND s.domain = $1
        WHERE a.reports_to = $2
          AND a.status = 'idle'
          AND (
            $1 IS NULL
            OR (a.labors ->> $1)::boolean = true
          )
        ORDER BY skill_level DESC, a.health_score DESC
        LIMIT 1
      `, [sub.required_labor, agentId]);

      if (!candidates.length) {
        // No child available — promote to todo for open broadcast
        await this.pool.query(`
          UPDATE issues SET status = 'todo', updated_at = NOW() WHERE id = $1
        `, [sub.id]);
        continue;
      }

      const child = candidates[0];
      // Assign to child agent
      await this.pool.query(`
        UPDATE issues
        SET status = 'in_progress',
            assignee_agent_id = $1,
            execution_locked_at = NOW(),
            updated_at = NOW()
        WHERE id = $2
      `, [child.id, sub.id]);

      this.emit("subIssueSpawned", sub.parent_id ?? sub.id, sub.id, child.id);

      await this.pool.query(`
        INSERT INTO activity_log (actor_type, actor_id, action, target_type, target_id, metadata)
        VALUES ('system', $1, 'sub_issue_routed', 'issue', $2, $3)
      `, [agentId, sub.id, JSON.stringify({ childAgentId: child.id, title: sub.title })]);

      // Wake the child agent
      await this.requestWakeup(child.id, "sub_issue", `sub-task: ${sub.title}`, {
        issueId: sub.id,
        issueTitle: sub.title,
        parentIssueId: sub.parent_id,
        requestDepth: sub.request_depth,
      });
    }

    // ── 4. Health score recompute (DF performance degradation) ────────────────
    // health = 100 - (consecutive_failures * 15) - (budget_exhaustion_pct * 30)
    // Clamped 0-100. Agents degrade gracefully, never blocked.
    const { rows: healthData } = await this.pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'failed') AS recent_failures,
        COUNT(*) FILTER (WHERE status = 'succeeded') AS recent_successes,
        (SELECT budget_monthly_cents FROM agents WHERE id = $1) AS budget,
        (SELECT spent_monthly_cents FROM agents WHERE id = $1) AS spent
      FROM heartbeat_runs
      WHERE agent_id = $1
        AND created_at > NOW() - INTERVAL '24 hours'
    `, [agentId]);

    if (healthData.length) {
      const { recent_failures, recent_successes, budget, spent } = healthData[0];
      const failures = parseInt(recent_failures, 10);
      const successes = parseInt(recent_successes, 10);
      const totalRecent = failures + successes;
      const failureRate = totalRecent > 0 ? failures / totalRecent : 0;
      const budgetPct = budget > 0 ? parseInt(spent, 10) / parseInt(budget, 10) : 0;

      // DF model: degradation not binary. Health affects priority, not availability.
      const healthScore = Math.max(0, Math.min(100, Math.round(
        100
        - (failureRate * 40)          // up to -40 for all failures
        - (Math.max(0, budgetPct - 0.8) * 100) // up to -20 for >80% budget used
      )));

      await this.pool.query(`
        UPDATE agents SET health_score = $1, updated_at = NOW() WHERE id = $2
      `, [healthScore, agentId]);

      this.emit("healthScoreUpdated", agentId, healthScore);
    }

    // ── 5. Activity log ───────────────────────────────────────────────────────
    await this.pool.query(`
      INSERT INTO activity_log (actor_type, actor_id, action, target_type, target_id, metadata)
      VALUES ('agent', $1, $2, 'run', $3, $4)
    `, [agentId, `run_${status}`, runId, JSON.stringify({ status })]);
  }
}

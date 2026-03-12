import { Pool } from "pg";

const MIGRATIONS = [
  `
  CREATE EXTENSION IF NOT EXISTS "pgcrypto";

  CREATE TABLE IF NOT EXISTS agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'general',
    title TEXT,
    icon TEXT,
    status TEXT NOT NULL DEFAULT 'idle',
    reports_to UUID REFERENCES agents(id),
    capabilities TEXT,
    adapter_type TEXT NOT NULL DEFAULT 'process',
    adapter_config JSONB NOT NULL DEFAULT '{}',
    runtime_config JSONB NOT NULL DEFAULT '{}',
    budget_monthly_cents INTEGER NOT NULL DEFAULT 0,
    spent_monthly_cents INTEGER NOT NULL DEFAULT 0,
    last_heartbeat_at TIMESTAMPTZ,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS agents_status_idx ON agents(status);
  CREATE INDEX IF NOT EXISTS agents_reports_to_idx ON agents(reports_to);
  `,
  `
  CREATE TABLE IF NOT EXISTS heartbeat_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id),
    invocation_source TEXT NOT NULL DEFAULT 'on_demand',
    trigger_detail TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    error TEXT,
    exit_code INTEGER,
    usage_json JSONB,
    result_json JSONB,
    log_bytes BIGINT,
    stdout_excerpt TEXT,
    stderr_excerpt TEXT,
    error_code TEXT,
    context_snapshot JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS heartbeat_runs_agent_started_idx ON heartbeat_runs(agent_id, started_at);
  CREATE INDEX IF NOT EXISTS heartbeat_runs_agent_status_idx ON heartbeat_runs(agent_id, status);
  `,
  `
  CREATE TABLE IF NOT EXISTS heartbeat_run_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES heartbeat_runs(id),
    seq INTEGER NOT NULL DEFAULT 0,
    event_type TEXT NOT NULL,
    body JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS heartbeat_run_events_run_seq_idx ON heartbeat_run_events(run_id, seq);
  `,
  `
  CREATE TABLE IF NOT EXISTS agent_wakeup_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id),
    source TEXT NOT NULL,
    trigger_detail TEXT,
    reason TEXT,
    payload JSONB,
    status TEXT NOT NULL DEFAULT 'queued',
    coalesced_count INTEGER NOT NULL DEFAULT 0,
    requested_by_actor_type TEXT,
    requested_by_actor_id TEXT,
    idempotency_key TEXT,
    run_id UUID,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    claimed_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS agent_wakeup_requests_agent_status_idx ON agent_wakeup_requests(agent_id, status);
  CREATE INDEX IF NOT EXISTS agent_wakeup_requests_requested_idx ON agent_wakeup_requests(requested_at);
  `,
  `
  CREATE TABLE IF NOT EXISTS issues (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_id UUID REFERENCES issues(id),
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'backlog',
    priority TEXT NOT NULL DEFAULT 'medium',
    assignee_agent_id UUID REFERENCES agents(id),
    assignee_user_id TEXT,
    checkout_run_id UUID REFERENCES heartbeat_runs(id) ON DELETE SET NULL,
    execution_run_id UUID REFERENCES heartbeat_runs(id) ON DELETE SET NULL,
    execution_locked_at TIMESTAMPTZ,
    created_by_agent_id UUID REFERENCES agents(id),
    created_by_user_id TEXT,
    issue_number INTEGER,
    identifier TEXT,
    request_depth INTEGER NOT NULL DEFAULT 0,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS issues_status_idx ON issues(status);
  CREATE INDEX IF NOT EXISTS issues_assignee_status_idx ON issues(assignee_agent_id, status);
  CREATE INDEX IF NOT EXISTS issues_parent_idx ON issues(parent_id);
  CREATE UNIQUE INDEX IF NOT EXISTS issues_identifier_idx ON issues(identifier) WHERE identifier IS NOT NULL;
  `,
  `
  CREATE TABLE IF NOT EXISTS activity_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_type TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS activity_log_actor_idx ON activity_log(actor_type, actor_id);
  CREATE INDEX IF NOT EXISTS activity_log_target_idx ON activity_log(target_type, target_id);
  CREATE INDEX IF NOT EXISTS activity_log_created_idx ON activity_log(created_at);
  `,
  `
  CREATE TABLE IF NOT EXISTS cost_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id),
    run_id UUID REFERENCES heartbeat_runs(id),
    amount_cents INTEGER NOT NULL,
    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS cost_events_agent_created_idx ON cost_events(agent_id, created_at);
  CREATE INDEX IF NOT EXISTS cost_events_run_idx ON cost_events(run_id);
  `,
  // Migration 8: agent labors + health_score + issue required_labor + spawned_by_run_id
  `
  ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS labors JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS health_score INTEGER NOT NULL DEFAULT 100;

  ALTER TABLE issues
    ADD COLUMN IF NOT EXISTS required_labor TEXT,
    ADD COLUMN IF NOT EXISTS spawned_by_run_id UUID REFERENCES heartbeat_runs(id) ON DELETE SET NULL;

  CREATE INDEX IF NOT EXISTS issues_required_labor_idx ON issues(required_labor) WHERE required_labor IS NOT NULL;
  `,
  // Migration 9: agent_skills table (DF job-skill model)
  `
  CREATE TABLE IF NOT EXISTS agent_skills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    domain TEXT NOT NULL,
    level INTEGER NOT NULL DEFAULT 1,
    completions INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS agent_skills_agent_domain_idx ON agent_skills(agent_id, domain);
  CREATE INDEX IF NOT EXISTS agent_skills_domain_level_idx ON agent_skills(domain, level DESC);
  `,
];

async function runMigrations() {
  const url = process.env.DATABASE_URL || "postgres://localhost/ade";
  const pool = new Pool({ connectionString: url });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS _ade_migrations (
      id SERIAL PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const { rows } = await pool.query("SELECT COUNT(*) as cnt FROM _ade_migrations");
  const applied = parseInt(rows[0].cnt, 10);

  for (let i = applied; i < MIGRATIONS.length; i++) {
    console.log(`Running migration ${i + 1}/${MIGRATIONS.length}...`);
    await pool.query(MIGRATIONS[i]);
    await pool.query("INSERT INTO _ade_migrations DEFAULT VALUES");
  }

  console.log("Migrations complete.");
  await pool.end();
}

runMigrations().catch((e) => {
  console.error("Migration failed:", e);
  process.exit(1);
});

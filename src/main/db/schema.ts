/**
 * ADE Database Schema
 *
 * Architecture: DB as message bus (Paperclip pattern)
 * No Kafka, no Redis, no RabbitMQ.
 * Three primitives:
 *   1. Atomic UPDATE WHERE + RETURNING → distributed mutex / claim
 *   2. Status enum + poll → message passing / state machine
 *   3. coalescedCount + deferred → backpressure / flood control
 *
 * All agent coordination flows through these table shapes.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  index,
  uniqueIndex,
  bigint,
  boolean,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

// ─── Agents ───────────────────────────────────────────────────────────────────
export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    role: text("role").notNull().default("general"),
    title: text("title"),
    icon: text("icon"),
    // idle | running | stuck | paused | error
    status: text("status").notNull().default("idle"),
    reportsTo: uuid("reports_to").references((): AnyPgColumn => agents.id),
    capabilities: text("capabilities"),
    adapterType: text("adapter_type").notNull().default("process"),
    adapterConfig: jsonb("adapter_config").$type<Record<string, unknown>>().notNull().default({}),
    runtimeConfig: jsonb("runtime_config").$type<Record<string, unknown>>().notNull().default({}),
    budgetMonthlyCents: integer("budget_monthly_cents").notNull().default(0),
    spentMonthlyCents: integer("spent_monthly_cents").notNull().default(0),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusIdx: index("agents_status_idx").on(t.status),
    reportsToIdx: index("agents_reports_to_idx").on(t.reportsTo),
  })
);

// ─── Heartbeat Runs ────────────────────────────────────────────────────────────
// Each run = one execution cycle of an agent.
// Status enum IS the message queue: queued → running → succeeded|failed|cancelled|timed_out
export const heartbeatRuns = pgTable(
  "heartbeat_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    invocationSource: text("invocation_source").notNull().default("on_demand"),
    triggerDetail: text("trigger_detail"),
    // queued | running | succeeded | failed | cancelled | timed_out
    status: text("status").notNull().default("queued"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    exitCode: integer("exit_code"),
    usageJson: jsonb("usage_json").$type<Record<string, unknown>>(),
    resultJson: jsonb("result_json").$type<Record<string, unknown>>(),
    logBytes: bigint("log_bytes", { mode: "number" }),
    stdoutExcerpt: text("stdout_excerpt"),
    stderrExcerpt: text("stderr_excerpt"),
    errorCode: text("error_code"),
    contextSnapshot: jsonb("context_snapshot").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    agentStartedIdx: index("heartbeat_runs_agent_started_idx").on(t.agentId, t.startedAt),
    agentStatusIdx: index("heartbeat_runs_agent_status_idx").on(t.agentId, t.status),
  })
);

// ─── Heartbeat Run Events ─────────────────────────────────────────────────────
// Append-only event log. seq column = Kafka-style consumer offset.
// Consumer polls WHERE run_id = ? AND seq > lastSeq ORDER BY seq.
export const heartbeatRunEvents = pgTable(
  "heartbeat_run_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id),
    // monotonic per-run sequence — consumer tracks lastSeq to resume
    seq: integer("seq").notNull().default(0),
    eventType: text("event_type").notNull(), // log_chunk | status_change | cost_update | adapter_invoke
    body: jsonb("body").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runSeqIdx: index("heartbeat_run_events_run_seq_idx").on(t.runId, t.seq),
  })
);

// ─── Agent Wakeup Requests ────────────────────────────────────────────────────
// Message queue for triggering agent runs.
// Backpressure primitive: if agent busy, UPDATE deferred row (coalesce N→1).
export const agentWakeupRequests = pgTable(
  "agent_wakeup_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    source: text("source").notNull(), // user | scheduler | agent | webhook
    triggerDetail: text("trigger_detail"),
    reason: text("reason"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    // queued | claimed | coalesced | deferred_issue_execution | completed | failed
    status: text("status").notNull().default("queued"),
    // how many requests got merged into this one (backpressure counter)
    coalescedCount: integer("coalesced_count").notNull().default(0),
    requestedByActorType: text("requested_by_actor_type"),
    requestedByActorId: text("requested_by_actor_id"),
    idempotencyKey: text("idempotency_key"),
    runId: uuid("run_id"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    agentStatusIdx: index("agent_wakeup_requests_agent_status_idx").on(t.agentId, t.status),
    requestedIdx: index("agent_wakeup_requests_requested_idx").on(t.requestedAt),
  })
);

// ─── Issues ───────────────────────────────────────────────────────────────────
// Work items. Atomic checkout uses UPDATE WHERE + RETURNING (distributed mutex).
// checkoutRunId = claimed by THIS run. executionRunId = actively executing.
// If run crashes, executionRunId becomes stale — next run can adopt it.
export const issues = pgTable(
  "issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    parentId: uuid("parent_id").references((): AnyPgColumn => issues.id),
    title: text("title").notNull(),
    description: text("description"),
    // backlog | todo | in_progress | in_review | done | blocked | cancelled
    status: text("status").notNull().default("backlog"),
    priority: text("priority").notNull().default("medium"),
    assigneeAgentId: uuid("assignee_agent_id").references(() => agents.id),
    assigneeUserId: text("assignee_user_id"),
    // two-field checkout pattern (Paperclip primitive 1)
    checkoutRunId: uuid("checkout_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    executionRunId: uuid("execution_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    executionLockedAt: timestamp("execution_locked_at", { withTimezone: true }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id),
    createdByUserId: text("created_by_user_id"),
    issueNumber: integer("issue_number"),
    identifier: text("identifier"),
    requestDepth: integer("request_depth").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusIdx: index("issues_status_idx").on(t.status),
    assigneeStatusIdx: index("issues_assignee_status_idx").on(t.assigneeAgentId, t.status),
    parentIdx: index("issues_parent_idx").on(t.parentId),
    identifierIdx: uniqueIndex("issues_identifier_idx").on(t.identifier),
  })
);

// ─── Activity Log ─────────────────────────────────────────────────────────────
// Append-only audit trail. Never mutated. Insert-only.
export const activityLog = pgTable(
  "activity_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorType: text("actor_type").notNull(), // agent | user | system
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    actorIdx: index("activity_log_actor_idx").on(t.actorType, t.actorId),
    targetIdx: index("activity_log_target_idx").on(t.targetType, t.targetId),
    createdIdx: index("activity_log_created_idx").on(t.createdAt),
  })
);

// ─── Cost Events ──────────────────────────────────────────────────────────────
export const costEvents = pgTable(
  "cost_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    runId: uuid("run_id").references(() => heartbeatRuns.id),
    amountCents: integer("amount_cents").notNull(),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    agentCreatedIdx: index("cost_events_agent_created_idx").on(t.agentId, t.createdAt),
    runIdx: index("cost_events_run_idx").on(t.runId),
  })
);

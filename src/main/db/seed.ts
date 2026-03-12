/**
 * Seed — creates demo agents for first run
 * Run: DATABASE_URL=... npx ts-node src/main/db/seed.ts
 */

import { Pool } from "pg";

// DF labor map: agents opt into labor domains for autonomous issue claiming
const DEMO_AGENTS = [
  {
    name: "CEO",
    role: "executive",
    title: "Chief Executive Officer",
    adapter_type: "mock",
    adapter_config: { durationMs: 3000 },
    reports_to: null,
    labors: {},  // execs don't claim issues autonomously
  },
  {
    name: "CTO",
    role: "executive",
    title: "Chief Technology Officer",
    adapter_type: "mock",
    adapter_config: { durationMs: 2500 },
    reports_to: "CEO",
    labors: {},
  },
  {
    name: "CPO",
    role: "executive",
    title: "Chief Product Officer",
    adapter_type: "mock",
    adapter_config: { durationMs: 2000 },
    reports_to: "CEO",
    labors: {},
  },
  {
    name: "Backend",
    role: "engineer",
    title: "Backend Engineer",
    adapter_type: "mock",
    adapter_config: { durationMs: 4000 },
    reports_to: "CTO",
    labors: { backend: true, devops: false, qa: true },
  },
  {
    name: "Frontend",
    role: "engineer",
    title: "Frontend Engineer",
    adapter_type: "mock",
    adapter_config: { durationMs: 3500 },
    reports_to: "CTO",
    labors: { frontend: true, design: false, qa: true },
  },
  {
    name: "Infra",
    role: "engineer",
    title: "Infrastructure Engineer",
    adapter_type: "mock",
    adapter_config: { durationMs: 5000 },
    reports_to: "CTO",
    labors: { devops: true, backend: false, security: true },
  },
  {
    name: "PM",
    role: "product",
    title: "Product Manager",
    adapter_type: "mock",
    adapter_config: { durationMs: 2000 },
    reports_to: "CPO",
    labors: { pm: true, research: true },
  },
  {
    name: "Design",
    role: "designer",
    title: "UX Designer",
    adapter_type: "mock",
    adapter_config: { durationMs: 2200 },
    reports_to: "CPO",
    labors: { design: true, frontend: false },
  },
  {
    name: "Research",
    role: "researcher",
    title: "Market Researcher",
    adapter_type: "mock",
    adapter_config: { durationMs: 6000 },
    reports_to: "CPO",
    labors: { research: true, data: true },
  },
];

async function seed() {
  const url = process.env.DATABASE_URL || "postgres://localhost/ade";
  const pool = new Pool({ connectionString: url });

  const existing = await pool.query("SELECT count(*) as cnt FROM agents");
  if (parseInt(existing.rows[0].cnt, 10) > 0) {
    console.log("Agents already seeded, skipping.");
    await pool.end();
    return;
  }

  // Insert agents, resolving reports_to by name
  const ids = new Map<string, string>();
  for (const a of DEMO_AGENTS) {
    const reportsToId = a.reports_to ? ids.get(a.reports_to) ?? null : null;
    const { rows } = await pool.query(
      `INSERT INTO agents (name, role, title, adapter_type, adapter_config, reports_to, labors)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [a.name, a.role, a.title, a.adapter_type, JSON.stringify(a.adapter_config), reportsToId, JSON.stringify(a.labors)]
    );
    ids.set(a.name, rows[0].id);
    console.log(`Created ${a.name} (${rows[0].id}) labors=${JSON.stringify(a.labors)}`);
  }

  // Seed demo issues with required_labor so autonomous claiming routes them correctly
  const backendId = ids.get("Backend");
  const frontendId = ids.get("Frontend");
  const pmId = ids.get("PM");

  await pool.query(
    `INSERT INTO issues (title, description, status, priority, assignee_agent_id, required_labor, created_by_user_id)
     VALUES
       ('Set up CI pipeline',           'Configure GitHub Actions for builds and deploys',     'in_progress', 'high',   $1, 'devops',    'user_seed'),
       ('Implement auth layer',          'JWT-based auth with refresh tokens',                 'todo',        'high',   NULL, 'backend', 'user_seed'),
       ('Build agent canvas component',  'SVG spatial view for agent org tree',                'done',        'medium', $2, 'frontend',  'user_seed'),
       ('Dark mode design system',       'Define tokens for dark void aesthetic',              'todo',        'medium', NULL, 'design',  'user_seed'),
       ('Market sizing analysis',        'TAM/SAM/SOM for agent tooling market',               'todo',        'low',    NULL, 'research','user_seed'),
       ('API rate limiting',             'Add sliding window rate limit to all endpoints',     'todo',        'medium', NULL, 'backend', 'user_seed'),
       ('Accessibility audit',           'WCAG 2.1 AA compliance review',                     'todo',        'low',    NULL, 'frontend','user_seed'),
       ('Infra cost analysis',           'Review AWS spend, identify savings',                 'todo',        'medium', NULL, 'devops',  'user_seed')`,
    [backendId, frontendId, pmId]
  );
  console.log("Seeded issues.");

  await pool.end();
  console.log("Seed complete.");
}

seed().catch((e) => {
  console.error("Seed failed:", e);
  process.exit(1);
});

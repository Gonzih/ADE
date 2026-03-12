# ADE — Agent Development Environment

> The IDE for teams of AI agents. Spatial command center with DB-as-message-bus coordination.

![ADE screenshot placeholder](doc/screenshot.png)

---

## What it is

Karpathy was right: we don't need less IDE — we need a bigger one. The unit of interest shifted from *file* to *agent*. ADE is built for that.

- **Spatial org canvas** — zoomable SVG tree of agents with live status, pulse rings for active runs, open-issue badges
- **DB as message bus** — zero Kafka/Redis/RabbitMQ. Postgres atomic UPDATE WHERE = distributed mutex. Status enum rows = message queues. coalescedCount = backpressure
- **Agent orchestrator** — 500ms poll loop claims wakeup requests atomically, dispatches process/mock/http adapters, streams log events
- **Create agents** — modal to spawn with any adapter config, org position
- **Issues tray** — collapsible panel, status/priority color-coded, live 3s poll

Forked from Paperclip's coordination patterns. Human orgs aren't legible. Agent orgs should be.

---

## Quickstart

```bash
# 1. Prerequisites: postgres running locally (or set DATABASE_URL)
createdb ade

# 2. Install
npm install

# 3. Migrate + seed
npm run db:setup

# 4. Run (dev mode — renderer on vite:5173, main compiled)
npm run build:main
npm run electron

# Or in dev with hot reload:
npm run electron:dev
```

---

## Architecture

```
src/
├── main/                          # Electron main process (Node/CommonJS)
│   ├── db/
│   │   ├── schema.ts              # Drizzle schema
│   │   ├── client.ts              # pg Pool
│   │   ├── migrate.ts             # SQL migration runner
│   │   └── seed.ts                # Demo org seeder
│   ├── services/
│   │   └── agentOrchestrator.ts   # Poll loop + atomic claim + adapter dispatch
│   ├── index.ts                   # App init + IPC handlers
│   └── preload.ts                 # contextBridge API surface
├── renderer/                      # React UI (Vite/ESM)
│   ├── components/
│   │   ├── AgentCanvas.tsx        # Zoomable SVG spatial map
│   │   ├── AgentSidebar.tsx       # Selected agent detail + controls
│   │   ├── CreateAgentModal.tsx   # Spawn new agent
│   │   ├── IssuesList.tsx         # Bottom issues tray
│   │   └── TopBar.tsx             # Header + stats
│   ├── hooks/useAgents.ts         # 2s poll + realtime subscription
│   └── styles/globals.css         # Dark void aesthetic
└── shared/types.ts                # IPC channel names + domain types
```

---

## DB coordination primitives

From [Paperclip's DB-as-message-bus pattern](money-brain/DB_AS_MESSAGE_BUS.md):

| What you need | What ADE uses |
|---|---|
| Distributed mutex | `UPDATE WHERE status IN ('todo','backlog') RETURNING *` → zero rows = someone else got it |
| Message queue | Table rows with status enum, poll `WHERE status = 'queued'` |
| Backpressure | `coalescedCount` — N rapid wakeups merge into 1 deferred row |
| Event stream | `heartbeat_run_events` append-only + `seq` integer (Kafka offset model) |
| Dead letter | `UPDATE SET status = 'failed'` |
| Stuck run cleanup | Poll for `started_at < NOW() - INTERVAL '10 minutes'`, mark `timed_out` |

Zero external services. One Postgres.

---

## Adapters

Agents are just *callables*. Three built-in:

- **mock** — simulated run, configurable `durationMs`. Good for demo/testing.
- **process** — spawns a subprocess. `{ command, args, cwd, env }`.
- **http** — (wired, not yet fully implemented) POST to a webhook URL.

Add your own by extending `agentOrchestrator.ts#runAdapter`.

---

## Roadmap

- [ ] Drag-to-connect nodes (live org restructuring)
- [ ] Edge inspection — click edge to see context flowing between agents
- [ ] Time scrub — replay run history on the canvas
- [ ] Cost heatmap overlay — burn rate visualized spatially
- [ ] Bundle/fork org configs — export full company as portable artifact
- [ ] HTTP adapter full implementation
- [ ] claude-local adapter (Claude Code as agent)
- [ ] Multi-company / workspace support

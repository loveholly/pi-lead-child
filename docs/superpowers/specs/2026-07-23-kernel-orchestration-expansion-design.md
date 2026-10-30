# pi-lead-child Kernel Orchestration Expansion Design

## Goal

Expand `pi-lead-child` from a Pi-specific Lead/Child launcher into a runtime-neutral,
auditable orchestration kernel that can:

1. run Pi, Codex, and Claude Code as child runtimes behind one contract;
2. represent a complex objective as a parent ticket plus dependency-aware subtickets;
3. resolve repositories into durable logical projects and merge multiple repositories into
   one project without losing provenance;
4. turn repeated failures and rework into project-scoped learning candidates, reusable
   capabilities, and executable evaluations;
5. expose the new state through the existing daemon control plane without breaking the
   current Companion client.

The daemon remains the Coordinator scheduler/runtime host. The Coordinator business boundary
is a DB-backed transactional domain layer that can be loaded by the daemon, CLI, Pi extension,
and MCP tool process. Lead is a reasoning client of that boundary, not the Coordinator itself.

## Locked Decisions

### Coordinator boundary

The Coordinator is a deterministic DB-backed domain service. It owns all business invariants
for tickets, projects, attempts, dependencies, budgets, dispatch, and capability promotion.

Lead, CLI commands, and children express intent through Coordinator methods or tools. Runtime
adapters do not write business state directly. Pi extensions and the MCP server may open the
shared SQLite database, but must call the same transactional Coordinator methods used by Lead
and the daemon rather than duplicating rules. Shared state such as dispatch claims is durable
in SQLite; in-memory runtime handles remain daemon-only.

The first implementation is a shared service/library, not a new microservice. Every current
writer (`plc create`, `plc work`, Lead tools, Pi extension, MCP tools, schedulers) must route
through it. This preserves the deployment model while creating a stable boundary that can
later be served over local RPC if stronger process isolation requires it.

### Runtime-neutral core

`provider/model` is not a runtime identifier. A child assignment has three independent
dimensions:

- `runtime`: `pi`, `codex`, or `claude`;
- `model`: runtime-specific model name, nullable to use runtime defaults;
- `purpose`: execution, review, integration, or learning.

The Coordinator records all three on the attempt. Existing callers that only provide a
model continue to use `runtime=pi`.

### Visible orchestration only

Runtime-native subagents are not the source of truth. A child that wants to delegate must
create Coordinator subtickets. This guarantees that every delegated unit has:

- a ticket ID and parent/root relationship;
- an attempt history;
- explicit dependency edges;
- project, budget, and workdir scope;
- observable runtime events and review evidence.

Native subagents may still be used internally by a runtime, but they do not satisfy a
delegated work item unless their result is represented in the Coordinator ledger.

### Tree for ownership, DAG for execution

Parent-child relationships answer “who owns this work?”. Dependency edges answer “what
must finish before this can run?”. A tree alone cannot express parallel and serial phases,
so both are first-class.

### Status compatibility

The existing ticket status enum remains unchanged. Parent orchestration uses a separate
`orchestration_state` field:

- `none`: ordinary ticket;
- `planning`: an orchestrator is decomposing work;
- `waiting`: required descendants are still running;
- `integrating`: descendants are ready and the parent is consolidating results.

A waiting parent remains `in_progress`. This avoids a destructive SQLite table rebuild. The
strict protocol-v2 ticket projection remains byte-for-byte shape compatible and continues to
map these states to its existing `running`/`idle` values. New orchestration states are exposed
only through separate kernel snapshot resources.

### Review semantics

Top-level tickets retain Lead/user acceptance. Automatically dispatched subtickets default
to `review_policy=automatic`:

1. executor moves the subticket to `review`;
2. Coordinator dispatches an independent reviewer attempt;
3. reviewer submits a structured verdict;
4. pass moves the subticket to `done` as a Coordinator decision;
5. fail moves it back to `in_progress`, records rework evidence, and redispatches an
   executor within retry limits.

This prevents a parent from consuming unreviewed leaf output while retaining the existing
manual acceptance flow for user-visible objectives.

### Project knowledge is structured state

Project/repository associations are not notes. Notes may remember naming preferences, but
authoritative mappings live in `projects`, `project_repositories`, and project change
history.

### Learning is gated promotion

One failure creates evidence, not an automatically trusted tool. Promotion follows:

`candidate -> draft capability -> evaluating -> active`

Global or privileged capabilities require human approval. Project-local documentation and
read-only evaluations can be activated automatically after deterministic evaluation.

## Architecture

```text
Channels (CLI / Slack / Companion)
                 |
                 v
             Lead agent
                 |
       Coordinator tool facade
                 |
                 v
  +----------------------------------+
  | Coordinator domain service      |
  | - tickets / projects             |
  | - hierarchy / dependency DAG     |
  | - dispatch policy / budgets      |
  | - review policy                  |
  | - learning / capability registry |
  +----------------------------------+
          |                 |
          v                 v
     SQLite ledger      Runtime registry
                          |    |    |
                          Pi Codex Claude
                          |    |    |
                          +----+----+
                               |
                     normalized runtime events
                               |
                        ingest + control plane
```

## Runtime Contract

### Types

```ts
export type RuntimeId = "pi" | "codex" | "claude";

export interface RuntimeCapabilities {
  streaming: boolean;
  steering: boolean;
  resume: boolean;
  interrupt: boolean;
  approvals: boolean;
  mcp: boolean;
}

export interface RuntimeStartRequest {
  ticketId: number;
  attemptId: number;
  role: "executor" | "reviewer";
  purpose: "execution" | "review" | "integration" | "learning";
  prompt: string;
  workdir: string;
  model?: string;
  resumeSessionId?: string;
  env: Record<string, string>;
}

export interface AgentRuntime {
  readonly id: RuntimeId;
  readonly capabilities: RuntimeCapabilities;
  start(request: RuntimeStartRequest): Promise<RuntimeHandle>;
}

export interface RuntimeHandle {
  readonly pid: number | null;
  readonly events: AsyncIterable<RuntimeEvent>;
  send?(message: string): Promise<void>;
  steer?(message: string): Promise<void>;
  interrupt(reason: string): Promise<void>;
  wait(): Promise<RuntimeExit>;
}

export type RuntimeEventPayload =
  | { type: "run.started"; seq: number; occurredAt: string; runtime: RuntimeId; model: string | null }
  | { type: "session.updated"; seq: number; occurredAt: string; externalSessionId: string; runtimeVersion?: string }
  | { type: "message.delta"; seq: number; occurredAt: string; messageId: string; delta: string }
  | { type: "message.completed"; seq: number; occurredAt: string; messageId: string; role: "assistant"; text: string; stopReason?: string }
  | { type: "tool.started"; seq: number; occurredAt: string; callId: string; name: string; args: unknown }
  | { type: "tool.updated"; seq: number; occurredAt: string; callId: string; name: string; update: unknown }
  | { type: "tool.completed"; seq: number; occurredAt: string; callId: string; name: string; result: unknown }
  | { type: "tool.failed"; seq: number; occurredAt: string; callId: string; name: string; error: string }
  | { type: "usage.updated"; seq: number; occurredAt: string; mode: "delta" | "cumulative"; inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number | null }
  | { type: "run.completed"; seq: number; occurredAt: string; exitCode: number; reason?: string }
  | { type: "run.failed"; seq: number; occurredAt: string; exitCode: number | null; errorCode: string; error: string }
  | { type: "runtime.stderr"; seq: number; occurredAt: string; text: string };

export type RuntimeEvent = RuntimeEventPayload & { attemptId: number };

export interface RuntimeExit {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  externalSessionId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}
```

One attempt represents one OS process run/turn. Resuming a Codex thread or Claude session
creates a new attempt that references the same `external_session_id`; attempt identity never
changes or spans process restarts.

### Normalized events

The kernel consumes only normalized events:

- `run.started`
- `session.updated`
- `message.delta`
- `message.completed`
- `tool.started`
- `tool.updated`
- `tool.completed`
- `tool.failed`
- `usage.updated`
- `run.completed`
- `run.failed`
- `runtime.stderr`

Every normalized event has `attemptId`, monotonically increasing `seq`, ISO `occurredAt`, and
an event-specific payload. Usage events declare `mode: "delta" | "cumulative"`; ingest stores
the last cumulative value per attempt and never double-counts. Exactly one terminal
`run.completed` or `run.failed` event is persisted. Native payloads may be retained in a
bounded `raw` field for audit, but no business rule depends on a runtime-native event name.

SQLite `runtime_events` is authoritative. In one SQLite transaction the Coordinator inserts
the event, advances the cursor, and sets `attempts.event_log_dirty=1`. It then appends the same
normalized JSON record to
`<dataDir>/runtime-events/attempt-<id>.jsonl`. `attempts.session_path` points to this derived log
for every runtime, including Pi; Pi's native session path is retained in attempt metadata. If
file append and durable flush succeed, a second SQLite transaction clears the dirty flag. A
crash at any earlier point therefore leaves it dirty. Startup and L3 reads reconcile a
dirty/missing/divergent file by atomically rewriting and fsyncing it from SQLite, then clear
the flag. Fault injection after DB commit, after append, and before dirty-clear must prove no
event loss or double counting.

### Pi adapter

The Pi adapter preserves the current long-lived RPC behavior:

- starts `pi --mode rpc` with ticket and web extensions;
- retrieves session metadata through `get_state`;
- sends `prompt`, `steer`, and interrupt/kill operations;
- maps Pi agent/message/tool events into normalized events;
- supports linger and context-preserving steering.

Linger is purpose-aware. Manual top-level executor tickets may retain the current linger
window. Executors on automatic-review tickets terminate immediately when they enter review;
planners terminate immediately after sealing and entering waiting; integration/reviewer
attempts terminate at turn end. The next claim is not eligible until the previous handle has
exited and its dispatch claim is completed. This prevents an old executor/planner from
mutating state while reviewer or integration work is active.

### Codex adapter

The first production adapter uses `codex exec --json`:

- `--sandbox workspace-write` for executor/integration/learning and `read-only` for reviewer;
- `--cd <ticket workdir>`;
- optional `--model`;
- JSONL stdout mapped to normalized thread, turn, item, usage, and error events;
- SIGTERM/SIGKILL interruption;
- external thread ID recorded when emitted;
- resume through `codex exec resume <thread-id>` when available.

Codex is one-shot per turn. It does not advertise steering. A follow-up creates a resumed
turn when possible or a new attempt when resume is unavailable.

### Claude adapter

The first production adapter uses Claude Code print mode:

- `claude -p --output-format stream-json --verbose`;
- `--permission-mode acceptEdits` for executor/integration/learning;
- reviewer is restricted to static review with `plan` and read-only tools. Executable review
  is assigned only to a runtime advertising enforceable read-only command execution (Codex
  initially); Claude is not eligible for executable automatic review;
- optional `--model` and `--resume`;
- stream-json system, assistant, tool, usage, result, and error messages normalized;
- SIGTERM/SIGKILL interruption;
- external session ID recorded from the init/result stream.

The adapter advertises resume but not in-turn steering. A future Agent SDK adapter can add
true bidirectional input without changing Coordinator contracts.

### Runtime-neutral child tools

Codex and Claude receive a per-attempt local MCP server. Pi keeps native extensions but the
tool behavior is implemented by the same Coordinator facade.

Minimum tools:

- `ticket_update`
- `notify_lead`
- `request_approval`
- `create_subticket`
- `add_dependency`
- `finish_planning`
- `list_descendants`
- `review_verdict`
- `register_capability`
- `request_capability_evaluation`

The MCP server derives ticket and attempt identity from environment variables. Callers
cannot choose another root ticket or project. Coordinator validation rejects scope escape,
cycles, depth overflow, fanout overflow, and budget overflow. Tool processes perform only
transactional ledger commands. Runtime start/stop remains daemon-owned and is triggered from
durable dispatch claims.

## Data Model

### Ticket extensions

```sql
ALTER TABLE tickets ADD COLUMN project_id INTEGER REFERENCES projects(id);
ALTER TABLE tickets ADD COLUMN parent_ticket_id INTEGER REFERENCES tickets(id);
ALTER TABLE tickets ADD COLUMN root_ticket_id INTEGER REFERENCES tickets(id);
ALTER TABLE tickets ADD COLUMN created_by_attempt_id INTEGER REFERENCES attempts(id);
ALTER TABLE tickets ADD COLUMN orchestration_state TEXT NOT NULL DEFAULT 'none';
ALTER TABLE tickets ADD COLUMN requested_runtime TEXT;
ALTER TABLE tickets ADD COLUMN requested_model TEXT;
ALTER TABLE tickets ADD COLUMN purpose TEXT NOT NULL DEFAULT 'execution';
ALTER TABLE tickets ADD COLUMN review_policy TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE tickets ADD COLUMN max_depth INTEGER;
ALTER TABLE tickets ADD COLUMN max_children INTEGER;
ALTER TABLE tickets ADD COLUMN max_concurrency INTEGER;
ALTER TABLE tickets ADD COLUMN token_budget INTEGER;
ALTER TABLE tickets ADD COLUMN cost_budget_usd REAL;
ALTER TABLE tickets ADD COLUMN retry_limit INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tickets ADD COLUMN active_plan_revision INTEGER;
```

`project` remains as a compatibility projection of the project name. New writes set both
`project_id` and `project`. Migration backfills projects from distinct existing values.

### Dependencies

```sql
CREATE TABLE ticket_dependencies (
  parent_ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  plan_revision INTEGER NOT NULL,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  depends_on_ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  kind TEXT NOT NULL DEFAULT 'blocks',
  created_by_attempt_id INTEGER REFERENCES attempts(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (parent_ticket_id, plan_revision, ticket_id, depends_on_ticket_id),
  CHECK (ticket_id <> depends_on_ticket_id)
);
```

Both tickets must be siblings with memberships in the same parent plan revision. Cross-parent
dependency edges are not supported in this iteration. Coordinator performs
recursive cycle detection before insert. A child ticket can independently open and seal its
own plan revision even when the root or its parent revision is already sealed; this is how
nested child-child delegation remains legal and auditable.

### Attempt extensions

```sql
ALTER TABLE attempts ADD COLUMN runtime TEXT NOT NULL DEFAULT 'pi';
ALTER TABLE attempts ADD COLUMN purpose TEXT NOT NULL DEFAULT 'execution';
ALTER TABLE attempts ADD COLUMN runtime_version TEXT;
ALTER TABLE attempts ADD COLUMN external_session_id TEXT;
ALTER TABLE attempts ADD COLUMN event_cursor TEXT;
ALTER TABLE attempts ADD COLUMN exit_code INTEGER;
ALTER TABLE attempts ADD COLUMN error_code TEXT;
ALTER TABLE attempts ADD COLUMN error_message TEXT;
ALTER TABLE attempts ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';
ALTER TABLE attempts ADD COLUMN cost_known INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attempts ADD COLUMN event_log_dirty INTEGER NOT NULL DEFAULT 0;
```

```sql
CREATE TABLE runtime_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id INTEGER NOT NULL REFERENCES attempts(id),
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  UNIQUE(attempt_id, seq)
);

CREATE TABLE dispatch_claims (
  ticket_id INTEGER PRIMARY KEY REFERENCES tickets(id),
  attempt_id INTEGER NOT NULL UNIQUE REFERENCES attempts(id),
  request_id INTEGER NOT NULL UNIQUE REFERENCES dispatch_requests(id),
  lease_token TEXT NOT NULL UNIQUE,
  lease_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE dispatch_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  role TEXT NOT NULL,
  purpose TEXT NOT NULL,
  runtime TEXT,
  model TEXT,
  plan_owner_ticket_id INTEGER REFERENCES tickets(id),
  plan_revision INTEGER,
  trigger TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE review_verdicts (
  attempt_id INTEGER PRIMARY KEY REFERENCES attempts(id),
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  verdict TEXT NOT NULL,
  evidence TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE ticket_plan_revisions (
  parent_ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  revision INTEGER NOT NULL,
  state TEXT NOT NULL,
  created_by_attempt_id INTEGER REFERENCES attempts(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sealed_at TEXT,
  PRIMARY KEY (parent_ticket_id, revision)
);

CREATE TABLE ticket_plan_memberships (
  parent_ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  revision INTEGER NOT NULL,
  child_ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  required INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (parent_ticket_id, revision, child_ticket_id),
  FOREIGN KEY (parent_ticket_id, revision)
    REFERENCES ticket_plan_revisions(parent_ticket_id, revision)
);
```

### Projects

```sql
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  confidence REAL NOT NULL DEFAULT 1.0,
  max_concurrency INTEGER,
  merged_into_project_id INTEGER REFERENCES projects(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE project_repositories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  repo_root TEXT NOT NULL UNIQUE,
  remote_url TEXT,
  repo_name TEXT NOT NULL,
  role TEXT,
  confidence REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE project_aliases (
  alias TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE project_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '{}',
  before_state TEXT,
  after_state TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Learning and capabilities

```sql
CREATE TABLE learning_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id),
  scope_key TEXT NOT NULL,
  ticket_id INTEGER REFERENCES tickets(id),
  attempt_id INTEGER REFERENCES attempts(id),
  fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '{}',
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  confidence REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'candidate',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(scope_key, fingerprint, status)
);

CREATE TABLE capabilities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id),
  scope_key TEXT NOT NULL,
  type TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  scope TEXT NOT NULL DEFAULT 'project',
  status TEXT NOT NULL DEFAULT 'draft',
  summary TEXT NOT NULL,
  asset_path TEXT,
  evaluator_path TEXT,
  source_candidates TEXT NOT NULL DEFAULT '[]',
  provenance TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(scope_key, slug, version)
);

CREATE TABLE capability_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  capability_id INTEGER NOT NULL REFERENCES capabilities(id),
  ticket_id INTEGER REFERENCES tickets(id),
  attempt_id INTEGER REFERENCES attempts(id),
  outcome TEXT NOT NULL,
  metrics TEXT NOT NULL DEFAULT '{}',
  evidence TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Schema upgrades are versioned in `schema_migrations`. Each migration is transactional,
rerunnable by version, and ends with row-count checks plus `PRAGMA foreign_key_check`. The
first kernel migration backfills every existing top-level ticket with `root_ticket_id=id`,
creates projects from legacy names, synchronizes `project_id`, and best-effort registers
canonical git roots from existing ticket workdirs. Reopening an upgraded database performs
no additional writes.

## Project Resolution

Ticket creation resolves project in this order:

1. explicit project ID/name/alias supplied by Lead;
2. repository mapping for the canonical git root of `workdir`;
3. normalized git remote identity;
4. repository basename as a new project;
5. no git repository: leave `project_id` null and compatibility `project` null.

Resolution uses bounded `git -C <workdir>` commands with no shell interpolation. A new
repository-derived project records `created_by=system:repo-resolution` and confidence 0.8.

Project merge is transactional:

- resolve source/target through `canonicalProjectId` so stale merged IDs redirect safely;
- move repository mappings, tickets, learning candidates, capabilities, and active learning
  tickets to the target;
- preserve source slug/name as aliases;
- mark source `merged` with `merged_into_project_id`;
- rewrite every affected compatibility `tickets.project` value to the target project name;
- record before/after state and reason in project changes;
- retain existing ticket history unchanged.

Before rewriting candidate scope keys, matching source/target candidates are aggregated:
occurrence counts are summed, confidence keeps the maximum plus a merge provenance marker,
evidence arrays are deduplicated and bounded, and the source duplicate is removed in the same
transaction. Capability collisions compare immutable content hashes: identical versions
coalesce with merged provenance; different content is assigned the next target version before
the source scope key is rewritten.

The `returns` example becomes one project with buyer and seller repository rows carrying
their respective roles. Capability assets do not live in either repository. Coordinator owns
them under `<dataDir>/capabilities/projects/<project-id>/<slug>/v<version>/`, so a multi-repo
project has one unambiguous capability namespace.

## Orchestration Flow

### Creating subtickets

`create_subticket` derives the parent from the calling attempt and accepts:

- title, brief, priority;
- purpose and preferred runtime/model;
- dependency IDs already created under the same root;
- no immediate dispatch flag; newly planned children are always unsealed;
- optional narrower workdir inside the project scope.

Coordinator checks:

- caller attempt is active and owns the parent ticket;
- maximum depth and child count;
- dependency root consistency and acyclicity;
- workdir is within the project/repository scope;
- root token/cost budget has not been exceeded.

Planning is revisioned per parent ticket. `ticket_plan_revisions` owns the revision state;
`ticket_plan_memberships` records which children participate in each revision, and dependency
edges store the same parent and revision. An existing completed child may be retained by
adding a membership in a later revision without changing or duplicating the child ticket.
The orchestrator may either call one atomic `create_work_plan` command or create
subtickets/dependencies incrementally and then call `finish_planning`. Sealing:

- validates the complete graph and marks that parent revision sealed;
- creates idempotent dispatch requests for eligible required children in that revision;
- moves the parent to `waiting`;
- rejects any later child/dependency mutation for that revision.

Adding a dependency to a claimed, running, review, or terminal ticket is always rejected.
A replan explicitly opens a new revision after all current-revision claims are settled. It
may supersede prior-revision membership/edges without deleting audit history. Parent
integration evaluates only children and dependencies belonging to the currently sealed
revision. Nested children manage separate revision sequences on their own ticket IDs.

### Dispatch scheduler

The daemon runs a short orchestration tick in addition to the existing time scheduler.
A dispatch request is eligible according to purpose:

- executor/learning: ticket is `backlog`, `assigned`, or retryable `blocked`;
- reviewer: ticket is `review`, policy is automatic, and it has no active reviewer or verdict;
- integration: ticket is `in_progress` with `orchestration_state=integrating`.

In every case:

- the current `dispatch_requests` row is `state='pending'`;
- when `plan_owner_ticket_id` is non-null, the ticket has a membership in that sealed parent
  plan revision. Root requests have no membership requirement; authorization is enforced when
  the request is created from its Lead, CLI, schedule, recovery, integration, or learning trigger;
- every dependency is `done`;
- no active attempt exists;
- root and project concurrency limits permit it;
- root budget permits it.

The requested role, purpose, runtime, model, plan owner, revision, trigger, and idempotency key
are persisted in `dispatch_requests`. Request states are
`pending -> claimed -> started -> completed|failed|cancelled`. A logical trigger uses one
idempotency key, so replay cannot enqueue another pending request. Explicit Lead reviewer
requests use `trigger=lead` and may run on manual-review tickets; automatic reviewer requests
require automatic policy.

The scheduler claims work transactionally by creating a `starting` attempt plus a durable
`dispatch_claims` lease in the same transaction. The primary-key claim prevents another tick
or process from claiming the ticket. A successful runtime start moves the request to `started`
and retains the claim until the attempt ends. Failed start ends the attempt, completes/removes
the claim, moves the request to failed or a new retry request with a new retry ordinal, and creates
learning evidence. Restart recovery reclaims expired leases before considering redispatch.
Reviewer failure is retried while its reviewer retry budget remains; exhaustion leaves the
child in `review`, records an orchestration failure, blocks its parent/root through
orchestration state and inbox notification, and does not attempt the illegal
`review -> blocked` status transition.

Orphan recovery starts from the original dispatch request/claim, not ticket ID alone, and
therefore preserves role, purpose, runtime, model, trigger, plan owner, and revision.

### Parent resumption

When every required child in the sealed revision is `done`, Coordinator sets the parent to `integrating` and
requests a new attempt using the parent ticket's preferred runtime/model. The integration
prompt includes a compact descendant summary and instructs the parent to verify combined
results, resolve remaining child issues, and move itself to review.

If any child is terminally cancelled or exceeds retry limits, the parent becomes blocked
with a structural notification.

### Budgets

Effective limits are inherited from the root ticket and bounded by environment defaults.
The Coordinator checks descendant totals, not only the current ticket. Project concurrency
uses `projects.max_concurrency` with an environment default. Exceeding a soft
threshold produces attention; exceeding a hard threshold prevents new dispatch and blocks
the root pending Lead action. A runtime that cannot report cost may still run under token
budgets, but is rejected when a hard USD budget is configured unless an explicit
runtime/model cost estimator exists. Unknown cost is never treated as zero.

## Learning Flow

### Capture

The kernel creates or increments a candidate on:

- process spawn failure or crash;
- runtime turn failure;
- reviewer failure;
- review-to-in-progress rework;
- repeated blocked transitions with the same normalized reason.

Fingerprints use stable normalized inputs: project, failure kind, error code, tool name,
and a scrubbed error signature. Paths, IDs, timestamps, and volatile numbers are removed.

### Candidate threshold

Default promotion threshold is two occurrences in one project. A severe safety failure may
create a draft immediately. At threshold, Coordinator:

1. creates a draft capability record;
2. creates one project-scoped learning ticket if none is active for the fingerprint;
3. asks the learning child to produce a concise `SKILL.md`, optional deterministic tool,
   and an evaluator script under `.pi-lead-child/capabilities/<slug>/`;
4. keeps the capability inactive until evaluation evidence exists.

### Evaluation and activation

The child may register a draft capability and request evaluation, but cannot report the
outcome. Coordinator hashes every asset, copies the immutable version into its capability
directory, and executes the evaluator itself with an argv array, bounded cwd, timeout, output
limit, and no shell interpolation. The run records asset/evaluator hashes, exit code, and
output digest. Any asset mutation creates a new version and invalidates prior evidence.

Project-scoped `skill`, `runbook`, and non-privileged `evaluator` capabilities become active
after at least one Coordinator-owned passing run and no failing run for the same immutable
version. Executable tools, network actions, global scope, or policy hooks require an approval
before activation. Global uniqueness uses a non-null scope key rather than nullable
`project_id` uniqueness.

Active capabilities are summarized in child prompts with exact paths. They are never
silently injected into global user configuration.

`scope_key` is always non-null: `project:<canonical-project-id>` for project scope and
`global` for global scope. Project merge rewrites project-scoped keys transactionally and
resolves collisions by preserving immutable versions or incrementing the target version.

## Control-plane Compatibility

Protocol v2 is frozen. Existing v2 endpoint response bodies and strict TypeBox schemas do not
gain fields or enum values. `project: string | null` remains populated for the current
Companion UI, and orchestration states map onto existing runtime states.

New authenticated kernel resources use separate schemas and routes under `/v1/kernel/*`:

- ticket hierarchy/orchestration snapshot;
- attempt runtime/event snapshot;
- detailed projects/repositories;
- learning candidates/capabilities.

The current Companion must continue to pass its existing protocol/client tests unchanged.
Future UI adoption may consume kernel resources without forcing an immediate protocol-v3
migration. A protocol v3 is required before adding fields to existing DTOs.

## Error Handling and Recovery

- Runtime spawn errors become crashed attempts, blocked tickets, inbox blockers, and
  learning candidates.
- Invalid runtime output is recorded as a bounded parse-error event; excessive malformed
  output fails the attempt instead of hanging.
- Daemon restart reclaims all active runtime attempts using the existing orphan policy.
- Dependency cycles and cross-root edges fail before any write.
- Scheduler claims are idempotent and protected by SQLite transactions.
- Project merge is all-or-nothing.
- Capability activation is reversible; deactivation never deletes assets or evidence.

## Security

- Codex runs with `workspace-write`, never danger-full-access by default.
- Claude runs with bounded permission modes and no permission bypass by default.
- Reviewer runtimes receive read-only instructions and tool restrictions where supported.
- Executable automatic review requires a runtime capability that enforces read-only command
  execution. Static-only Claude review is never used to satisfy an executable acceptance
  criterion. Reviewer verdict writes are idempotent per attempt, and attempted workspace
  mutation must fail or invalidate the review by post-run diff/hash checks.
- MCP identity is injected by the Coordinator; callers cannot impersonate another ticket.
- Child-created workdirs must remain inside registered project repository roots unless Lead
  explicitly approves an additional directory.
- Global and privileged capabilities require human approval.

## Testing Strategy

### Unit and migration tests

- old database migration and compatibility projection;
- project resolution, aliasing, merge, and rollback;
- hierarchy depth, fanout, root consistency, and dependency cycle checks;
- dispatch readiness, concurrency, retry, and budget checks;
- failure fingerprinting and candidate aggregation;
- capability lifecycle and activation gates;
- runtime-native event normalization.
- versioned migration row-count/foreign-key validation and no-op reopen;
- durable runtime-event replay and L3 audit for each runtime;
- fault-injected DB-to-JSONL reconciliation;
- claim lease uniqueness and expiration recovery;
- purpose-specific executor/reviewer/integration claims and reviewer exhaustion;
- nested delegation plus dependency-changing replan across parent-local revisions;
- nonzero-linger automatic review/integration handoff;
- dispatch request replay/idempotency and purpose-preserving orphan recovery;
- replan retaining one prior completed child while replacing another;
- project merge with duplicate candidates and conflicting capability versions;
- forged evaluation evidence and post-evaluation asset mutation rejection.

### Adapter integration tests

Each adapter is tested against a fake executable that emits the native JSONL/stream format.
Tests assert process arguments, normalized events, interruption, session IDs, usage, and
exit semantics.

### End-to-end kernel test

A daemon starts with a fake Lead session and fake runtime registry. The test creates a root
ticket, runs a planner that creates parallel and dependent subtickets through the MCP tool
plane, dispatches them, runs automatic reviewers, resumes the parent integration attempt,
and verifies final ledger/control-plane state.

### Local real-runtime smoke tests

When installed and authenticated, run one bounded no-op ticket through local Codex and one
through local Claude Code in temporary git repositories. The task writes a marker file,
calls `ticket_update`, and exits. The test verifies the marker, attempt runtime/session
metadata, normalized events, and review state. These smoke tests are opt-in and never run in
the default CI suite.

## Non-goals for This Iteration

- replacing the Pi-based Lead runtime;
- remote/public execution workers;
- container or VM sandbox orchestration;
- automatic git worktree creation and merge automation;
- unrestricted recursive delegation;
- silently installing global skills, hooks, or tools;
- changing the current Companion information architecture.

## Acceptance Criteria

1. Existing Pi child behavior and current tests remain compatible.
2. Codex and Claude adapters can execute a ticket through the shared manager and persist
   runtime/session/usage/exit metadata.
3. A child can create a bounded ticket DAG; independent leaves run in parallel and serial
   leaves wait for dependencies.
4. Automatic subticket review gates downstream execution; the root returns to integration
   only after required descendants are done.
5. Ticket creation defaults to repository project identity, and two repositories can be
   transactionally merged into one logical project with history.
6. Repeated failures create one aggregated learning candidate, one draft capability, and a
   learning ticket; a passing evaluation can activate an allowed project capability.
7. Separate kernel snapshots expose hierarchy, runtime, project, and capability state while
   existing strict v2 snapshots and the current Companion remain unchanged.
8. Full unit/integration tests, TypeScript compilation, build, daemon E2E, and available
   real-runtime smoke tests pass.

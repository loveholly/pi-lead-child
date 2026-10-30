# Kernel Orchestration Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `pi-lead-child` into a runtime-neutral Coordinator with project-aware ticket DAGs and a gated failure-learning loop, while preserving the existing Pi, daemon, gateway, and Companion behavior.

**Architecture:** Add a deterministic Coordinator domain service over SQLite, place Pi/Codex/Claude behind one normalized runtime contract, and let Lead/child tools call the same service. Parent ownership is represented by ticket hierarchy, execution order by dependency edges, and repeated failures by a candidate/capability lifecycle. Existing protocol v2 fields remain compatible; new fields and resources are additive.

**Tech Stack:** TypeScript, Node.js child processes, SQLite/better-sqlite3, Pi RPC, Codex JSONL, Claude Code stream-json, MCP stdio JSON-RPC, TypeBox, Vitest, Expo Companion protocol package.

**Design Spec:** `docs/superpowers/specs/2026-07-23-kernel-orchestration-expansion-design.md`

---

## File Map

### New kernel modules

- `src/coordinator/service.ts`: ticket/project/orchestration/learning facade and invariant enforcement.
- `src/coordinator/policy.ts`: bounded configuration and effective root limits.
- `src/coordinator/dispatch.ts`: dependency readiness, durable lease claims, parent resumption.
- `src/coordinator/project-resolver.ts`: bounded git identity and logical project resolution.
- `src/runtimes/types.ts`: runtime contract and normalized events.
- `src/runtimes/event-queue.ts`: async event queue shared by process adapters.
- `src/runtimes/registry.ts`: runtime lookup and default registry.
- `src/runtimes/pi.ts`: Pi RPC adapter.
- `src/runtimes/codex.ts`: Codex exec JSONL adapter/parser.
- `src/runtimes/claude.ts`: Claude Code stream-json adapter/parser.
- `src/agent-tools/definitions.ts`: runtime-neutral tool schemas and Coordinator handlers.
- `src/agent-tools/mcp-server.ts`: stdio MCP transport for Codex/Claude.
- `src/store/projects.ts`: project/repository/alias/change persistence.
- `src/store/dependencies.ts`: ticket dependency persistence/query helpers.
- `src/store/runtime-events.ts`: append-only normalized runtime events and JSONL audit logs.
- `src/store/learning.ts`: candidates, immutable capabilities, and Coordinator evaluation runs.
- `src/pipeline/orchestrator.ts`: daemon orchestration and learning tick.

### Existing modules to modify

- `src/store/schema.ts`, `src/store/db.ts`, `src/store/types.ts`: additive schema and versioned migration.
- `src/store/tickets.ts`, `src/store/attempts.ts`: hierarchy/runtime fields and compatible writes.
- `src/children/manager.ts`: delegate process lifecycle to runtime registry.
- `src/extension/ticket-tools.ts`: use shared agent-tool handlers and add delegation/review/learning tools.
- `src/lead/tools.ts`, `src/lead/prompt.ts`, `src/config.ts`, `src/lead/session.ts`, `src/cli.ts`: route every writer through the Coordinator facade.
- `src/pipeline/ingest.ts`, `src/pipeline/scheduler.ts`, `src/pipeline/watchdog.ts`: normalized events and orchestration semantics.
- `src/daemon/server.ts`: runtime registry, orchestrator tick, control-plane events, recovery.
- `src/gateway/control-plane.ts`, `src/gateway/paired-server.ts`: additive snapshots/endpoints.
- `packages/protocol/src/index.ts`: separate kernel schemas; existing v2 schemas stay frozen.
- `scripts/build.ts`, `package.json`: include the MCP entrypoint in distributable builds.

### Test fixtures

- `test/fake-codex.ts`, `test/fake-claude.ts`: native event streams and failure scenarios.
- `test/fake-agent-mcp-client.ts`: Task 6 minimal stdio MCP client fixture.
- New test files listed per task below.

## TDD Execution Rule

Every behavior listed in a task is implemented as its own RED/GREEN cycle: add one focused
assertion, run the narrow test and confirm the expected missing-export or wrong-behavior
failure, implement only that behavior, rerun the narrow test, then run the task regression
set. A task does not batch production implementation before observing each focused failure.
Because the working tree already contains user-owned uncommitted work, checkpoints are test
evidence and plan checkbox updates rather than mixed commits.

## Task 1: Additive schema and migration foundation

**Files:**
- Modify: `src/store/schema.ts`
- Modify: `src/store/db.ts`
- Modify: `src/store/types.ts`
- Modify: `src/store/tickets.ts`
- Modify: `src/store/attempts.ts`
- Create: `src/coordinator/service.ts`
- Test: `test/kernel-schema-migration.test.ts`
- Test: `test/tickets.test.ts`
- Test: `test/attempts.test.ts`

- [ ] **Step 1: Write migration tests before production changes**

Create an old-format database containing the current tables, reopen it through `openDb`,
and assert that all additive ticket/attempt columns and new tables exist. Assert existing
rows preserve status, project string, and attempts; every old ticket gets `root_ticket_id=id`;
legacy projects are backfilled; repository mappings are derived where possible; migration
version and row counts are stable on reopen; `PRAGMA foreign_key_check` is empty.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npx vitest run test/kernel-schema-migration.test.ts`

Expected: FAIL because the new columns/tables are absent.

- [ ] **Step 3: Add schema and idempotent migration**

Add ticket hierarchy/orchestration/budget/revision-membership columns, attempt runtime/error
and event-log repair columns, project, parent-local plan revision, revisioned dependency,
runtime-event, dispatch-request/claim, review-verdict, learning scope-key, capability, and
capability-run tables plus indexes. Add `schema_migrations`; each migration must:

- add only missing columns;
- backfill `root_ticket_id=id` for existing tickets;
- create one active project for every distinct non-null legacy `tickets.project` value;
- set `tickets.project_id` to that project;
- best-effort register canonical roots for existing git workdirs;
- validate row counts and foreign keys;
- remain a no-op when `openDb` runs repeatedly.

- [ ] **Step 4: Extend TypeScript row types and compatible DAO writes**

Existing `createTicket` and `createAttempt` calls must still compile and retain old defaults.
New fields are optional arguments with deterministic defaults.

Create the Coordinator service shell and route root ticket creation plus legacy-compatible
attempt creation through it. Later tasks add methods to this existing service; no task may
write a domain invariant in a pipeline/adapter first and move it later.

- [ ] **Step 5: Run focused and existing store tests**

Run: `npx vitest run test/kernel-schema-migration.test.ts test/store-db.test.ts test/tickets.test.ts test/attempts.test.ts test/ticket-attrs.test.ts`

Expected: PASS.

## Task 2: First-class projects and repository resolution

**Files:**
- Create: `src/store/projects.ts`
- Create: `src/coordinator/project-resolver.ts`
- Modify: `src/coordinator/service.ts`
- Modify: `src/store/tickets.ts`
- Test: `test/projects.test.ts`
- Test: `test/project-resolution.test.ts`

- [ ] **Step 1: Write failing project lifecycle tests**

Cover create/find by slug and alias, repository link, summary update with change history,
transactional merge, compatibility `tickets.project` synchronization, and duplicate repo
mapping rejection.

- [ ] **Step 2: Write failing git resolution tests**

Create temporary git repositories with and without remotes. Assert resolution by explicit
project, registered canonical root, normalized remote, repo basename fallback, and null for
non-git directories.

- [ ] **Step 3: Verify RED**

Run: `npx vitest run test/projects.test.ts test/project-resolution.test.ts`

- [ ] **Step 4: Implement project persistence and bounded git probing**

Use `execFileSync("git", [...], { timeout })`, never shell strings. Normalize remote URLs
without credentials. Project merge must run in one SQLite transaction and preserve aliases
and project change evidence.

- [ ] **Step 5: Route Coordinator ticket creation through project resolution**

Explicit project wins. Otherwise resolve from `workdir`. Set both `project_id` and legacy
`project` name.

- [ ] **Step 6: Verify focused tests**

Run: `npx vitest run test/projects.test.ts test/project-resolution.test.ts test/ticket-attrs.test.ts`

Expected: PASS.

## Task 3: Coordinator ticket hierarchy and dependency DAG

**Files:**
- Create: `src/coordinator/policy.ts`
- Create: `src/store/dependencies.ts`
- Modify: `src/coordinator/service.ts`
- Modify: `src/store/tickets.ts`
- Test: `test/coordinator-tickets.test.ts`
- Test: `test/ticket-dependencies.test.ts`

- [ ] **Step 1: Write failing hierarchy tests**

Assert root creation, child/root propagation, calling-attempt ownership, inherited project,
depth and fanout limits, workdir scope, planning revision lifecycle, and parent orchestration state.

- [ ] **Step 2: Write failing DAG tests**

Assert same-root edges, duplicate idempotency, cross-root rejection, direct and transitive
cycle rejection, dependency readiness, and deterministic child/descendant queries. Assert
dispatch is impossible before `finishPlanning`, sealing validates the entire graph, and
dependency mutation is rejected after seal or claim. Cover nested child-owned planning and a
dependency-changing replan that supersedes, but does not delete, the prior revision.

- [ ] **Step 3: Verify RED**

Run: `npx vitest run test/coordinator-tickets.test.ts test/ticket-dependencies.test.ts`

- [ ] **Step 4: Implement Coordinator service and policies**

Expose narrow methods:

```ts
createRootTicket(input): number
createSubticket(context, input): number
addDependency(context, ticketId, dependsOnId): void
createWorkPlan(context, input): number[]
finishPlanning(context): number
reopenPlanning(context): number
listChildren(ticketId): Ticket[]
listDescendants(ticketId): Ticket[]
listDependencies(ticketId): TicketDependency[]
markWaiting(ticketId): void
```

All validation occurs before writes or inside one transaction.

- [ ] **Step 5: Verify focused and transition tests**

Run: `npx vitest run test/coordinator-tickets.test.ts test/ticket-dependencies.test.ts test/transition.test.ts`

Expected: PASS.

## Task 4: Runtime contract and native event parsers

**Files:**
- Create: `src/runtimes/types.ts`
- Create: `src/runtimes/event-queue.ts`
- Create: `src/runtimes/codex.ts`
- Create: `src/runtimes/claude.ts`
- Create: `test/fake-codex.ts`
- Create: `test/fake-claude.ts`
- Test: `test/runtime-events.test.ts`
- Test: `test/codex-runtime.test.ts`
- Test: `test/claude-runtime.test.ts`

- [ ] **Step 1: Write parser tests from captured real event fixtures**

Codex fixtures cover `thread.started`, `turn.started`, command/agent items, usage, completed,
error, malformed line, and non-zero exit. Claude fixtures cover `system/init`, assistant text
and tool blocks, result success/error, session/cost/usage, hooks ignored, malformed line, and
non-zero exit.

Add focused argv/process tests before adapter code: executor and reviewer sandbox flags, cwd,
environment isolation, MCP-only config, model selection, resume invocation, SIGTERM followed
by bounded SIGKILL escalation, and malformed-output limits. Expected RED failures are missing
adapter exports first, then incorrect argv/event values one assertion at a time.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run test/runtime-events.test.ts test/codex-runtime.test.ts test/claude-runtime.test.ts`

- [ ] **Step 3: Implement async event queue and normalized types**

The queue must deliver events in order, terminate exactly once, and propagate process-level
failure without leaving consumers blocked. Normalized events define monotonic sequence,
delta/cumulative usage semantics, and exactly one terminal event.

- [ ] **Step 4: Implement Codex adapter**

Default executor args: `exec --json --sandbox workspace-write --skip-git-repo-check --ignore-user-config --cd <workdir>`.
Reviewer uses `--sandbox read-only` and advertises enforceable read-only execution.
Inject only Coordinator MCP config. Parse stdout line-by-line, bound raw payloads, capture
thread ID and usage, and expose interrupt/wait.

Run `test/codex-runtime.test.ts` after each of: argv, success events, usage/session metadata,
resume, malformed output, interrupt, and nonzero exit.

- [ ] **Step 5: Implement Claude adapter**

Default executor args: `-p --output-format stream-json --verbose --safe-mode --permission-mode acceptEdits`.
Inject only Coordinator MCP config. Reviewer uses plan/read-only tools and is marked static
only, so it cannot satisfy executable acceptance criteria. Capture
session ID, model, cost, usage, and terminal result.

Run `test/claude-runtime.test.ts` after each of: argv, success events, usage/session metadata,
resume, hook filtering, malformed output, interrupt, and nonzero exit.

- [ ] **Step 6: Verify adapter tests**

Run: `npx vitest run test/runtime-events.test.ts test/codex-runtime.test.ts test/claude-runtime.test.ts`

Expected: PASS with fake executables and no network.

## Task 5: Pi adapter and generic Child Manager

**Files:**
- Create: `src/runtimes/pi.ts`
- Create: `src/runtimes/registry.ts`
- Create: `src/store/runtime-events.ts`
- Modify: `src/coordinator/service.ts`
- Modify: `src/children/manager.ts`
- Modify: `src/children/rpc-client.ts`
- Modify: `src/pipeline/ingest.ts`
- Modify: `src/pipeline/watchdog.ts`
- Modify: `src/pipeline/scheduler.ts`
- Modify: `src/lead/tools.ts`
- Test: `test/pi-runtime.test.ts`
- Test: `test/manager-multiruntime.test.ts`
- Modify: `test/manager.test.ts`
- Modify: `test/steer-stop.test.ts`

- [ ] **Step 1: Write failing Pi normalization tests**

Assert current fake Pi events map to normalized run/message/tool/usage events and retain
session metadata, steering, linger, crash, and spawn-failure behavior. Assert Pi native
session metadata is retained while `attempt.session_path` points to normalized JSONL.

- [ ] **Step 2: Write failing generic manager tests**

Run one ticket through each fake runtime. Assert attempt runtime/model/session/exit fields,
ticket transitions, usage totals without cumulative double-counting, durable `runtime_events`,
restart/replay, generic L3 audit, live handle registration, and unsupported steering error.
Fault-inject failure between authoritative SQLite commit and derived JSONL append; assert
`event_log_dirty` reconciliation rewrites the log without event loss or duplication.

Assert resume creates a new attempt that carries the previous external session ID, builds the
correct Codex `exec resume` and Claude `--resume` argv, and falls back to a fresh session when
the adapter does not support resume.

- [ ] **Step 3: Verify RED**

Run: `npx vitest run test/pi-runtime.test.ts test/manager-multiruntime.test.ts`

- [ ] **Step 4: Implement Pi adapter and registry**

Preserve dependency injection for fake Pi. Registry accepts test adapters and resolves
`pi`, `codex`, and `claude` defaults.

- [ ] **Step 5: Refactor manager around `AgentRuntime`**

Keep public `runTicket`, `liveChildren`, `killIdleChildren`, and validation compatibility.
Add Coordinator methods for attempt creation, normalized event persistence, transitions,
completion, failure, and usage accounting. Manager, ingest, watchdog, time scheduler, and Lead
L3 auditing become thin callers. The time scheduler must create tickets through Coordinator.

- [ ] **Step 6: Verify all child lifecycle tests**

Run: `npx vitest run test/manager.test.ts test/pi-runtime.test.ts test/manager-multiruntime.test.ts test/linger.test.ts test/steer-stop.test.ts test/reviewer.test.ts test/ingest.test.ts test/ingest-m3.test.ts`

Expected: PASS.

## Task 6: Runtime-neutral agent tool plane

**Files:**
- Create: `src/agent-tools/definitions.ts`
- Create: `src/agent-tools/mcp-server.ts`
- Create: `test/fake-agent-mcp-client.ts`
- Modify: `src/extension/ticket-tools.ts`
- Modify: `src/config.ts`
- Modify: `scripts/build.ts`
- Test: `test/agent-tool-handlers.test.ts`
- Test: `test/mcp-server.test.ts`
- Modify: `test/extension.test.ts`
- Modify: `test/approvals.test.ts`

- [ ] **Step 1: Write failing handler tests**

Call handlers directly for ticket update, notification, approval, create subticket with
dependencies, atomic work plan, finish planning, and descendant listing. Assert identity/scope
cannot be overridden by tool arguments. Reviewer-verdict and capability tools are added only
after their domain methods exist in Tasks 7 and 8.

- [ ] **Step 2: Write failing MCP protocol tests**

Spawn the MCP server, send newline-delimited JSON-RPC `initialize`, `tools/list`, and
`tools/call`, and assert valid MCP responses plus bounded invalid-request errors.

- [ ] **Step 3: Verify RED**

Run: `npx vitest run test/agent-tool-handlers.test.ts test/mcp-server.test.ts`

- [ ] **Step 4: Implement shared handlers and thin Pi registration**

Pi extension schemas call handlers. MCP tool schemas call the same handlers. Approval
polling remains abortable. No tool contains duplicate transition or hierarchy logic.

- [ ] **Step 5: Generate per-attempt MCP configuration**

Codex and Claude adapters receive command/args/env pointing at the source entrypoint in dev
and bundled entrypoint in production. Prompt lists exact tool names and delegation rules.

- [ ] **Step 6: Verify tool-plane tests**

Run: `npx vitest run test/agent-tool-handlers.test.ts test/mcp-server.test.ts test/extension.test.ts test/approvals.test.ts`

Expected: PASS.

## Task 7: Dependency-aware orchestration and automatic subticket review

**Files:**
- Create: `src/coordinator/dispatch.ts`
- Create: `src/pipeline/orchestrator.ts`
- Modify: `src/coordinator/service.ts`
- Modify: `src/daemon/server.ts`
- Modify: `src/lead/tools.ts`
- Modify: `src/config.ts`
- Modify: `src/pipeline/ingest.ts`
- Modify: `src/agent-tools/definitions.ts`
- Modify: `src/agent-tools/mcp-server.ts`
- Modify: `src/extension/ticket-tools.ts`
- Test: `test/orchestrator.test.ts`
- Test: `test/automatic-review.test.ts`
- Test: `test/orchestration-budget.test.ts`

- [ ] **Step 1: Write failing readiness/concurrency tests**

Assert parallel siblings are both claimable only after graph sealing, dependent siblings
wait, active attempts are not duplicated, project/root concurrency is enforced, and durable
lease claims are idempotent across concurrent ticks and recover after expiration.

Assert request states and idempotency keys prevent replayed review/integration triggers,
successful starts retain claims until attempt completion, and orphan recovery preserves role,
purpose, runtime, model, trigger, plan owner, and revision.

- [ ] **Step 2: Write failing automatic review tests**

Executor review transition requests an eligible reviewer runtime. Passing idempotent verdict
moves an automatic subticket to done. Failing reviewer creates rework evidence and redispatches
within retry limit. Reviewer crash follows bounded retry. Executable review cannot select a
static-only runtime, attempted reviewer writes fail or invalidate review, and manual root
ticket remains review pending Lead.

Cover purpose-specific eligibility explicitly: executor/learning on runnable tickets,
reviewer on automatic `review`, and integration on `in_progress+integrating`. Reviewer
exhaustion must leave status `review` and block orchestration without an illegal transition.

Run the same automatic review and integration handoff with nonzero Pi linger. Assert the
executor/planner handle exits before the reviewer/integration claim starts. Manual top-level
executor linger must remain intact.

- [ ] **Step 3: Write failing parent-resumption and budget tests**

Parent remains waiting until all required children are done, then enters integrating and is
redispatched. Cancelled/exhausted child blocks parent. Descendant token/cost totals gate new
dispatch.

Budget cases must cover soft-threshold attention, hard token-budget root blocking, USD-budget
rejection for unknown-cost runtimes, and acceptance when an explicit estimator is configured.

- [ ] **Step 4: Verify RED**

Run: `npx vitest run test/orchestrator.test.ts test/automatic-review.test.ts test/orchestration-budget.test.ts`

- [ ] **Step 5: Implement transactional dispatcher and daemon tick**

The dispatcher creates a starting attempt plus lease claim atomically; daemon owns actual
process starts and consumes the lease token. Failed starts restore dispatch intent according
to retry policy and emit structural inbox/learning evidence.

Add Coordinator methods for dispatch request creation, claim, start acknowledgement,
completion/failure, reviewer verdict, retry, and parent integration. Register `review_verdict`
in both Pi and MCP tool planes only after these methods pass focused tests.

- [ ] **Step 6: Verify orchestration tests and daemon recovery**

Run: `npx vitest run test/orchestrator.test.ts test/automatic-review.test.ts test/orchestration-budget.test.ts test/daemon.test.ts test/watchdog.test.ts test/scheduler.test.ts`

Expected: PASS.

## Task 8: Failure learning and capability lifecycle

**Files:**
- Create: `src/store/learning.ts`
- Create: `src/coordinator/learning.ts`
- Modify: `src/coordinator/service.ts`
- Modify: `src/pipeline/ingest.ts`
- Modify: `src/store/tickets.ts`
- Modify: `src/pipeline/orchestrator.ts`
- Modify: `src/store/projects.ts`
- Modify: `src/agent-tools/definitions.ts`
- Modify: `src/agent-tools/mcp-server.ts`
- Modify: `src/extension/ticket-tools.ts`
- Test: `test/learning-candidates.test.ts`
- Test: `test/capabilities.test.ts`
- Test: `test/learning-orchestrator.test.ts`

- [ ] **Step 1: Write failing fingerprint and aggregation tests**

Assert volatile paths, IDs, timestamps, and numbers normalize; repeated same-project
failures increment one candidate; different projects/kinds remain separate.

- [ ] **Step 2: Write failing capability gate tests**

Assert draft creation at threshold, one learning ticket per fingerprint, Coordinator-owned
data-dir path containment, canonical project merge behavior, immutable asset/evaluator hashes,
Coordinator-executed evaluation, forged evidence rejection, mutation invalidation, automatic
activation for safe types, approval requirement for global/privileged types, non-null global
`scope_key` uniqueness, project-scope key rewrite on merge, versioned deprecation, and active
capability prompt rendering.

- [ ] **Step 3: Verify RED**

Run: `npx vitest run test/learning-candidates.test.ts test/capabilities.test.ts test/learning-orchestrator.test.ts`

- [ ] **Step 4: Implement capture and lifecycle**

Wire spawn/crash/runtime/reviewer/rework failures to candidate recording. Threshold creates
draft metadata and a learning ticket. Registration copies immutable assets into the
Coordinator capability directory. Evaluation requests are executed by Coordinator with argv,
cwd, timeout, output, and hash bounds; only owned results move capabilities through states.

Register `register_capability` and `request_capability_evaluation` in Pi/MCP only after the
Coordinator lifecycle exists. Project merge tests include duplicate candidate aggregation and
conflicting immutable capability versions.

- [ ] **Step 5: Verify focused tests**

Run: `npx vitest run test/learning-candidates.test.ts test/capabilities.test.ts test/learning-orchestrator.test.ts test/ingest-m3.test.ts test/reviewer.test.ts`

Expected: PASS.

## Task 9: Lead tools and reasoning policy

**Files:**
- Modify: `src/lead/tools.ts`
- Modify: `src/lead/prompt.ts`
- Modify: `src/lead/session.ts`
- Modify: `src/config.ts`
- Modify: `src/cli.ts`
- Test: `test/lead-kernel-tools.test.ts`
- Modify: `test/lead-tools.test.ts`
- Modify: `test/lead-session.test.ts`

- [ ] **Step 1: Write failing tool contract tests**

Cover runtime selection, create/update/merge project, hierarchy queries, dependency queries,
learning candidates, capability state, backwards-compatible `spawn_child(model)`, and CLI
create/work routing through Coordinator without invariant-bypassing direct writes.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run test/lead-kernel-tools.test.ts`

- [ ] **Step 3: Route Lead tools through Coordinator**

Expose runtime and project as distinct parameters. Keep aliases for existing tools. Tool
descriptions require visible subtickets for delegation and explain parallel versus serial
dependency semantics.

- [ ] **Step 4: Update Lead and child prompts**

Lead learns project associations through structured tools, chooses runtime independently
from model, and treats learning activation as evidence-gated. Child prompts describe MCP/Pi
tool names, DAG rules, review policy, and active project capabilities.

- [ ] **Step 5: Verify Lead tests**

Run: `npx vitest run test/lead-kernel-tools.test.ts test/lead-tools.test.ts test/lead-session.test.ts test/reviewer.test.ts`

Expected: PASS.

## Task 10: Frozen protocol-v2 and separate kernel snapshots

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Modify: `src/gateway/control-plane.ts`
- Modify: `src/gateway/paired-server.ts`
- Modify: `src/daemon/server.ts`
- Test: `test/kernel-protocol-contract.test.ts`
- Modify: `test/control-plane.test.ts`
- Modify: `test/paired-http.test.ts`
- Modify: `test/protocol-contract.test.ts`

- [ ] **Step 1: Write failing kernel contract tests**

Validate separate kernel ticket, attempt, project, dependency, learning, and capability
schemas. Existing strict v2 fixtures and response shapes must remain valid unchanged, with no
new fields or enum values.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run test/kernel-protocol-contract.test.ts test/protocol-contract.test.ts`

- [ ] **Step 3: Implement separate projections and endpoints**

Add:

- `GET /v1/kernel/projects/:id`
- `GET /v1/kernel/tickets/:id`
- `GET /v1/kernel/tickets/:id/children`
- `GET /v1/kernel/tickets/:id/dependencies`
- `GET /v1/kernel/attempts/:id`
- `GET /v1/kernel/attempts/:id/events`
- `GET /v1/kernel/learning/candidates`
- `GET /v1/kernel/capabilities`
- `POST /v1/tickets` guarded by `tickets:create`, routed through Coordinator

All use existing authentication and `tickets:view` scope for read-only data. Existing v2
events and their strict union remain unchanged. Kernel state is refreshed using existing
`ticket.updated`/snapshot-required hints and explicit kernel snapshot fetches; no new event
type is added to the v2 WebSocket channel in this iteration.

- [ ] **Step 4: Verify protocol and HTTP tests**

Run: `npx vitest run test/kernel-protocol-contract.test.ts test/protocol-contract.test.ts test/control-plane.test.ts test/paired-http.test.ts test/paired-protocol-v2.test.ts`

Expected: PASS.

- [ ] **Step 5: Run the unchanged Companion contract suite**

Run the Companion unit and type checks without changing its current v2 parsing code. This
proves the expanded daemon did not introduce strict-schema regressions.

## Task 11: End-to-end orchestration and real-runtime smoke verification

**Files:**
- Create: `test/kernel-e2e.test.ts`
- Create: `scripts/smoke-runtime.ts`
- Modify: `docs/ACCEPTANCE.md`
- Modify: `docs/DESIGN-GATEWAY.md`
- Modify: `package.json`

- [ ] **Step 1: Write the daemon E2E test first**

Start a daemon with a fake Lead and three fake runtime adapters. Drive this exact flow:

1. root planner starts;
2. planner creates `planning`, two parallel execution leaves, a serial integration leaf,
   and dependency edges through the MCP tool plane;
3. dispatcher starts eligible leaves in parallel;
4. each executor moves to review;
5. automatic reviewers pass;
6. serial child starts only after dependencies are done;
7. parent resumes integration and moves to review;
8. one injected repeated failure creates a candidate, draft capability, learning ticket,
   and passing evaluation activates a project capability;
9. kernel snapshots expose the complete tree and runtime metadata while v2 stays unchanged.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run test/kernel-e2e.test.ts`

- [ ] **Step 3: Implement missing integration glue only**

Do not weaken assertions or bypass Coordinator APIs.

- [ ] **Step 4: Run the full automated verification matrix**

Run:

```bash
npx tsc --noEmit
npm test
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 5: Run daemon/process smoke tests**

Start the built daemon against a temporary data directory, create/pair a local control-plane
client, create a ticket through the new Coordinator-backed authenticated API, dispatch a fake runtime, receive
ordered WebSocket events, fetch final v2 and kernel snapshots, prove the v2 body shape is
unchanged, and shut down cleanly.

- [ ] **Step 6: Run available real runtime smoke tests**

Run one temporary-repo marker task with local `codex` and one with local `claude`, using
strict cost/time limits and Coordinator MCP tools. If local auth is unavailable, report the
exact command and error; do not claim that adapter as end-to-end verified.

- [ ] **Step 7: Document operational configuration and acceptance evidence**

Document runtime selection, binaries, model defaults, policy env vars, project merge tools,
orchestration limits, capability paths, smoke commands, and observed versions.

## Final Review Gate

- [ ] Re-read the design acceptance criteria line by line and map each to test evidence.
- [ ] Run `git diff --check`.
- [ ] Run `npx tsc --noEmit`, `npm test`, and `npm run build` again after all review fixes.
- [ ] Run the unchanged Companion contract/type suite.
- [ ] Review the full diff for accidental changes to pre-existing user work.
- [ ] Perform an independent code review focused on migrations, process cleanup, scheduler
      races, permission boundaries, and hidden Pi-only assumptions.

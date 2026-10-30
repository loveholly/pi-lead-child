# Checkpoint Control Plane UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add lightweight child-agent Checkpoints, authoritative approval/decision interventions, durable Lead conversation cards, ticket timing, and the approved high-fidelity ticket UX without changing the frozen paired protocol v2 event union.

**Architecture:** New additive kernel resources sit beside the frozen v2 summaries and events. SQLite remains the source of truth: domain mutations, append-only checkpoints, durable conversation-card projections, and existing v2 outbox rows commit in the same transaction. The Companion normalizes these resources into its existing isolated Zustand stores, reconciles durable cards with transient live parts by stable card key, and renders grouped ticket work, contextual interventions, and ticket-detail feeds on Web, Android, and iOS.

**Tech Stack:** TypeScript, SQLite/`better-sqlite3`, TypeBox, Vitest, Node HTTP/WebSocket control plane, Expo 57, React 19, React Native 0.86, Expo Router, Zustand 5, Unistyles 3, React Native Reanimated.

**Design Spec:** `docs/superpowers/specs/2026-07-24-checkpoint-control-plane-ux-design.md`

**Execution status (2026-07-24):** Implemented and independently reviewed. The checkboxes below
remain the original TDD execution script; fresh acceptance evidence is recorded in
`docs/ACCEPTANCE.md` (`112/578` backend tests, `24/155` Companion tests, build, daemon/Codex/Claude
smoke, and Web/Android/iOS exports).

---

## Execution Topology

Use one implementation agent per task. Agents must not edit outside their assigned file list unless the coordinator explicitly transfers ownership. The coordinator integrates and runs the cross-cutting verification after each wave.

### Wave 1A: independent foundations

- Task 1 owns shared kernel protocol resource schemas.
- Task 7 runs in parallel and owns pure workspace display-model/component files only.

### Wave 1B: persistence foundation

- Task 2 starts after Task 1 exports stable resource names and owns SQLite schema, migration,
  append-only stores, and timing.

### Wave 2A: transaction authority and planning lifecycle

- Task 3 starts after Task 2 and owns the single transactional checkpoint/intervention service,
  Lead resolution tools, planning/delegation lifecycle hooks, and all authority/event-order
  semantics.

### Wave 2B: independent policy and projection

- Task 4 starts after Task 3 and owns child tools, prompts, checkpoint policy, runtime attempt
  start/crash and child-completion lifecycle hooks.
- Task 5 runs in parallel with Task 4 and owns Lead tool-operation card projection; it consumes
  Task 2 store APIs and does not edit the Coordinator service.

### Wave 2C: public read/control plane

- Task 6 starts after Tasks 4 and 5, exposes their stable APIs over paired HTTP, routes every
  existing paired/AiSH/expiry resolution entry point through Task 3's transaction service, and
  owns daemon-start recovery checkpoints/repair.

### Wave 3: Companion integration

- Task 8 starts after Task 6 and owns client and Zustand resource integration.
- Task 9 starts after Task 8 and owns Lead conversation-card rendering and action wiring.
- Task 10 starts after Tasks 7-9 and owns final UX integration, documentation, and end-to-end
  acceptance.

Shared hot files must be edited sequentially:

- `src/store/schema.ts`, `src/store/db.ts`, `src/store/types.ts`: Task 2 only.
- `src/coordinator/service.ts`: Task 3 only. Tasks 4-6 consume its exported APIs.
- `src/lead/tools.ts`, `src/lead/prompt.ts`: Task 3 only.
- `src/gateway/control-plane.ts`, `src/gateway/paired-server.ts`: Task 6 only.
- `apps/companion/src/state/types.ts`, `runtime.ts`, `hooks.ts`, and control-plane store files: Task 8 only.
- `apps/companion/src/features/chat/MessagePartView.tsx` and `LeadConversation.tsx`: Task 9 only.

## Frozen Compatibility Rules

- Do not add fields to existing protocol v2 `TicketSummary`, `GatewayEvent`, or paired envelope schemas.
- Do not introduce new WebSocket event types. All live invalidation uses the existing event matrix defined in the design spec.
- Additive kernel response schemas live in dedicated protocol modules and are exported from `packages/protocol/src/index.ts`.
- Public workbench/card responses expose only `KernelInterventionRef`; full intervention payloads require `approvals:respond`.
- Checkpoint ordering is canonical database-ID ascending. Default and cursor pages return ascending arrays; the UI reverses only in selectors when needed.
- New child calls cannot create approval requests without checkpoint context. Legacy pending approvals are repaired idempotently during migration/startup.
- No artifact data may be fabricated. Unsupported artifact views render a real empty/unsupported state.

---

### Task 1: Additive Kernel Protocol Resources

**Owner boundary:** `packages/protocol/**` and protocol contract tests only.

**Files:**
- Create: `packages/protocol/src/checkpoints.ts`
- Create: `packages/protocol/src/interventions.ts`
- Create: `packages/protocol/src/workbench.ts`
- Create: `packages/protocol/src/conversation-cards.ts`
- Modify: `packages/protocol/src/index.ts`
- Test: `test/kernel-checkpoint-protocol.test.ts`
- Test: `test/kernel-protocol-contract.test.ts`
- Test: `test/paired-protocol-v2.test.ts`

- [ ] **Step 1: Write failing schema contract tests**

Assert exact Checkpoint kind/source unions, field limits, per-kind validation, timing schema, decision request schema, safe/full intervention projections, operation-card bounds metadata, card stable keys, work-item groups, workbench response shape, and cursor query/response schemas.

- [ ] **Step 2: Prove frozen v2 remains unchanged**

Add negative assertions that existing v2 summaries/events still reject additive checkpoint, timing, progress, and intervention fields.

- [ ] **Step 3: Run RED**

Run:

```bash
npx vitest run test/kernel-checkpoint-protocol.test.ts test/kernel-protocol-contract.test.ts test/paired-protocol-v2.test.ts
```

Expected: new imports/schemas fail; existing frozen-v2 tests continue passing.

- [ ] **Step 4: Implement focused TypeBox schemas and inferred types**

Use string literal unions, not TypeScript enums, so runtime validation and serialized wire values have one source of truth. Export constants for code-side switch statements where useful.

- [ ] **Step 5: Run GREEN and package build**

Run:

```bash
npx vitest run test/kernel-checkpoint-protocol.test.ts test/kernel-protocol-contract.test.ts test/paired-protocol-v2.test.ts
npm run build
```

Expected: PASS with no generated changes outside `packages/protocol`.

---

### Task 2: SQLite Migration, Append-Only Stores, and Ticket Timing

**Owner boundary:** `src/store/**` plus store/migration tests. Do not implement Coordinator policy or HTTP handlers.

**Files:**
- Modify: `src/store/schema.ts`
- Modify: `src/store/db.ts`
- Modify: `src/store/types.ts`
- Modify: `src/store/tickets.ts`
- Modify: `src/store/approvals.ts`
- Create: `src/store/checkpoints.ts`
- Create: `src/store/decision-requests.ts`
- Create: `src/store/conversation-cards.ts`
- Create: `src/store/timing.ts`
- Test: `test/checkpoints.test.ts`
- Test: `test/decision-requests.test.ts`
- Test: `test/conversation-cards-store.test.ts`
- Test: `test/ticket-timing.test.ts`
- Modify: `test/kernel-schema-migration.test.ts`

- [ ] **Step 1: Write failing migration and store tests**

Cover fresh install and v10 upgrade; nullable `approvals.attempt_id`; checkpoint append-only behavior; idempotency keys; semantic dedupe window; ascending cursor pages; structured decisions; card stable-key upsert; 16-row operation bounding; 16 KiB payload cap; timing backfill; and reviewer-attempt exclusion from active execution time.

- [ ] **Step 2: Run RED**

Run:

```bash
npx vitest run test/checkpoints.test.ts test/decision-requests.test.ts test/conversation-cards-store.test.ts test/ticket-timing.test.ts test/kernel-schema-migration.test.ts
```

Expected: missing tables/functions/columns.

- [ ] **Step 3: Add migration version and tables**

Create `checkpoints`, `decision_requests`, and `conversation_cards`; add nullable foreign-key column `approvals.attempt_id`; add ticket timing columns `first_started_at`, `completed_at`, and `status_changed_at`; add indexes required by ticket, attempt, session, card key, intervention state, and checkpoint cursor queries.

- [ ] **Step 4: Implement pure stores**

Keep checkpoint rows immutable after insert. Card writes use stable key as the logical identity and database ID as storage identity. Reject over-limit checkpoint/card content before SQLite writes.

- [ ] **Step 5: Implement timing transitions and backfill**

Update ticket transition SQL atomically: first execution sets `first_started_at`, terminal completion sets `completed_at`, reopening clears terminal timing only where specified by the design, and every status transition sets `status_changed_at`. Compute elapsed/active values from attempts without treating reviewer attempts as child execution.

- [ ] **Step 6: Add idempotent legacy approval repair primitive**

Expose store-level query/update primitives that detect pending approvals or pending decision
requests lacking a checkpoint/card and record deterministic repair rows using
`legacy-approval:<id>` and `legacy-decision:<id>` keys without emitting events. Domain event
publication remains Task 3.

- [ ] **Step 7: Run GREEN and full store regression**

Run:

```bash
npx vitest run test/checkpoints.test.ts test/decision-requests.test.ts test/conversation-cards-store.test.ts test/ticket-timing.test.ts test/kernel-schema-migration.test.ts test/tickets.test.ts test/approvals.test.ts test/attempts.test.ts
npm run build
```

Expected: PASS.

---

### Task 3: Transactional Checkpoint and Intervention Domain Services

**Owner boundary:** new Coordinator domain modules, `src/coordinator/service.ts`, approval integration, and exact event-order tests. Store SQL remains Task 2 ownership.

**Files:**
- Create: `src/coordinator/checkpoints.ts`
- Create: `src/coordinator/interventions.ts`
- Create: `src/coordinator/workbench.ts`
- Modify: `src/coordinator/service.ts`
- Modify: `src/lead/tools.ts`
- Modify: `src/lead/prompt.ts`
- Modify: `src/store/approvals.ts`
- Modify: `src/store/gateway-events.ts`
- Test: `test/coordinator-checkpoints.test.ts`
- Test: `test/interventions.test.ts`
- Test: `test/checkpoint-outbox-order.test.ts`
- Modify: `test/coordinator-tickets.test.ts`
- Modify: `test/orchestrator.test.ts`
- Modify: `test/approvals.test.ts`
- Modify: `test/lead-tools.test.ts`
- Modify: `test/lead-session.test.ts`

- [ ] **Step 1: Write failing domain transaction tests**

Assert one transaction contains authoritative mutation, inbox write/consumption, checkpoint/card
projection, and outbox rows. Assert rollback removes all of them if any write fails.

- [ ] **Step 2: Encode the exact frozen-v2 event matrix in tests**

Required order:

```text
submit checkpoint: ticket.updated
request approval: approval.required -> ticket.updated
resolve approval: approval.resolved -> ticket.updated
create/resolve decision: ticket.updated
card-only lead tool update: lead.tool.*
card update with known ticket: lead.tool.* -> ticket.updated
```

Also assert deterministic lifecycle order without inventing event types:

```text
finish_planning: existing planning/ticket event when already emitted -> ticket.updated
child ticket created: existing ticket event when already emitted -> parent ticket.updated
child ticket completed: existing ticket/attempt event when already emitted -> parent ticket.updated
attempt start: attempt.started -> ticket.updated
attempt crash: attempt.updated -> ticket.updated
attempt recovery: attempt.started or attempt.updated -> ticket.updated
```

The final `ticket.updated` row is required only when the lifecycle transaction created or changed
a checkpoint/card, exactly as specified by the frozen-v2 matrix.

- [ ] **Step 3: Run RED**

Run:

```bash
npx vitest run test/coordinator-checkpoints.test.ts test/interventions.test.ts test/checkpoint-outbox-order.test.ts
```

- [ ] **Step 4: Implement transactional services**

Expose typed methods for submit checkpoint, create/resolve/expire decision,
create/resolve/expire approval with checkpoint context, ticket workbench read model, safe/full
intervention reads, and legacy pending approval/decision repair.

- [ ] **Step 5: Integrate planning and delegation lifecycle checkpoints**

Within the existing Coordinator transactions:

- `finishPlanning` writes `plan-sealed:<ticketId>:<revision>` as a system milestone;
- child creation writes `subticket-created:<parentId>:<childId>` as a parent delegation
  checkpoint with `relatedTicketIds=[childId]`;
- child completion uses the shared lifecycle service and deterministic
  `subticket-completed:<parentId>:<childId>:<attemptId>` key;
- retries do not duplicate checkpoint, card, activity, or outbox rows.

Add focused planning/delegation tests before proceeding.

- [ ] **Step 6: Enforce authority separation**

Checkpoints may reference approval/decision IDs but never resolve them. Resolution methods validate scope, current state, selected option/custom text rules, and actor identity before writing a resolution checkpoint.

- [ ] **Step 7: Route Lead authority tools through the domain service**

Keep `resolve_approval` as a user-decision relay and add `resolve_decision_request`. Update Lead
prompt rules so Lead may autonomously resolve only `lead`/`lead_or_user` decision audiences, never
approve on behalf of a user, and records channel-attributed user instructions accurately. Add
tests for audience restrictions, identical retries, contradictory retries, and prompt wording.

- [ ] **Step 8: Run GREEN and regression**

Run:

```bash
npx vitest run test/coordinator-checkpoints.test.ts test/interventions.test.ts test/checkpoint-outbox-order.test.ts test/coordinator-tickets.test.ts test/orchestrator.test.ts test/approvals.test.ts test/gateway-events.test.ts test/lead-tools.test.ts test/lead-session.test.ts
npm run build
```

Expected: PASS.

---

### Task 4: Child Tools, Prompt Discipline, and Checkpoint Policy

**Owner boundary:** agent tool schemas/handlers, child prompt/config, pipeline lifecycle policy, and their tests. Do not edit HTTP/Companion files.

**Files:**
- Modify: `src/agent-tools/definitions.ts`
- Modify: `src/agent-tools/mcp-server.ts`
- Modify: `src/config.ts`
- Modify: `src/children/manager.ts`
- Modify: `src/pipeline/orchestrator.ts`
- Modify: `src/pipeline/watchdog.ts`
- Create: `src/coordinator/checkpoint-policy.ts`
- Test: `test/checkpoint-tools.test.ts`
- Test: `test/checkpoint-policy.test.ts`
- Modify: `test/agent-tool-handlers.test.ts`
- Modify: `test/manager-multiruntime.test.ts`
- Modify: `test/watchdog.test.ts`
- Modify: `test/orchestrator-pipeline.test.ts`

- [ ] **Step 1: Write failing tool-policy tests**

Cover `submit_checkpoint`, `request_decision`, approval checkpoint context, atomic
`ticket_update(status=review|blocked, checkpoint=...)`, invalid kind/payload combinations,
dedupe/rate limits, deterministic attempt-start/crash and child-completion hooks, and identical
behavior across Pi, Codex, and Claude runtime adapters.

- [ ] **Step 2: Write failing prompt tests**

Assert child instructions describe milestone reporting, blocking decisions/approvals, delegation checkpoints, and one atomic completion call:

```text
ticket_update(status='review', checkpoint={kind:'completed', ...})
```

- [ ] **Step 3: Write failing silence-watchdog tests**

Inject clocks/config and cover the documented defaults, activity counters, cooldown, reminder suppression after a semantic checkpoint, and no fake checkpoint creation from raw runtime noise.

- [ ] **Step 4: Run RED**

Run:

```bash
npx vitest run test/checkpoint-tools.test.ts test/checkpoint-policy.test.ts test/agent-tool-handlers.test.ts test/manager-multiruntime.test.ts test/watchdog.test.ts test/orchestrator-pipeline.test.ts
```

- [ ] **Step 5: Implement tools and atomic transition validation**

New child calls must fail closed if an approval or terminal/blocked transition lacks checkpoint context. Keep legacy compatibility only where the design explicitly allows it; do not synthesize success evidence.

- [ ] **Step 6: Implement runtime lifecycle hooks**

- actual attempt start writes `attempt-start:<attemptId>` once and sets ticket timing;
- crash writes `attempt-crash:<attemptId>` as a system blocked checkpoint;
- child completion writes the parent milestone through Task 3's shared lifecycle API;
- terminal/replayed runtime events do not duplicate rows;
- all corresponding existing attempt events precede the broad `ticket.updated` invalidation.

- [ ] **Step 7: Implement policy and configuration**

Read the six `PLC_CHECKPOINT_*` environment variables with validation. System-derived checkpoints are limited to deterministic lifecycle facts; reminders ask the child to report but do not masquerade as agent-reported progress.

- [ ] **Step 8: Run GREEN and runtime regressions**

Run:

```bash
npx vitest run test/checkpoint-tools.test.ts test/checkpoint-policy.test.ts test/agent-tool-handlers.test.ts test/manager-multiruntime.test.ts test/watchdog.test.ts test/orchestrator-pipeline.test.ts test/pi-runtime.test.ts test/codex-runtime.test.ts test/claude-runtime.test.ts
npm run build
```

Expected: PASS.

---

### Task 5: Durable Lead Conversation-Card Projection

**Owner boundary:** Lead tool-operation conversation-card backend projection and tests. Consume
Task 2 card-store APIs and Task 3 transaction helpers; do not edit `src/coordinator/service.ts` or
implement React rendering.

**Files:**
- Create: `src/gateway/conversation-card-projection.ts`
- Create: `src/coordinator/conversation-cards.ts`
- Modify: `src/store/conversations.ts`
- Modify: `src/gateway/event-projection.ts`
- Test: `test/conversation-card-projection.test.ts`
- Test: `test/conversation-card-reconciliation.test.ts`
- Modify: `test/conversations.test.ts`
- Modify: `test/control-plane-events.test.ts`

- [ ] **Step 1: Write failing projection tests**

Cover durable `ticket_execution`, `checkpoint`, and `intervention` cards; stable-key upsert; source line; ticket/attempt/agent references; operation row state updates; first-plus-newest-15 truncation; payload limits; and persisted cards surviving process restart.

- [ ] **Step 2: Write failing live/durable identity tests**

Prove `lead.tool.started/updated/completed/failed` can update one transient card by stable key, then a snapshot with the durable database ID replaces it without duplication or ordering jumps.

- [ ] **Step 3: Run RED**

Run:

```bash
npx vitest run test/conversation-card-projection.test.ts test/conversation-card-reconciliation.test.ts test/conversations.test.ts test/control-plane-events.test.ts
```

- [ ] **Step 4: Implement bounded projection**

Persist display-safe projections only. Strip raw secret-bearing tool payloads and large/binary values. Intervention cards reference safe intervention refs; privileged details remain behind Task 6 authorization.

- [ ] **Step 5: Run GREEN and gateway regression**

Run:

```bash
npx vitest run test/conversation-card-projection.test.ts test/conversation-card-reconciliation.test.ts test/conversations.test.ts test/control-plane-events.test.ts test/gateway-events.test.ts
npm run build
```

Expected: PASS.

---

### Task 6: Kernel HTTP Resources, Capabilities, and Authorization

**Owner boundary:** control-plane query/command methods, paired HTTP routing, capability
advertisement, existing AiSH/expiry authority routing, and authorization tests.

**Files:**
- Modify: `src/gateway/control-plane.ts`
- Modify: `src/gateway/paired-server.ts`
- Modify: `src/gateway/aish-adapter.ts`
- Modify: `src/daemon/server.ts`
- Modify: `src/cli.ts`
- Test: `test/checkpoint-http.test.ts`
- Test: `test/workbench-http.test.ts`
- Test: `test/conversation-cards-http.test.ts`
- Modify: `test/capabilities.test.ts`
- Modify: `test/paired-http.test.ts`
- Modify: `test/control-plane.test.ts`
- Modify: `test/daemon.test.ts`

- [ ] **Step 1: Write failing route and scope tests**

Cover checkpoint list, work items, workbench, card collection, safe intervention collection,
privileged intervention detail, approval resolution, and decision resolution. Test malformed
cursors, limits, unknown tickets, replayed command IDs, and denied scopes. Assert no paired public
checkpoint-write route exists; child checkpoint writes remain internal Coordinator operations.

- [ ] **Step 2: Write capability tests**

Advertise exactly:

```text
kernel.checkpoints.v1
kernel.interventions.v1
kernel.work-items.v1
kernel.ticket-workbench.v1
kernel.conversation-cards.v1
```

Do not increment or mutate paired protocol v2.

- [ ] **Step 3: Run RED**

Run:

```bash
npx vitest run test/checkpoint-http.test.ts test/workbench-http.test.ts test/conversation-cards-http.test.ts test/capabilities.test.ts test/paired-http.test.ts
```

- [ ] **Step 4: Implement additive routes and authorization**

Parse all inputs with protocol schemas. Workbench/cards return safe refs only. Full intervention reads and resolution commands require `approvals:respond`; normal checkpoint/card reads use the existing read scope selected in the design.

Route `/v1/approvals/:id/resolve`, `/v1/kernel/interventions/:id/resolve`, AiSH approval results,
and approval/decision expiry sweeps through Task 3's transaction service. No entry point may call
the authority stores directly after this task.

On daemon startup/restoration, detect live/recovered attempts and write deterministic
`attempt-recovered:<oldAttemptId>:<newAttemptId>` or missing `attempt-start:<attemptId>` system
checkpoints through the same transaction service. Recovery, authority repair, and expiry must be
idempotent across repeated daemon restarts and must append `ticket.updated` only when a durable
projection changed.

- [ ] **Step 5: Run GREEN and control-plane regression**

Run:

```bash
npx vitest run test/checkpoint-http.test.ts test/workbench-http.test.ts test/conversation-cards-http.test.ts test/capabilities.test.ts test/paired-http.test.ts test/control-plane.test.ts test/daemon.test.ts test/kernel-e2e.test.ts
npm run build
```

Expected: PASS.

---

### Task 7: Pure Ticket UX Models and Presentational Components

**Owner boundary:** workspace/ticket model and presentational components only. Do not import the client or mutate Zustand runtime files.

**Files:**
- Modify: `apps/companion/src/features/workspace/model.ts`
- Modify: `apps/companion/src/features/workspace/model.test.ts`
- Modify: `apps/companion/src/features/workspace/TicketList.tsx`
- Modify: `apps/companion/src/features/workspace/WorkRail.tsx`
- Modify: `apps/companion/src/features/tickets/TicketThread.tsx`
- Create: `apps/companion/src/features/tickets/CheckpointFeed.tsx`
- Create: `apps/companion/src/features/tickets/InterventionPanel.tsx`
- Create: `apps/companion/src/features/tickets/TicketTiming.tsx`
- Create: `apps/companion/src/features/tickets/ticketPresentation.test.ts`

- [ ] **Step 1: Write failing pure-model tests**

Cover groups `needs_intervention`, `running`, `review`, and `completed`; filters `all`, `running`, `todo`; unknown projects; group counts; no fake progress; elapsed formatting; agent/runtime labels; and all four empty-state variants from the prototype.

- [ ] **Step 2: Write failing component projection tests**

Use pure render-model/helper assertions rather than brittle full snapshots. Assert ticket details expose tabs `进展`, `产物`, `日志`; elapsed is a ticket property; the old fixed metrics grid is absent; artifacts show an unsupported/empty state; and intervention actions are derived from authoritative refs.

- [ ] **Step 3: Run RED**

Run:

```bash
npm --prefix apps/companion test -- src/features/workspace/model.test.ts src/features/tickets/ticketPresentation.test.ts
```

- [ ] **Step 4: Implement presentational models/components**

Accept typed props and callbacks so Task 8 can connect Zustand later. Preserve current responsive three-column interaction and Reanimated panel behavior. Do not restore native bottom tabs.

- [ ] **Step 5: Run GREEN, typecheck, and lint**

Run:

```bash
npm --prefix apps/companion test -- src/features/workspace/model.test.ts src/features/tickets/ticketPresentation.test.ts
npm --prefix apps/companion run typecheck
npm --prefix apps/companion run lint
```

Expected: PASS.

---

### Task 8: Companion Client and Zustand Resource Integration

**Owner boundary:** data client and `apps/companion/src/state/**`. UI components are consumed but not redesigned here.

**Files:**
- Modify: `apps/companion/src/data/controlPlaneClient.ts`
- Modify: `apps/companion/src/data/controlPlaneClient.test.ts`
- Modify: `apps/companion/src/state/types.ts`
- Modify: `apps/companion/src/state/control-plane/store.ts`
- Modify: `apps/companion/src/state/control-plane/normalize.ts`
- Modify: `apps/companion/src/state/control-plane/actions.ts`
- Modify: `apps/companion/src/state/control-plane/eventReducer.ts`
- Modify: `apps/companion/src/state/control-plane/invalidation.ts`
- Modify: `apps/companion/src/state/runtime.ts`
- Modify: `apps/companion/src/state/hooks.ts`
- Modify: `apps/companion/src/state/selectors.ts`
- Test: `apps/companion/src/state/control-plane/checkpointResources.test.ts`
- Test: `apps/companion/src/state/control-plane/cardReconciliation.test.ts`
- Modify: `apps/companion/src/state/runtime.test.ts`
- Modify: `apps/companion/src/state/selectors.test.ts`

- [ ] **Step 1: Write failing client tests**

Cover endpoint paths, cursor parameters, command IDs, capability fallback, safe/full intervention reads, decision/approval commands, cancellation, and schema failures.

- [ ] **Step 2: Write failing normalized-resource tests**

Assert checkpoints, work items, workbenches, interventions, timings, and cards normalize to `byId + ordered ids`; unchanged entities/arrays preserve identity; checkpoint order remains ascending in storage; selectors derive newest-first feeds; and resource invalidations coalesce.

- [ ] **Step 3: Write failing reconciliation tests**

Assert stable card key is the primary live identity, durable ID is attached on snapshot, duplicate live/snapshot cards collapse, operation updates retain one card, and permanent disconnect/forget clears transient-only cards without deleting durable entities.

- [ ] **Step 4: Run RED**

Run:

```bash
npm --prefix apps/companion test -- src/data/controlPlaneClient.test.ts src/state/control-plane/checkpointResources.test.ts src/state/control-plane/cardReconciliation.test.ts src/state/runtime.test.ts src/state/selectors.test.ts
```

- [ ] **Step 5: Implement client methods and typed resource keys**

Do not import Zustand into the data client. Add resource-generation keys for work items, ticket workbench, checkpoint collection, conversation cards, safe interventions, and privileged intervention detail.

- [ ] **Step 6: Implement normalization, actions, and invalidation**

Existing frozen-v2 events trigger additive resource refreshes rather than introducing new event cases. Keep high-frequency runtime logs in `streamStore`; authoritative checkpoint/card/intervention entities remain in `controlPlaneStore`; panel selection/filter/tab state remains in `workspaceStore`.

- [ ] **Step 7: Run GREEN and state regressions**

Run:

```bash
npm --prefix apps/companion test -- src/data/controlPlaneClient.test.ts src/state/control-plane/checkpointResources.test.ts src/state/control-plane/cardReconciliation.test.ts src/state/runtime.test.ts src/state/selectors.test.ts src/state/control-plane/eventReducer.test.ts src/state/control-plane/invalidation.test.ts src/state/storeIsolation.test.ts
npm --prefix apps/companion run typecheck
```

Expected: PASS.

---

### Task 9: Lead Conversation Cards and Intervention Actions

**Owner boundary:** chat message-part mapping/rendering and related tests. Do not change backend or Zustand entity storage.

**Files:**
- Modify: `apps/companion/src/features/chat/LeadConversation.tsx`
- Modify: `apps/companion/src/features/chat/MessagePartView.tsx`
- Modify: `apps/companion/src/features/chat/EmbeddedTicketCard.tsx`
- Modify: `apps/companion/src/features/chat/ToolCallRow.tsx`
- Create: `apps/companion/src/features/chat/TicketExecutionCard.tsx`
- Create: `apps/companion/src/features/chat/CheckpointCard.tsx`
- Create: `apps/companion/src/features/chat/InterventionCard.tsx`
- Modify: `apps/companion/src/features/chat/messageParts.test.ts`
- Create: `apps/companion/src/features/chat/conversationCards.test.ts`

- [ ] **Step 1: Write failing message-part tests**

Cover durable and transient card parts; stable-key equality; source labels; status/priority/ticket/project metadata; bounded operation rows; tool lifecycle states; checkpoint kinds; intervention stderr/detail preview; authorize/choose/dismiss/open-ticket actions; and redaction of privileged/raw payloads.

- [ ] **Step 2: Write failing conversation ordering tests**

Assert cards render in the Lead timeline next to text/tool messages, survive refresh from durable snapshots, and do not duplicate when the corresponding live card is still present.

- [ ] **Step 3: Run RED**

Run:

```bash
npm --prefix apps/companion test -- src/features/chat/messageParts.test.ts src/features/chat/conversationCards.test.ts
```

- [ ] **Step 4: Implement the approved card forms**

Match the prototype hierarchy rather than pixel-hardcoding: ticket execution card with operation rows, checkpoint feedback card, and intervention card with contextual actions. Actions call Task 8 commands and reflect pending/success/error states without optimistic authority resolution.

- [ ] **Step 5: Run GREEN, typecheck, and lint**

Run:

```bash
npm --prefix apps/companion test -- src/features/chat/messageParts.test.ts src/features/chat/conversationCards.test.ts
npm --prefix apps/companion run typecheck
npm --prefix apps/companion run lint
```

Expected: PASS.

---

### Task 10: Integration, Migration Repair, Documentation, and End-to-End Acceptance

**Owner boundary:** final wiring, route-level integration, acceptance docs, and verification. Fixes discovered here may touch prior files but must preserve their tests and ownership assumptions.

**Files:**
- Modify: `apps/companion/src/features/workspace/Workbench.tsx`
- Modify: `apps/companion/src/features/workspace/Workbench.web.tsx`
- Modify: `apps/companion/src/features/workspace/WorkRail.tsx`
- Modify: `apps/companion/src/features/tickets/TicketThread.tsx`
- Modify: `apps/companion/src/app/ticket/[id].tsx`
- Modify: `src/daemon/server.ts`
- Modify: `docs/DESIGN-GATEWAY.md`
- Modify: `docs/ACCEPTANCE.md`
- Create: `test/checkpoint-control-plane-e2e.test.ts`
- Create: `apps/companion/src/features/workspace/checkpointUxIntegration.test.ts`

- [ ] **Step 1: Write failing backend end-to-end scenario**

Start a real temporary kernel/control-plane, pair a client, create and dispatch a ticket, submit
progress/delegation/blocked/completed checkpoints through internal child tools, create and resolve
a decision, create and resolve an approval, and verify timing, workbench, durable cards,
authorization, inbox consumption, event order, session exemption, expiry, restart persistence,
legacy approval/decision repair, nested child-ticket planning, parallel child dispatch, child
completion projection to the parent, attempt crash, and daemon recovery without duplicate rows.

- [ ] **Step 2: Write failing Companion integration scenario**

Hydrate a real paired-client fixture through `CompanionStateRuntime`; verify grouped rail, ticket timing, checkpoint detail feed, intervention action state, durable Lead cards, live/durable reconciliation, empty states, and unsupported artifact presentation with no mock entities.

Also cover disconnected cached content, malformed additive resources, command retry/error states,
keyboard/screen-reader labels for intervention actions, and compact-width overflow/scroll behavior.

- [ ] **Step 3: Run RED**

Run:

```bash
npx vitest run test/checkpoint-control-plane-e2e.test.ts
npm --prefix apps/companion test -- src/features/workspace/checkpointUxIntegration.test.ts
```

- [ ] **Step 4: Wire route-level resources and startup repair**

Workbench screens observe only the resources they render. Opening a ticket loads
workbench/checkpoints and optionally privileged intervention details; closing panels releases
observers. Daemon startup performs idempotent legacy approval and decision repair and publishes
the documented existing v2 invalidations once.

- [ ] **Step 5: Update architecture and acceptance documentation**

Document additive kernel capabilities, event compatibility, checkpoint/intervention authority, migration version, configuration defaults, Zustand boundaries, card reconciliation, and exact commands/evidence used for acceptance.

- [ ] **Step 6: Run targeted GREEN**

Run:

```bash
npx vitest run test/checkpoint-control-plane-e2e.test.ts
npm --prefix apps/companion test -- src/features/workspace/checkpointUxIntegration.test.ts
```

- [ ] **Step 7: Run complete backend verification**

Run:

```bash
npm test
npm run build
npm run smoke:daemon
npm run smoke:runtime
```

Expected: all commands exit 0.

- [ ] **Step 8: Run complete Companion verification**

Run:

```bash
npm --prefix apps/companion test
npm --prefix apps/companion run typecheck
npm --prefix apps/companion run lint
npm --prefix apps/companion run export:web
```

Expected: all commands exit 0 and the static Web export contains no SSR mojibake or first-frame unstyled regression.

- [ ] **Step 9: Run live browser acceptance**

Start the daemon and Expo Web against a fresh temporary state directory. Verify loopback auto-pair, no fake initial conversation, stable first frame, grouped ticket rail, opening/closing animated side panels, session width animation, card refresh persistence, and intervention resolution.

- [ ] **Step 10: Run native bundle acceptance**

Start Expo in LAN mode and verify Android/iOS bundles compile with Reanimated/Unistyles, no traditional bottom tabs render, the native pairing flow reaches the socket gateway, panel gestures remain usable, and border width/style values are numeric on native.

- [ ] **Step 11: Record residual manual-device limits honestly**

If a physical iOS or Android device is unavailable, record successful native bundle generation and the exact remaining device-only checks rather than claiming they ran.

---

## Acceptance Gate

Implementation is complete only when all of the following are true:

- Existing paired protocol v2 contract tests pass unchanged.
- Checkpoint writes are append-only, deduplicated, cursor-stable, and transactionally paired with existing outbox invalidations.
- Approval and decision authority cannot be resolved through checkpoint writes.
- Ticket elapsed timing is accurate across restarts and excludes reviewer execution from child active time.
- Existing pending approvals receive exactly one repair checkpoint/card.
- Durable Lead cards survive restart and reconcile with live cards by stable key without duplicates.
- Operation cards never exceed 16 rows or 16 KiB and expose truncation explicitly.
- Companion resources obey the agreed Zustand boundaries and narrow selector behavior.
- Left rail grouping/filtering/empty states match the approved prototype semantics.
- Ticket details show `进展 | 产物 | 日志`, ticket-level elapsed time, real checkpoint/intervention content, and no fake metric/progress/artifact data.
- Central Lead messages render ticket execution, checkpoint, and intervention cards with authoritative actions.
- Backend tests/build/smokes and Companion tests/typecheck/lint/Web export all pass.
- Web live acceptance passes; native bundle/device evidence is recorded precisely.

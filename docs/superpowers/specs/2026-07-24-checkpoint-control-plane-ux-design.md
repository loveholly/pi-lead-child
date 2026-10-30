# Checkpoint Control-plane and Companion UX Design

**Date:** 2026-07-24

**Status:** Independently reviewed; awaiting user approval for implementation planning

## 1. Objective

Replace the high-fidelity prototype's formal-looking `PoW` summary with a lightweight,
durable Checkpoint model that lets a child agent report meaningful progress at key execution
moments without turning those reports into acceptance verdicts.

The design must also:

- promote elapsed time from a prototype-only metric card to a ticket-level timing property;
- keep approvals and decisions actionable inside the Checkpoint feed without making the
  Checkpoint itself the authority for action state;
- ensure critical checkpoints exist even when an LLM forgets to report them;
- preserve the frozen control-plane protocol v2 DTO and WebSocket event shapes;
- use HTTP snapshots as authority and existing v2 events as invalidation signals;
- make the prototype's ticket, Checkpoint, and intervention cards durable in the central Lead
  conversation instead of leaving them as live-only client projections;
- map cleanly into the current Companion Zustand architecture;
- support Pi, Codex, and Claude child runtimes through the same Coordinator and agent-tool
  boundary;
- produce the refined desktop three-column and compact mobile UX represented by
  `/Users/alice/Downloads/1-Lead-Child 助理 UI (standalone).html`.

## 2. Product Definition

### 2.1 What a Checkpoint is

A Checkpoint is a high-signal, append-only report associated with one ticket and usually one
attempt. It records a meaningful execution moment such as:

- a phase or milestone completed;
- an important finding;
- a material implementation decision;
- delegation to child tickets;
- a blocker or request for human input;
- preparation to enter review;
- final executor completion;
- a deterministic system lifecycle event.

A Checkpoint sits between raw runtime logs and formal review:

```text
runtime events/logs       complete low-level execution trace
Checkpoint               concise semantic progress report
review verdict            independent acceptance result
```

### 2.2 What a Checkpoint is not

A Checkpoint is not:

- a reviewer verdict;
- an acceptance checklist;
- proof that a claim is correct;
- a periodic heartbeat;
- a copy of every tool call;
- a mutable ticket description;
- the authority for an approval or decision lifecycle;
- a required percentage estimate.

Agent-authored checkpoints are explicitly presented as reports from the child. The UI must not
label them as independently verified unless a separate reviewer or evaluator has produced such
a result.

### 2.3 Naming decision

Use `Checkpoint` consistently in domain and protocol code:

```text
Entity:      Checkpoint
Tool:        submit_checkpoint
HTTP:        /v1/kernel/tickets/:id/checkpoints
Store:       checkpointsById / checkpointIdsByTicket
Capability:  kernel.checkpoints.v1
```

The user-facing Chinese tab label is `进展`. `PoW` is removed from the default UI because it
suggests formal proof or acceptance. No `WorkCheckpoint` prefix is needed because ticket and
attempt ownership already provide the domain context.

## 3. Design Decisions

### 3.1 Selected approach: hybrid semantic and deterministic checkpoints

The selected design combines:

1. explicit agent-authored checkpoints through `submit_checkpoint`;
2. atomic checkpoint creation for critical state-changing tools;
3. deterministic system-derived checkpoints for lifecycle events;
4. a silence watchdog that reminds an active child when meaningful work has occurred without a
   semantic checkpoint;
5. validation, deduplication, and rate control to prevent low-value spam.

This provides a hard guarantee for critical lifecycle coverage while retaining the child's
ability to explain discoveries and decisions in its own words.

### 3.2 Rejected: prompt-only reporting

Prompt-only reporting is insufficient because:

- Pi, Codex, and Claude may follow the instruction with different reliability;
- an agent may forget to report before exiting;
- an agent may over-report ordinary tool activity;
- a prompt cannot make two related database writes atomic;
- there is no deterministic way to prove critical coverage.

The current child prompt already asks the agent to call `ticket_update` at milestones. This is
useful behavioral guidance, but it is not a complete reliability mechanism.

### 3.3 Rejected: formal proof and verification model

A formal proof submission with criteria revisions, claims, verification states, and acceptance
authority is outside this feature's purpose. Existing reviewer attempts and immutable
`review_verdicts` remain the acceptance mechanism. Checkpoint does not replace or wrap them.

### 3.4 Rejected: deriving every checkpoint from runtime events

Runtime events can determine that a tool ran, an attempt started, or a process crashed. They
cannot reliably determine why a design changed, what was discovered, or what the child plans to
do next. Pure derivation would produce a tool timeline, not a semantic progress feed.

## 4. Protocol Compatibility

### 4.1 Protocol v2 remains frozen

The following existing protocol-v2 shapes remain unchanged:

- `TicketSummary`;
- `TicketDetail`;
- `GatewayEventType`;
- v2 WebSocket commands;
- existing approval DTOs;
- existing event payload schemas.

No `progress`, `checkpoint`, or `timing` field is added to `TicketSummary`.

### 4.2 Additive kernel resources

New schemas are exported from `packages/protocol`, but are served only through new kernel or
workbench endpoints:

```text
GET  /v1/kernel/tickets/:id/workbench
GET  /v1/kernel/work-items
GET  /v1/kernel/tickets/:id/checkpoints
GET  /v1/kernel/interventions
POST /v1/kernel/interventions/:id/resolve
GET  /v1/kernel/conversation/cards
```

Adding exported kernel schemas does not mutate a frozen v2 response or WebSocket union.

### 4.3 Capability negotiation

The existing `hello.v2.capabilities: string[]` advertises:

```text
kernel.checkpoints.v1
kernel.interventions.v1
kernel.work-items.v1
kernel.ticket-workbench.v1
kernel.conversation-cards.v1
```

The Companion enables the new detail experience only when the corresponding capability is
present. This permits daemon and app versions to roll independently without inventing fallback
data.

Ticket timing is carried by `kernel.work-items.v1` and `kernel.ticket-workbench.v1`; there is no
standalone timing capability or endpoint. The rail requires `kernel.work-items.v1`. The detail
panel requires `kernel.ticket-workbench.v1` and `kernel.checkpoints.v1`. Full action controls
additionally require `kernel.interventions.v1` plus the `approvals:respond` scope. Durable central
cards require `kernel.conversation-cards.v1`.

### 4.4 Live update strategy

No new WebSocket event type is added in this phase. Existing events invalidate additive
resources:

| Existing v2 event | Companion invalidation |
|---|---|
| terminal `lead.tool.*` with a derived card key | conversation cards for the initiating binding |
| `ticket.created` | tickets, projects, work-items, workbench, conversation cards |
| `ticket.updated` | ticket, checkpoints, interventions, work-items, workbench, conversation cards |
| `attempt.started` | execution, work-items, workbench, conversation cards |
| `attempt.updated` | execution, checkpoints, work-items, workbench, conversation cards |
| `approval.required` | approvals, interventions, workbench, conversation cards |
| `approval.resolved` | approvals, interventions, checkpoints, workbench, conversation cards |
| `snapshot.required` | all observed resources |

When a new checkpoint is written, the server publishes a normal `ticket.updated` event with the
already-supported `snapshotRequired` semantics. The client fetches checkpoints after its current
maximum checkpoint ID.

A future protocol version may add first-class `checkpoint.created` events, but this is not
required for the current UX or latency target.

## 5. Checkpoint Domain Model

### 5.1 Shared schema

```ts
type CheckpointKind =
  | 'progress'
  | 'milestone'
  | 'decision'
  | 'delegation'
  | 'blocked'
  | 'completed';

type CheckpointSource = 'agent_reported' | 'system_derived';

interface CheckpointFact {
  label: string;
  value: string;
}

interface CheckpointActionRef {
  type: 'approval' | 'decision_request';
  id: number;
}

interface KernelCheckpoint {
  id: number;
  ticketId: number;
  attemptId: number | null;
  author: {
    kind: 'executor' | 'reviewer' | 'system';
    runtime: 'pi' | 'codex' | 'claude' | null;
  };
  source: CheckpointSource;
  kind: CheckpointKind;
  stage: string | null;
  title: string;
  summary: string;
  keyFacts: CheckpointFact[];
  artifactRefs: string[];
  relatedTicketIds: number[];
  nextStep: string | null;
  actionRef: CheckpointActionRef | null;
  createdAt: string;
}
```

### 5.2 Field limits

The server validates bounded data before storage:

| Field | Limit |
|---|---|
| `title` | 1 to 160 characters |
| `summary` | 1 to 2,000 characters |
| `stage` | 0 to 120 characters |
| `keyFacts` | maximum 8 entries |
| fact label | maximum 80 characters |
| fact value | maximum 240 characters |
| `artifactRefs` | maximum 20 IDs |
| `relatedTicketIds` | maximum 20 IDs |
| `nextStep` | maximum 500 characters |

The store contains identifiers and display-safe summaries only. Binary artifact content, raw
tool payloads, full logs, and secrets never enter checkpoint rows.

### 5.3 Type-specific validation

Additional deterministic validation applies:

- `agent_reported` requires a current attempt owned by the ticket;
- `system_derived` may use a null attempt when the event is ticket-level;
- `delegation` requires at least one `relatedTicketId`;
- `blocked` requires either an `actionRef` or a non-empty `nextStep` describing the unblock path;
- `completed` must not use an unresolved blocker as its action reference;
- an `approval` action reference must point to an approval for the same ticket;
- a `decision_request` action reference must point to a decision request for the same ticket;
- `artifactRefs` are accepted as opaque IDs until the first-class Artifact protocol exists;
- unknown keys and invalid enum values are rejected.

### 5.4 Append-only semantics

Checkpoint rows are append-only:

- no update endpoint;
- no delete endpoint in the initial scope;
- corrections are submitted as a new `decision` or `progress` checkpoint;
- database checkpoint ID is the sole canonical ordering and incremental sync cursor;
- `createdAt` is display metadata and is not used to reorder checkpoint history.

Historical checkpoint text remains stable. Linked approval or decision state is loaded from the
current authority and may therefore render as pending, resolved, rejected, or expired without
modifying the checkpoint row.

## 6. Storage Design

### 6.1 `checkpoints` table

```sql
CREATE TABLE checkpoints (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id           INTEGER NOT NULL REFERENCES tickets(id),
  attempt_id          INTEGER REFERENCES attempts(id),
  source              TEXT NOT NULL
                      CHECK (source IN ('agent_reported','system_derived')),
  kind                TEXT NOT NULL
                      CHECK (kind IN ('progress','milestone','decision',
                                      'delegation','blocked','completed')),
  stage               TEXT,
  title               TEXT NOT NULL,
  summary             TEXT NOT NULL,
  key_facts           TEXT NOT NULL DEFAULT '[]',
  artifact_refs       TEXT NOT NULL DEFAULT '[]',
  related_ticket_ids  TEXT NOT NULL DEFAULT '[]',
  next_step           TEXT,
  action_type         TEXT CHECK (action_type IN ('approval','decision_request')),
  action_id           INTEGER,
  idempotency_key     TEXT UNIQUE,
  content_hash        TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((action_type IS NULL) = (action_id IS NULL))
);

CREATE INDEX checkpoints_ticket_id
  ON checkpoints(ticket_id, id);

CREATE INDEX checkpoints_attempt_id
  ON checkpoints(attempt_id, id);
```

SQLite cannot express a foreign key to one of two authority tables. The service validates
polymorphic action references in the same transaction that creates the checkpoint.

### 6.2 Idempotency and deduplication

System checkpoints use deterministic idempotency keys:

```text
attempt-start:<attemptId>
attempt-crash:<attemptId>
attempt-recovered:<oldAttemptId>:<newAttemptId>
plan-sealed:<ticketId>:<revision>
subticket-created:<parentId>:<childId>
subticket-completed:<parentId>:<childId>:<attemptId>
approval-created:<approvalId>
approval-resolved:<approvalId>:<status>
decision-created:<decisionRequestId>
decision-resolved:<decisionRequestId>
attempt-completed:<attemptId>
```

Agent checkpoints receive a generated ID, plus a canonical JSON content hash over every semantic
field:

```text
attemptId + kind + stage + title + summary + keyFacts + artifactRefs + relatedTicketIds +
nextStep + actionRef
```

An exact duplicate from the same attempt within the configurable deduplication window returns
the original checkpoint rather than inserting a new row. `blocked` and `completed` entries are
never discarded merely because they are close in time to a different checkpoint.

### 6.3 Existing activities remain

`activities` stays as the thin audit ledger used by existing control-plane endpoints and tests.
Checkpoint is not stored as an overloaded activity payload because:

- activities currently use an untyped payload;
- checkpoints need pagination, action references, validation, and focused indexes;
- checkpoints are a product read model, while activities remain an internal audit ledger.

Important checkpoint creation may also add a concise `milestone`, `decision`, or `notification`
activity for backward-compatible CLI and audit behavior. The checkpoint row is authoritative for
the new UI.

### 6.4 Durable Lead conversation cards

The prototype contains two structured card families in the central Lead message list:

1. a ticket execution card created by Lead tools such as `create_ticket` and `spawn_child`;
2. an asynchronous child Checkpoint or intervention card that may not belong to a user turn.

Current `channel_turns` persist text only. Live Zustand `MessagePart` projections are therefore
insufficient because cards disappear after refresh or reconnect. Add a durable read-model table:

```sql
CREATE TABLE conversation_cards (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id           TEXT REFERENCES channel_turns(id),
  ticket_id         INTEGER REFERENCES tickets(id),
  kind              TEXT NOT NULL
                    CHECK (kind IN ('ticket_execution','checkpoint','intervention')),
  checkpoint_id     INTEGER REFERENCES checkpoints(id),
  action_type       TEXT CHECK (action_type IN ('approval','decision_request')),
  action_id         INTEGER,
  payload           TEXT NOT NULL DEFAULT '{}',
  idempotency_key   TEXT NOT NULL UNIQUE,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((action_type IS NULL) = (action_id IS NULL))
);

CREATE INDEX conversation_cards_turn
  ON conversation_cards(turn_id, id);

CREATE INDEX conversation_cards_ticket
  ON conversation_cards(ticket_id, id);
```

`conversation_cards` is a durable display projection, not domain authority:

- ticket status, priority, runtime, and timing are read from ticket/workbench entities;
- Checkpoint text is read from the immutable checkpoint entity;
- approval/decision state is read from its authority;
- only bounded tool-operation display rows are stored in `payload`;
- raw tool arguments, raw tool results, absolute secret-bearing paths, and logs are not stored.

The API exposes `idempotency_key` as `key`. Live Companion reducers derive the same key before a
database card ID is known. Snapshot reconciliation replaces the live projection by key and then
records the authoritative numeric card ID; it never relies on text or timestamp matching.

Ticket execution cards use one stable key per turn and ticket:

```text
turn:<turnId>:ticket:<ticketId>
```

On `create_ticket` completion, the projection creates the card. Later Lead operations in the same
turn that target the same ticket, such as `spawn_child`, update the card's bounded operation rows.
The projection stores only:

```ts
interface TicketOperationProjection {
  id: string;              // turnId + toolCallId
  name: string;
  state: 'started' | 'running' | 'completed' | 'failed';
  label: string;
  detail: string | null;
}
```

Projection bounds are strict:

| Value | Limit |
|---|---|
| operation rows per card | 16 |
| operation `id` | 240 characters |
| operation `name` | 120 characters |
| operation `label` | 160 characters |
| operation `detail` | 500 characters |
| serialized card payload | 16 KiB |

Updating an existing operation row is always allowed. When adding a seventeenth unique operation,
the projection retains the first row and the newest fifteen rows, evicts the oldest non-first row,
and sets `operationsTruncated=true`. Full operation history remains available through runtime/tool
events; the card is intentionally a bounded summary.

Every ticket-card insert or terminal operation update that has a resolved ticket ID also inserts a
durable broadcast `ticket.updated` outbox row in the same transaction. The originating binding may
render the existing live `lead.tool.*` projection immediately; all bindings converge through the
card snapshot invalidated by `ticket.updated`.

Checkpoint and intervention cards use deterministic keys:

```text
checkpoint:<checkpointId>
intervention:<actionType>:<actionId>
```

An intervention card references both the Checkpoint that explains the context and the authority
that supplies current buttons/state. It does not copy approval or decision resolution state into
its payload.

### 6.5 Lead-feed projection policy

Not every Checkpoint enters the central Lead conversation. The deterministic policy is:

| Checkpoint | Ticket detail | Lead conversation |
|---|---|---|
| ordinary `progress` | yes | no |
| ordinary `milestone` | yes | no |
| `delegation` | yes | no, unless Lead initiated the same turn |
| `decision` with pending request | yes | yes |
| `blocked` with pending action | yes | yes |
| `completed` for a root/top-level ticket | yes | yes |
| system start/recovery | yes | no |
| system crash or retry exhaustion | yes | yes |
| action resolution for a Lead-visible intervention | yes | yes |

This keeps the Lead conversation high signal while the ticket detail remains the complete
Checkpoint history. Child agents cannot arbitrarily force ordinary progress into the Lead feed.

## 7. Decision and Approval Model

### 7.1 Authority separation

A checkpoint displays the context of an approval or decision, but it never owns action state.

```text
Checkpoint             immutable semantic context
Approval               authority for sensitive/irreversible action
DecisionRequest        authority for non-approval human or Lead decision
Inbox                   notification delivery queue
```

This prevents the checkpoint feed, approval list, Slack buttons, and Companion buttons from
diverging.

### 7.2 Existing approvals remain authoritative

The existing `approvals` table, expiry, session exemption, paired HTTP resolution, CLI/Lead
resolution, and Slack AiSH mapping remain unchanged.

Add nullable attempt attribution for newly created child approvals:

```sql
ALTER TABLE approvals ADD COLUMN attempt_id INTEGER REFERENCES attempts(id);
```

Legacy approvals retain `attempt_id = NULL`. New child-origin approvals persist the current
attempt ID so the Checkpoint card can identify its author without guessing the active attempt.

Upgrade reconciliation covers existing pending approvals. For every pending approval without a
linked Checkpoint, the migration/startup repair transaction creates:

- one `system_derived` blocked Checkpoint with idempotency key `legacy-approval:<approvalId>`;
- a safe summary derived from approval tool/action, not raw payload;
- an approval action reference;
- one Lead intervention conversation card when the approval belongs to a visible ticket.

Resolved historical approvals are not backfilled because they do not require current action. The
same idempotent repair runs on daemon startup so a pre-migration or partially projected pending
approval cannot disappear from the inline UX.

`request_approval` requires checkpoint context for new child calls. Approval, inbox notification,
checkpoint, Lead conversation card, and the required `approval.required` plus `ticket.updated`
gateway outbox rows are created in one database transaction.

```ts
request_approval({
  tool: 'paired_api',
  action: 'Open approvals:respond for this validation',
  payload: { scope: 'approvals:respond' },
  checkpoint: {
    title: 'Waiting for authorization to continue',
    summary: 'The remaining validation requires approvals:respond.',
    next_step: 'Continue the authorization boundary audit after approval.'
  }
})
```

The resulting checkpoint has:

```text
kind = blocked
source = agent_reported
actionRef = { type: approval, id: approvalId }
```

Session exemption is checked before creating a new approval. When an existing approved
session-exemption applies:

- no new approval or pending intervention is created;
- one agent-attributed `progress` checkpoint is created from the supplied context with the
  server title `已使用现有 Session 授权`;
- the checkpoint has no `actionRef`;
- the tool returns `{ status: 'approved', session_exempt: true, checkpoint_id }` immediately.

Legacy direct store callers may omit checkpoint context during the migration window, but the
agent-facing JSON schema requires it. This preserves internal compatibility without allowing new
runtime prompts to bypass the Checkpoint guarantee.

### 7.3 New decision requests

Add a focused authority for non-approval questions:

```sql
CREATE TABLE decision_requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id     INTEGER NOT NULL REFERENCES tickets(id),
  attempt_id    INTEGER REFERENCES attempts(id),
  kind          TEXT NOT NULL CHECK (kind IN ('decision','question','blocker')),
  audience      TEXT NOT NULL CHECK (audience IN ('lead','user','lead_or_user')),
  blocking      INTEGER NOT NULL DEFAULT 1,
  allow_custom  INTEGER NOT NULL DEFAULT 0,
  prompt        TEXT NOT NULL,
  options       TEXT NOT NULL DEFAULT '[]',
  state         TEXT NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending','resolved','dismissed','expired')),
  resolution_kind TEXT CHECK (resolution_kind IN ('option','text','dismissed','expired')),
  selected_option_id TEXT,
  resolution_text TEXT,
  dismissal_reason TEXT,
  resolved_by   TEXT,
  resolved_at   TEXT,
  expires_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
```

The initial tool is:

```ts
request_decision({
  kind: 'decision' | 'question' | 'blocker',
  audience: 'lead' | 'user' | 'lead_or_user',
  blocking?: boolean,
  allow_custom?: boolean,
  prompt: string,
  options?: Array<{ id: string; label: string; description?: string }>,
  checkpoint: {
    title: string,
    summary: string,
    next_step?: string
  }
})
```

Decision request, notification inbox row, checkpoint, Lead intervention conversation card, and
durable `ticket.updated` outbox row are created atomically. `blocking` defaults to `true`. A
blocking request waits for a resolution using the same abort-aware polling discipline as
`request_approval`; a non-blocking request returns after durable creation.

`blocking` describes tool-call behavior, not canonical ticket status. A pending decision already
places the ticket in the `需要你介入` projection. The child uses the explicit critical
`ticket_update(status='blocked', checkpoint=...)` path only when the whole ticket should enter the
canonical blocked state.

Lead receives a pending decision through the existing inbox/Lead context path and resolves it
with a new deterministic Lead tool:

```ts
resolve_decision_request({
  request_id: number,
  decision: 'select' | 'respond' | 'dismiss',
  option_id?: string,
  resolution?: string,
  reason?: string
})
```

Companion resolves through the kernel HTTP endpoint. CLI users can instruct Lead to resolve it.
Slack approvals continue using native approval buttons. Arbitrary multi-option decisions are
delivered as a normal Slack card/message and resolved from the user's explicit thread reply by
Lead; this phase does not assume AiSH supports arbitrary decision buttons.

Startup reconciliation covers pending decision requests just as it covers pending approvals. A
pending request without a linked Checkpoint/card receives exactly one system repair projection
using `legacy-decision:<requestId>` keys. The repair also enqueues `ticket.updated`, so paired
clients cannot permanently miss the action after an interrupted migration or projection write.

### 7.4 Unified Companion projection

Every `tickets:view` reader may receive a safe reference:

```ts
interface KernelInterventionRef {
  id: string;
  ticketId: number;
  kind: 'approval' | 'decision' | 'question' | 'blocker';
  state: 'pending' | 'approved' | 'rejected' | 'resolved' | 'dismissed' | 'expired';
  requiresAction: boolean;
}
```

This contains no approval payload, decision prompt, options, resolution text, or actions. The
privileged kernel API returns the full discriminated union:

```ts
type KernelIntervention =
  | {
      id: `approval:${number}`;
      kind: 'approval';
      authorityId: number;
      ticketId: number;
      attemptId: number | null;
      audience: 'user';
      state: 'pending' | 'approved' | 'rejected' | 'expired';
      title: string;
      detail: string;
      actions: Array<'approve' | 'reject' | 'approve_session'>;
      resolution: {
        decision: 'approve' | 'reject' | 'approve_session';
        sessionExempt: boolean;
      } | null;
      createdAt: string;
      resolvedBy: string | null;
      resolvedAt: string | null;
    }
  | {
      id: `decision:${number}`;
      kind: 'decision' | 'question' | 'blocker';
      authorityId: number;
      ticketId: number;
      attemptId: number | null;
      audience: 'lead' | 'user' | 'lead_or_user';
      blocking: boolean;
      allowCustom: boolean;
      state: 'pending' | 'resolved' | 'dismissed' | 'expired';
      title: string;
      detail: string;
      options: Array<{ id: string; label: string; description: string | null }>;
      actions: Array<
        | { kind: 'select'; optionId: string; label: string }
        | { kind: 'respond'; label: string }
        | { kind: 'dismiss'; label: string }
      >;
      resolution: {
        kind: 'option' | 'text' | 'dismissed';
        optionId: string | null;
        text: string | null;
      } | null;
      createdAt: string;
      resolvedBy: string | null;
      resolvedAt: string | null;
    };
```

`actions` is non-empty only while an intervention is pending and the caller is eligible to
respond. Resolved, rejected, dismissed, expired, or audience-ineligible projections return an
empty action list while retaining resolution metadata.

The current `approvals:respond` scope protects both approval and decision responses in this
protocol-v2-compatible phase. A future protocol version may rename it to a broader action scope.

### 7.5 Resolution checkpoints

The paired resolve endpoint accepts a strict union:

```ts
type ResolveKernelInterventionRequest =
  | {
      authority: 'approval';
      decision: 'approve' | 'reject' | 'approve_session';
    }
  | {
      authority: 'decision_request';
      decision: 'select';
      optionId: string;
    }
  | {
      authority: 'decision_request';
      decision: 'respond';
      resolution: string;
    }
  | {
      authority: 'decision_request';
      decision: 'dismiss';
      reason?: string;
    };
```

Validation and state transitions are deterministic:

- only `pending` authorities can transition;
- approval decisions map to approved/rejected and derive `sessionExempt`;
- `select` requires an option ID present in the stored options;
- `respond` is accepted only when no options exist or `allow_custom = 1`;
- `dismiss` transitions a decision request to `dismissed`;
- the expiry sweep transitions pending rows with `expires_at <= now` to `expired`;
- paired callers may resolve `user` and `lead_or_user` requests only;
- the Lead tool may resolve `lead` and `lead_or_user` requests;
- a user instruction received through CLI or Slack is recorded as `user via <channel>`, not as an
  autonomous Lead decision;
- an identical retry returns the stored resolution idempotently;
- a contradictory retry returns HTTP 409 / domain conflict.

Resolution persistence uses separate columns rather than an opaque JSON/text value:

| Decision | Persisted identity |
|---|---|
| `select` | `resolution_kind='option'`, exact `selected_option_id` |
| `respond` | `resolution_kind='text'`, normalized `resolution_text` |
| `dismiss` | `resolution_kind='dismissed'`, optional `dismissal_reason` |
| expiry | `resolution_kind='expired'` |

Idempotent retry compares this normalized persisted tuple. Option selection and free-text response
therefore cannot collapse into the same stored string.

One Coordinator domain transaction performs:

1. authority compare-and-set;
2. resolution metadata write;
3. linked inbox consumption;
4. deterministic follow-up Checkpoint creation;
5. Lead conversation-card creation/update when applicable;
6. durable `ticket.updated` gateway outbox insertion.

The socket broadcaster reads committed outbox rows after transaction commit. A daemon crash after
the transaction cannot lose the invalidation event or the required follow-up Checkpoint.

All existing resolution entry points delegate to this domain transaction:

- `/v1/approvals/:id/resolve`;
- `/v1/kernel/interventions/:id/resolve`;
- Lead approval/decision tools;
- CLI user instructions routed through Lead;
- AiSH approval results;
- approval and decision expiry sweeps.

No entry point updates an authority table directly after this migration.

Resolving an approval or decision does not mutate the original checkpoint. The Coordinator
creates one deterministic system checkpoint:

```text
kind: progress
title: Authorization approved, execution resumed
summary: User approved approval #18. Child #73 may continue.
```

Rejection or dismissal creates a decision checkpoint describing the selected fallback or the
fact that execution remains blocked.

## 8. Ticket Timing

### 8.1 Product semantics

Remove the prototype's fixed metric grid:

- capability coverage and gaps are optional checkpoint `keyFacts`;
- tool-call count stays in logs or advanced runtime telemetry;
- elapsed time becomes a generic ticket property.

The UI distinguishes:

```text
Elapsed time             first execution start to now or completion
Active execution time    sum of actual attempt runtime durations
Status duration          time spent in the current ticket state
```

The primary UI displays only elapsed time. The other values may appear in advanced detail later.

### 8.2 Ticket columns

```sql
ALTER TABLE tickets ADD COLUMN first_started_at TEXT;
ALTER TABLE tickets ADD COLUMN completed_at TEXT;
ALTER TABLE tickets ADD COLUMN status_changed_at TEXT;
```

Rules:

- `first_started_at` is set once when the first attempt actually starts, not when the ticket is
  merely assigned;
- `status_changed_at` changes only when canonical ticket status changes;
- `completed_at` is set on `done` or `cancelled`;
- reopening a terminal ticket clears `completed_at` but preserves `first_started_at`;
- ordinary body, project, priority, or reminder updates do not change `status_changed_at`.

### 8.3 Shared timing schema

```ts
interface KernelTicketTiming {
  firstStartedAt: string | null;
  completedAt: string | null;
  statusChangedAt: string | null;
  computedAt: string;
  elapsedMs: number | null;
  activeExecutionMs: number;
  statusDurationMs: number | null;
}
```

Calculation:

```text
elapsedMs = (completedAt ?? computedAt) - firstStartedAt

activeExecutionMs = sum over attempts:
  (attempt.endedAt ?? computedAt) - attempt.startedAt

statusDurationMs = computedAt - statusChangedAt
```

Parallel attempts can make `activeExecutionMs` larger than `elapsedMs`; this is correct because
the former is cumulative agent runtime while the latter is user-visible wall time.

`activeExecutionMs` includes executor-role attempts, including integration work. Reviewer-role
attempts are excluded so review cost is not mislabeled as executor execution time.

The service computes durations at read time. It does not continuously write elapsed counters.

### 8.4 Migration backfill

For existing rows:

- `first_started_at` uses the minimum attempt `started_at` when available;
- `status_changed_at` falls back to ticket `updated_at` because historical status transitions do
  not provide a guaranteed complete timestamp source;
- terminal tickets set `completed_at = updated_at` as an explicitly approximate legacy value;
- no historical semantic checkpoints are fabricated from ticket body text;
- active tickets with a live attempt receive deterministic system start checkpoints only after
  the new daemon observes or restores them.

## 9. Agent Tool and Coordinator Policy

### 9.1 `submit_checkpoint`

Add one shared child tool through `createAgentToolHandlers`, making it available to Pi, Codex,
and Claude runtimes:

```ts
submit_checkpoint({
  kind,
  stage?,
  title,
  summary,
  key_facts?,
  artifact_refs?,
  related_ticket_ids?,
  next_step?
})
```

The handler:

1. validates ticket and attempt ownership;
2. validates bounded payload and type-specific requirements;
3. redacts or rejects obvious secret-bearing values using the existing projection discipline;
4. deduplicates exact recent repeats;
5. stores the checkpoint;
6. adds a backward-compatible activity when appropriate;
7. updates ticket `last_activity_at` without changing canonical status;
8. publishes `ticket.updated` with snapshot invalidation;
9. returns `{ checkpoint_id, created_at, deduplicated }`.

### 9.2 Child prompt discipline

Replace the current instruction to use `ticket_update` for every milestone with:

```text
- Your complete low-level process is already recorded. Do not report ordinary reads, commands,
  or tool calls.
- Call submit_checkpoint only when a phase completes, an important finding or decision changes
  the direction, work is delegated, execution is blocked, or you are ready for review.
- A useful checkpoint explains what changed, why it matters, and what happens next.
- Do not estimate a percentage unless the plan has a deterministic completed/total basis.
- Use request_approval for sensitive or irreversible actions.
- Use request_decision when Lead or the user must choose or provide information.
- You cannot mark a ticket done. When execution is complete, make one atomic
  ticket_update(status='review', checkpoint={kind:'completed', ...}) call.
```

Include short positive and negative examples for all runtimes.

### 9.3 Critical transition guarantees

Critical transitions cannot rely on voluntary behavior:

| Transition or action | Guarantee |
|---|---|
| `ticket_update(status='review')` | requires an atomic `completed` checkpoint payload |
| `ticket_update(status='blocked')` | requires an atomic `blocked` checkpoint with an unblock next step |
| `request_approval` | creates blocked checkpoint and approval atomically |
| `request_decision` | creates decision/blocked checkpoint and request atomically |
| `finish_planning` | creates system milestone checkpoint after revision seals |
| child attempt start | creates system progress checkpoint |
| child attempt crash | creates system blocked checkpoint |
| child attempt recovery | creates system progress checkpoint |
| child ticket created | parent receives system delegation checkpoint |
| child ticket completed | parent receives system milestone checkpoint |

For compatibility, `ticket_update` keeps `body_append`, but body text is reserved for durable
handoff context rather than routine progress. During migration, old calls without a checkpoint
remain accepted unless they attempt the critical `review` or `blocked` transitions.

`body_append` becomes optional. The handler requires at least one of `body_append`, `status`, or
`checkpoint`. This preserves old calls while allowing a critical state transition and its
Checkpoint to be written without forcing duplicate prose into the ticket body.

The exact agent-facing contract is:

```ts
ticket_update({
  body_append?: string,
  status?: 'blocked' | 'review' | 'in_progress',
  reason?: string,
  checkpoint?: SubmitCheckpointInput
})
```

Additional rules:

- `status='review'` requires `checkpoint.kind='completed'`;
- `status='blocked'` requires `checkpoint.kind='blocked'` and non-empty `next_step`;
- `checkpoint.actionRef` is never accepted from agent input; authority references are created only
  by `request_approval` and `request_decision`;
- one transaction applies body append, status transition, Checkpoint insert, conversation-card
  projection, activity, and durable `ticket.updated` outbox row;
- any validation or write failure rolls back every effect;
- old calls that only append body text remain compatible.

### 9.4 Silence watchdog

The watchdog derives its state from persisted checkpoints, runtime events, child-ticket rows, and
`notification` activities. It does not keep a restart-sensitive in-memory counter.

Conceptually it calculates:

```ts
interface CheckpointPolicyState {
  lastCheckpointAt: string | null;
  lastCheckpointRuntimeSeq: number | null;
  completedToolEventsSinceCheckpoint: number;
  domainEventsSinceCheckpoint: number;
  childTicketsSinceCheckpoint: number;
  reminderSentAt: string | null;
}
```

Domain events include plan sealing, child-ticket creation/completion, approval/decision creation,
and canonical ticket transition. Runtime `tool.completed` events are counted separately because
their semantic importance cannot be reliably inferred across Pi, Codex, and Claude.

Defaults and configuration:

```text
PLC_CHECKPOINT_DEDUPE_WINDOW_MS=60000
PLC_CHECKPOINT_PROGRESS_MIN_INTERVAL_MS=120000
PLC_CHECKPOINT_SILENCE_MS=900000
PLC_CHECKPOINT_SILENCE_TOOL_EVENTS=8
PLC_CHECKPOINT_SILENCE_DOMAIN_EVENTS=3
PLC_CHECKPOINT_REMINDER_COOLDOWN_MS=900000
```

The watchdog sends one reminder when either:

- the attempt has been active for at least `SILENCE_MS`, has no newer Checkpoint, and has at least
  `SILENCE_TOOL_EVENTS` completed tools; or
- at least `SILENCE_DOMAIN_EVENTS` domain events occurred after the latest Checkpoint.

A Checkpoint resets both effective counters because subsequent queries use its creation time and
runtime cursor. Terminal attempts are excluded. Reminder delivery writes a `notification`
activity with `payload.kind='checkpoint_reminder'`; that persisted activity supplies cooldown and
restart continuity.

When configurable thresholds are exceeded, the Coordinator sends one non-blocking steering
message:

```text
You have completed meaningful work without a recent Checkpoint. If a phase conclusion now
exists, call submit_checkpoint. If you are still in the same phase, continue without reporting.
```

The watchdog does not fabricate an `agent_reported` checkpoint. It may create only deterministic
`system_derived` lifecycle checkpoints.

### 9.5 Rate and quality controls

- identical recent checkpoints from one attempt are deduplicated;
- ordinary `progress` checkpoints are rate limited per attempt;
- `blocked`, `decision`, and `completed` are never delayed by progress rate limits;
- generic summaries such as `still working` are discouraged by prompt examples;
- delegation checkpoints enforce related ticket references; artifact references remain optional on
  any checkpoint kind until the Artifact protocol exists;
- checkpoint creation failures are returned to the agent as tool errors rather than silently
  dropping the report;
- maximum checkpoint count per ticket is not truncated server-side; clients page results and
  keep bounded caches.

Rate behavior is deterministic:

- an exact duplicate inside `PLC_CHECKPOINT_DEDUPE_WINDOW_MS` returns the original row with
  `deduplicated=true`;
- a non-identical `progress` checkpoint inside
  `PLC_CHECKPOINT_PROGRESS_MIN_INTERVAL_MS` returns a tool-level `rate_limited` error and does not
  write a row;
- the interval is calculated from the latest stored `progress` checkpoint for the same attempt;
- progress rate limiting applies only to standalone `agent_reported` submissions; system-derived
  and transaction-generated progress checkpoints bypass it;
- `milestone`, `decision`, `delegation`, `blocked`, and `completed` bypass the progress interval;
- invalid non-positive configuration values fail daemon startup rather than silently changing
  policy.

### 9.6 Transaction and frozen-v2 event matrix

Every write path inserts all domain rows, display projections, and replayable gateway outbox rows
in one SQLite transaction. Socket broadcast happens only after commit.

| Write path | Atomic persisted rows | Frozen-v2 outbox events, in sequence order |
|---|---|---|
| `submit_checkpoint` | checkpoint, optional activity, optional Lead card | `ticket.updated` |
| critical `ticket_update` | ticket/body/transition, checkpoint, activity, optional Lead card | `ticket.updated` |
| `request_approval` pending | approval, inbox, checkpoint, intervention card | `approval.required`, then `ticket.updated` |
| session-exempt approval | progress checkpoint, optional activity | `ticket.updated` |
| approval resolve/expire | approval, inbox consume, follow-up checkpoint, card projection | `approval.resolved`, then `ticket.updated` |
| `request_decision` | decision request, inbox, checkpoint, intervention card | `ticket.updated` |
| decision resolve/dismiss/expire | decision request, inbox consume, follow-up checkpoint, card projection | `ticket.updated` |
| planning/delegation lifecycle | plan/ticket rows, system checkpoint, optional parent card | existing ticket/attempt event when already required, then `ticket.updated` |
| attempt start/update/crash/recovery | attempt/timing rows, system checkpoint when required | existing `attempt.started` or `attempt.updated`, then `ticket.updated` when checkpoint/card changed |
| ticket execution card upsert | conversation card projection | existing private `lead.tool.*` remains live; broadcast `ticket.updated` when ticket ID is known |
| legacy approval/decision repair | checkpoint, intervention card, missing inbox linkage repair | `ticket.updated` |

Rules:

- existing `approval.required` and `approval.resolved` payload schemas remain unchanged;
- approval event rows preserve their existing `approvals:respond` required scope;
- `ticket.updated` preserves `tickets:view` scope and drives additive resource invalidation;
- a transaction that cannot insert every required outbox row fails entirely;
- replay order guarantees the authority event is observed before the broad ticket invalidation;
- decision requests use no invented v2 event type;
- the outbox flusher broadcasts committed rows by gateway sequence and resumes after daemon
  restart.

## 10. Control-plane Read Models and API

### 10.1 Checkpoint collection

```text
GET /v1/kernel/tickets/:id/checkpoints
```

Query parameters:

```text
after_id     incremental ascending sync
before_id    historical pagination
limit        default 50, maximum 200
```

`after_id` and `before_id` are mutually exclusive.

Ordering is fixed for every request:

- default returns the newest `limit` rows, but `items` are sorted by ID ascending;
- `before_id=N` returns the newest `limit` rows with `id < N`, sorted ascending;
- `after_id=N` returns rows with `id > N`, sorted ascending;
- `nextBeforeId` is the smallest returned ID, or null when no older row exists;
- the normalized store always keeps IDs ascending;
- the UI selector reverses the normalized IDs for newest-first rendering.

Response:

```ts
interface KernelCheckpointListResponse {
  items: KernelCheckpoint[];
  hasMore: boolean;
  nextBeforeId: number | null;
}
```

### 10.2 Intervention collection

```text
GET /v1/kernel/interventions?ticket_id=:id&state=pending&id=approval:18&id=decision:7
POST /v1/kernel/interventions/:id/resolve
```

`ticket_id`, `state`, and repeated `id` filters may be combined. Full intervention reads require
`approvals:respond`; the repeated ID form lets historical conversation cards resolve their
authority without one request per card.

Resolution input is a strict discriminated union so an approval cannot receive a decision
option and a decision cannot receive `approve_session`.

Existing `/v1/approvals` and `/v1/approvals/:id/resolve` remain for compatibility.

### 10.3 Workbench snapshot

The left rail needs active agent and elapsed-time data without fetching one detail resource per
ticket. Add a batch work-item projection:

```ts
interface KernelTicketWorkItem {
  ticketId: number;
  timing: KernelTicketTiming;
  activeExecution: {
    attemptId: number;
    role: 'executor' | 'reviewer';
    runtime: 'pi' | 'codex' | 'claude';
    state: 'starting' | 'running' | 'settled' | 'crashed' | 'stopped';
    model: string | null;
    externalSessionId: string | null;
  } | null;
  pendingInterventionCount: number;
  latestCheckpointId: number | null;
}
```

Endpoint:

```text
GET /v1/kernel/work-items
```

It supports repeated `ticket_id` parameters. Without `ticket_id`, it returns the same ticket
universe as `GET /v1/tickets`. This remains one batch request rather than an N+1 detail fetch.

The frozen `TicketSummary.attention` semantics remain unchanged. The left rail combines those
existing counts with additive `KernelTicketWorkItem.pendingInterventionCount`; no protocol-v2
field changes meaning.

The ticket detail uses the richer workbench projection:

```ts
interface KernelTicketWorkbench {
  ticket: KernelTicket;
  timing: KernelTicketTiming;
  activeAttempt: KernelAttempt | null;
  children: KernelTicket[];
  latestCheckpoints: KernelCheckpoint[];
  interventionRefs: KernelInterventionRef[];
}
```

Endpoint:

```text
GET /v1/kernel/tickets/:id/workbench
```

The composite endpoint is optimized for opening the detail panel without an N+1 waterfall. It
returns only the latest 50 checkpoints and direct children. Older checkpoints and detailed logs
remain paged resources.

### 10.4 Lead conversation card collection

```ts
type KernelConversationCard =
  | {
      id: number;
      key: string;
      kind: 'ticket_execution';
      turnId: string;
      ticketId: number;
      operations: TicketOperationProjection[];
      operationsTruncated: boolean;
      createdAt: string;
      updatedAt: string;
    }
  | {
      id: number;
      key: string;
      kind: 'checkpoint';
      turnId: string | null;
      ticketId: number;
      checkpointId: number;
      createdAt: string;
      updatedAt: string;
    }
  | {
      id: number;
      key: string;
      kind: 'intervention';
      turnId: string | null;
      ticketId: number;
      checkpointId: number;
      interventionId: string;
      createdAt: string;
      updatedAt: string;
    };
```

Endpoint:

```text
GET /v1/kernel/conversation/cards?after_id=:id&before_id=:id&limit=100
GET /v1/kernel/conversation/cards?ticket_id=:id&key=:stableKey
```

The endpoint follows the same mutually exclusive cursor rules and ascending item ordering as
checkpoints.

Cursor pagination discovers newly inserted cards and loads history. Existing ticket-execution
cards are mutable display projections because operation rows advance from running to terminal.
Therefore a `ticket.updated` invalidation refetches cards by `ticket_id`, and a terminal live tool
event may refetch by stable `key`; it must not rely only on `after_id`. Repeated `ticket_id` and
`key` filters are supported for batching.

Response includes immutable Checkpoint sidecars for every referenced checkpoint in the page:

```ts
interface KernelConversationCardListResponse {
  items: KernelConversationCard[];
  checkpoints: KernelCheckpoint[];
  interventionRefs: KernelInterventionRef[];
  hasMore: boolean;
  nextBeforeId: number | null;
}
```

Intervention authority details are deliberately excluded from this `tickets:view` response.
Authorized clients batch-load referenced intervention IDs from the intervention endpoint. A
read-only client can still render safe Checkpoint context and a non-interactive action-required
state.
Cards with a `turnId` are appended to the matching assistant message. Cards without a `turnId`
become synthetic system messages in the single Lead session. Top-level turns and synthetic card
messages sort by `(createdAt, sourceRank, stableKey)`, where `sourceRank` is `turn=0, card=1` and
`stableKey` is `turn:<turnId>` or `card:<cardId>`. This defines deterministic ties without trying
to compare numeric card IDs with string turn IDs.

The first durable card scope covers the card forms visible in the accepted prototype:

- ticket execution card with current ticket summary and bounded operation rows;
- Checkpoint summary card for Lead-visible completion/failure updates;
- intervention card with child context, diagnostic fact, actions, and open-ticket affordance.

Generic historical Lead tool cards remain a later extension unless they are operation rows inside
a ticket execution card.

### 10.5 Authorization

- checkpoint and timing reads require `tickets:view`;
- work-item and conversation-card reads require `tickets:view`;
- workbench reads require `tickets:view`;
- workbench and conversation cards expose only intervention IDs, kind, and state, never approval
  payloads, decision options, or response actions;
- full intervention reads and approval/decision resolution require `approvals:respond`;
- child tool writes are internal Coordinator operations, not paired public endpoints;
- raw runtime logs continue to require `tickets:view` and are not broadcast over WebSocket.

## 11. Companion Zustand Design

### 11.1 `controlPlaneStore`

Add normalized cold entities:

```ts
interface TicketWorkbenchIndex {
  ticketId: number;
  activeAttemptId: number | null;
  childTicketIds: number[];
  latestCheckpointIds: number[];
  interventionIds: string[];
}

interface ControlPlaneData {
  checkpointsById: Record<number, KernelCheckpoint>;
  checkpointIdsByTicket: Record<number, number[]>;

  interventionRefsById: Record<string, KernelInterventionRef>;
  interventionsById: Record<string, KernelIntervention>;
  interventionIdsByTicket: Record<number, string[]>;

  workItemsByTicketId: Record<number, KernelTicketWorkItem>;
  workbenchByTicketId: Record<number, TicketWorkbenchIndex>;
  timingByTicketId: Record<number, KernelTicketTiming>;

  conversationCardsById: Record<number, KernelConversationCard>;
  conversationCardIdByKey: Record<string, number>;
  conversationCardIds: number[];
}
```

Normalization rules:

- checkpoint ordering uses numeric ID, not timestamp-only sorting;
- replacing a workbench snapshot normalizes ticket, timing, active attempt, child tickets,
  checkpoints, and intervention refs into their canonical entity maps, then stores IDs only in
  `TicketWorkbenchIndex`;
- incremental fetch appends IDs not already present;
- intervention ID includes the authority type prefix;
- safe intervention refs always normalize into `interventionRefsById`;
- privileged full intervention responses normalize into `interventionsById` without replacing or
  weakening the safe ref;
- UI selectors use the full entity when available and otherwise use the safe ref for state-only
  rendering;
- work-item snapshots merge by ticket ID and are loaded in one batch;
- live conversation cards first merge by stable key; authoritative snapshots then merge by
  numeric card ID and retain server ordering;
- linked approval state remains normalized in the existing approval entities where practical;
- server data is never copied into `workspaceStore`.

Durable cards are adapted into the existing normalized message model:

- a card with `turnId` becomes one or more structured parts on that turn's assistant message;
- an asynchronous card creates a synthetic `system` message with stable ID `card:<cardId>`;
- ticket execution uses a `ticket-execution` part;
- Checkpoint uses a `checkpoint` part;
- actionable child feedback uses an `intervention` part;
- a refresh replaces the same stable IDs instead of creating duplicate messages.

### 11.2 Resource keys

```text
workbench:<ticketId>
work-items
checkpoints:<ticketId>
interventions:<ticketId>
conversation-cards
conversation-cards:ticket:<ticketId>
attempt-events:<attemptId>
```

Timing has no independent HTTP resource key. `timingByTicketId` is refreshed by the observed
`work-items` batch for the rail and by `workbench:<ticketId>` for detail. Event invalidation marks
those owners stale rather than scheduling an undefined timing endpoint.

Opening a ticket detail observes the workbench resource. Opening the log tab additionally
observes attempt events. Closing the panel decrements observers but keeps bounded cached data for
fast reopen.

### 11.3 `streamStore`

No checkpoint data enters `streamStore`. Checkpoints are low-frequency authoritative entities.

Existing bounded attempt log buffers remain the source for the Logs tab. The first implementation
may refresh logs on `attempt.updated` and tab focus; no raw log WebSocket broadcast is introduced.

### 11.4 `workspaceStore`

Add:

```ts
type TicketDetailTab = 'checkpoints' | 'artifacts' | 'logs';

interface WorkspaceData {
  ticketDetailTabByTicket: Record<number, TicketDetailTab>;
}
```

Default tab is `checkpoints`. Selection is local UI state and survives panel close within the
current app lifecycle.

### 11.5 Runtime actions

Add focused actions:

```text
ensureTicketWorkbench(ticketId)
observeTicketWorkbench(ticketId)
ensureWorkItems(ticketIds?)
loadOlderCheckpoints(ticketId)
refreshCheckpoints(ticketId)
ensureConversationCards()
loadOlderConversationCards()
resolveIntervention(id, input)
observeAttemptEvents(attemptId)
```

Components continue to access these through focused hooks rather than importing the client.

## 12. UX Mapping to the Prototype

### 12.1 Left ticket rail

Implement the prototype's grouped ticket list using existing ticket summaries:

```text
需要你介入
进行中
待验收
已完成
```

Group rules:

- `需要你介入`: pending approval/intervention, blocker count, stale runtime, or blocked status;
- `进行中`: assigned or in-progress without pending intervention;
- `待验收`: review without higher-priority intervention;
- `已完成`: done, collapsed by default;
- cancelled tickets are available under `全部` but not mixed into completed success counts.

Top filters:

```text
全部
进行中
待办
```

`待办` means pending user/Lead action or review. It is not a synonym for every unfinished ticket.

The list must include the prototype's three empty states:

- no tickets yet;
- all tickets completed;
- current filter/search has no results.

### 12.2 Ticket cards

Cards display:

- runtime/agent avatar when active execution exists;
- title as primary text;
- ticket ID, child/runtime state, and optional elapsed time as secondary text;
- status edge/accent;
- attention signal;
- progress bar only when a future trustworthy progress model exists.

No percentage is inferred from runtime state, tool calls, or child prose.

Compact elapsed formatting:

```text
under 1 minute     <1m
1 to 59 minutes    6m
1 to 47 hours      2h 18m
48 hours or more   3d 4h
```

### 12.3 Central Lead conversation cards

The central message list supports the exact structured card families highlighted in the
prototype.

#### Ticket execution card

After Lead creates a ticket, the assistant message renders one durable card containing:

```text
ticket ID, status, priority
ticket title and summary
open-ticket affordance
bounded operation rows such as create_ticket and spawn_child
current operation state: done, running, or failed
```

Ticket fields are live projections from normalized ticket/work-item state. Operation rows come
from the durable conversation-card payload. Updating runtime state must not overwrite historical
operation completion.

Clicking the card selects the real ticket and opens the right detail column on desktop or the
full-screen detail on compact layouts.

#### Checkpoint card

A Lead-visible child completion, crash, or important result renders:

```text
source line: 来自 child #70 的消息 · 15:43
checkpoint kind and ticket ID
title and summary
optional facts/artifacts
open-ticket affordance
```

Routine progress remains only in ticket detail according to the lead-feed projection policy.

#### Intervention card

An actionable blocked/decision Checkpoint renders the prototype's emphasized intervention card:

```text
source line
需要你介入 badge
ticket ID and title
child explanation
diagnostic fact such as stderr projection
authority-backed actions
open-ticket action
```

The card's copy comes from the Checkpoint. Buttons and resolution state come from the linked
intervention authority. The message card never stores an independent approved/rejected flag.

#### Merge and ordering rules

- a ticket card tied to a Lead turn renders after that turn's assistant text;
- asynchronous child cards render as synthetic system messages;
- persisted turns and cards merge by the defined `(createdAt, sourceRank, stableKey)` ordering;
- cards keep stable message/part IDs across refresh and reconnect;
- a live card is reconciled with its later snapshot by stable key first, then authoritative card
  ID, never by text or timestamp heuristics;
- no demo card is inserted while card snapshots load.

### 12.4 Detail header

The right desktop column and mobile full-screen detail show:

- title and summary;
- ticket ID, status, priority;
- current runtime health or attention state;
- project;
- active runtime and child attempt;
- session ID with copy affordance;
- elapsed time as a ticket property;
- direct child tickets.

Correct the prototype contradiction `未分配 · child #70`: an existing child is displayed as
`child #70 · 已暂停`; a truly unassigned ticket displays no child ID.

### 12.5 Detail tabs

Replace:

```text
PoW | 产物 | 日志
```

with:

```text
进展 | 产物 | 日志
```

The fixed four-card metric grid is removed.

- task-specific facts render inside the relevant Checkpoint card;
- elapsed time lives in the ticket property section;
- tool count stays in Logs advanced metadata;
- Artifact remains a separate resource boundary and is not fabricated from file paths;
- Logs use existing normalized runtime events and bounded client buffers.

If the artifact capability is unavailable, the Artifact tab renders a real unsupported/empty
state rather than mock files.

### 12.6 Checkpoint feed

The feed is reverse chronological, with the newest Checkpoint first. Historical pagination loads
older items below the current list without reordering or duplicating existing IDs.
Each card may show:

```text
source avatar and label
timestamp
kind/status chip
stage
title
summary
key facts
artifact chips
related ticket chips
next step
embedded intervention actions
```

Agent and system source labels are explicit:

```text
child #73 汇报
系统记录
reviewer #81 汇报
```

Checkpoint states use progress language, not acceptance language:

```text
已完成阶段
进行中
方向调整
已委派
需要介入
执行完成，等待验收
```

Do not render `2/3 passed` unless a separate verified review resource exists. A deterministic
plan may render `已完成 2/3 个阶段`, but this is plan progress, not proof.

### 12.7 Embedded approvals and decisions

Pending interventions render inline in their linked checkpoint:

```text
需要你介入
child #73 needs approvals:respond to continue validation.

[拒绝并绕开] [授权本次] [本 Session 允许]
```

The card reads current action state from `KernelIntervention`:

```text
pending     interactive buttons
resolved    resolved by and resolution
rejected    selected fallback or blocked state
expired     disabled action with expiry explanation
```

Resolving an action updates the authority and then appends a system checkpoint describing resume,
fallback, or continued blocking.

### 12.8 Contextual composer

The ticket-specific composer remains fixed at the bottom of the detail panel and sends to the
single Lead session with `ticketId` context. It does not write checkpoints directly. Lead may
choose to steer the child, resolve a decision, or create a new checkpoint through normal domain
tools.

### 12.9 Responsive behavior

Desktop:

- center Lead session remains primary;
- left rail and right detail stay optional and independently closable;
- opening either side animates center width with Reanimated;
- right detail retains independent scrolling and sticky composer.

Compact Web, Android, and iOS:

- ticket detail is full screen;
- the bottom four-way workspace switch is an in-panel segmented navigation, not an Expo Router
  root Bottom Tab navigator;
- ticket detail tabs use the same logical state and data resources as desktop;
- no platform-specific checkpoint data model exists.

## 13. Error, Empty, and Recovery States

### 13.1 Checkpoints

- initial loading: stable skeleton, no fake cards;
- empty: `这张工单还没有关键进展`;
- disconnected with cache: show cached checkpoints with `等待重新连接`;
- disconnected without cache: show connection state, not a demo feed;
- page failure: preserve loaded items and show an inline retry affordance;
- malformed checkpoint: reject at protocol adapter and invalidate the resource;
- sequence gap: refresh workbench and checkpoints from HTTP authority.

### 13.2 Timing

- ticket never started: show `尚未开始`, not `0s`;
- legacy approximate completion timestamp: display normally but mark only in diagnostics, not UI;
- clock skew: use server `computedAt` as the calculation base and advance locally from that base;
- detail view updates elapsed text at most once per second;
- ticket list rounds elapsed time and updates at most once per minute.

### 13.3 Interventions

- action already resolved elsewhere: return conflict, refresh authority, render final state;
- expired approval: disable action and append/derive an expiry system checkpoint;
- child disconnected while waiting: action remains resolvable; resume policy is handled by the
  Coordinator after resolution;
- unauthorized binding: return forbidden without exposing action payload;
- duplicate resolve: idempotent if identical, conflict if contradictory.

### 13.4 Lead conversation cards

- initial card loading never inserts placeholder domain cards;
- a live card remains visible while its authoritative snapshot is loading;
- malformed card payload invalidates `conversation-cards` without discarding valid text turns;
- a missing referenced ticket/checkpoint/intervention renders a bounded synchronization state and
  schedules the corresponding resource refresh;
- refresh and replay reconcile by stable key first and authoritative card ID second;
- operation projection failure cannot prevent the underlying Lead text from rendering.

## 14. Migration and Rollout

### Phase 1: schema and pure domain services

- add versioned migration for checkpoints, decision requests, conversation cards, approval
  attempt attribution, and ticket timing columns;
- add typed store functions and validators;
- add timing computation service;
- add checkpoint deduplication and deterministic system keys;
- keep current UI unchanged.

Exit criterion: migrations are rerunnable, foreign keys are valid, and domain unit tests pass.

### Phase 2: agent tools and lifecycle policy

- add `submit_checkpoint` and `request_decision`;
- extend `request_approval` and critical `ticket_update` transitions atomically;
- update child prompt discipline and examples;
- add system lifecycle checkpoints;
- add silence watchdog;
- cover Pi, Codex, and Claude through the same tool handlers.

Exit criterion: real child attempts produce deterministic and semantic checkpoints without UI.

### Phase 3: additive kernel API

- add shared kernel schemas;
- add checkpoint, intervention, work-item, workbench, and conversation-card endpoints plus timing
  projections inside work-item/workbench responses;
- advertise capabilities in `hello.v2`;
- map existing v2 events to snapshot invalidation;
- project Lead ticket operations and Lead-visible asynchronous checkpoints into durable cards;
- preserve frozen v2 contract tests.

Exit criterion: paired HTTP contract and authorization tests pass with protocol v2 unchanged.

### Phase 4: Companion Zustand integration

- add normalized checkpoint/intervention/timing/work-item/workbench/conversation-card entities;
- add resource observers and incremental checkpoint pagination;
- extend invalidation coordinator;
- merge durable cards into stable existing/synthetic message entities;
- expose focused hooks and runtime actions;
- retain bounded runtime log behavior.

Exit criterion: state tests prove dedupe, paging, reconnect, invalidation, and no cross-store high
frequency updates.

### Phase 5: high-fidelity UX implementation

- implement grouped left rail and empty states;
- implement durable ticket execution, Checkpoint, and intervention cards in the Lead message list;
- replace PoW with the Checkpoint feed;
- move elapsed time into ticket properties and cards;
- embed approval and decision actions;
- implement direct children, Artifact boundary state, and Logs tab;
- preserve desktop panel and compact mobile animations.

Exit criterion: desktop Web, compact Web, Android, and iOS match the accepted prototype semantics
using only real data.

### Phase 6: end-to-end acceptance

- run a real daemon and paired Companion;
- exercise semantic, deterministic, approval, decision, crash, recovery, completion, and timing
  flows;
- verify refresh/reconnect and historical checkpoint pagination;
- verify no mock card or fabricated percentage appears;
- update `docs/ACCEPTANCE.md` and gateway documentation.

## 15. Testing Strategy

### 15.1 Protocol tests

- strict validation for every checkpoint kind;
- reject extra fields, oversized arrays, invalid action refs, and invalid enums;
- existing v2 DTO and event contract fixtures remain byte-for-byte valid;
- existing v2 schemas still reject checkpoint and timing fields added to frozen objects;
- kernel workbench and list response validation;
- strict conversation-card union and bounded ticket-operation projection validation;

### 15.2 Migration and store tests

- fresh database creates all tables and indexes;
- old database backfills timing safely;
- migration is transactional and rerunnable;
- `PRAGMA foreign_key_check` returns no rows;
- agent duplicate checkpoint deduplicates;
- system idempotency keys are exactly-once;
- checkpoint pagination is stable under concurrent inserts;
- action reference transaction rolls back fully on failure;
- conversation-card projection keys are stable and exactly-once;
- tool-operation upserts cannot exceed the bounded row count or store raw tool payloads;
- operation projection retains the first plus newest rows and sets `operationsTruncated` at the
  seventeenth unique operation;
- pending legacy approvals receive exactly one repair Checkpoint/card while resolved approvals do
  not;
- decision/approval resolution, follow-up Checkpoint, card update, inbox consumption, and outbox
  insertion roll back as one transaction;
- approval creation/resolution emits the exact ordered authority event followed by
  `ticket.updated`; decision writes emit no invented v2 event;
- option/text/dismissed/expired decision resolution round-trips through dedicated columns and
  idempotent retry identity;

### 15.3 Coordinator and tool tests

- Pi, Codex, and Claude receive `submit_checkpoint`;
- invalid, oversized, or structurally incomplete payloads return useful tool errors;
- entering review without a completed checkpoint is rejected;
- atomic review transition writes checkpoint and transition together;
- request approval writes approval and checkpoint together;
- request decision writes decision request and checkpoint together;
- blocker resolution appends the correct system checkpoint;
- system lifecycle checkpoint keys are idempotent across daemon restart;
- silence watchdog sends at most one reminder per threshold window;
- ordinary reads and deltas do not trigger reminders;
- watchdog state and cooldown reconstruct from persisted rows after daemon restart;
- progress rate limiting, duplicate return, and bypass kinds obey configured windows;
- session-exempt approval requests create no pending approval and one progress Checkpoint;
- Lead `create_ticket` and `spawn_child` tool events converge into one ticket execution card;
- Lead-visible child intervention creates one asynchronous conversation card;

### 15.4 HTTP and authorization tests

- checkpoint list supports after/before paging and limits;
- workbench avoids N+1 client fetch requirements;
- unauthorized and under-scoped bindings receive 401/403;
- intervention resolution rejects mismatched action types;
- concurrent resolution returns one success and one stable conflict/idempotent result;
- option, custom-text, dismissal, expiry, audience, and identical retry rules are covered;
- `tickets:view` workbench/card responses do not expose approval payloads or decision actions;
- full intervention reads require `approvals:respond`;
- capability advertisement matches available endpoints;
- work-items return agent/timing data in one batch without per-ticket requests;
- conversation-card incremental/history pagination remains stable during live inserts;
- an updated existing ticket card is refetched by ticket/key rather than missed by `after_id`;

### 15.5 Zustand tests

- workbench normalization merges without duplicate IDs;
- incremental checkpoint fetch preserves order;
- `ticket.updated` invalidates the correct resources only;
- approval events refresh intervention projections;
- opening Logs does not reload checkpoint history;
- stream log updates do not notify ticket rail selectors;
- forget/reset removes checkpoint, intervention, and timing state;
- SSR/provider instances do not share new entities;
- a turn-bound card attaches to the existing assistant message;
- an asynchronous card creates exactly one stable synthetic message;
- live and snapshot versions of the same card reconcile by stable key, then authoritative ID;
- workbench normalization keeps one canonical checkpoint/intervention/timing entity per ID;
- work-item and workbench invalidation own timing refresh without an independent timing request;

### 15.6 UI tests

- correct group membership and counts;
- first-use, all-complete, and filter-empty states;
- no percentage when progress is unavailable;
- elapsed time formatting across running, blocked, review, done, and never-started tickets;
- Checkpoint source, kind, facts, artifacts, child links, and next step rendering;
- pending/resolved/rejected/expired intervention states;
- desktop side-panel width animation and mobile full-screen detail;
- screen-reader labels for checkpoint and action controls;
- no horizontal overflow at compact widths;
- ticket execution cards preserve tool-row states after refresh;
- intervention cards use authority-backed buttons and current resolution state;
- asynchronous child cards retain chronological placement after reconnect;
- read-only bindings see safe action-required cards without privileged payloads or buttons;

### 15.7 Real end-to-end scenarios

#### Scenario A: normal execution

1. Lead creates and dispatches a real ticket.
2. The Lead turn renders one durable ticket execution card with `create_ticket` and
   `spawn_child` operation rows.
3. Refresh reconstructs the same card without duplication.
4. System start checkpoint appears in ticket detail.
5. Child submits a milestone checkpoint.
6. Companion receives `ticket.updated`, fetches incrementally, and renders it.
7. Child submits completed checkpoint and enters review atomically.
8. A Lead-visible completion card appears for the root ticket.
9. Elapsed time freezes only when the ticket reaches done.

#### Scenario B: approval

1. Child calls `request_approval` with checkpoint context.
2. Companion and Slack show the same pending authority.
3. User approves in Companion.
4. Approval is resolved once.
5. Child resumes.
6. A system resume checkpoint appears in ticket detail and in the Lead feed when the original
   intervention was Lead-visible; Slack receives the existing adapter notification.
7. The original Lead intervention card now renders its resolved authority state.

#### Scenario C: decision request

1. Child presents two technical options to Lead or the user.
2. Checkpoint renders the decision context and actions.
3. Lead or user resolves one option.
4. Child receives the resolution and continues.
5. Resolution checkpoint records the selected direction.
6. On Slack, a non-approval multi-option decision is resolved from the user's explicit thread
   reply through Lead, not through unsupported arbitrary buttons.

#### Scenario D: crash and recovery

1. Child emits a semantic checkpoint.
2. Runtime crashes.
3. System crash checkpoint is inserted exactly once.
4. Coordinator redispatches or restores execution.
5. System recovery checkpoint appears.
6. Historical semantic checkpoint remains unchanged.

#### Scenario E: nested tickets

1. Parent child seals a plan and creates multiple child tickets.
2. Parent receives one plan milestone and delegation checkpoints.
3. Child completions produce parent system checkpoints.
4. Parent detail links to real global child ticket IDs.
5. No fabricated `#42.1` identifier is stored as ticket identity.

## 16. Acceptance Criteria

### Protocol and compatibility

- [ ] Protocol version remains `2`.
- [ ] Existing strict `TicketSummary`, `TicketDetail`, and Gateway event schemas are unchanged.
- [ ] New kernel schemas are strict and shared by backend and Companion.
- [ ] Old paired clients continue to connect and use current snapshots/events.
- [ ] Every additive endpoint is gated by an advertised capability and documented scope.

### Checkpoint behavior

- [ ] Agent-authored checkpoints are append-only and attributed to an attempt.
- [ ] System-derived checkpoints are deterministic and idempotent.
- [ ] Critical review, blocker, approval, decision, crash, recovery, delegation, and completion
      transitions cannot lose their checkpoint.
- [ ] Ordinary tool calls do not flood the feed.
- [ ] No child-authored checkpoint is presented as an independent pass verdict.

### Timing

- [ ] Never-started tickets show no fabricated elapsed time.
- [ ] Running, blocked, and review elapsed time continues from first actual execution start.
- [ ] Done/cancelled elapsed time freezes at completion.
- [ ] Active execution time is derived from attempts and handles parallel attempts correctly.
- [ ] Elapsed time is not continuously persisted as a counter.

### Decisions and approvals

- [ ] Checkpoint references action authorities instead of duplicating their state.
- [ ] Approval and checkpoint creation is atomic.
- [ ] Decision request and checkpoint creation is atomic.
- [ ] Resolution from Companion, Slack, CLI, or Lead converges on one authority state.
- [ ] Resolution creates a deterministic follow-up checkpoint.
- [ ] Pending legacy approvals remain visible after migration through idempotent repair.
- [ ] Read-only ticket clients cannot retrieve privileged action payloads or options.

### Companion UX

- [ ] Lead-created tickets render durable ticket execution cards with real operation states.
- [ ] Asynchronous child Checkpoint/intervention cards survive refresh and reconnect.
- [ ] Conversation cards reconcile with live projections by stable key and then authoritative ID
      without duplicate messages.
- [ ] Mutable ticket execution cards refresh by stable key/ticket filter, not append cursor alone.
- [ ] Intervention cards read pending/resolved/rejected/expired state from the action authority.
- [ ] Prototype `PoW` becomes `进展` backed by real Checkpoint data.
- [ ] Fixed capability/gap/tool-count cards are removed.
- [ ] Task-specific facts appear only when supplied by a real Checkpoint.
- [ ] Elapsed time appears as a ticket property.
- [ ] Left rail grouping, counts, filters, and all empty states use real tickets.
- [ ] Desktop and compact layouts use the same entities and actions.
- [ ] No mock ticket, checkpoint, metric, artifact, approval, or conversation is rendered.

### Verification

- [ ] Backend unit, protocol, migration, HTTP, Coordinator, runtime, and E2E suites pass.
- [ ] Companion typecheck, unit tests, Expo Web export, Android bundle, and iOS bundle pass.
- [ ] Real paired Web and Android Expo Go flows render checkpoint creation and action resolution.
- [ ] Refresh and reconnect preserve ordering and do not duplicate checkpoints or conversation
      cards.

## 17. Documentation Impact

Implementation must update:

- `docs/DESIGN-GATEWAY.md` with additive kernel resources and capability strings;
- `docs/ACCEPTANCE.md` with real Checkpoint, timing, approval, decision, and reconnect evidence;
- child/reviewer prompt documentation so Checkpoint and review verdict remain distinct;
- Companion state architecture documentation with normalized Checkpoint and intervention entities;
- protocol contract documentation confirming v2 remains frozen.

## 18. Deferred Work

The following are intentionally deferred:

- formal acceptance criteria and proof verification entities;
- trustworthy generic percentage progress;
- first-class Artifact metadata/download protocol;
- raw runtime log streaming over WebSocket;
- editing or deleting historical checkpoints;
- global analytics based on tool-call counts;
- protocol-v3 first-class checkpoint events;
- renaming the compatibility `approvals:respond` scope.

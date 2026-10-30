# Companion Zustand State Architecture Design

**Date:** 2026-07-24

**Status:** Implemented and accepted on 2026-07-24. See `docs/ACCEPTANCE.md`.

## 1. Objective

Migrate the Expo Companion application from one high-churn React Context provider and
component-local server caches to a Zustand-based state layer that is:

- driven by the existing strict control-plane protocol;
- normalized by stable domain IDs;
- safe for Expo Router static web rendering and React Native lifecycle behavior;
- efficient for streaming Lead text, tool updates, artifacts metadata, and bounded agent logs;
- independently testable without mounting the whole application;
- incrementally adoptable without a flag-day UI rewrite.

The migration must preserve all current pairing, reconnect, replay-cursor, approval, ticket,
project, agenda, Lead chat, native navigation, responsive panel, and no-mock-data behavior.

The selected dependency is Zustand 5.x. The latest package version verified on 2026-07-24 is
`5.0.14`. The implementation will use Zustand vanilla stores and React selectors. Immer is
not required for the initial migration.

## 2. Pre-Migration Problems

### 2.1 One Context owns unrelated update frequencies

`ControlPlaneProvider` currently owns connection state, all snapshots, conversation turns,
streaming text, commands, and ticket execution loading. Every provider state change creates a
new context value. A single `lead.message.delta` can therefore wake every consumer, including
ticket lists, project lists, agenda, navigation chrome, and inactive detail views.

### 2.2 Domain events trigger broad snapshot reloads

Most gateway events call one `refresh()` function that reloads overview, tickets, projects,
agenda, approvals, and conversation turns. This is acceptable for a small prototype but is
not viable for tool-stream updates or future log lines.

### 2.3 Ticket execution data is component-local

`TicketThread` loads activities and attempts into local state. Opening the same ticket from a
different route repeats the request, and Web/native screens do not share the cache. Artifact
metadata and runtime events would multiply this duplication.

### 2.4 Conversation snapshots cannot represent message cards

The current `ConversationTurn` snapshot contains only user and assistant text. Gateway events
carry Lead tool lifecycle events, but refresh cannot reconstruct those cards after reconnect.
The UI state migration must introduce a message-part model, while explicitly recognizing that
durable historical tool/artifact cards require a later protocol snapshot extension.

### 2.5 Workspace UI state is split by platform

Web and native independently own selected ticket, panel, rail, and thread state. Their behavior
has already diverged slightly and will become harder to coordinate when sessions, artifacts,
and log panels are introduced.

## 3. Scope

### 3.1 Included

- Add Zustand to the Companion app.
- Replace high-churn context data with stable, injected vanilla stores.
- Normalize tickets, projects, agenda items, approvals, Lead sessions/messages, attempts,
  activities, and future artifact metadata by ID. Runtime-event snapshots are validated and
  reduced by `(attemptId, seq)` into bounded stream projections rather than permanent raw
  entities.
- Add a deterministic gateway-event reducer and resource invalidation coordinator.
- Add bounded streaming state for message deltas, tool updates, and agent logs.
- Move shared Web/native workspace selection and panel state into a UI store.
- Replace `useControlPlane()` whole-context reads with focused selectors/actions.
- Move ticket execution loading and caching out of `TicketThread`.
- Introduce a discriminated message-part model and render existing text/tool/ticket-capable
  cards from normalized data.
- Keep credentials and replay cursor in the existing credential store.
- Preserve strict protocol validation in `ControlPlaneClient`.

### 3.2 Explicitly excluded from this migration

- Inventing artifact records when the daemon has no artifact resource.
- Persisting complete server snapshots, message history, artifact contents, or agent logs on
  the device.
- Replacing the control-plane protocol with Zustand persistence or a local-first sync engine.
- Adding a second state library or TanStack Query.
- Changing visual design, navigation semantics, or Unistyles/Reanimated behavior.
- Making tool/artifact cards historically durable without a daemon snapshot contract.
- Broadcasting raw `runtime.stderr` over WebSocket. Existing runtime events can be loaded from
  `/v1/kernel/attempts/:id/events`; real-time raw logs require a separate backend protocol task.

## 4. Architectural Decision

Use a stable `CompanionStateRuntime` containing three injected vanilla stores and one
`ControlPlaneClient`:

```text
HTTP snapshots -----------+
                          |
ordered Gateway events ---+--> protocol adapters/reducers
                          |             |
commands/results ---------+             +--> controlPlaneStore
                                        +--> streamStore
React gestures ------------------------------> workspaceStore

React components --> narrow selectors --> the relevant store only
```

The three stores are separate objects rather than slices in one global store. This is a
deliberate notification and ownership boundary: high-frequency log appends must never notify
ticket/project/session-list subscribers, and workspace gestures must not modify protocol
state.

The stores are created per Provider instance, not as mutable module singletons. This prevents
SSR/static-export request leakage, permits isolated tests, and gives pairing/logout a complete
runtime reset boundary.

## 5. Store Boundaries

### 5.1 `controlPlaneStore`: authoritative read models and commands

Owns relatively cold, server-authoritative state:

```ts
type ResourceState = 'idle' | 'loading' | 'ready' | 'stale' | 'error';

interface ControlPlaneState {
  phase: 'loading' | 'unpaired' | 'connecting' | 'ready' | 'error';
  connectionState: ConnectionState;
  error: string | null;
  overview: Overview | null;

  ticketsById: Record<number, TicketSummary>;
  ticketIds: number[];
  ticketDetailsById: Record<number, TicketDetail>;

  projectsById: Record<string, ProjectSummary>;
  projectIds: string[];
  agendaById: Record<string, AgendaItem>;
  agendaIds: string[];
  approvalsById: Record<number, ApprovalDto>;
  approvalIds: number[];

  sessionsById: Record<string, LeadSessionEntity>;
  sessionIds: string[];
  turnsById: Record<string, LeadTurnEntity>;
  turnIdsBySession: Record<string, string[]>;
  messagesById: Record<string, MessageEntity>;
  messageIdsBySession: Record<string, string[]>;
  messagePartsById: Record<string, MessagePart>;
  partIdsByMessage: Record<string, string[]>;
  assistantMessageIdByTurnId: Record<string, string>;
  turnIdByCommandId: Record<string, string>;

  attemptsById: Record<number, AttemptEntity>;
  attemptIdsByTicket: Record<number, number[]>;
  activitiesById: Record<number, ActivityDto>;
  activityIdsByTicket: Record<number, number[]>;

  artifactMetadataById: Record<string, ArtifactMetadata>;
  artifactIdsByAttempt: Record<number, string[]>;

  resourceState: Record<ResourceKey, ResourceLoadState>;
  lastAppliedGatewaySeq: number;
}
```

`artifactMetadataById` is a typed future boundary. No artifact entities are created until a
validated artifact protocol exists. Artifact bytes, blobs, and base64 content never enter the
store; they are downloaded or streamed by a dedicated client when requested.

Commands remain imperative actions implemented by the runtime and exposed through focused
hooks:

- pair / pairSocket / forget;
- connect / disconnect / refreshCore;
- sendChat;
- retryMessage / dismissLocalMessage;
- resolveApproval;
- ensureTicketDetail;
- ensureTicketExecution;
- ensureAttemptEvents.

Components cannot call arbitrary `setState` on domain data.

### 5.2 `streamStore`: bounded high-frequency state

Owns state that may update many times per second:

```ts
interface StreamState {
  textByMessageId: Record<string, string>;
  toolProgressByPartId: Record<string, ToolProgress>;
  logBuffersByAttemptId: Record<number, AgentLogBuffer>;
  heartbeatByAttemptId: Record<number, AttemptHeartbeat>;
}

interface AgentLogBuffer {
  items: AgentLogEntry[];
  seenSeqs: Record<number, true>;
  firstSeq: number | null;
  lastSeq: number | null;
  discardThroughSeq: number | null;
}
```

Rules:

- Message deltas update only one message key and are accumulated per message before one
  animation-frame or bounded 16 ms flush, rather than committing one store update per token.
- Tool updates use the composite part identity `turnId + callId`; a bare call ID is never a
  globally unique key.
- Runtime log events are deduplicated by `(attemptId, seq)`.
- Each attempt retains at most 2,000 log entries by default.
- At most eight attempt buffers are retained; least-recently-used buffers are evicted.
- Eviction and trimming prune both entries and their `seenSeqs` membership. The
  `discardThroughSeq` watermark prevents old snapshot pages from reintroducing truncated rows.
- Incoming log events are queued and flushed once per 16–50 ms frame/window, not once per line.
- A completed assistant message is folded into `controlPlaneStore`; its transient stream entry
  is then removed.
- Closing a detail/log viewer does not immediately delete its buffer, but least-recently-used
  buffers are evicted when the configured attempt-buffer count is exceeded.
- Terminal tool progress is folded into its canonical message part and deleted from the stream
  store. Terminal attempts delete their heartbeat.
- Message failure, active-session replacement, permanent disconnect, forget, and disposal clear
  affected transient text/tool/heartbeat entries.
- Orphaned non-terminal text and tool streams are capped at 256 entries each and expire after five
  minutes without activity. Heartbeats are capped at 64 attempts with the same idle expiry.
- Cleanup uses injected timers and is covered with fake-time tests; no unbounded seen/expiry index
  is retained after an entry is removed.

### 5.3 `workspaceStore`: local UI state

Owns state that is not server truth:

```ts
interface WorkspaceState {
  hydrated: boolean;
  selectedSessionId: string | null;
  selectedTicketId: number | null;
  selectedAttemptId: number | null;
  railOpen: boolean;
  threadOpen: boolean;
  compactPanel: 'work' | 'thread' | 'artifacts' | 'logs' | null;
  railView: 'tickets' | 'projects' | 'agenda';
  ticketQuery: string;
  expandedMessagePartIds: Record<string, true>;
  composerDraftByContext: Record<string, string>;
}
```

This store is shared by Web and native implementations. Responsive presentation remains in
the platform components, but selecting a ticket/session and opening/closing logical panels use
the same actions.

Platform composition follows this transition table:

| User intent | Desktop Web | Compact Web / native |
|---|---|---|
| select ticket | `selectTicket(id)` then `openThread()` | `selectTicket(id)` then `openCompactPanel('thread')` |
| open work list | `openRail()` | `openCompactPanel('work')` |
| close work list | `closeRail()` | `closeCompactPanel()` |
| open selected thread | `openThread()` | `openCompactPanel('thread')` |
| close selected thread | `closeThread()` | `closeCompactPanel()` |
| enter/leave compact breakpoint | retain selection and latent desktop `railOpen/threadOpen`; close `compactPanel` | same transition |

Breakpoint changes never discard selected ticket/session/attempt or drafts. Returning to desktop
restores the previously retained desktop rail/thread flags; compact overlays never mutate those
latent flags.

Only small UI preferences and drafts are eligible for future persistence. The initial
migration does not add a new cross-platform persistence dependency.

## 6. Session and Message Model

The current daemon exposes one active Lead session ID through overview plus flat
`ConversationTurn` snapshots. The app will normalize each turn into a user message and an
assistant message under a synthetic/current `LeadSessionEntity`:

```ts
interface LeadSessionEntity {
  id: string;
  kind: 'lead';
  title: string;
  createdAt: string | null;
  updatedAt: string | null;
}

interface LeadTurnEntity {
  id: string;
  sessionId: string;
  ticketId: number | null;
  originBindingId: number | null;
  originKind: string | null;
  state: ConversationTurn['state'];
  error: string | null;
  userMessageId: string;
  assistantMessageId: string;
  createdAt: string;
  updatedAt: string;
}

interface MessageEntity {
  id: string;
  sessionId: string;
  turnId: string | null;
  role: 'user' | 'assistant' | 'system';
  state: 'queued' | 'streaming' | 'completed' | 'failed' | 'steered';
  failure: {
    kind: 'rejected' | 'timeout-unknown' | 'turn-error';
    code: string | null;
    message: string;
  } | null;
  clientCommandId: string | null;
  source: 'snapshot' | 'live' | 'optimistic';
  createdAt: string;
  updatedAt: string;
}

interface ToolDisplayProjection {
  preview: string;
  truncated: boolean;
  redacted: boolean;
  artifactRefs: string[];
}

type MessagePart =
  | { kind: 'text'; id: string; text: string }
  | {
      kind: 'tool';
      id: string;
      callId: string;
      name: string;
      state: ToolState;
      args: ToolDisplayProjection | null;
      result: ToolDisplayProjection | null;
      error: string | null;
    }
  | { kind: 'ticket'; id: string; ticketId: number }
  | { kind: 'approval'; id: string; approvalId: number }
  | { kind: 'artifact'; id: string; artifactId: string }
  | { kind: 'agent-status'; id: string; ticketId?: number; attemptId?: number; state: string };

interface AttemptEntity {
  id: number;
  ticketId: number;
  role: AttemptDto['role'];
  state: AttemptDto['state'];
  model: string | null;
  runtime: KernelAttempt['runtime'] | null;
  startedAt: string;
  endedAt: string | null;
  kernel: KernelAttempt | null;
}
```

Current snapshot turns produce text parts. Existing `lead.tool.started/updated/completed/failed`
events create and patch tool parts using stable `turnId + toolCallId` identity. Ticket cards are
rendered when a validated part references a real ticket entity; no card is fabricated by
parsing arbitrary assistant text.

The runtime allocates the client command ID before optimistic state is written and calls
`ControlPlaneClient.sendChatCommand({ id, message, ticketId })`. The client validates a successful
result as `{ turnId: string }` before it reaches the domain reducer. The runtime stores
`turnIdByCommandId`; a successful result aliases the optimistic user message and assistant
shell to the returned turn without duplicating either. `lead.turn.started` is independently
idempotent against that turn.

A rejected command marks the optimistic message failed with a structured
`failure.kind: 'rejected'`. A timeout uses `failure.kind: 'timeout-unknown'` because it is
intentionally ambiguous:
the current authoritative snapshot does not contain the client command ID, so the app must not
guess by matching text or timestamps. A timed-out optimistic message remains local and visibly
retryable/dismissible until a future protocol adds durable command correlation. Retrying creates
a new client command and optimistic message after removing/replacing the failed row at the same
logical position; dismissing removes only that local message and all of its local indexes/parts.
The runtime exposes `retryMessage(messageId)` and `dismissLocalMessage(messageId)`; neither may
alter a server-backed snapshot message.
Snapshot turns therefore never silently consume an ambiguous timed-out optimistic row.

Message and part IDs are deterministic from `sessionId + turnId + role` and
`turnId + part-kind + protocol-identity`. A full turn snapshot replaces snapshot-owned turn and
text fields, while retaining live tool/status parts for the same active session generation.
Live parts are cleared only on active-session replacement, forget, runtime disposal, or an
explicit complete-disconnect policy. Turn normalization starts only after the accepted overview
snapshot establishes the active `sessionId` generation.

Durability rule: event-created tool parts are live-session data. They survive component
navigation but not a complete disconnect/restart unless the daemon later exposes a durable
message-part snapshot. The UI must not imply otherwise.

Kernel runtime-event responses are validated as ordered collections and reduced into bounded
per-attempt stream projections keyed by `(attemptId, seq)`. They are not normalized as permanent
raw event entities. Snapshot and future live projections merge in ascending sequence order and
obey the same 2,000-entry, eight-buffer, `discardThroughSeq`, and redaction limits.

## 7. Event Reduction and Invalidation

`ControlPlaneClient` remains responsible for:

- protocol validation;
- pairing and credential access;
- WebSocket connection/reconnection;
- command correlation;
- replay cursor persistence;
- rejecting duplicate/out-of-order gateway sequence numbers at the transport boundary.

Ownership is singular:

- `ControlPlaneClient` owns the active socket, reconnect timer, pending command map, transient
  pairing sockets/timers, and serialized replay-cursor persistence;
- `ResourceCoordinator` owns resource generations, observer counts, in-flight HTTP Promises,
  AbortControllers, invalidation timers, and replacement-fetch scheduling;
- the stream coordinator owns stream flush timers and attempt-buffer LRU bookkeeping;
- `CompanionStateRuntime` composes those objects and owns only the top-level lifecycle epoch,
  startup/forget/disposal ordering, and cross-store command/event orchestration.

Envelope validation is not sufficient because `GatewayEvent.payload` is currently an unknown
record. A protocol adapter validates the payload against a schema selected by event type and
produces a discriminated `ValidatedGatewayEvent` union before any reducer is called. Events with
an unknown or incomplete payload may produce conservative resource invalidations, but cannot
directly mutate entities. Invalid payloads surface a protocol diagnostic and never write raw
payload data into Zustand.

Raw tool arguments/results are not stored. The adapter creates a bounded display projection,
defaulting to 16 KiB per field, strips binary/base64-like values, and keeps explicit artifact
references rather than embedded content.

`ToolDisplayProjection` is the only args/result type accepted by `MessagePart`; reducer and UI
code never receive the original `unknown` payload after protocol adaptation.

Every accepted event enters one serialized ingress queue. The runtime validates and reduces
events synchronously in ascending sequence order, then applies control-plane mutations, stream
mutations, and invalidation intents as one ordered operation. `lastAppliedGatewaySeq` advances
only after those operations complete. It is initialized from the persisted replay cursor and is
diagnostic state, not a second independent replay filter.

Command results have no gateway sequence and are independently idempotent against events. Any
Lead event containing a valid `turnId` first ensures the session, turn, and assistant-message
shell exist. This makes event-before-command-result, command-result-before-event, and replay
permutations converge. On message completion, canonical assistant text is written to the
control-plane store before transient text is removed, preventing a blank render frame.

After validation, events are passed to one pure `reduceGatewayEvent` adapter. The adapter
returns deterministic mutations plus invalidation intents.

### Event mapping

| Event | Direct state update | Invalidations |
|---|---|---|
| `lead.turn.started` | create/mark active message shell | session turns if user text is unavailable |
| `lead.message.delta` | append one transient message stream | none |
| `lead.message.completed` | complete/fold message, clear transient text | session turns |
| `lead.tool.*` | create/update one tool part | none |
| `ticket.created` | none until validated snapshot | ticket list, projects, overview |
| `ticket.updated` | patch fields only when payload is complete | one ticket detail/summary, overview; related resources marked stale |
| `attempt.*` | patch attempt state when complete | active ticket execution |
| `child.tool.*` | patch live tool/log projection | active ticket execution |
| `approval.*` | remove/patch when sufficient | approvals and affected ticket |
| `notice.created` | for validated `{ severity: 'error', message }` with `turnId`, mark that turn/assistant failed with `failure.kind: 'turn-error'` | conversation turns when payload/turn target is incomplete |
| `daemon.status.changed` | patch overview status when sufficient | overview |
| `snapshot.required` | none | coalesced core refresh |

Invalidations are resource-specific, deduplicated, and coalesced in one microtask or short
window. A burst of 100 child tool events must not cause 100 HTTP refreshes.

Invalidating a resource increments its generation even when a request is already in flight.
The older response is discarded; if the resource still has observers, one replacement request
is scheduled after the stale request settles. A snapshot started before a gateway event cannot
therefore overwrite post-event state.

Only currently observed ticket/attempt detail resources are eagerly refreshed. Unobserved
resources are marked `stale` and loaded when opened.

## 8. Snapshot Loading and Cache Semantics

Each resource key tracks:

- state: idle/loading/ready/stale/error;
- request generation;
- last success time;
- error;
- observer count where relevant.

Concurrent `ensure*` calls for the same resource share one in-flight Promise. A stale response
from an older request generation cannot overwrite a newer accepted response.

The runtime owns its lifecycle epoch. The client owns an internal credential-write generation;
the resource and stream coordinators own their cancellation state. Disconnect, forget, or
provider disposal increments/invalidate these generations before cancellation. Public client
HTTP and pairing methods (`pair`, `pairLoopback`, and `pairSocket`) accept an `AbortSignal`.
Pairing acceptance, credential saves, and replay-cursor saves verify the captured client
credential generation immediately before every actual `save()`. Every async completion also
checks its captured runtime lifecycle epoch before mutating a store.

`forget()` first invalidates queued credential/cursor writes, then cancels work, clears
credentials, disconnects transport, and resets domain and stream stores. No old cursor save,
pairing acceptance, HTTP result, command result, invalidation callback, or stream flush may write
after reset.

Workspace reset uses `resetForForget({ preserveHydrated: true })`: ticket/session/attempt
selection, panels, filters, expansions, and drafts return to defaults, while `hydrated` retains its
current client value so forget does not recreate an SSR boot-shell transition.

Replay-cursor persistence is fail-closed and recoverable. Events are serialized in the client;
`record.lastSeq` is changed and the event is delivered only after the candidate credential
snapshot is saved successfully. If save fails, the client keeps the last successfully persisted
sequence, does not deliver the event, invalidates queued event work for that connection, reports a
protocol/storage error, closes the socket, and reconnects from the last persisted cursor. The
serialized write chain catches/resets its rejection so a later successful reconnect is not
permanently poisoned.

Core connect hydration requests overview, ticket list, project list, current week agenda,
approvals, and Lead turns according to scopes. Each request captures its resource generation.
An invalidation increments generation once per coalesced resource burst. If a request is already
active, its result is discarded and exactly one non-overlapping replacement runs after it
settles.

On initial connection, failure of a required pre-connect resource keeps the phase in `error`
and the socket is not opened. After the app has previously reached a successful connection,
reconnect keeps the transport available and exposes resource-level errors without erasing valid
entities. Readiness is reached only after every authorized core resource has either produced a
current-generation result or an actionable error for that hydration cycle.

Initial required resources are explicit:

| Authorized scope | Required pre-connect snapshot work |
|---|---|
| `tickets:view` | overview, tickets, projects, current-week agenda |
| `approvals:respond` | approvals |
| `chat` | conversation turns; hold the validated result locally until overview or `hello.v2` supplies the active session ID |
| `tickets:create` | none |
| `notices` | none until a notices snapshot contract exists |

All authorized rows in this table are required on the first connection. Successful resources are
retained if another required resource fails, but the initial socket is not opened. After one
successful ready cycle, the same failures are resource-local during reconnect.

Logout/forget atomically resets domain and stream stores, resets workspace business fields while
preserving `hydrated`, and disconnects the client.

## 9. React Integration

`CompanionStateProvider` places a stable runtime reference in React Context. The Context value
never contains live domain data.

Feature hooks use Zustand selectors, for example:

```ts
useConnectionPhase()
useTicketIds()
useTicket(ticketId)
useTicketExecution(ticketId)
useLeadSessionIds()
useSessionMessageIds(sessionId)
useMessage(messageId)
useMessageParts(messageId)
useStreamingText(messageId)
useAttemptLogs(attemptId)
useWorkspaceSelection()
```

Selectors must return stable primitives, entity references, or shallow-compared tuples. No
component may subscribe to an entire store or rebuild all entity arrays for unrelated updates.

Normalization and store actions follow a structural-sharing contract:

- unchanged entity values preserve the previous object reference;
- ordered ID arrays are reused when membership and order are unchanged;
- empty selectors return shared constants rather than new arrays/objects;
- selector `getSnapshot` paths never allocate;
- intentional tuples use shallow equality;
- `useMessageParts` returns the stored part-ID array or a shallow projection backed by stable
  entity references.

Derived view models such as status labels remain pure functions outside the store. The store
contains protocol/domain values, not localized presentation strings.

## 10. Expo, React Native, and Web Constraints

- No mutable module singleton is used for request-scoped SSR state.
- Store construction does not access `window`, `document`, SecureStore, locale/week helpers,
  timers, or WebSocket.
- Client connection starts only in a client effect and stops on provider unmount.
- `workspaceStore.hydrated` is `false` on the server and first client render. A provider client
  effect sets it to `true`; forget does not reset hydration.
- Static web rendering and the first client render see the same deterministic boot shell.
- Credential storage remains platform-specific and outside Zustand persistence.
- React Native AppState behavior is unchanged in the first migration; reconnect remains owned
  by `ControlPlaneClient`.
- No Node-only APIs enter the Companion bundle.

## 11. Proposed File Structure

```text
apps/companion/src/state/
  CompanionStateProvider.tsx
  runtime.ts
  types.ts
  selectors.ts
  control-plane/
    store.ts
    actions.ts
    normalize.ts
    eventReducer.ts
    invalidation.ts
  streams/
    store.ts
    logBuffer.ts
    batching.ts
  workspace/
    store.ts
    selectors.ts
  testing/
    createTestRuntime.ts
```

`ControlPlaneClient` stays under `src/data/`. It remains a transport/protocol adapter and does
not import React or Zustand.

## 12. Migration Sequence

### Phase 1: Foundation and compatibility bridge

- Install Zustand.
- Add three vanilla stores and runtime/provider construction.
- Normalize existing `ConversationTurn` snapshots immediately into session, turn, message, and
  text-part entities.
- Move connection lifecycle and core snapshot hydration behind runtime actions.
- Keep a temporary compatibility hook for unchanged screens, but it must read the same runtime
  entities and cannot construct a second client, socket, hydration coordinator, or domain copy.

Exit criterion: mixed migrated and compatibility consumers share one client/socket, one
coordinator/reducer, and one canonical entity graph; existing UI behavior and tests pass.

### Phase 2: Focused selectors and workspace unification

- Migrate screens/components away from whole-context reads.
- Move Web/native selection and panel state into `workspaceStore`.
- Remove duplicate local workspace reducers/state.

Exit criterion: changing one message stream does not notify ticket/project/agenda selectors.

### Phase 3: Ticket execution cache

- Normalize activities and attempts.
- Add deduplicated `ensureTicketExecution`.
- Migrate `TicketThread` from component-local execution state.
- Add lazy runtime-event loading from kernel attempt events.

Exit criterion: opening the same ticket from two surfaces performs one in-flight request and
both views receive the same updates.

### Phase 4: Sessions and message parts

- Add text/tool/ticket/approval/artifact/status part render boundaries.
- Route Lead tool lifecycle events into tool cards.
- Move streaming text into `streamStore`.

Exit criterion: a tool lifecycle updates one card in place, while the session list and unrelated
messages retain selector identity.

### Phase 5: Remove compatibility layer

- Remove `ControlPlaneProvider` live Context API and temporary whole-state facade.
- Retain only the stable runtime provider and narrow hooks.
- Delete demo conversation/ticket/timeline fallback from every production path. Unpaired,
  disconnected, and empty resources render explicit connection or empty states.

Exit criterion: no production component imports `useControlPlane` or subscribes to a whole store.

## 13. Acceptance Criteria

### 13.1 Functional parity

- Loopback, code, and encrypted socket pairing still work.
- Reconnect resumes from the persisted gateway sequence.
- Ticket/project/agenda/approval views match current control-plane snapshots.
- Global and ticket-context chat commands still correlate and stream.
- Approval resolution updates the relevant card and ticket state.
- Web and native preserve the current temporary left/right panel interaction model.
- Unpaired mode never renders mock conversations or tickets.
- Workspace behavior is defined by semantic actions (`selectTicket`, `openRail`, `closeRail`,
  `openThread`, `closeThread`, `openCompactPanel`, `closeCompactPanel`) that platform components
  compose differently without owning duplicate state machines.

### 13.2 State isolation

- Appending 1,000 deltas to message A does not notify subscribers for tickets, projects,
  agenda, workspace selection, message B, or inactive ticket execution.
- Given 1,000 deltas before timers advance, the stream store performs zero commits before flush
  and exactly one commit after the configured flush.
- Appending logs for attempt A does not notify attempt B or the Lead session list.
- Selecting a ticket changes only workspace selectors and components that derive that selection.
- Updating ticket A does not notify a selector subscribed to ticket B.

### 13.3 Event correctness

- Duplicate or old sequence events are ignored.
- `lead.tool.started -> updated -> completed/failed` updates one stable tool part.
- A completed Lead message folds transient text exactly once and clears the stream buffer.
- Event bursts coalesce invalidations; 100 invalidations for one resource produce one request.
  If a request is already active, they produce exactly one non-overlapping replacement.
- Reconnect replay produces the same final normalized state as a clean snapshot plus live events.
- Reducer permutations for command-result/start/delta/tool/completed converge to the same state.
- Duplicate tool call IDs in different turns update distinct composite part IDs.
- Live tool/status parts survive text snapshot replacement for the same session generation.

### 13.4 Cache correctness

- Concurrent detail/execution/event requests for one key share a Promise.
- Older request generations cannot overwrite newer data.
- Disconnect/forget during an in-flight request prevents its completion from mutating reset
  state.
- Partial refresh failure preserves already-valid entities and exposes resource-level errors.
- Forget/logout resets domain, streams, workspace state, request registries, and client connection.
- Unchanged snapshots produce zero notifications for entity and ordered-ID selectors.
- Race tests cover cursor-save-vs-forget, pairing-vs-forget, HTTP-vs-disposal,
  command-result-vs-disposal, and stream-flush-vs-disposal.
- A failed replay-cursor save does not apply the event, does not advance in-memory/persisted
  sequence, triggers reconnect, and a later successful save resumes from the last durable cursor.

### 13.5 Streaming and memory bounds

- Per-attempt logs are ordered and deduplicated by sequence.
- The default buffer retains no more than 2,000 entries and exposes truncation metadata.
- No more than eight per-attempt buffers are retained, and trimmed `seenSeqs` state cannot grow
  independently of retained entries.
- Log bursts are batch-flushed rather than committing once per line.
- Artifact bytes/base64 never appear in Zustand state.
- Orphan text/tool streams never exceed 256 entries, heartbeats never exceed 64 attempts, and all
  expire after five minutes of inactivity.

### 13.6 SSR and platform validation

- `npm test` and `npm run typecheck` pass in `apps/companion`.
- `npm run lint` passes.
- `npm run export:web` completes with static routes.
- Expo export succeeds for Android and iOS bundles.
- Initial web static HTML renders the stable boot shell without accessing browser-only APIs.
- Server and first-client store snapshots are equal before the hydration effect.
- Desktop Web, compact Web, native, and breakpoint transitions pass the same workspace semantic
  transition table.

### 13.7 End-to-end validation

- Existing real-daemon Companion integration tests remain green.
- Add a store-level real-daemon test covering snapshot hydration, ordered Lead deltas, a tool
  lifecycle card, ticket invalidation, approval resolution, disconnect, and replay reconnect.
- Capture selector notification counts in tests to prove isolation, not only visual parity.

## 14. Deferred Protocol Work

The Zustand migration creates stable client boundaries but does not make missing backend data
appear. These follow-up protocol tasks are explicitly tracked:

1. Durable Lead session/message/message-part snapshots so tool/ticket/artifact cards survive a
   full reconnect and app restart.
2. Artifact metadata/list/download resources with content hashes, media type, size, attempt,
   ticket, and provenance.
3. Optional scoped real-time runtime-event projection for active attempt logs, with replay and
   backpressure semantics. Until then, the app uses lazy kernel event snapshots.
4. Session listing beyond the daemon's current active Lead session.
5. Durable client-command correlation IDs in conversation snapshots/events. Until this exists,
   timed-out optimistic messages cannot be automatically reconciled safely.

The state model must accept these additions without replacing stores or component APIs.

## 15. Success Definition

The migration is successful when Zustand is not merely a replacement for `useState`, but an
explicit client-side read-model layer:

- protocol input is reduced once;
- entities have one canonical location;
- high-frequency streams are bounded and isolated;
- UI state is shared where behavior is shared;
- components subscribe only to what they render;
- missing backend contracts remain explicit rather than represented by mock state.

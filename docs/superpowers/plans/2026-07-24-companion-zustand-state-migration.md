# Companion Zustand State Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Companion app's high-churn React Context and component-local server caches with three isolated Zustand vanilla stores for authoritative control-plane state, bounded real-time streams, and shared workspace UI state.

**Architecture:** A stable `CompanionStateRuntime` owns one existing `ControlPlaneClient` plus three vanilla Zustand stores. Protocol snapshots and ordered gateway events enter pure normalizers/reducers, high-frequency deltas/logs are frame-batched in a separate stream store, and components subscribe through narrow selector hooks. A temporary compatibility facade keeps the app usable while features migrate, then is removed.

**Tech Stack:** Expo 57, React 19, React Native 0.86, Expo Router, Zustand 5.0.14, TypeScript, Vitest, TypeBox protocol schemas, existing Unistyles/Reanimated UI.

**Design Spec:** `docs/superpowers/specs/2026-07-24-companion-zustand-state-architecture-design.md`

**Status:** Completed and accepted on 2026-07-24. The temporary compatibility facade was
deleted after all consumers migrated. Final evidence is recorded in `docs/ACCEPTANCE.md`.

---

## File Structure

### New state runtime files

- `apps/companion/src/state/types.ts`: normalized entity, resource, message-part, stream, and workspace types.
- `apps/companion/src/state/runtime.ts`: composes client, resource/stream coordinators, and stores;
  owns only top-level lifecycle/startup/forget/disposal orchestration.
- `apps/companion/src/state/CompanionStateProvider.tsx`: stable runtime Context and narrow store hooks.
- `apps/companion/src/state/selectors.ts`: pure selectors and stable empty IDs.
- `apps/companion/src/state/hooks.ts`: focused React selector hooks and derived arrays.
- `apps/companion/src/state/control-plane/store.ts`: vanilla authoritative domain store.
- `apps/companion/src/state/control-plane/normalize.ts`: snapshot-to-entity normalization.
- `apps/companion/src/state/control-plane/protocolAdapter.ts`: event-type payload validation,
  redaction, and bounded display projection.
- `apps/companion/src/state/control-plane/eventReducer.ts`: pure gateway-event reduction and invalidation intents.
- `apps/companion/src/state/control-plane/actions.ts`: domain commands, hydration, optimistic
  messages, and execution/event loading over the resource coordinator.
- `apps/companion/src/state/control-plane/invalidation.ts`: resource coordinator owning
  generations, observers, in-flight Promises, AbortControllers, and coalesced refresh scheduling.
- `apps/companion/src/state/streams/store.ts`: message/tool/log stream store.
- `apps/companion/src/state/streams/batching.ts`: injected frame/timer batching.
- `apps/companion/src/state/streams/logBuffer.ts`: bounded sequence-deduplicated attempt buffers.
- `apps/companion/src/state/workspace/store.ts`: shared Web/native selection and panel state.
- `apps/companion/src/state/testing/createTestRuntime.ts`: deterministic stores/client/timers for tests.

### Existing files to migrate

- `apps/companion/src/data/ControlPlaneProvider.tsx`: temporary compatibility adapter, then delete.
- `apps/companion/src/data/controlPlaneClient.ts`: expose command IDs/results and request cancellation without importing Zustand.
- `apps/companion/src/app/_layout.tsx`: use `CompanionStateProvider`.
- `apps/companion/src/features/workspace/Workbench.tsx`: workspace selectors/actions.
- `apps/companion/src/features/workspace/Workbench.web.tsx`: same workspace selectors/actions.
- `apps/companion/src/features/workspace/WorkRail.tsx`: narrow ticket/project/agenda selectors.
- `apps/companion/src/features/chat/LeadConversation.tsx`: normalized sessions/messages/parts and stream selectors.
- `apps/companion/src/features/chat/EmbeddedTicketCard.tsx`: dynamic ticket part rendering.
- `apps/companion/src/features/chat/ToolCallRow.tsx`: dynamic tool lifecycle rendering.
- `apps/companion/src/features/tickets/TicketThread.tsx`: shared execution/event cache.
- Route and identity components currently importing `useControlPlane`.

---

### Task 1: Install Zustand and establish isolated vanilla store contracts

**Files:**
- Modify: `apps/companion/package.json`
- Modify: `apps/companion/package-lock.json`
- Create: `apps/companion/src/state/types.ts`
- Create: `apps/companion/src/state/control-plane/store.ts`
- Create: `apps/companion/src/state/streams/store.ts`
- Create: `apps/companion/src/state/workspace/store.ts`
- Test: `apps/companion/src/state/storeIsolation.test.ts`

- [ ] **Step 1: Install `zustand@5.0.14` in the Companion package**

Run: `npm install --prefix apps/companion zustand@5.0.14`

Do not install Immer or another state/query library. Verify only
`apps/companion/package.json` and its package lock are changed by this command.

- [ ] **Step 2: Add importable contract scaffolding**

Create typed initial states and store factories using
`subscribeWithSelector` from `zustand/middleware`, but leave behavioral actions as explicit
no-ops. This is compile/test scaffolding only; no domain behavior is implemented before RED.

- [ ] **Step 3: Write failing store isolation tests**

Cover:

- three stores are distinct vanilla store instances;
- ticket A subscription is not notified by ticket B update;
- stream update does not notify control-plane or workspace stores;
- workspace selection does not notify domain/stream stores;
- reset restores deterministic initial state.

- [ ] **Step 4: Verify RED**

Run: `npm test -- src/state/storeIsolation.test.ts`

Expected: FAIL on concrete action/subscription assertions, not import, syntax, or type errors.

- [ ] **Step 5: Implement minimal store types and factories**

Use `createStore` from `zustand/vanilla`. Store factories must return new instances and expose
only named actions; no mutable singleton exports. Selector notification tests use
`subscribeWithSelector` rather than vanilla whole-store `subscribe`.

- [ ] **Step 6: Verify GREEN**

Run: `npm --prefix apps/companion test -- src/state/storeIsolation.test.ts && npm --prefix apps/companion run typecheck`

Expected: PASS.

### Task 2: Normalize control-plane snapshots and current Lead turns

**Files:**
- Create: `apps/companion/src/state/control-plane/normalize.ts`
- Create: `apps/companion/src/state/control-plane/normalize.test.ts`
- Modify: `apps/companion/src/state/types.ts`
- Modify: `apps/companion/src/state/control-plane/store.ts`

- [ ] **Step 1: Write failing normalization tests**

Assert:

- ticket/project/agenda/approval arrays become `byId + ordered ids`;
- removed snapshot entities are removed from current ordered collections without deleting
  independently cached detail entities;
- one `ConversationTurn` becomes stable user and assistant message IDs;
- repeated snapshot hydration is idempotent and preserves entity identity when values are equal;
- unchanged ordered ID arrays preserve their previous array identity;
- session order and message order are deterministic;
- turn entities retain ticket, origin binding/kind, protocol state, error, and timestamps;
- `originBindingId` remains `number | null`, message state preserves protocol `steered`, and
  `AttemptEntity` retains exact `role/state/model/startedAt/endedAt` summary fields;
- message entities retain `clientCommandId` and `source`;
- `turnsById`, `turnIdsBySession`, `assistantMessageIdByTurnId`, and
  `turnIdByCommandId` are internally consistent;
- no tool/ticket/artifact part is fabricated from assistant text.

- [ ] **Step 2: Verify RED**

Run: `npm test -- src/state/control-plane/normalize.test.ts`

- [ ] **Step 3: Implement pure normalizers**

Use explicit equality/reuse helpers so unchanged entities retain their prior object reference.
Reuse ordered ID arrays and shared empty constants. Do not put localized status labels into the
store. Normalize turns only after the current overview/session generation is accepted.

- [ ] **Step 4: Verify GREEN and regression tests**

Run: `npm --prefix apps/companion test -- src/state/control-plane/normalize.test.ts src/features/workspace/model.test.ts && npm --prefix apps/companion run typecheck`

### Task 3: Implement bounded, batched stream state

**Files:**
- Create: `apps/companion/src/state/streams/batching.ts`
- Create: `apps/companion/src/state/streams/logBuffer.ts`
- Create: `apps/companion/src/state/streams/streamStore.test.ts`
- Modify: `apps/companion/src/state/streams/store.ts`

- [ ] **Step 1: Write failing stream tests with fake timers**

Assert:

- 1,000 deltas queued before timers advance produce zero commits before flush and exactly one
  commit after flush;
- message B and domain/workspace subscribers are not notified;
- one log burst flushes once, and attempt A log updates do not notify attempt B subscribers;
- duplicate tool call IDs in different turns update distinct composite part IDs;
- log events dedupe and order by `(attemptId, seq)`;
- 2,001 log entries retain 2,000 and set truncation metadata;
- no more than eight attempt buffers are retained;
- trimming/evicting a buffer prunes its dedupe membership and advances
  `discardThroughSeq` so old snapshot pages cannot reintroduce removed rows;
- completing a message drains and deletes its transient text exactly once.
- terminal tool progress can be drained/returned and removes its transient stream entry;
- terminal attempts remove heartbeat state;
- failure/session replacement/permanent disconnect/forget/disposal clear affected transient
  entries;
- orphan text/tool maps cap at 256 entries, heartbeat caps at 64 attempts, and all expire after
  five idle minutes without leaking expiry indexes.

- [ ] **Step 2: Verify RED**

Run: `npm --prefix apps/companion test -- src/state/streams/streamStore.test.ts`

- [ ] **Step 3: Implement batching and bounded buffers**

Inject scheduling functions so native/web tests do not depend on real animation timing.

- [ ] **Step 4: Verify GREEN**

Run: `npm --prefix apps/companion test -- src/state/streams/streamStore.test.ts && npm --prefix apps/companion run typecheck`

### Task 4: Add pure gateway event reduction and coalesced invalidation

**Files:**
- Create: `apps/companion/src/state/control-plane/eventReducer.ts`
- Create: `apps/companion/src/state/control-plane/eventReducer.test.ts`
- Create: `apps/companion/src/state/control-plane/protocolAdapter.ts`
- Create: `apps/companion/src/state/control-plane/protocolAdapter.test.ts`
- Create: `apps/companion/src/state/control-plane/invalidation.ts`
- Create: `apps/companion/src/state/control-plane/invalidation.test.ts`

- [ ] **Step 1: Write failing reducer tests**

Cover every current gateway event type. Specifically prove:

- type-specific payload schemas produce a discriminated `ValidatedGatewayEvent` union;
- malformed/incomplete payloads never mutate entities, surface a protocol diagnostic, and may
  only produce conservative invalidation intents;
- tool argument/result projections are capped at 16 KiB, strip binary/base64-like content, and
  retain explicit artifact references;
- `MessagePart` accepts only `ToolDisplayProjection`; add a compile-time/type assertion proving
  raw `unknown` payloads cannot be assigned to args/result fields;
- Lead delta targets one assistant message;
- any Lead event can ensure a missing session/turn/assistant shell;
- tool start/update/complete/fail updates one stable `MessagePart`;
- ticket/attempt/approval/daemon events produce the documented resource invalidations;
- `notice.created` validates `{ severity: 'error', message }`; with a turn target it marks the
  turn/assistant failed using `failure.kind: 'turn-error'`, otherwise it is invalidation-only;
- 100 same-resource invalidations produce one request; when a request is already active they
  produce exactly one non-overlapping replacement;
- reducer completion output explicitly orders canonical text mutation before transient cleanup.
- reducer output represents terminal tool canonicalization before transient progress cleanup;

- [ ] **Step 2: Verify RED**

Run: `npm test -- src/state/control-plane/protocolAdapter.test.ts src/state/control-plane/eventReducer.test.ts src/state/control-plane/invalidation.test.ts`

- [ ] **Step 3: Implement reducer and scheduler**

Protocol adapter validates/redacts before the reducer. Reducer output is data, not side effects.
Invalidation scheduler owns timers, observer checks, generation increments, in-flight dedupe,
AbortControllers, and replacement scheduling. Transport ingress and cross-store sequencing are
implemented and tested in Task 5.

- [ ] **Step 4: Verify GREEN**

Run the same command and expect PASS, then run `npm --prefix apps/companion run typecheck`.

### Task 5: Build `CompanionStateRuntime` lifecycle and compatibility provider

**Files:**
- Create: `apps/companion/src/state/runtime.ts`
- Create: `apps/companion/src/state/control-plane/actions.ts`
- Create: `apps/companion/src/state/CompanionStateProvider.tsx`
- Create: `apps/companion/src/state/testing/createTestRuntime.ts`
- Create: `apps/companion/src/state/runtime.test.ts`
- Create: `apps/companion/src/state/runtime.integration.test.ts`
- Modify: `apps/companion/src/data/controlPlaneClient.ts`
- Modify: `apps/companion/src/data/controlPlaneClient.test.ts`
- Modify: `apps/companion/src/data/ControlPlaneProvider.tsx`
- Modify: `apps/companion/src/app/_layout.tsx`
- Modify: `apps/companion/src/features/workspace/WorkspaceBootShell.tsx` only if the existing
  `testID="workspace-boot-shell"` marker is missing
- Modify: `test/companion-client-integration.test.ts` only if typed chat helper coverage requires it

- [ ] **Step 1: Write failing lifecycle tests**

Assert:

- runtime creates one client and three stores;
- connect hydrates scoped core resources and then listens for events;
- partial snapshot failure preserves successful resources and records resource error;
- concurrent `ensure*` calls share one Promise;
- event invalidation during fetch discards old generation and performs one replacement fetch;
- first-connect required resources follow the scope table in the design; any authorized required
  failure retains successful snapshots, sets phase error, and does not open the socket;
- initial required-resource failure does not open the socket;
- reconnect after a prior ready state keeps transport and exposes resource errors;
- runtime-allocated chat command IDs map typed `{ turnId }` results without duplicating turns;
- accepted gateway events enter one serialized ascending-sequence ingress queue;
- `lastAppliedGatewaySeq` advances only after control, stream, and invalidation output is applied;
- duplicate/old sequence rejection remains owned by the client, not a second store filter;
- event-before-command-result and command-result-before-event are idempotent;
- rejected commands fail optimistic messages, while timed-out messages remain explicitly
  ambiguous and are never reconciled by text/time heuristics;
- disconnect/forget increments lifecycle and credential epochs before cancellation, aborts work,
  and prevents old HTTP/command/pairing/cursor/invalidation/stream completions from writing;
- provider unmount disconnects once;
- static/server construction touches no browser/native side-effect APIs, timers, locale/week
  helpers, or credential reads;
- server and first-client snapshots match until a client effect sets workspace hydration.
- static render output exposes the stable `workspace-boot-shell` marker and contains no real
  ticket/conversation entities before hydration.
- replay-cursor save failure does not deliver/apply the event or advance the in-memory cursor,
  closes/reconnects from the last durable sequence, and resets the serialized write chain so the
  next save can succeed.

Use a pure `mountCompanionRuntime(runtime)` lifecycle harness for startup/cleanup tests instead of
adding a React renderer dependency solely for provider-unmount coverage.

- [ ] **Step 2: Verify RED**

Run: `npm test -- src/state/runtime.test.ts`

- [ ] **Step 3: Add transport hooks without Zustand coupling**

Keep the current positional `sendChat(message, ticketId?)` wrapper for compatibility and add a
runtime-facing `sendChatCommand({ id, message, ticketId }, signal?)` returning validated
`{ turnId: string }`. Add `AbortSignal` to public HTTP and pairing methods (`pair`,
`pairLoopback`, `pairSocket`). The client owns socket/reconnect/pending commands/transient pairing
sockets and an internal credential-write generation. Every credential/cursor `save()` checks the
captured generation immediately before writing.

Client event persistence is serialized. It commits `record.lastSeq` and invokes `onEvent` only
after successful credential save; a failed save invalidates queued connection work before
reconnect and cannot poison future queue operations.

Runtime sequencing tests prove terminal tool data is committed to the canonical message part
before the stream coordinator drains/deletes transient tool progress.

- [ ] **Step 4: Implement runtime/provider and temporary facade**

The temporary `useControlPlane` facade reads the same runtime entities for compatibility, but
cannot instantiate another client/socket/coordinator or copy domain state. New code uses narrow
hooks. Keep it only until Task 9.

- [ ] **Step 5: Verify GREEN and client regressions**

Run: `npm --prefix apps/companion test -- src/state/runtime.test.ts src/state/runtime.integration.test.ts src/data/controlPlaneClient.test.ts && npm --prefix apps/companion run typecheck`

### Task 6: Unify workspace UI state across Web and native

**Files:**
- Create: `apps/companion/src/state/workspace/workspaceStore.test.ts`
- Create: `apps/companion/src/state/workspace/selectors.ts`
- Modify: `apps/companion/src/state/workspace/store.ts`
- Modify: `apps/companion/src/features/workspace/Workbench.tsx`
- Modify: `apps/companion/src/features/workspace/Workbench.web.tsx`
- Modify: `apps/companion/src/features/workspace/WorkRail.tsx`
- Modify: `apps/companion/src/features/chat/MessageComposer.tsx`
- Modify: `apps/companion/src/features/chat/LeadConversation.tsx`
- Modify: `apps/companion/src/features/tickets/TicketThread.tsx`
- Modify: `apps/companion/src/state/control-plane/actions.ts`
- Modify: `apps/companion/src/features/workspace/model.ts`
- Modify: `apps/companion/src/features/workspace/model.test.ts`

- [ ] **Step 1: Write failing shared-workspace tests**

Assert Web/native use the same semantic actions (`selectTicket`, `selectSession`,
`selectAttempt`, `openRail`, `closeRail`,
`openThread`, `closeThread`, `openCompactPanel`, `closeCompactPanel`) and share selection,
rail/thread state, compact panel, rail view, query, and invalid-selection cleanup. Freeze a
transition table for desktop Web, compact Web, native, and breakpoint changes. Assert forget does
not reset the client hydration flag. Cover expanded message-part state and composer drafts by
context, including draft update/clear actions.

- [ ] **Step 2: Verify RED**

Run: `npm test -- src/state/workspace/workspaceStore.test.ts src/features/workspace/model.test.ts`

- [ ] **Step 3: Implement and migrate platform workbenches**

Responsive rendering remains platform-specific; logical state/actions come from the same store.
Accepted ticket/session/attempt snapshots call one reconciliation action that clears only invalid
selections. `MessageComposer` receives a context key and uses the shared draft actions.

- [ ] **Step 4: Verify GREEN and motion/navigation tests**

Run: `npm --prefix apps/companion test -- src/state/workspace/workspaceStore.test.ts src/features/workspace/model.test.ts src/features/workspace/workspaceMotion.test.ts src/navigation/nativeNavigation.test.ts src/features/chat/composerStyles.test.ts && npm --prefix apps/companion run typecheck`

### Task 7: Migrate screens and collection components to focused selectors

**Files:**
- Create: `apps/companion/src/state/selectors.ts`
- Create: `apps/companion/src/state/selectors.test.ts`
- Modify: `apps/companion/src/app/(tabs)/agenda.tsx`
- Modify: `apps/companion/src/app/(tabs)/projects.tsx`
- Modify: `apps/companion/src/app/(tabs)/tickets.tsx`
- Modify: `apps/companion/src/app/ticket/[id].tsx`
- Modify: `apps/companion/src/app/pair.tsx`
- Modify: `apps/companion/src/components/LeadIdentity.tsx`
- Modify: `apps/companion/src/features/workspace/WorkRail.tsx`

- [ ] **Step 1: Write failing selector notification tests**

Measure subscription calls for tickets, projects, agenda, approvals, phase, and one entity by
ID. Updates to unrelated stores/entities must produce zero calls.

- [ ] **Step 2: Verify RED**

Run: `npm test -- src/state/selectors.test.ts`

- [ ] **Step 3: Implement stable selector hooks and migrate consumers**

Use `useStore(store, selector)` and `useShallow` only for intentional tuples/arrays. Avoid
selectors that allocate arrays on every read. `getSnapshot` paths return stable primitives,
entity refs, stored ID arrays, shared empties, or shallow tuples. An unchanged snapshot must
produce zero selector notifications.

- [ ] **Step 4: Verify GREEN**

Run: `npm --prefix apps/companion test -- src/state/selectors.test.ts src/features/workspace/model.test.ts src/data/loopbackAutoPair.test.ts src/navigation/nativeNavigation.test.ts && npm --prefix apps/companion run typecheck`

### Task 8: Move ticket execution and runtime-event caches out of components

**Files:**
- Create: `apps/companion/src/state/control-plane/executionCache.test.ts`
- Modify: `apps/companion/src/state/runtime.ts`
- Modify: `apps/companion/src/state/control-plane/actions.ts`
- Modify: `apps/companion/src/state/control-plane/store.ts`
- Modify: `apps/companion/src/data/controlPlaneClient.ts`
- Modify: `apps/companion/src/features/tickets/TicketThread.tsx`
- Modify: `apps/companion/src/features/tickets/TimelineRow.tsx`
- Modify: `apps/companion/src/features/chat/MessageComposer.tsx`

- [ ] **Step 1: Write failing execution-cache tests**

Assert:

- two views requesting the same ticket execution share one activities/attempts load;
- attempt/ticket events refresh only observed execution resources;
- inactive resources become stale without immediate request;
- kernel attempt events load into bounded stream buffers;
- attempt snapshots normalize to one `AttemptEntity` summary with optional kernel detail rather
  than an `AttemptDto | KernelAttempt` union;
- runtime event snapshots validate strictly and merge by ascending `(attemptId, seq)` with live
  projections;
- reopening a ticket uses ready cache and refreshes only when stale;
- errors are resource-local and retryable.
- `TicketThread` approval resolution, ticket-context chat, phase/error state, and execution data
  all use focused hooks/actions;
- no local `approved` shadow state or demo timeline import remains.

- [ ] **Step 2: Verify RED**

Run: `npm test -- src/state/control-plane/executionCache.test.ts`

- [ ] **Step 3: Add validated kernel event client method**

Add `ControlPlaneClient.getAttemptEvents(attemptId, signal)` using the existing shared
`KernelRuntimeEventListResponseSchema`. Reduce validated rows into bounded projections; do not
normalize raw runtime events as permanent entities.

- [ ] **Step 4: Migrate `TicketThread`**

Remove component-local execution state, cancellation boolean, whole compatibility facade,
`approved` shadow state, and demo fallback. Component observes focused ticket/approval/execution
selectors and invokes ensure/release/chat/approval actions.

- [ ] **Step 5: Verify GREEN**

Run: `npm --prefix apps/companion test -- src/state/control-plane/executionCache.test.ts src/data/controlPlaneClient.test.ts src/features/workspace/model.test.ts && npm --prefix apps/companion run typecheck`

### Task 9: Normalize Lead messages and render live message parts

**Files:**
- Create: `apps/companion/src/features/chat/MessagePartView.tsx`
- Create: `apps/companion/src/features/chat/messageParts.test.ts`
- Modify: `apps/companion/src/features/chat/LeadConversation.tsx`
- Modify: `apps/companion/src/features/chat/EmbeddedTicketCard.tsx`
- Modify: `apps/companion/src/features/chat/ToolCallRow.tsx`
- Modify: `apps/companion/src/state/runtime.ts`
- Modify: `apps/companion/src/state/control-plane/actions.ts`
- Modify: `apps/companion/src/state/control-plane/store.ts`
- Modify: `apps/companion/src/state/control-plane/normalize.ts`
- Modify: `apps/companion/src/state/control-plane/eventReducer.ts`

- [ ] **Step 1: Write failing message-part tests**

Assert:

- sendChat immediately creates one optimistic user message;
- command success aliases command ID to turn ID without duplicate user message;
- timeout/rejection marks optimistic message failed;
- snapshot reconciliation does not duplicate command-correlated optimistic messages;
- timed-out optimistic messages remain local until explicit retry/dismissal because current
  snapshots have no command correlation ID;
- rejected messages use structured `failure.kind: 'rejected'`; ambiguous timeouts use
  `failure.kind: 'timeout-unknown'` and expose explicit retry/dismiss actions;
- `retryMessage(messageId)` removes/replaces the failed local row at the same logical position,
  allocates a new command ID, and sends a new optimistic message; `dismissLocalMessage(messageId)`
  removes only optimistic/failed local entities plus their indexes/parts and rejects snapshot rows;
- text delta updates only assistant text part;
- tool lifecycle updates one card and displays redacted args/result/error;
- text snapshot replacement retains live tool/status parts for the same active session;
- duplicate call IDs in different turns never collide;
- ticket part renders only from a validated ticket ID/entity;
- missing artifact metadata renders an explicit unavailable state, not fake content;
- event-created tool cards are cleared/reconciled according to documented reconnect durability.

- [ ] **Step 2: Verify RED**

Run: `npm test -- src/features/chat/messageParts.test.ts`

- [ ] **Step 3: Implement message part renderer and session selectors**

Reuse existing visual components but remove hard-coded tool rows from embedded ticket cards.
This task extends the canonical session/turn/message/text model established in Task 2; it must
not introduce a second conversation representation.

- [ ] **Step 4: Verify GREEN**

Run: `npm --prefix apps/companion test -- src/features/chat/messageParts.test.ts src/state/runtime.test.ts src/data/controlPlaneClient.test.ts src/features/chat/composerStyles.test.ts && npm --prefix apps/companion run typecheck`

### Task 10: Remove the compatibility facade and prove end-to-end behavior

**Files:**
- Delete: `apps/companion/src/data/ControlPlaneProvider.tsx`
- Modify: all remaining imports of `useControlPlane`
- Create: `apps/companion/src/state/sourceBoundaries.test.ts`
- Create: `test/companion-zustand-integration.test.ts` as final integration verification
- Modify: `test/companion-client-integration.test.ts` only if shared setup extraction is useful
- Modify: `docs/ACCEPTANCE.md`
- Modify: `docs/DESIGN-GATEWAY.md`

- [ ] **Step 1: Add a failing source-boundary test**

Assert production files do not import `useControlPlane`, `ControlPlaneProvider`, the exported demo
`tickets`, or the exported demo `timeline`. This test must fail before facade/fallback removal.

- [ ] **Step 2: Verify RED**

Run: `npm --prefix apps/companion test -- src/state/sourceBoundaries.test.ts`

- [ ] **Step 3: Remove compatibility facade and complete integration glue**

Task 10 performs no new business-state migration. All consumers must already use focused hooks by
the end of Tasks 7–9.

Run: `npm --prefix apps/companion test -- src/state/sourceBoundaries.test.ts && npm --prefix apps/companion run typecheck`

- [ ] **Step 4: Add final real-daemon integration verification**

Start a fake-Lead real daemon and drive:

1. pairing and core hydration;
2. ticket/project/session normalization;
3. ordered Lead message deltas;
4. Lead tool start/update/completion card;
5. ticket invalidation coalescing;
6. approval resolution;
7. disconnect and replay reconnect;
8. selector notification isolation.

Also assert replay reconnect reaches the same normalized state as a clean snapshot plus the same
live event suffix.

Run: `npx vitest run test/companion-zustand-integration.test.ts test/companion-client-integration.test.ts`

- [ ] **Step 5: Update acceptance documentation**

Record selector notification evidence, request-coalescing counts, log limits, platform export
results to be populated below, remaining backend requirements for durable message
cards/artifacts/live stderr, and the exact Zustand version.

- [ ] **Step 6: Run full Companion verification**

```bash
cd apps/companion
npm test
npm run typecheck
npm run lint
npm run export:web
npx expo export --platform android --output-dir dist-android
npx expo export --platform ios --output-dir dist-ios
test -n "$(find dist -name '*.html' -print -quit)"
rg -q 'data-testid="workspace-boot-shell"' dist -g '*.html'
```

Expected: all exit 0.

- [ ] **Step 7: Run root integration and protocol verification**

```bash
cd /Users/alice/Workspace/AI/pi-lead-child
npx tsc --noEmit
npm test
npm run build
npm run smoke:daemon
git diff --check
```

Expected: all exit 0.

- [ ] **Step 8: Fill final verification evidence in documentation and re-run doc checks**

Record the exact command outcomes and static HTML boot-shell assertion, then run
`git diff --check docs/ACCEPTANCE.md docs/DESIGN-GATEWAY.md`.

## Implementation Discipline

- Follow RED → GREEN → REFACTOR for every behavior-changing task.
- Do not modify daemon/protocol semantics merely to make client state tests easier.
- Do not add mock fallback entities to connected paths.
- Do not persist credentials or server snapshots through Zustand.
- Do not commit unrelated dirty-worktree files.
- Do not claim phase completion without fresh focused tests and final full verification.

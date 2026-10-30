# Companion Prototype Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the Expo Companion to the latest approved standalone HTML with real durable progress, PoW, artifact, desktop, conversation-density, and mobile-navigation behavior.

**Architecture:** Preserve all protocol-v2 DTOs and events, add versioned additive kernel-v2 resources, persist structured checkpoint progress/proof and immutable artifact snapshots, then normalize those resources into the existing isolated Zustand stores. Refactor the UI around prototype-shaped presentation models: compact rail rows, one-level conversation cards, flat checkpoint updates, a real `PoW / 产物 / 日志` task thread, and persistent compact navigation.

**Tech Stack:** TypeScript, TypeBox, SQLite/`better-sqlite3`, Node HTTP/WebSocket, Vitest, Expo SDK 57, React Native 0.86, Expo Router, Zustand 5, Unistyles 3, Reanimated 4.

**Design spec:** `docs/superpowers/specs/2026-07-25-companion-prototype-fidelity-design.md`

---

## File ownership map

- Versioned contracts: `packages/protocol/src/prototype-fidelity.ts`, `packages/protocol/src/index.ts`.
- Durable data: `src/store/schema.ts`, `src/store/db.ts`, `src/store/checkpoints.ts`, `src/store/artifacts.ts`, `src/store/types.ts`.
- Domain projection: `src/coordinator/checkpoints.ts`, `src/coordinator/checkpoint-policy.ts`, `src/coordinator/workbench.ts`, `src/coordinator/service.ts`.
- Agent input: `src/agent-tools/definitions.ts`, child prompt/config files already owning checkpoint discipline.
- Public API: `src/gateway/control-plane.ts`, `src/gateway/paired-server.ts`.
- Companion transport/state: `apps/companion/src/data/controlPlaneClient.ts`, `apps/companion/src/state/**`.
- Companion UX: `apps/companion/src/features/chat/**`, `features/tickets/**`, `features/workspace/**`, `navigation/**`.
- Acceptance: focused tests listed below plus `docs/ACCEPTANCE.md`.

Do not refactor unrelated gateway, orchestration, memory, or runtime behavior. Do not add a new v2
event type.

### Task 1: Versioned additive protocol contracts

**Files:**
- Create: `packages/protocol/src/prototype-fidelity.ts`
- Modify: `packages/protocol/src/index.ts`
- Test: `test/kernel-checkpoint-protocol.test.ts`
- Test: `test/kernel-protocol-contract.test.ts`
- Test: `test/paired-protocol-v2.test.ts`

- [ ] **Step 1: Write failing strict-schema tests**

Add fixtures for checkpoint-v2 progress/proof, work-item-v2 progress, workbench-v2 PoW, artifact
list/content metadata, ordering, bounds, proof retirement, and rejection of unknown fields.

```ts
expect(Value.Check(KernelCheckpointV2Schema, {
  ...checkpointV1,
  progress: { current: 3, total: 5, label: '协议覆盖' },
  proofItems: [{ id: 'auth', label: '鉴权边界', state: 'passed', evidence: 'paired tests pass' }],
})).toBe(true);
```

- [ ] **Step 2: Run RED**

Run:

```bash
npx vitest run test/kernel-checkpoint-protocol.test.ts test/kernel-protocol-contract.test.ts test/paired-protocol-v2.test.ts
```

Expected: imports for the new schemas/capabilities fail while existing v2 contract tests remain green.

- [ ] **Step 3: Implement strict v2 additive schemas**

Export exact schemas/types and capability constants:

```ts
export const KERNEL_FIDELITY_CAPABILITIES = {
  checkpoints: 'kernel.checkpoints.v2',
  workItems: 'kernel.work-items.v2',
  workbench: 'kernel.ticket-workbench.v2',
  artifacts: 'kernel.artifacts.v1',
} as const;
```

Use `additionalProperties: false`, refinements for progress cross-fields, proof quotas, SHA format,
and artifact availability/content nullability.

- [ ] **Step 4: Prove frozen compatibility**

Add byte-shape tests that v1 kernel mappers and protocol-v2 schemas reject every new field. Assert
the protocol-v2 event literal union is unchanged.

- [ ] **Step 5: Run GREEN**

Run the Task 1 command and `npx tsc --noEmit`.

### Task 2: Migration 13 and immutable artifact storage

**Files:**
- Modify: `src/store/schema.ts`
- Modify: `src/store/db.ts`
- Modify: `src/store/types.ts`
- Modify: `src/store/checkpoints.ts`
- Create: `src/store/artifacts.ts`
- Modify: `src/config.ts`
- Modify: `src/daemon/server.ts`
- Test: `test/kernel-schema-migration.test.ts`
- Test: `test/checkpoints.test.ts`
- Create: `test/artifacts.test.ts`
- Test: `test/env-config.test.ts`
- Test: `test/daemon.test.ts`

- [ ] **Step 1: Write failing version-12 migration tests**

Create a real v12 database with repeated legacy artifact refs and a populated
`conversation_cards.checkpoint_id` dependency. Assert version 13 columns, checks, FKs, indexes,
deterministic metadata-only backfill, proof materialization, and restart repair. Add a forced
migration failure proving rollback preserves the original table, dependent row, and migration
version.

- [ ] **Step 2: Write failing artifact-store tests**

Cover quota precheck and in-transaction recheck; 250 MiB accounting by distinct available SHA;
existing-target length/SHA verification and collision quarantine; absolute path, NUL, traversal,
intermediate/final escaping symlinks, path-swap/TOCTOU, and non-file input; 25 MiB/ref quotas; SHA
dedupe; conflicting refs; rollback orphans; corrupt blob repair; safe filename; byte-identical
reads; and proof that public projections never expose `storage_key`, original paths, or workdirs.
Before implementation, add daemon restart tests for proof drift, missing/corrupt blobs,
availability downgrade, grace-period orphan GC, and invalid orphan-grace configuration.

- [ ] **Step 3: Run RED**

```bash
npx vitest run test/kernel-schema-migration.test.ts test/checkpoints.test.ts test/artifacts.test.ts test/env-config.test.ts test/daemon.test.ts
```

Expected: migration 13 and artifact store APIs are missing.

- [ ] **Step 4: Add migration 13**

Rebuild `checkpoints` because SQLite cannot add the required cross-column invariant with the
existing `ALTER TABLE` helper. Save the current `foreign_keys` pragma, disable it before opening the
migration transaction, and restore it in `finally` whether migration commits or rolls back:

1. create `checkpoints_v13` with the complete old and new schema/checks;
2. copy every row preserving IDs, foreign-key provenance, timestamps, idempotency keys, and hashes;
3. verify row counts and representative hashes;
4. drop/rename tables and recreate every checkpoint index/FK-dependent index;
5. create `ticket_proof_items` and `artifacts`;
6. backfill legacy refs and materialized proof deterministically;
7. run `foreign_key_check` before commit and fail the transaction on any returned row;
8. insert migration version 13 only after all checks pass.

The populated dependent-row and forced-failure tests must prove both successful relationship
preservation and full rollback while `foreign_keys` is restored to its original value.

- [ ] **Step 5: Implement managed blob ingestion**

Implement a focused artifact store API:

```ts
stageArtifact(db, {
  dataDir, ticketId, attemptId, ref, name, kind, mediaType, description, relativePath,
}): StagedArtifact

commitStagedArtifacts(db, checkpointId, staged): Artifact[]
listArtifacts(db, ticketId): Artifact[]
openArtifactContent(db, dataDir, ticketId, artifactId): ArtifactContent
repairArtifactStorage(db, dataDir, now, orphanGraceMs): RepairResult
```

Read from a no-follow descriptor, hash while streaming, fsync file and directory, use
content-addressed final paths, and return cleanup handles for failed DB transactions.

- [ ] **Step 6: Wire daemon-only startup repair**

Add `PLC_ARTIFACT_ORPHAN_GRACE_MS`, parsed as a positive safe integer with a default of 86,400,000
milliseconds. Pass the validated value to `repairArtifactStorage`.

Call `repairArtifactStorage` in `startDaemon` after the live-socket single-instance guard succeeds
and before sessions, orchestrator, paired services, or child recovery start. Never run GC from
`openDb`, CLI reads, or child tool processes. Make the prewritten restart and config tests GREEN.

- [ ] **Step 7: Extend checkpoint normalization**

Persist optional progress and proof JSON. Apply proof updates transactionally to the materialized
table; reject duplicate IDs, quota overflow, invalid retirement, and idempotency conflicts.

- [ ] **Step 8: Run GREEN and migration regression**

```bash
npx vitest run test/kernel-schema-migration.test.ts test/checkpoints.test.ts test/artifacts.test.ts test/daemon.test.ts test/checkpoint-outbox-order.test.ts
```

### Task 3: Atomic checkpoint, proof, and artifact domain writes

**Files:**
- Modify: `src/coordinator/checkpoints.ts`
- Modify: `src/coordinator/checkpoint-policy.ts`
- Modify: `src/coordinator/service.ts`
- Modify: `src/agent-tools/definitions.ts`
- Modify: `src/config.ts`
- Modify: `src/children/manager.ts`
- Test: `test/coordinator-checkpoints.test.ts`
- Test: `test/checkpoint-policy.test.ts`
- Test: `test/checkpoint-tools.test.ts`
- Test: `test/checkpoint-outbox-order.test.ts`
- Test: `test/manager-multiruntime.test.ts`

- [ ] **Step 1: Write failing atomicity tests**

Assert one transaction commits checkpoint, proof current state, artifact metadata, activity,
conversation projection, ticket touch, and final `ticket.updated`. Inject failure at each write and
assert no partial DB state.

- [ ] **Step 2: Write failing agent-tool tests**

Extend `submit_checkpoint` and `ticket_update.checkpoint` inputs with:

```json
{
  "progress": { "current": 3, "total": 5, "label": "协议覆盖" },
  "proof_items": [{ "id": "auth", "label": "鉴权边界", "state": "passed", "evidence": "tests pass" }],
  "artifacts": [{ "ref": "report", "name": "report.md", "kind": "report", "media_type": "text/markdown", "relative_path": "report.md" }]
}
```

Test display safety, idempotency identity including artifact SHA/byte length, changed bytes on retry,
staging failure before any DB mutation, quota conflicts, and all three runtimes receiving the same
definitions.

- [ ] **Step 3: Run RED**

```bash
npx vitest run test/coordinator-checkpoints.test.ts test/checkpoint-policy.test.ts test/checkpoint-tools.test.ts test/checkpoint-outbox-order.test.ts test/manager-multiruntime.test.ts
```

- [ ] **Step 4: Implement staging plus DB transaction orchestration**

Parse and stage artifact bytes before entering the *outer* transaction in
`createAgentToolHandlers.call`. Include staged `{ref, sha256, byteLength}` values in
`ticketUpdateRequestFingerprint` and standalone checkpoint idempotency input. Pass prepared staged
artifacts into a synchronous coordinator method. The one outer `ticket_update` transaction must
atomically commit body append, status transition, receipt, checkpoint, proof current state, artifact
metadata, activity/card projection, ticket touch, and outbox. Standalone `submit_checkpoint` uses the
same preparation path. Staging errors occur before any database mutation; DB errors leave only
grace-period-GC-safe blobs.

- [ ] **Step 5: Update child discipline**

Require children to report progress only when they have a measurable denominator, update stable
PoW IDs rather than creating duplicates, retire obsolete checks explicitly, and register artifacts
only after the file exists. Never require synthetic values.

- [ ] **Step 6: Run GREEN**

```bash
npx vitest run test/coordinator-checkpoints.test.ts test/checkpoint-policy.test.ts test/checkpoint-tools.test.ts test/checkpoint-outbox-order.test.ts test/manager-multiruntime.test.ts test/checkpoint-control-plane-e2e.test.ts
npm run build
```

### Task 4: Deterministic work-item and PoW projections

**Files:**
- Modify: `src/coordinator/workbench.ts`
- Modify: `src/store/runtime-events.ts`
- Modify: `src/gateway/control-plane.ts`
- Test: `test/coordinator-tickets.test.ts`
- Test: `test/workbench-http.test.ts`
- Test: `test/runtime-events-store.test.ts`
- Test: `test/kernel-protocol-contract.test.ts`

- [ ] **Step 1: Write failing projection tests**

Cover precedence `cancelled -> null`, `done -> terminal`, newest explicit, then direct-child fallback;
exact rounding; no recursion; retired PoW items; verdict truth table; wall elapsed; checkpoint count;
and distinct `(attemptId, callId)` `tool.started` count across executor/reviewer attempts.

- [ ] **Step 2: Run RED**

```bash
npx vitest run test/coordinator-tickets.test.ts test/workbench-http.test.ts test/runtime-events-store.test.ts
```

- [ ] **Step 3: Implement focused selectors**

Add store queries for latest explicit progress and distinct tool calls. Keep projection functions
pure where possible:

```ts
projectTicketProgress(db, ticket): KernelTicketProgress | null
projectTicketPow(db, ticket, timing, interventions, now): KernelTicketPow
```

- [ ] **Step 4: Add dedicated v1/v2 mappers**

Keep existing `kernelCheckpoint`, work-item, and workbench mappers unchanged for v1. Add separate v2
mappers and tests proving new DB fields never leak to v1.

- [ ] **Step 5: Run GREEN**

```bash
npx vitest run test/coordinator-tickets.test.ts test/workbench-http.test.ts test/runtime-events-store.test.ts test/kernel-protocol-contract.test.ts
npx tsc --noEmit
```

### Task 5: Versioned paired APIs and artifact content delivery

**Files:**
- Modify: `src/gateway/control-plane.ts`
- Modify: `src/gateway/paired-server.ts`
- Test: `test/capabilities.test.ts`
- Test: `test/checkpoint-http.test.ts`
- Test: `test/workbench-http.test.ts`
- Test: `test/paired-http.test.ts`
- Create: `test/artifact-http.test.ts`

- [ ] **Step 1: Write failing capability and route tests**

Assert v1 capabilities/routes remain unchanged; new capability strings advertise independently;
mixed capability sets work; v2 endpoints validate strict schemas; artifact content reauthorizes on
every request.

- [ ] **Step 2: Write failing content security tests**

Cover non-disclosing cross-ticket/unknown 404, missing scope, `nosniff`, `private, no-store`, content
length/type, RFC 5987 filename, cancellation/aborted stream, metadata-only/unavailable responses,
and bytes matching SHA.

- [ ] **Step 3: Run RED**

```bash
npx vitest run test/capabilities.test.ts test/checkpoint-http.test.ts test/workbench-http.test.ts test/paired-http.test.ts test/artifact-http.test.ts
```

- [ ] **Step 4: Implement versioned endpoints**

Add `/v1/kernel/v2/work-items`, `/v1/kernel/v2/tickets/:ticketId/workbench`, and
`/v1/kernel/v2/tickets/:ticketId/checkpoints` plus
`/v1/kernel/v1/tickets/:ticketId/artifacts` and
`/v1/kernel/v1/tickets/:ticketId/artifacts/:artifactId/content`. Reuse the existing bearer and
scope middleware.

- [ ] **Step 5: Run GREEN and daemon smoke**

```bash
npx vitest run test/capabilities.test.ts test/checkpoint-http.test.ts test/workbench-http.test.ts test/paired-http.test.ts test/artifact-http.test.ts
npm run build
npm run smoke:daemon
```

### Task 6: Companion transport and normalized state

**Files:**
- Modify: `apps/companion/package.json`
- Modify: `apps/companion/package-lock.json`
- Modify: `apps/companion/src/data/controlPlaneClient.ts`
- Create: `apps/companion/src/data/artifactDownload.ts`
- Create: `apps/companion/src/data/artifactDownload.web.ts`
- Create: `apps/companion/src/data/artifactDownload.native.ts`
- Modify: `apps/companion/src/state/types.ts`
- Modify: `apps/companion/src/state/control-plane/store.ts`
- Modify: `apps/companion/src/state/control-plane/normalize.ts`
- Modify: `apps/companion/src/state/runtime.ts`
- Modify: `apps/companion/src/state/hooks.ts`
- Modify: `apps/companion/src/state/workspace/store.ts`
- Test: `apps/companion/src/data/controlPlaneClient.test.ts`
- Test: `apps/companion/src/state/control-plane/checkpointResources.test.ts`
- Test: `apps/companion/src/state/runtime.test.ts`
- Test: `apps/companion/src/state/selectors.test.ts`
- Test: `apps/companion/src/state/workspace/workspaceStore.test.ts`
- Create: `apps/companion/src/data/artifactDownload.test.ts`

- [ ] **Step 0: Read exact Expo SDK 57 documentation**

Before editing Companion code, read the official versioned Expo SDK 57 documentation for
`expo-file-system` and `expo-sharing` as required by `apps/companion/AGENTS.md`. Record the selected
SDK-57 APIs in the implementation notes; do not rely on remembered APIs from another Expo version.

- [ ] **Step 1: Write failing negotiation/normalization tests**

Cover new client/old daemon, old capability fallback, every mixed capability set, strict malformed
payload rejection, cached-state preservation, artifact lifecycle, and download cancellation.

- [ ] **Step 2: Write failing compact destination tests**

Add `conversation|tickets|projects|agenda`, return destination, deep-link default, breakpoint mapping,
and preservation of filters, expansion, scroll anchors, and drafts.

- [ ] **Step 3: Run RED**

```bash
npm --prefix apps/companion test -- src/data/controlPlaneClient.test.ts src/data/artifactDownload.test.ts src/state/control-plane/checkpointResources.test.ts src/state/runtime.test.ts src/state/selectors.test.ts src/state/workspace/workspaceStore.test.ts
```

- [ ] **Step 4: Implement capability-preferred resource loading**

Prefer v2 resource URLs independently; fallback to existing v1 keys without clearing accepted
content. Add `artifacts:<ticketId>` resource generation/observation/invalidation.

- [ ] **Step 5: Install supported native download/share modules**

Run:

```bash
cd apps/companion && npx expo install expo-file-system expo-sharing
```

Expected: Expo-compatible versions are added to the Companion package and lockfile.

- [ ] **Step 6: Implement authenticated downloads**

Add an authenticated binary method separate from the existing JSON parser:

```ts
downloadArtifact(ticketId, artifactId, signal): Promise<{
  bytes: ArrayBuffer;
  filename: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
}>
```

Validate content headers, actual byte length, and SHA before handing bytes to platform adapters.
The web adapter creates a Blob URL, clicks a temporary anchor, and always revokes/removes it. The
native adapter writes to Expo FileSystem cache, opens Expo Sharing, and cleans the cache on success,
failure, and cancellation. Share-sheet unavailable/failure remains retryable. Track download state
outside canonical artifact metadata.

- [ ] **Step 7: Run GREEN, typecheck, and lint**

```bash
npm --prefix apps/companion test -- src/data/controlPlaneClient.test.ts src/data/artifactDownload.test.ts src/state/control-plane/checkpointResources.test.ts src/state/runtime.test.ts src/state/selectors.test.ts src/state/workspace/workspaceStore.test.ts
npm --prefix apps/companion run typecheck
npm --prefix apps/companion run lint
```

### Task 7: High-density rail and real empty-state actions

**Files:**
- Modify: `apps/companion/src/features/workspace/model.ts`
- Modify: `apps/companion/src/features/workspace/TicketList.tsx`
- Modify: `apps/companion/src/features/workspace/WorkRail.tsx`
- Modify: `apps/companion/src/features/workspace/ConnectedWorkRail.tsx`
- Modify: `apps/companion/src/features/workspace/Workbench.web.tsx`
- Test: `apps/companion/src/features/workspace/model.test.ts`
- Test: `apps/companion/src/features/workspace/checkpointUxIntegration.test.ts`

- [ ] **Step 1: Write failing presentation/source tests**

Assert compact rows omit summary/badge/project subrows, running progress renders only with a real
projection, no-results clears filter+query, first-use exposes three prototype commands, create action
seeds the Lead draft, and desktop thread width is 400.

- [ ] **Step 2: Run RED**

```bash
npm --prefix apps/companion test -- src/features/workspace/model.test.ts src/features/workspace/checkpointUxIntegration.test.ts
```

- [ ] **Step 3: Implement prototype-shaped rail rows**

Use 28 px agent marks, one-line title, compact metadata, 3 px state edge, heartbeat, and an optional
3 px progress bar. Preserve grouping, collapse, search, unknown project, and accessibility.

- [ ] **Step 4: Wire actions to shared workspace state**

Example commands and new-task actions set the `lead` composer draft, return to conversation, and
close the transient work surface without sending automatically.

- [ ] **Step 5: Run GREEN**

```bash
npm --prefix apps/companion test -- src/features/workspace/model.test.ts src/features/workspace/checkpointUxIntegration.test.ts
npm --prefix apps/companion run typecheck
```

### Task 8: Flatten Lead conversation operations and checkpoints

**Files:**
- Modify: `apps/companion/src/features/chat/ToolCallRow.tsx`
- Modify: `apps/companion/src/features/chat/TicketExecutionCard.tsx`
- Modify: `apps/companion/src/features/chat/CheckpointCard.tsx`
- Modify: `apps/companion/src/features/chat/InterventionCard.tsx`
- Modify: `apps/companion/src/features/chat/MessagePartView.tsx`
- Modify: `apps/companion/src/features/chat/LeadConversation.tsx`
- Test: `apps/companion/src/features/chat/messageParts.test.ts`
- Test: `apps/companion/src/features/chat/conversationCards.test.ts`
- Create: `apps/companion/src/features/chat/prototypeDensity.test.ts`

- [ ] **Step 1: Write failing source-boundary and model tests**

Assert one outer ticket card, flat operation divider rows with no root border/radius, ordinary
checkpoint messages without card border/shadow, actionable intervention cards only, and compact
resolved follow-ups.

- [ ] **Step 2: Run RED**

```bash
npm --prefix apps/companion test -- src/features/chat/messageParts.test.ts src/features/chat/conversationCards.test.ts src/features/chat/prototypeDensity.test.ts
```

- [ ] **Step 3: Implement row variants**

Replace generic card fallback with semantic `tool`, `agent-status`, and `artifact` rows. Keep detail
expansion, redaction, truncation, retry, and accessibility behavior.

- [ ] **Step 4: Replace CheckpointCard with a flat message update**

Keep source, kind, stage, title, summary, facts, next step, references, and ticket opening, but remove
the repeated elevated card container. Intervention remains a contextual exception.

- [ ] **Step 5: Run GREEN**

```bash
npm --prefix apps/companion test -- src/features/chat/messageParts.test.ts src/features/chat/conversationCards.test.ts src/features/chat/prototypeDensity.test.ts
npm --prefix apps/companion run lint
```

### Task 9: Rebuild task thread as PoW / Artifacts / Logs

**Files:**
- Modify: `apps/companion/src/features/workspace/model.ts`
- Modify: `apps/companion/src/features/tickets/CheckpointFeed.tsx`
- Modify: `apps/companion/src/features/tickets/TicketThread.tsx`
- Modify: `apps/companion/src/features/tickets/ConnectedTicketThread.tsx`
- Modify: `apps/companion/src/features/tickets/InterventionPanel.tsx`
- Create: `apps/companion/src/features/tickets/PowPanel.tsx`
- Create: `apps/companion/src/features/tickets/ArtifactList.tsx`
- Create: `apps/companion/src/features/tickets/LogTimeline.tsx`
- Test: `apps/companion/src/features/tickets/ticketPresentation.test.ts`
- Test: `apps/companion/src/features/workspace/checkpointUxIntegration.test.ts`

- [ ] **Step 1: Write failing PoW tests**

Assert exact tab labels; verdict truth table; real metric omission/presence; flat checklist; retired
item absence; compact checkpoint history; artifact states/actions; and light timeline logs.

- [ ] **Step 2: Run RED**

```bash
npm --prefix apps/companion test -- src/features/tickets/ticketPresentation.test.ts src/features/workspace/checkpointUxIntegration.test.ts
```

- [ ] **Step 3: Implement `PowPanel` and flat checkpoint history**

Render the prototype verdict banner, 2-column metric grid using only non-null real metrics, flat
check rows, and compact history rows. Embed intervention controls only on the related row.

- [ ] **Step 4: Implement artifact rows and download state**

Match the 36 px icon, filename/meta, and download control. Disable unavailable/offline content with
a tooltip/accessibility label; render progress/error/retry states without resizing the row.

- [ ] **Step 5: Implement light log timeline**

Render state dot, vertical connector, tool/source, tag, description, and time on the light surface.
Keep bounded stream data and error emphasis.

- [ ] **Step 6: Run GREEN**

```bash
npm --prefix apps/companion test -- src/features/tickets/ticketPresentation.test.ts src/features/workspace/checkpointUxIntegration.test.ts
npm --prefix apps/companion run typecheck
npm --prefix apps/companion run lint
```

### Task 10: Persistent mobile four-destination navigation

**Files:**
- Modify: `apps/companion/src/navigation/RootTabs.tsx`
- Modify: `apps/companion/src/features/workspace/Workbench.tsx`
- Modify: `apps/companion/src/features/workspace/Workbench.web.tsx`
- Modify: `apps/companion/src/features/chat/LeadConversation.tsx`
- Modify: `apps/companion/src/features/chat/MessagePartView.tsx`
- Create: `apps/companion/src/features/workspace/CompactWorkspaceNav.tsx`
- Modify: `apps/companion/src/features/workspace/WorkspaceMotion.tsx`
- Modify: `apps/companion/src/state/workspace/store.ts`
- Modify: `apps/companion/src/app/ticket/[id].tsx`
- Modify: `apps/companion/src/app/(tabs)/tickets.tsx`
- Modify: `apps/companion/src/app/(tabs)/projects.tsx`
- Modify: `apps/companion/src/app/(tabs)/agenda.tsx`
- Test: `apps/companion/src/navigation/nativeNavigation.test.ts`
- Test: `apps/companion/src/features/workspace/workspaceMotion.test.ts`
- Test: `apps/companion/src/features/workspace/checkpointUxIntegration.test.ts`

- [ ] **Step 1: Replace the intentional no-tab tests with prototype behavior tests**

Assert four stable segments, selection semantics, safe-area padding, notification badge, detail
drill-in hiding nav, Back restoration, edge handle, compact web parity, and no bottom nav on pairing.
Move these exact shared fields into the workspace store:

```ts
compactDestination: 'conversation' | 'tickets' | 'projects' | 'agenda';
ticketReturnDestination: 'conversation' | 'tickets' | 'projects' | 'agenda';
ticketFilter: 'all' | 'running' | 'todo';
ticketQuery: string;
collapsedTicketGroupIds: TicketGroupId[];
scrollAnchorByContext: Record<string, string | null>;
composerDraftByContext: Record<string, string>;
```

- [ ] **Step 2: Run RED**

```bash
npm --prefix apps/companion test -- src/navigation/nativeNavigation.test.ts src/features/workspace/workspaceMotion.test.ts src/features/workspace/checkpointUxIntegration.test.ts
```

- [ ] **Step 3: Implement shared compact navigation**

Use Lucide-equivalent platform icons through `AppIcon`, fixed 56-64 px navigation height,
`conversation|tickets|projects|agenda` state, and unframed destination surfaces. Do not reintroduce
four unrelated router-owned business stores.

- [ ] **Step 4: Integrate ticket drill-in and breakpoint transitions**

Hide navigation for the ticket thread; Back restores `ticketReturnDestination`; map destination to
desktop rail view at 1100 px and restore on compact return.

- [ ] **Step 5: Run GREEN and native exports**

```bash
npm --prefix apps/companion test -- src/navigation/nativeNavigation.test.ts src/features/workspace/workspaceMotion.test.ts src/features/workspace/checkpointUxIntegration.test.ts
(cd apps/companion && npx expo export --platform android --output-dir dist-android)
(cd apps/companion && npx expo export --platform ios --output-dir dist-ios)
```

### Task 11: Integration, compatibility, and acceptance fixtures

**Files:**
- Modify: `test/checkpoint-control-plane-e2e.test.ts`
- Modify: `test/companion-client-integration.test.ts`
- Modify: `apps/companion/src/features/workspace/checkpointUxIntegration.test.ts`
- Modify: `package.json`
- Create: `scripts/seed-companion-fidelity.ts`
- Create: `scripts/serve-companion-prototype.mjs`
- Create: `scripts/run-companion-fidelity-acceptance.mjs`
- Create: `scripts/create-companion-fidelity-comparison.mjs`
- Create: `test/companion-fidelity-fixture.test.ts`
- Modify: `docs/ACCEPTANCE.md`

- [ ] **Step 1: Write failing end-to-end fidelity data test**

Create a real ticket/attempt with explicit progress, three PoW items, normalized tool events, one
downloadable artifact, one metadata-only legacy artifact, and an intervention. Assert daemon restart,
v2 snapshots, bytes, Companion normalization, and no duplicate event/card/proof/artifact rows.

- [ ] **Step 2: Add compatibility matrix tests**

Cover old client/new daemon v1, new client/old daemon, all mixed capability combinations, malformed
v2 fail-closed behavior, and v12-to-v13 migration restart.

- [ ] **Step 3: Run integration and fixture RED**

```bash
npx vitest run test/checkpoint-control-plane-e2e.test.ts test/companion-client-integration.test.ts test/companion-fidelity-fixture.test.ts
npm --prefix apps/companion test -- src/features/workspace/checkpointUxIntegration.test.ts
```

Expected failures include missing seed scenarios, exact launcher child process contracts,
stop/restart behavior, comparison outputs, stable selectors, and the new end-to-end resources.

- [ ] **Step 4: Add a deterministic acceptance fixture**

`scripts/seed-companion-fidelity.ts` accepts `--data-dir` and `--scenario`; each scenario gets its
own database so mutable browser work cannot contaminate another scenario:

- `populated`: populated rail, explicit progress, three PoW states, child tickets, artifact
  success/metadata-only/unavailable, logs, and intervention;
- `first-use`: zero tickets;
- `all-completed`: completed tickets only;
- `no-results`: populated data plus the expected `todo` filter and search query that match nothing.

The script performs no LLM call and prints ticket IDs, artifact IDs, expected selectors, and the
expected workspace state as JSON. Add:

```json
{
  "scripts": {
    "acceptance:seed:fidelity": "tsx scripts/seed-companion-fidelity.ts",
    "acceptance:prototype": "node scripts/serve-companion-prototype.mjs",
    "acceptance:run:fidelity": "node scripts/run-companion-fidelity-acceptance.mjs"
  }
}
```

`serve-companion-prototype.mjs` serves only the exact file whose SHA-256 is
`246337627a539e859330447ab3415b94a8d6cf206b9996b2e8368ebd37c6b3a9`; it refuses another file.
`run-companion-fidelity-acceptance.mjs --scenario <name>` creates a fresh scenario directory, runs
the seed command, and starts the daemon on 47140, Expo on 49161, and the prototype on 49162 as
managed child processes. It writes `daemon.log`, `expo.log`, `prototype.log`, and `pids.json`, polls
all readiness URLs before succeeding, emits a JSON session record, and traps SIGINT/SIGTERM for
cleanup. The launcher starts:

- daemon argv `node dist/coordinatord.mjs`, repo-root cwd, and env
  `PLC_DATA_DIR=<fresh scenario directory>`, `PLC_GATEWAY_PORT=47140`,
  `PLC_GATEWAY_HOST=127.0.0.1`,
  `PLC_ALLOW_LOOPBACK_AUTO_PAIR=1`, and
  `PLC_LOOPBACK_AUTO_PAIR_ORIGINS=http://localhost:49161`;
- Expo argv `npx expo start --web --port 49161 --clear`, `apps/companion` cwd, and env
  `CI=1` plus `EXPO_PUBLIC_PLC_GATEWAY_URL=http://127.0.0.1:47140`;
- prototype argv from `acceptance:prototype`, repo-root cwd, fixed port 49162, exact file, and hash.

Fixture tests assert those exact argv/cwd/env values. `--stop --session <json>` terminates and waits
for every recorded process. `--stop-daemon --session <json>` stops only the recorded daemon, waits
for exit, confirms health is unavailable, and atomically marks the daemon stopped in the session
record. `--start-daemon --session <json>` requires that stopped state, starts the daemon with the
same argv/cwd/env/data directory, polls `/v1/health`, and atomically updates the session record with
the new PID and start timestamp. Fixture tests cover the complete start/stop/start lifecycle.
`create-companion-fidelity-comparison.mjs` generates side-by-side and 50%-opacity HTML comparison
pages from captured implementation/reference PNGs without modifying the images.

- [ ] **Step 5: Add stable browser selectors**

Add web-rendered test IDs to the implementation: `workbench`, `work-rail`, `lead-conversation`,
`ticket-thread`, `compact-nav`, `pow-panel`, `artifact-list`, and `log-timeline`. Artifact actions use
`artifact-download-<artifactId>`, `artifact-cancel-<artifactId>`, and
`artifact-retry-<artifactId>`. The fixture test asserts the seed script is idempotent and prints all
expected IDs.

- [ ] **Step 6: Run focused integration GREEN**

```bash
npx vitest run test/checkpoint-control-plane-e2e.test.ts test/companion-client-integration.test.ts test/companion-fidelity-fixture.test.ts
npm --prefix apps/companion test -- src/features/workspace/checkpointUxIntegration.test.ts
```

- [ ] **Step 7: Update acceptance documentation**

Record only fresh commands and browser evidence. Preserve the existing localhost stale-credential
todo until separately fixed.

### Task 12: Full verification and browser acceptance

**Files:**
- Modify only files required by failures found during verification.

- [ ] **Step 1: Run backend verification**

```bash
npm test
npx tsc --noEmit
npm run build
npm run smoke:daemon
npm run smoke:runtime -- codex
npm run smoke:runtime -- claude
```

- [ ] **Step 2: Run Companion verification**

```bash
npm --prefix apps/companion test
npm --prefix apps/companion run typecheck
npm --prefix apps/companion run lint
npm --prefix apps/companion run export:web
(cd apps/companion && npx expo export --platform android --output-dir dist-android)
(cd apps/companion && npx expo export --platform ios --output-dir dist-ios)
```

- [ ] **Step 3: Run repository hygiene checks**

```bash
git diff --check
git status --short
```

Inspect the dirty tree and confirm no unrelated user changes were reverted or staged.

- [ ] **Step 4: Start deterministic real services**

Start the populated scenario with managed process orchestration:

```bash
npm run acceptance:run:fidelity -- --scenario populated \
  --prototype '/Users/alice/Downloads/1-Lead-Child 助理 UI (standalone).html' \
  --sha256 246337627a539e859330447ab3415b94a8d6cf206b9996b2e8368ebd37c6b3a9 \
  --session-out /tmp/plc-companion-fidelity-populated.json
```

Confirm `http://127.0.0.1:47140/v1/health`, `http://localhost:49161`, and
`http://localhost:49162/#1c` before browser work. Stop the managed session with:

```bash
npm run acceptance:run:fidelity -- --stop --session /tmp/plc-companion-fidelity-populated.json
```

Repeat `first-use`, `all-completed`, and `no-results` one at a time with separate session records so
every scenario starts from a clean database and fixed process set. Before opening each scenario,
require the controlled implementation tab's `cdp` capability and call
`Storage.clearDataForOrigin` with `{ origin: "http://localhost:49161", storageTypes:
"local_storage" }`, then call `Page.reload` and wait for the connected Lead workbench state. This
removes credentials bound to the previous fresh database and verifies loopback auto-pair against the
new scenario before any scenario assertion. Acceptance blocks if clearing, reload, or pairing fails.

- [ ] **Step 5: Perform controlled browser acceptance**

Use the in-app Browser plugin through its `browser-client` runtime, never standalone Playwright or a
different browser automation server. Open `http://localhost:49161` and the reference at
`http://localhost:49162/#1c`. At 1440x900 and 390x844:

1. exercise every scenario listed in the design spec;
2. capture `desktop-implementation.png`, `desktop-reference.png`, `mobile-implementation.png`, and
   `mobile-reference.png` under `docs/audits/2026-07-25-companion-prototype-fidelity/`;
3. query `getBoundingClientRect()` for the stable test IDs and write the measurements to
   `measurements.json`;
4. inspect browser console and page errors, overflow, focus/keyboard, safe areas, and refresh; write
   machine-readable errors to `browser-errors.json` and conclusions to `acceptance-notes.md`;
5. run `node scripts/create-companion-fidelity-comparison.mjs --dir
   docs/audits/2026-07-25-companion-prototype-fidelity`;
6. open `desktop-side-by-side.html`, `desktop-overlay.html`, `mobile-side-by-side.html`, and
   `mobile-overlay.html` in the same controlled browser and record explicit pass/fail notes;
7. require the controlled implementation tab's `cdp` capability. Send `Fetch.enable` with a URL
   pattern matching `/v1/kernel/v1/tickets/*/artifacts/*/content`; on the first
   `Fetch.requestPaused`, send `Fetch.failRequest` and verify `artifact-retry-<artifactId>`; on the
   second paused request, hold it, click `artifact-cancel-<artifactId>`, then send
   `Fetch.continueRequest`; finally send `Fetch.disable`, click
   `artifact-retry-<artifactId>`/`artifact-download-<artifactId>`, and verify success. Browser
   acceptance blocks if the tab lacks `cdp` or any selector/action is unavailable;
8. run `npm run acceptance:run:fidelity -- --stop-daemon --session
   /tmp/plc-companion-fidelity-populated.json` without reseeding; while health is unavailable verify
   cached state, offline affordances, and disabled commands/downloads. Then run
   `npm run acceptance:run:fidelity -- --start-daemon --session
   /tmp/plc-companion-fidelity-populated.json`, verify reconnect and explicit refresh, and verify the
   updated daemon PID/start timestamp.

Required structural tolerances:

- desktop rail/thread widths: <=1 px difference;
- primary bounds/spacing anchors: <=4 px difference;
- exact fonts, weights, token colors, radii, tab labels, row/card hierarchy, and navigation placement.

- [ ] **Step 6: Request final code review**

Dispatch a code reviewer with the design spec, this plan, and the complete diff. Fix all critical and
important findings, then rerun every affected verification command.

- [ ] **Step 7: Record final evidence**

Update `docs/ACCEPTANCE.md` with test counts, build/export results, browser viewport evidence,
screenshots, deviations if any, and remaining external constraints. Do not claim completion if the
controlled browser is unavailable or any prototype scenario remains unverified.

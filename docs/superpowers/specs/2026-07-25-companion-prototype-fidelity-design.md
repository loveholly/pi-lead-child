# Companion Prototype Fidelity Design

**Date:** 2026-07-25

**Authoritative reference:** `/Users/alice/Downloads/1-Lead-Child 助理 UI (standalone).html`

## Goal

Restore the Companion to the latest approved prototype at the information-architecture,
interaction, density, responsive-navigation, and visual-hierarchy levels while keeping all
displayed progress, proof-of-work, and artifact data authoritative and durable.

## Non-negotiable constraints

- Protocol v2 DTOs and the v2 WebSocket event union remain frozen.
- New data is exposed only through additive kernel schemas and endpoints.
- The UI never invents percentages, metrics, proof items, artifacts, or successful states.
- Existing pairing, scope enforcement, replay, checkpoint ordering, and intervention authority
  semantics remain unchanged.
- Desktop, compact web, iOS, and Android share the same business presentation models.
- The latest standalone HTML is the visual baseline; later implementation-plan decisions that
  intentionally removed PoW metrics or mobile bottom navigation are superseded.

## Product structure

### Desktop

The desktop surface keeps the conditional three-column workbench:

1. A 288 px work rail for tickets, projects, and agenda.
2. A permanent Lead conversation as the primary surface.
3. A 400 px task thread when a ticket is open.

The rail and thread remain independently closable. The conversation expands when either side is
closed. The workbench retains the prototype fonts, cool-paper palette, cobalt accent, restrained
state colors, and compact rounded geometry.

### Compact web and native

The Lead conversation remains the default screen. A persistent four-segment bottom navigation
switches between `对话`, `任务`, `项目`, and `日程`. Ticket detail is a full-screen drill-in and hides
the bottom navigation until the user returns. The header work button and left-edge handle remain
available as redundant entry points to the work surface.

## Authoritative data model

### Structured checkpoint progress

Agent-reported checkpoints may include an optional progress object:

```ts
type CheckpointProgress = {
  current: number;
  total: number;
  label: string | null;
};
```

`current` and `total` are safe integers in `0..2_147_483_647`, `total` is greater than zero, and
`current` may not exceed `total`. The displayed percent is
`clamp(0, 100, Math.round(current * 100 / total))`, computed by the server projection and never
supplied by the UI. System checkpoints normally omit progress.

The ticket work-item projection uses the newest explicit progress report. If no explicit report
exists but the ticket has child tickets, it may expose child completion as a separately labelled
source. Otherwise progress is `null` and the UI omits the bar and percentage.

### Proof-of-work items

Agent-reported checkpoints may update stable PoW items:

```ts
type CheckpointProofItem = {
  id: string;
  label: string;
  state: 'pending' | 'passed' | 'failed' | 'retired';
  evidence: string | null;
};
```

Proof IDs match `[A-Za-z0-9._-]{1,80}`, labels contain 1-160 characters, and evidence is nullable
with a 1,000-character maximum. One checkpoint may update at most 20 unique proof IDs, duplicate
IDs in one submission are rejected, and a ticket may retain at most 200 non-retired current items.
`retired` is an explicit tombstone: it remains in checkpoint history, removes the item from current
counts and verdict calculation, and releases one current-item quota slot.

Checkpoint rows remain immutable. In the same transaction that inserts a checkpoint, the
Coordinator folds its proof updates into a materialized `ticket_proof_items` table. Updates are
applied in checkpoint-ID order and the greatest checkpoint ID always wins for the same
`(ticketId, proofItemId)`. This preserves the append-only audit history without requiring an
unbounded fold on every read.

The PoW projection contains:

- the folded checklist;
- verdict state: `empty`, `running`, `attention`, or `passed`;
- real passed/total counts;
- real checkpoint count;
- real elapsed time;
- real runtime tool-operation count;
- pending-intervention count.

No metric is shown when its source is unavailable.

### Artifacts

Checkpoint submissions may register artifact metadata and immutable content together with their
references:

```ts
type CheckpointArtifactInput = {
  ref: string;
  name: string;
  kind: string;
  mediaType: string;
  description: string | null;
  relativePath: string | null;
};
```

Before the database transaction begins, a relative path is accepted only when it resolves to a
regular file inside the ticket workdir. The daemon streams that file into managed immutable,
content-addressed storage under `PLC_DATA_DIR`, computes SHA-256 and byte length, fsyncs it, and
atomically renames it to its final storage key. The transaction then stores metadata keyed by
`(ticketId, ref)` and links it to the producing attempt and checkpoint. Raw filesystem paths and
storage keys are never returned to clients.

If the database transaction rolls back, the immutable blob may be temporarily orphaned but no row
can reference a missing blob. Startup repair removes unreferenced blobs older than the configured
grace period. Identical content is deduplicated by SHA-256. Metadata-only legacy references remain
visible with `availability='metadata_only'` and no download action.

The additive API exposes artifact metadata and a scope-protected content endpoint backed by the
managed immutable snapshot. Companion downloads bytes through the authenticated control-plane
client. Web uses a Blob download; native uses Expo FileSystem and the platform share sheet.
Metadata-only artifacts remain visible but have a disabled download action with an explicit
unavailable state.

## Deterministic projections

### Progress selection

1. A cancelled ticket exposes `null` progress.
2. A done ticket exposes terminal progress `1/1`, 100%, with source `terminal`.
3. Otherwise, the newest checkpoint by database ID with explicit progress wins.
4. If no explicit progress exists, use direct, non-cancelled child tickets only: `current` is the
   number in `done`, `total` is all direct non-cancelled children, and the source label is `子任务`.
   Ticket status is the authority; no additional executor-settlement condition is required.
5. Recursive descendants never contribute to a parent's fallback ratio.
6. Conflicting retries under one checkpoint idempotency identity fail; later checkpoints are valid
   authoritative updates.

### PoW folding and verdict

- Checkpoints are processed by ascending database ID; proof items within one checkpoint retain
  submitted order; the last update for an item ID wins.
- Retired items are omitted from the current checklist. Final checklist order is ascending by the
  checkpoint ID of the latest non-retired update, then item ID.
- `total` includes passed, pending, and failed current items. `passed` counts only passed items.
- Verdict is `empty` when total is zero; `attention` when any item failed, a pending intervention
  exists, or the ticket is blocked; `passed` when total is positive and every item passed; otherwise
  it is `running`.
- `checkpointCount` counts every durable checkpoint for the ticket.
- `toolOperationCount` counts distinct `(attempt_id, callId)` rows whose canonical runtime event is
  `tool.started`, across executor and reviewer attempts for the ticket. Conversation-card rows are
  never used because they are bounded and may be truncated.
- `elapsedMs` is wall-clock ticket elapsed time from `KernelTicketTiming`, not active execution
  time. `computedAt` is the workbench projection timestamp.

The projection DTO exposes the progress source (`explicit`, `children`, or `terminal`) and label so
the UI never implies that a derived child ratio was agent-reported.

## Database migration and atomicity

Migration version 13 adds:

- nullable `checkpoints.progress_current`, `progress_total`, and `progress_label` columns with a
  table-level invariant that the numeric pair is either both null or satisfies
  `0 <= current <= total <= 2_147_483_647` and `total > 0`;
- `checkpoints.proof_items` as strict JSON with default `[]` and `CHECK(json_valid(proof_items))`;
- `ticket_proof_items(ticket_id, item_id, label, state, evidence, checkpoint_id, updated_at)` with
  foreign keys to tickets/checkpoints, state check `pending|passed|failed`, primary key
  `(ticket_id, item_id)`, and indexes by ticket/state and checkpoint;
- `artifacts(id, ticket_id, attempt_id, checkpoint_id, ref, name, kind, media_type, description,
  original_filename, sha256, byte_length, storage_key, availability, created_at)` with unique
  `(ticket_id, ref)`, foreign keys to tickets/attempts/checkpoints, availability check
  `available|metadata_only|unavailable`, SHA lookup, and ticket/checkpoint indexes. `available`
  requires SHA, byte length, and storage key; `metadata_only` requires all three to be null;
  `unavailable` requires a null storage key but may retain expected SHA and byte length for audit.

Legacy checkpoint `artifact_refs` are processed by ascending checkpoint ID and array order. The
first occurrence of `(ticketId, ref)` owns provenance; later duplicates are ignored. Backfilled
rows use `name=basename(ref) || ref`, `kind='reference'`,
`media_type='application/octet-stream'`, null description/content fields, and
`availability='metadata_only'`. The migration folds any checkpoint proof JSON into
`ticket_proof_items`, then verifies that rebuilding from immutable checkpoints produces the same
rows. Startup repair repeats this verification and repairs drift transactionally. The migration
uses null progress defaults, preserves ledger row counts, runs foreign-key checks, and records its
schema-migration row only after success.

Checkpoint insertion, proof-item materialization, artifact metadata rows, activity, conversation
projection, ticket touch, and the existing durable `ticket.updated` outbox row commit in one SQLite
transaction. Managed artifact blobs are staged and finalized before that transaction; failed
transactions leave only repairable unreferenced blobs. Startup repair verifies every available
artifact row has matching bytes and hash, downgrades corrupt rows to unavailable without deleting
audit metadata, and garbage-collects old unreferenced blobs.

## Additive kernel API

The protocol package adds strict versioned schemas for:

- checkpoint progress, proof items, and artifact inputs;
- ticket progress and PoW workbench projections;
- artifact list items and cursor-free ticket-scoped list responses;
- artifact content metadata used before download.

Exact DTO additions are:

```ts
type KernelCheckpointV2 = KernelCheckpointV1 & {
  progress: { current: number; total: number; label: string | null } | null;
  proofItems: Array<{
    id: string;
    label: string;
    state: 'pending' | 'passed' | 'failed' | 'retired';
    evidence: string | null;
  }>;
};

type KernelTicketProgress = {
  current: number;
  total: number;
  percent: number;
  label: string | null;
  source: 'explicit' | 'children' | 'terminal';
  checkpointId: number | null;
};

type KernelTicketWorkItemV2 = KernelTicketWorkItemV1 & {
  progress: KernelTicketProgress | null;
};

type KernelTicketPow = {
  verdict: 'empty' | 'running' | 'attention' | 'passed';
  items: Array<{
    id: string;
    label: string;
    state: 'pending' | 'passed' | 'failed';
    evidence: string | null;
    checkpointId: number;
    updatedAt: string;
  }>;
  metrics: {
    passed: number;
    total: number;
    checkpointCount: number;
    toolOperationCount: number;
    elapsedMs: number | null;
    pendingInterventionCount: number;
  };
  computedAt: string;
};

type KernelTicketWorkbenchV2 = KernelTicketWorkbenchV1 & {
  progress: KernelTicketProgress | null;
  pow: KernelTicketPow;
};

type KernelArtifact = {
  id: number;
  ticketId: number;
  attemptId: number | null;
  checkpointId: number;
  ref: string;
  name: string;
  kind: string;
  mediaType: string;
  description: string | null;
  availability: 'available' | 'metadata_only' | 'unavailable';
  byteLength: number | null;
  sha256: string | null;
  createdAt: string;
};

type KernelArtifactListResponse = { items: KernelArtifact[] };
type KernelArtifactContentMetadata = {
  artifactId: number;
  filename: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
};
```

All objects are strict. Checkpoint and artifact arrays are ordered by ascending database ID; PoW
items use the deterministic order defined above. Dedicated v1 and v2 mapper functions are
mandatory so migration fields can never leak into byte-compatible v1 responses.

Existing strict kernel-v1 response shapes and capabilities remain byte-for-byte compatible. New
capabilities are:

- `kernel.checkpoints.v2`
- `kernel.work-items.v2`
- `kernel.ticket-workbench.v2`
- `kernel.artifacts.v1`

Versioned endpoints are:

- `GET /v1/kernel/v2/work-items`
- `GET /v1/kernel/v2/tickets/:ticketId/workbench`
- `GET /v1/kernel/v2/tickets/:ticketId/checkpoints`
- `GET /v1/kernel/v1/tickets/:ticketId/artifacts`
- `GET /v1/kernel/v1/tickets/:ticketId/artifacts/:artifactId/content`

Companion prefers every v2 additive capability independently. When a capability is absent it keeps
using the existing v1 resource, omits unsupported progress/PoW fields, and renders the existing
honest unsupported artifact state. Mixed-capability servers remain valid.

All reads require `tickets:view`. Existing `ticket.updated` invalidation refreshes progress, PoW,
and artifact resources; no new WebSocket event type is introduced.

## Companion rendering

### Work rail

- Ticket rows use the prototype's compact title-first layout.
- Status is represented through group placement, metadata, left accent, and heartbeat rather than
  a second badge row.
- Only running tickets with authoritative progress show a thin progress bar and percentage.
- Completed remains collapsed by default.
- First-use empty state includes three example commands that seed the Lead composer.
- The top add button and all-completed action both return to Lead and focus a new-task draft.
- No-results always offers `清除筛选`, resets both filter and query, and preserves the current rail
  destination.

### Lead conversation

- A ticket-execution card remains one outer card.
- Tool operations inside it become flat divider rows, not nested cards.
- Ordinary checkpoints render as compact message updates with source, state, title, summary, and
  optional inline facts; they do not receive a card border or shadow.
- Intervention requests remain highlighted cards because they are actionable exceptions.
- Resolved intervention follow-ups collapse to compact status rows.
- Generic tool, agent, and artifact parts use row presentations unless they are directly
  actionable.

### Task thread

- Tabs are `PoW`, `产物`, and `日志`.
- PoW renders the verdict banner, only available real metrics, a flat acceptance checklist, and a
  compact flat checkpoint history below it.
- Checkpoints never render as repeated elevated cards.
- Artifacts match the prototype's file-row layout and expose download state.
- Logs use the prototype's light vertical timeline rather than a dark terminal container.
- Header metadata, session copy, child-ticket rows, heartbeat, and contextual composer remain.

### Responsive details

- Desktop thread width is 400 px.
- Compact navigation has stable dimensions and safe-area padding.
- Bottom navigation is hidden only for ticket detail, pairing, and scanner surfaces.
- No text, badge, or action may resize the navigation or overlap adjacent content.

## State and lifecycle

- Control-plane normalization stores progress, PoW, and artifact entities separately from transient
  streams.
- Workspace state owns `CompactDestination = 'conversation' | 'tickets' | 'projects' | 'agenda'`.
  Selecting a destination closes ticket drill-in and retains rail filter, query, expansion, scroll
  anchor, and every context-keyed composer draft. Opening a ticket stores the current destination
  as `ticketReturnDestination`; Back restores it. A ticket deep link defaults the return destination
  to `tickets`. At the desktop breakpoint, the destination maps to the rail view while the selected
  ticket remains eligible for the right thread; returning below the breakpoint restores the last
  compact destination.
- Existing resource invalidation and generation checks apply to the new artifact resource.
- Disconnect preserves cached additive content and disables commands/downloads requiring a live
  connection.
- Malformed additive payloads fail closed without deleting previously accepted cached content.

## Security and failure handling

- Artifact limits are 20 registrations per checkpoint, 200 current refs per ticket, 25 MiB per
  file, and 250 MiB total immutable bytes per ticket. Quota checks run before blob finalization and
  again inside the metadata transaction.
- Artifact refs are 1-160 characters matching `[A-Za-z0-9._:/-]+`; names are 1-180 characters;
  kinds and media types are 1-120; descriptions and proof evidence are at most 1,000 characters;
  progress labels are at most 120. All display strings pass secret-bearing-data checks.
- Artifact relative paths reject absolute paths, traversal, NUL, symlinks escaping the workdir,
  missing files, and non-regular files. Ingestion resolves the canonical workdir and candidate,
  opens the canonical target through a no-follow descriptor, verifies it with post-open `fstat`,
  and copies only from that descriptor. Managed-storage directory entries are fsynced after atomic
  rename. Content routes use the opaque numeric artifact ID, never the user-controlled ref.
- When a content-addressed target already exists, its byte length and SHA are verified before
  reuse; mismatches are quarantined and fail the checkpoint. Per-ticket quota counts distinct
  available SHA values, while every ref still counts toward the 200-ref limit.
- Every content request rechecks bearer authorization and `tickets:view`. An artifact belonging to
  a different ticket and an unknown artifact both return the same non-disclosing 404 response.
- Content responses set validated media type and length, `X-Content-Type-Options: nosniff`,
  `Cache-Control: private, no-store`, and a CR/LF-free RFC 5987 attachment filename.
- A failed artifact download remains retryable and never marks the artifact unavailable globally.
- Download requests support cancellation. UI states are `idle`, `downloading`, `failed`,
  `unavailable`, and `offline`; only `failed` is retryable without a resource refresh.
- Agent retries with the same checkpoint idempotency identity must produce identical progress,
  proof, and artifact content or fail as a conflict.

## Testing strategy

Implementation follows red-green-refactor in these layers:

1. Protocol schema and frozen-v2 negative tests.
2. SQLite migration, checkpoint folding, artifact validation, and idempotency tests.
3. Coordinator workbench projections and HTTP authorization/content tests.
4. Agent-tool input and prompt-discipline tests.
5. Companion normalization, selectors, state lifecycle, and presentation-model tests.
6. Source-boundary/component tests for flat rows, PoW tabs, 400 px thread, real empty states, and
   persistent compact navigation.
7. Full backend and Companion regression, typecheck, lint, build, and Expo exports.
8. Browser acceptance against the latest standalone HTML at fixed 1440x900 desktop and 390x844
   mobile viewports. A deterministic real-daemon fixture must exercise: populated rail; first-use,
   all-completed, and no-results states with every action; all desktop panel combinations and the
   400 px thread; all four mobile destinations; ticket drill-in hiding/restoring navigation;
   PoW/Artifacts/Logs switching; artifact success, unavailable, failed, retry, and cancellation;
   intervention resolution; disconnect/cache behavior; refresh durability; keyboard and safe-area
   behavior; horizontal/vertical overflow; browser console/page errors; and baseline screenshots.
9. Compatibility fixtures cover old client/new daemon with kernel-v1 only, new client/old daemon,
   every mixed v1/v2 capability combination, and byte-identical v1 mapper output. Migration tests
   open a real version-12 database containing repeated legacy artifact refs and verify the exact
   version-13 backfill and restart repair.

Visual acceptance combines deterministic DOM/layout assertions with manual overlay review:

- desktop rail and thread widths differ from the prototype by at most 1 px;
- primary component bounds and spacing anchors differ by at most 4 px at the fixed viewports;
- font families, weights, state colors, radii, and tab labels match the prototype tokens exactly;
- screenshot comparison may mask dynamic text values but not structure, navigation, cards, rows,
  empty states, or control placement;
- an agent-performed side-by-side and 50%-opacity overlay review records explicit pass/fail notes
  for desktop and mobile before completion.

## Acceptance criteria

- No nested operation cards appear inside a conversation ticket card.
- No ordinary Checkpoint is rendered as an elevated card in Lead conversation or task thread.
- The task thread matches `PoW / 产物 / 日志` and shows only real data.
- Running rail tickets show progress only when an authoritative source exists.
- Artifact rows are backed by durable metadata and downloadable content when available.
- Mobile exposes the four prototype destinations through persistent bottom navigation.
- All four ticket-list states match the prototype, including example and creation actions.
- Desktop and mobile browser screenshots are reviewed against the authoritative HTML before the
  work is declared complete.

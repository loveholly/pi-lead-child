# Control-plane Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a shared, versioned, scoped, replayable control-plane protocol for pi-lead-child and provide the Companion client foundation.

**Architecture:** Use a pure TypeBox package for contracts, HTTP for authoritative snapshots, and a SQLite-backed WebSocket event stream for ordered live updates. Keep the existing v1 daemon protocol compatible while introducing v2 commands and origin-aware paired delivery.

**Tech Stack:** TypeScript, TypeBox, better-sqlite3, Node HTTP, ws, Vitest, Expo/React Native.

**Implementation status (2026-07-23):** Completed. Backend full suite, Companion checks, real-daemon E2E, and Web/iOS/Android exports passed. Remaining product gaps are tracked in the audit document and are outside this protocol-foundation plan.

---

### Task 1: Shared protocol schemas

**Files:**
- Create: `packages/protocol/package.json`
- Create: `packages/protocol/src/index.ts`
- Create: `test/protocol-contract.test.ts`
- Modify: `tsconfig.json`

- [ ] Write failing schema tests for scopes, ticket DTOs, handshake, commands, command results, and event envelopes.
- [ ] Run the focused test and verify imports/schemas are missing.
- [ ] Implement the minimal pure TypeBox package.
- [ ] Run schema tests and root typecheck.

### Task 2: Conversation and replay stores

**Files:**
- Modify: `src/store/schema.ts`
- Create: `src/store/conversations.ts`
- Create: `src/store/gateway-events.ts`
- Create: `test/conversations.test.ts`
- Create: `test/gateway-events.test.ts`

- [ ] Write failing tests for visible turns, assistant delta append, completion, monotonic event sequences, audience filtering, and scope filtering.
- [ ] Add append-only gateway event and channel turn tables.
- [ ] Implement stores and retention-safe queries.
- [ ] Run focused tests.

### Task 3: Control-plane projections

**Files:**
- Create: `src/gateway/control-plane.ts`
- Modify: `src/store/attempts.ts`
- Modify: `src/store/activities.ts`
- Modify: `src/store/schedules.ts`
- Create: `test/control-plane.test.ts`

- [ ] Write failing tests for overview, ticket summary/detail, project aggregation, runtime health, attention counts, agenda range expansion, attempts, activities, and approvals.
- [ ] Implement DTO mapping without leaking SQLite row shapes.
- [ ] Verify all timestamps are ISO strings and project null remains null.

### Task 4: Authenticated HTTP API

**Files:**
- Modify: `src/gateway/paired-server.ts`
- Modify: `src/store/gateway.ts`
- Modify: `src/store/approvals.ts`
- Create: `test/paired-http.test.ts`

- [ ] Write failing tests for bearer auth, scope denial, snapshots, approval resolution, CORS, body limits, one-time WS tickets, and redemption rate limiting.
- [ ] Implement route matching and stable error responses.
- [ ] Keep redeem/health compatibility.
- [ ] Run HTTP and existing paired tests.

### Task 5: WebSocket v2 and replay

**Files:**
- Modify: `src/gateway/paired-server.ts`
- Modify: `src/daemon/server.ts`
- Create: `test/paired-protocol-v2.test.ts`

- [ ] Write failing tests for hello.v2, command correlation, scope checks, audience-isolated deltas, ordered event ids, and resume replay.
- [ ] Implement paired connection registry and v2 command parser.
- [ ] Retain legacy chat/status messages.
- [ ] Verify revoked bindings cannot send commands or receive events.

### Task 6: Lead and Child lifecycle bridge

**Files:**
- Modify: `src/daemon/server.ts`
- Modify: `src/lead/tools.ts`
- Modify: `src/children/manager.ts`
- Create: `test/control-plane-events.test.ts`

- [ ] Write failing tests for Lead message/tool start/update/end normalization and Child tool lifecycle forwarding.
- [ ] Thread origin, turn id, ticket id, and onChildEvent through the daemon.
- [ ] Redact and truncate channel-visible tool payloads.
- [ ] Keep activities thin and session JSONL authoritative.

### Task 7: Companion protocol client

**Files:**
- Modify: `apps/companion/package.json`
- Modify: `apps/companion/tsconfig.json`
- Create: `apps/companion/src/data/controlPlaneClient.ts`
- Create: `apps/companion/src/data/credentialStore.ts`
- Create: `apps/companion/src/data/controlPlaneClient.test.ts`

- [ ] Write failing tests for endpoint normalization, pairing redemption, WS-ticket flow, command correlation, replay cursor, and reconnect state.
- [ ] Add the local protocol package and Expo SecureStore.
- [ ] Implement a platform-neutral client with injected fetch/WebSocket/storage for tests.
- [ ] Verify Expo typecheck and lint.

### Task 8: Verification and documentation

**Files:**
- Modify: `docs/DESIGN-GATEWAY.md`
- Modify: `docs/audits/2026-07-23-companion-backend-gap-audit.md`

- [ ] Run all backend tests outside the restricted socket sandbox if required.
- [ ] Run backend build and typecheck.
- [ ] Run Companion tests, typecheck, lint, dependency check, and web/iOS/Android exports.
- [ ] Document implemented endpoints, event types, compatibility behavior, and remaining gaps.

# pi-lead-child Control-plane Protocol Design

Date: 2026-07-23

## Goal

Turn the existing paired chat transport into a versioned control-plane that can safely support the Expo Companion, desktop clients, and future channels without exposing CLI text or SQLite directly.

## Scope

This design implements the protocol foundation required for a connected alpha:

- shared TypeBox schemas and TypeScript types
- authenticated HTTP snapshots for overview, tickets, projects, agenda, activities, attempts, and approvals
- approval resolution over paired HTTP
- WebSocket v2 handshake, command results, event identity, ordering, replay, scope filtering, and origin-aware delivery
- a user-visible conversation projection for Lead turns
- a reusable Companion protocol client and secure credential abstraction
- backward compatibility for the existing v1 `chat/status` WebSocket commands

The following remain separate phases:

- Expo push delivery
- arbitrary files and voice transcription
- external calendar connectors
- first-class project entities
- child-reported progress percentages

## Architecture

### Authoritative snapshots

HTTP responses are the source of truth for current state. The client may cache snapshots, but after reconnect or a sequence gap it must refresh affected resources.

### Ordered event stream

WebSocket events improve latency and streaming UX. Every replayable event has:

- protocol version
- event id
- monotonic sequence
- event type
- occurrence timestamp
- required scope
- optional audience binding id
- optional turn id
- optional ticket id
- structured payload

The gateway stores replayable events in SQLite. A reconnecting client supplies `after_seq`; events outside its scopes or addressed to another binding are not returned.

### Shared protocol package

`packages/protocol` contains pure TypeBox schemas, static types, constants, and validation helpers. Backend and Companion import the same package. Domain code remains in `src/store`; the protocol package must not depend on Node, React Native, SQLite, or pi.

### Conversation projection

The pi session remains the full agent fact source. A separate `channel_turns` table stores only user-visible channel data:

- user input
- assistant text
- source binding/channel
- optional ticket context
- state and error

Internal clock injection, memory refresh blocks, raw tool results, and system prompt content are never exposed through conversation history.

### Tool execution projection

Live Lead and Child tool events are normalized from pi lifecycle events. Historical child tool details continue to come from attempt session JSONL on demand. Activities remain a thin append-only ledger and do not mirror every raw pi event.

## Protocol Versioning

- `PROTOCOL_VERSION = 2`
- `/v1/*` remains the HTTP URL namespace for resource stability.
- The negotiated protocol version is carried in the WebSocket handshake and event envelope.
- Existing v1 WebSocket commands remain accepted during migration.
- Unsupported future protocol versions return `protocol_version_unsupported` without closing before the error is delivered.

## Scopes

Initial scopes:

- `chat`
- `tickets:view`
- `tickets:create`
- `approvals:respond`
- `notices`

Scope checks happen for every HTTP route and every WebSocket command. Authentication without authorization returns 403 rather than silently degrading.

## HTTP API

Public:

- `GET /v1/health`
- `POST /v1/paired/redeem`

Authenticated:

- `POST /v1/paired/ws-ticket`
- `GET /v1/overview`
- `GET /v1/conversation/turns`
- `GET /v1/tickets`
- `GET /v1/tickets/:id`
- `GET /v1/tickets/:id/activities`
- `GET /v1/tickets/:id/attempts`
- `GET /v1/projects`
- `GET /v1/agenda`
- `GET /v1/approvals`
- `POST /v1/approvals/:id/resolve`

The browser obtains a short-lived, one-time WS ticket through authenticated HTTPS. Long-lived access tokens in the WebSocket query string remain a compatibility fallback only.

## WebSocket Protocol

### Handshake

Server sends `hello.v2` containing:

- protocol version
- binding identity and scopes
- model/session/busy status
- latest event sequence
- server time and timezone
- supported capabilities

### Commands

- `chat.send`
- `status.get`
- `sync.resume`

Every command includes a client-generated id. The server answers with `command.result` using the same id.

### Chat context

`chat.send` may include `context.ticket_id`. The daemon injects that context into the same Lead session and stores it on the visible channel turn. A ticket thread is a filtered projection, never a second Lead session.

### Routing

- assistant deltas and tool events are sent only to the initiating paired binding
- notices and domain invalidation events are broadcast only to clients with the required scope
- Unix socket keeps its current observer-compatible legacy stream during migration
- Slack replies continue through the AiSH stream associated with the originating event

## DTO Decisions

- Backend status names are canonical; the UI uses `in_progress`, not `running`.
- `unknown` is a presentation group for `project = null`, not stored in tickets.
- Runtime health is computed from attempt state, live child state, and last activity.
- Attention is computed from pending approvals and non-consumed blockers.
- Progress percentage is omitted until a trustworthy reporting policy exists.
- Agenda V1 contains ticket due/remind entries and recurring schedule occurrences only.

## Security

- access tokens are stored only as hashes in SQLite
- Companion native storage uses Expo SecureStore
- Web storage is abstracted and must not log tokens
- request bodies are size limited
- pairing redemption is rate limited per remote address
- CORS allows loopback development origins and explicitly configured origins only
- revoked bindings are rejected on every command and excluded from event delivery
- tool arguments/results are truncated and passed through a secret-redaction helper before channel delivery

## Error Model

All HTTP and command failures use stable codes:

- `invalid_request`
- `unauthorized`
- `forbidden`
- `not_found`
- `conflict`
- `protocol_version_unsupported`
- `rate_limited`
- `internal_error`

Human-readable messages are not control-flow contracts.

## Testing

- schema validation tests for every public command and DTO family
- HTTP contract tests for 200/400/401/403/404/409/429 and CORS
- WS tests for handshake, scope enforcement, origin isolation, event ids, ordering, and replay
- daemon tests for Lead message/tool lifecycle normalization
- child RPC tests for live tool event forwarding
- Companion tests for URL construction, command correlation, replay cursor, and credential storage adapters
- full backend suite and Expo web/iOS/Android exports

## Release Gate

Connected alpha is allowed only when:

- existing backend tests remain green
- protocol contract tests pass
- two paired clients cannot observe each other's private Lead deltas
- reconnect replay is deterministic
- scope denial is covered by tests
- Companion can pair, connect, load ticket snapshots, send chat, and resolve an approval against a real daemon

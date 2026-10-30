# Ticket #49 Unattended Lead Delegation

## Scope

Ticket #49 adds a durable, auditable delegation workflow for ordinary technical
review, rework, and delivery. A Lead may close the loop only when a live
`delegation_policies` row grants `acceptance_policy='delegated_to_lead'` for the
task and a real reviewer attempt has written a structured `review_verdicts` row.

Session text, comments, and later Lead narration are never authority.

## Policy Semantics

| Policy | Values | Authority |
| --- | --- | --- |
| `verification_policy` | `independent_reviewer`, `lead_static`, `user` | Selects what evidence source is expected before acceptance. Automatic review dispatch requires `independent_reviewer`. Since schema v55, this column is the only source: v55 copied the old automatic review setting into it. |
| `acceptance_policy` | `user_only`, `delegated_to_lead` | Controls who may accept a reviewer result. Legacy rows and rows without an active delegation policy remain `user_only`. |
| `rework_policy` | `ask_user`, `automatic` | Controls whether a reviewer FAIL can re-enter the same task for executor rework without asking the user. |
| `delivery_policy` | `notify_only`, `continue_workflow` | Controls whether a PASS may continue structured workflow actions after technical delivery. |
| `delegation_policy.mode` | `technical_delivery`, `disabled` | Only `technical_delivery` with no revoke and valid expiry is active. |

Delegation rows also record scope, max rework cycles, token/USD budget limits,
effective expiry, creator/channel, policy version, revoke fields, and escalation
conditions. Granting an item-specific delegation updates the task policy columns;
revocation only revokes the delegation row and does not erase history.

Before accepting an unattended delegation request, Lead or the user control plane
runs a structured preflight. `preflight_delegation` records Lead-side checks in
`activities`; `/v1/lead/delegation` and `plc delegate lead` run the same checks
before creating a policy. A blocked preflight is recorded and the grant is
rejected instead of silently accepting an impossible workflow.

## Permission Boundary

| Action | Allowed automatically when delegated | Required evidence | Escalates instead |
| --- | --- | --- | --- |
| Accept reviewer PASS | Yes | Reviewer run belongs to the item and has `verdict='pass'` | No active delegation, revoked/expired policy, missing verdict, evidence conflict, budget exhaustion |
| Request rework on reviewer FAIL | Yes, if cycles remain and rework is automatic | Reviewer run belongs to the item and has `verdict='fail'` | No delegation, rework policy asks user, cycle limit exhausted, requirement/architecture change, evidence conflict |
| Complete technical delivery | Yes, after delegated PASS acceptance | Item is `done`, active delegation exists, reviewer PASS exists | Missing PASS evidence or no active delegation |
| Create follow-up work | Yes, only through structured continuation actions | Active delegation, idempotent continuation row, and matching durable trigger event | Capability not deployed/loaded, blocking dependency, revoked/expired delegation, retry exhaustion |
| Start dependency-blocked task | No | `depends_on` blockers must be done or revoked | Task may exist, but dispatch/run is blocked |
| Accept offline delegation | Only through user control plane/CLI after preflight | `delegation_preflight_accepted` activity and durable policy row | Missing reviewer/rework authority, invalid budget/expiry, missing required continuation/capability |

The Lead tools `accept_review`, `request_rework`, and `complete_delivery` enforce
these checks. They do not grant or revoke delegation. User-only confirmation
authority remains separate from delegation authority.

## Escalation Matrix

| Condition | Result |
| --- | --- |
| Requirement or architecture change is needed | Keep item in review/blocked state, record `delegated_review_escalate`, send `automation_blocked`. |
| Reviewer evidence conflicts with artifacts or another report | Stop automation, send `automation_blocked`, require user/Lead decision. |
| Irreversible external action is required | Stop automation and require approval. |
| External approval boundary is hit | Stop automation and notify. |
| Token or USD budget limit is exhausted | Stop automation and notify. |
| Max rework cycles are exhausted | Keep item in review, send `rework_exhausted`, create blocker inbox notice. |
| Capability is implemented but not deployed or not loaded into Lead tools | Continuation waits in `waiting_capability`, sends deduped `automation_blocked`. |
| Delegation is revoked or expired before continuation runs | Continuation moves to `waiting_user`, sends `automation_blocked`, and does not mutate tasks. |
| Continuation retries are exhausted | Continuation moves to `failed`, sends `continuation_failed`. |

Every automatic decision records the reviewer run id, delegation policy id, policy
version, and reason in `activities`.

## Continuation Workflow

Continuation state is stored in `continuations`, keyed by a stable
`idempotency_key`, with actions serialized in `action_sequence`. Pending
continuations are not polled directly: the runner consumes durable
`continuation_events` and only starts a row when the event matches its
`trigger_event`, item, and action-specific payload.

Supported trigger/resume events are:

- `review_passed`
- `review_failed`
- `capability_deployed`
- `dependency_satisfied`
- `automation_blocked`

Supported actions are:

- `wait_for_capability`
- `create_task`
- `link_tickets`
- `request_dispatch`

`review_passed`, `review_failed`, and `automation_blocked` events are produced
from delegated review decisions. `capability_deployed` is produced only when a
capability is active, implementation-verified, deployed, and loaded into Lead
tools. `dependency_satisfied` is produced when a `depends_on` blocker transitions
to `done` and the dependent item has no remaining active blockers.

Comments may describe intent, but they do not schedule future work. Follow-up
automation must be represented by continuation rows. Mutating continuation
actions (`create_task`, `link_tickets`, `request_dispatch`) require a persisted
`delegation_policy_id`; the runner rechecks revocation, expiry,
`acceptance_policy='delegated_to_lead'`, and `delivery_policy='continue_workflow'`
before every execution. The continuation runner can recover after restart because
each action reuses durable context keys and advances `current_step` only after
successful execution.

## Capability Readiness

A capability is available to Lead only when all three facts are true:

- `implementation_status='implementation_verified'`
- `deployment_status='deployed'`
- `lead_tool_status='loaded'`

Evaluator success sets implementation verification only. Deployment and Lead tool
loading are explicit facts and must not be inferred from code completion.

## Notification Outbox

User-facing review and automation events are written to `notifications`, not the
Lead inbox. The outbox keeps one row per durable event via `dedup_key` and moves
through `pending`, `delivered`, and `acked`.

Current delivery/read surfaces:

- Lead daemon delivery reads pending immediate notifications and marks them
  `delivered` only after a Lead turn succeeds.
- Scheduler fallback pushes stale immediate notifications and marks them
  `delivered` via fallback.
- Paired control-plane clients with the `notices` scope can read
  `/v1/notifications` and ack `/v1/notifications/:id/ack`.
- Companion hydrates pending/delivered notifications at startup, displays them
  in the work rail outbox, and refreshes notifications plus overview after ack.

`Overview.counts.unreadNotices` is derived from pending/delivered notifications,
so offline events remain visible when the user reconnects.

## End-To-End Evidence

Focused #49 regression:

```text
TMPDIR=/private/tmp ./node_modules/.bin/vitest run test/delegated-workflow.test.ts test/automatic-review.test.ts test/notifications.test.ts test/ticket-relations.test.ts --configLoader runner --reporter default
```

Result: 4 files passed, 36 tests passed. Covered delegation preflight, reviewer
FAIL automatic rework on the original item, reviewer PASS delegated delivery,
no-authorization refusal, revocation, cycle exhaustion, evidence conflict
escalation, continuation idempotency/restart behavior, trigger-event gating,
revoked-delegation continuation blocking, dependency-blocked task creation,
capability readiness waiting, and notification pending/delivered/acked states.

Related contract and compatibility suite:

```text
TMPDIR=/private/tmp ./node_modules/.bin/vitest run test/control-plane.test.ts test/protocol-contract.test.ts test/kernel-protocol-contract.test.ts test/kernel-schema-migration.test.ts --configLoader runner --reporter default
```

Result: 4 files passed, 31 tests passed. This proves the TicketSummary schema
projects #49 policy fields, protocol contracts remain additive, and migrations
preserve legacy `user_only` behavior instead of manufacturing delegation.

Companion regression:

```text
TMPDIR=/private/tmp ./node_modules/.bin/vitest run --configLoader runner --reporter default
```

Run from `apps/companion`. Result: 36 files passed, 306 tests passed. This covers
the notification outbox read/ack client flow, runtime refresh, WorkRail outbox,
and ticket-thread Lead delegation grant/revoke affordance.

Additional verification:

```text
./node_modules/.bin/tsc --noEmit -p tsconfig.json
./apps/companion/node_modules/.bin/tsc --noEmit -p apps/companion/tsconfig.json
./node_modules/.bin/eslint . --no-cache
TMPDIR=/private/tmp node --import tsx scripts/acceptance-item-model.ts
npm run build
```

Results:

- Root typecheck passed.
- Companion typecheck passed.
- Companion lint passed with two warnings in pre-existing Companion files. The
  command was run from `apps/companion`; `npm --prefix apps/companion run lint`
  remains unsuitable in this sandbox because Expo writes `.expo/cache/eslint`.
- Item-model acceptance passed: 36 checks.
- Build passed and wrote `dist/coordinatord.mjs`, `dist/cli.mjs`, and
  `dist/mcp-server.mjs`.

The root full Vitest suite was not used as acceptance in this sandbox: a
mistaken full-suite run hit the known environment limitation where local
process/socket/HTTP tests fail or time out on `listen EPERM` and child-process
controls. Focused root suites that do not require those restricted OS operations
passed as listed above.

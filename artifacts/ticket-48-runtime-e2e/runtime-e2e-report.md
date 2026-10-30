# Ticket #48 Runtime E2E Acceptance Report

Audit date: 2026-08-17

Executor ticket: #51

Conclusion: **BLOCKED / NOT PASSED**

The live runtime now has the #48 relation schema and relation tools loaded, and
most structured-relation paths were exercised against the actual Companion/HTTP
runtime. The acceptance still cannot be marked passed because required runtime
evidence is incomplete: screenshots could not be saved to the requested artifact
directory, direct user start of a blocked ticket returned a gateway 500 and did
not write the required blocker activity, `create_task(relations)` was not
verified through an actual Lead conversation/tool invocation, and full parent
tree restore could not be exercised with the available safe runtime API.

## Runtime Environment

| Item | Observed |
| --- | --- |
| Repository | `/Users/alice/Workspace/AI/pi-lead-child` |
| Branch / HEAD | `master`, `65084672e18d29ffded242e204e11916b82e4f48` |
| Package version | `1.0.0` |
| Worktree | Dirty; includes #48/#49 source, tests, docs, and generated artifacts |
| Live DB | `/Users/alice/.pi-lead-child/plc.db` |
| Schema migrations | v17 `ticket-relations-v1`, v18 `delegation-workflow-v1`, both applied `2026-08-14 06:57:06` |
| Relation table | `ticket_relations` exists |
| Daemon | `node` pid `17349`, cwd repo root, DB open, listening on TCP `*:47130` |
| Companion | `node` pid `18581`, cwd `apps/companion`, listening on TCP `*:8081` |
| Active Runs before/after E2E | only #51 Run #40 remained `running`; no unrelated Run was stopped |
| Companion pairing | Loopback auto-pair used from `http://localhost:8081`; token was not recorded in this report |

No daemon restart or migration was performed during this run. The live instance
was already migrated to v17/v18. I did not kill or restart any service because
the current #51 Run was active.

## Runtime Tool Readiness

| Check | Result | Evidence |
| --- | --- | --- |
| `get_ticket_relations` loaded in current agent runtime | Passed | Actual call for #51 returned `{"ticket_id":51,"relations":[]}` rather than `unknown tool` |
| `link_tickets` / `revoke_ticket_relation` runtime capability | Passed | Current tool namespace exposed both; Companion/HTTP created relation IDs 1-11 and revoked IDs 1-7, 10-11 |
| `create_task(relations)` atomic Lead capability | Not verified | Source contains the parameter, but no safe non-interactive Lead chat/tool-list path was available; HTTP create endpoint does not accept `relations` |

## Scenario Matrix

| Case | Expected | Actual Result |
| --- | --- | --- |
| a. `implements` + `depends_on` bidirectional display | Both sides show forward/reverse relations, reason, user, time, jump actions | Passed before cleanup. #54 displayed `depends_on #55` and `implements #55`; #55 displayed `blocks #54` and `implemented_by #54`. Relation IDs #1/#2, created by `user` at `2026-08-17 06:11:07`. Revoked during cleanup. |
| b. Blocker rejects executor Run and records waiting/blocker | #54 exists, no Run dispatched while #55 unfinished, UI/activity show blocker | Partially failed. Starting #54 was rejected and no Run/dispatch request was created, but HTTP returned `500 internal_error` and activities did not include `dispatch_blocked_by_ticket_relation`; daemon log had the blocker text. UI relation section showed the dependency but no blocker activity. |
| c. `implements` alone does not block Run | #56 can start with only `implements #57` | Passed. Relation #3 created, #56 started Run #41, then was immediately stopped by user for no-side-effect cleanup. Run #41 ended `stopped/interrupted`. |
| d. Companion fixed enum `relates_to`, revoke with reason | Create relation, revoke with reason, history preserved | Passed. #58/#59 relation #4 was created as `relates_to` and revoked at `2026-08-17 06:11:12`; UI showed created/revoked activities, original reason, revoke reason, user, and timestamps. |
| e. High-impact risk and cancel no write | `duplicates`/risk warning requires confirmation; cancel path does not persist | Passed. Accepted duplicate #60 -> #61 relation #5 returned canonical risk. Separate UI-only path #67 -> #68 clicked first `检查高影响`; UI showed high-impact warning and `确认建立`, and DB relation count for #67/#68 stayed `0`. |
| f. Validation failures atomic | self-link, duplicate, cycle, missing/cancelled target, parent write rejected without half-write | Passed. Self-link #62->#62 returned 400; duplicate #62->#63 returned existing relation #6 with no new row; cycle #64->#62 returned 409; missing #999999 returned 404; cancelled target #65 returned 409; `parent_of` returned 400. Only setup relations #6/#7 existed, later revoked. |
| g. Restore does not expand through ordinary relations | Restore only follows parent/child tree, not `relates_to`/`implements` | Partial. Full isolated parent tree could not be created through available safe HTTP/MCP paths. Boundary check #69/#70 proved restore did not expand via `implements`/`relates_to`: after cancelling both, restoring #69 returned `restoredItemIds:[69]`, while #70 remained `cancelled`. |
| Final #45 business action | Create implementation ticket, link `implements #45` and `depends_on #45`, do not start Run | Passed for data/API. #66 was created and left `ready`; relation #8 `implements #45` and #9 `depends_on #45` remain active; #45 remains `review`; #66 has no Run. #66 UI shows both relations and `尚未执行`. #45 API returns reverse `implemented_by #66` and `blocks #66`; #45 review UI did not render the relation section. |

## Key Evidence

### Relation rows after cleanup

Final active relations:

| Relation | Source | Target | Type | State |
| --- | --- | --- | --- | --- |
| #8 | #66 | #45 | `implements` | active |
| #9 | #66 | #45 | `depends_on` | active |

All temporary E2E relations (#1-#7, #10-#11) were revoked with cleanup reason
`T48-E2E-51-20260817061106: cleanup revoke after runtime E2E evidence; preserve audit history`.

### Final ticket state

| Ticket | State | Notes |
| --- | --- | --- |
| #45 | `review` | Existing design ticket remains waiting for user acceptance |
| #66 | `ready` | Final implementation follow-up remains, linked to #45, not started |
| #53-#65, #67-#70 | `cancelled` | Temporary E2E test data cancelled after audit evidence |

Runs for E2E tickets:

| Run | Ticket | State | Notes |
| --- | --- | --- |
| #41 | #56 | `stopped` | Created only to prove implements-only does not block; immediately stopped |

No Run exists for #66.

### Blocked start evidence

Daemon log:

```text
[2026-08-17T06:11:07.692Z] [gateway] HTTP error: item #54 is blocked by depends_on relation(s): #55 [ready] [E2E #51 T48-E2E-51-20260817061106] case-a-b unfinished authority / blocker; the blocker ticket must be done or the relation must be revoked
```

There was no `dispatch_requests` row for #54 and no Run for #54. The missing
blocker activity is the failing part of case b.

### Screenshot status

Companion screenshots were captured as Chrome MCP previews for:

| Intended screenshot | Runtime page | Status |
| --- | --- | --- |
| Tool/capability readiness | #51 detail/checkpoint page | Preview captured, not saved |
| Bidirectional relations | #54/#55 details | Preview captured, not saved |
| Waiting dependency | #54/#55 details | Preview captured, not saved |
| Create/revoke audit | #58 detail | Preview captured, not saved |
| High-impact warning | #67 detail form | Snapshot/preview captured, not saved |
| Final #45 implementation relation | #66 detail | Preview captured, not saved |

Saving PNGs to
`artifacts/ticket-48-runtime-e2e/*.png` failed with:

```text
Error: Access denied: path artifacts/ticket-48-runtime-e2e/case-a-b-reverse-relations.png
(canonical: /Users/alice/Workspace/AI/pi-lead-child/artifacts/ticket-48-runtime-e2e/case-a-b-reverse-relations.png)
is not within any of the configured workspace roots.
```

`screencapture` and headless Chrome fallback attempts also failed in this
runtime, so no screenshot files are registered. This alone prevents a passing
acceptance under the requested criteria.

## Artifacts

| Ref | Path | Kind |
| --- | --- | --- |
| report | `artifacts/ticket-48-runtime-e2e/runtime-e2e-report.md` | Markdown report |
| pre-v17-backup | `artifacts/ticket-48-runtime-e2e/db-backup/plc-live-pre-v17-20260814-1345.db` | Existing backup from prior blocked run |
| post-e2e-backup | `artifacts/ticket-48-runtime-e2e/db-backup/plc-live-post-e2e-20260817-1430.db` | SQLite backup after this E2E run |

## Required Unblock Path

1. Fix gateway/user-action error mapping and activity recording so a direct
   blocked start returns an expected conflict response and writes an auditable
   blocker/waiting activity, or provide a dispatcher path that satisfies the UI
   and activity requirement.
2. Provide a screenshot-capable browser/runtime path that can save PNG files
   into `/Users/alice/Workspace/AI/pi-lead-child/artifacts/ticket-48-runtime-e2e/`.
3. Exercise actual Lead `create_task` with `relations` in the live session, or
   expose a non-interactive runtime tool-list/tool-call acceptance path for it.
4. Provide a safe way to create an isolated parent/child tree in the runtime, or
   use a controlled Lead create path, then rerun restore verification against a
   real parent tree.
5. Re-run the failed/partial cases. Keep #66 as the real follow-up for #45; do
   not start it until #45 is accepted.

# Companion UI Completion Checklist

Last checked: 2026-09-07

This checklist is the completion gate for the Companion UI and its end-to-end workspace flows. An item is only complete when the implementation, focused tests, and real UI verification are all recorded.

## P0 UI And User Flows

- [x] Inbox-first information architecture.
- [x] User-action projection separated from lifecycle status.
- [x] Current-ticket context in Lead conversation.
- [x] Workspace lifecycle rail in ticket detail.
- [x] Fixed review decision bar for accept/rework.
- [x] Reviewer pre/post hash projection and UI summary.
- [ ] Merge-conflict-specific status and resolution flow.
- [x] Workspace failure, review-hold, cleanup-failure, and TTL-expiring states.
- [x] Mobile review decision layout verified at narrow viewport.
- [ ] Pairing center final UX and formal 49211 bundle refresh.
- [x] Unified attention reason across inbox, rail, detail, footer, and notifications.
- [ ] Real screenshot verification for every ticket state.

## P1 UI Follow-ups

- [x] Progressive disclosure for Session, Runtime, Checkpoint, and worktree terminology.
- [x] Reviewer evidence packet with coverage, artifacts, risks, and hash details.
- [x] Merge/integration status surfaced as a first-class decision packet.

## P1 Runtime And Integration Completion

- [x] Daemon startup reconcile integration flow.
- [x] Cleanup six-check flow and UI result projection.
- [x] TTL sweep and expiring-workspace notification.
- [x] Integration Run and merge-conflict integration flow.
- [x] Workspace-aware concurrency warning end-to-end flow.
- [x] Coding workspace skill end-to-end flow.
- [x] ReviewAuthorityService end-to-end flow.
- [x] Remove remaining direct Run state writes.
- [x] Supervisor schema-version report correction.

## Verification Gate

- [x] Companion typecheck passes after current changes.
- [x] Root typecheck passes after current changes.
- [x] `npm run test:core-invariants` passes after final changes.
- [x] Full `npm run verify` passes after final changes.
- [x] Fresh desktop and mobile screenshots reviewed after final changes.
- [ ] Checklist re-read with no unchecked item before final completion.

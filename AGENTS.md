# Engineering Guardrails

## Public Repository: No Real People, No Internal Data

This repository is public (user, 2026-10-30: 「务必保护机密信息和我的个人隐私相关的真实信息，不要进代码，不要进提交历史」).

- Never put real data in code, tests, docs, comments, prompts or commit messages: real names of the user or colleagues (or nicknames), account names, emails, home paths, Slack user or channel IDs, Jira keys, internal hostnames, company repository names, or quoted real messages.
- Use made-up stand-ins: names like Ethan, Nina, 李雷, 韩梅梅; `alice@example.com`; `/Users/alice`; `acme/x`; `*.example.com`; `PROJ-123`. A replay test of a real incident rewrites the people, the text and the identifiers.
- Text that reaches the model (system prompt, skills, tool descriptions) writes paths under the home directory as `~`, and holds no live configuration values: tools fetch them (`get_environment`).
- `.scratch/` is local only (`.gitignore`). Never force-add it.
- Configuration that points at internal services (gateway URLs, internal MCP servers) comes from the environment or the user's local settings, never from a default in the code.

## Bug Fixes

1. Add a regression test that reproduces the reported failure before changing production behavior.
2. Keep a focused unit test at the decision boundary changed by the fix.
3. For lifecycle, migration, startup repair, dispatch, notification, or cross-view state changes, also add an integration test covering the full persisted flow.
4. Run `npm run test:core-invariants` before the full `npm run verify` gate.

## Core Invariants

- `items.stage` is the authoritative lifecycle fact. Derived checkpoints, inbox rows, notifications, runtime state, and UI attention cannot rewrite or visually override terminal `done`, `cancelled`, or `acked` states.
- Startup repair is idempotent and bounded. Historical data predating a feature rollout cannot create user-facing blocker floods.
- Migrations preserve item lifecycle fields unless that exact lifecycle transformation is the migration's declared purpose. Test legacy, fresh, and reopen paths.
- Every UI surface derives the current ticket state from the same `TicketSummary`. Historical event labels describe the event and must not imply a conflicting current state.
- A fix is complete only when its regression test fails against the old behavior and passes with the fix.

## UI Design

Before you design or change any UI (conversation cards, panels, settings, genui components, mockups), read `docs/design/README.md`, then `docs/design/system/patterns.md` and the active theme (`docs/design/themes/default.md`). Follow the theme's rules; do not invent styles inside a task. If no rule covers the case, find the general card pattern it belongs to (patterns P9); if none fits, ask the user and add the rule first. The conversation list must never jump: expand only into an anchored panel. genui uses the same components as the app. Before you commit UI work, run the five checks in `docs/design/README.md`.

## UI Tokens

Semantic tokens set spacing and text size in the UI: `gap="card-row"`, `size="card-title"`. Before you write or change a spacing or text-size value in `apps/companion` or `packages/components`, read "语义间距和语义字号" in `packages/components/README.md` and pick a token by its use. If no token fits, add one in `packages/components/src/theme/tokens.ts` first, with all three density values on the scale (multiples of 4, plus 2 and 6; text sizes 11/12/13/14/16/20/24). Never write a bare number for a gap, padding, margin, `size` or `leading`; the only exceptions are a component's own spec (kept in the component or its `*.shared.ts`, with a comment) and 1–3px optical nudges. Density is declared once per zone with `<Density zone="ticket">`; components never pick their own density. The user's appearance knobs (density per zone, radius, text scale, line height, colors; 设置 → 外观, `packages/protocol/src/design-preferences.ts`) are applied inside the component library; never read them in a feature component, and never hardcode a color that a knob should drive.

## UI Actions

Every UI control that calls the backend is one operation with two entry points: the HTTP route the UI calls and a Lead tool. This covers the whole UI (tickets, settings, connections, channels, devices), so the user can always delegate to Lead what they can click.

- Both entry points call the same function. The "can it be done now" answer comes from that same function.
- Each operation declares its permission: `user_only`, `lead_allowed`, `delegated` or `user_direct`.
- Lead can run every non-ticket operation except `user_direct` in any turn, also in a turn that a timer or a Slack event woke (user, 2026-10-27). Inside the user's own active, authenticated turn, the ledger records `actor=lead` with `onBehalfOf: "user"`. In other turns, it records `actor=lead`.
- `user_direct` is for operations that grant Lead power or carry secrets: delegation and trust grants, approving Lead's own proposals, tokens and keys, device pairing and revocation, 「不是我」. Lead can call them and always gets a structured refusal that tells the user where to click.
- Timers (follow-ups, reminders, triggers, reminder moves) carry their origin: the user, external (source, sender, message event) or the system (spec D16, user 2026-10-27). In a turn that external text woke, the decision model decides, not a fixed rule. The authority table gives the ceiling from Jev's intent. The confidence model's cost axis adds two generic factors: "deferred" and "acts outward when it fires".
  - Low cost: Lead sets the timer, and the system tells the user.
  - Higher cost: the system keeps the timer and returns a confirm card. The user decides on it (`timer_request.resolve`, `user_direct`).
  - The request asks to change rules: the system refuses and gives the reason.
  - A timer with external origin wakes an external turn: rule changes are refused. Lead's own outbound text goes out on Lead's judgment in every turn, signed auto-reply; it gets no confidence check and no draft card (user, 2026-10-29: "我期望它就能自己做判断").
  - A follow-up set in the user's own turn records it, and the turn it wakes counts as the user's turn (`timer:<inbox id>`). That turn is not the live-user exception for rule changes.
  - The reminder list shows who asked for an external timer. The user can cancel it (`timer.cancel`). Cancels, edits and confirm-card answers become calibration samples.
  - See `packages/lead/src/turn-origin.ts` and `packages/engine/src/ui-actions/timers.ts`.
- Slack text must never rewrite Lead's behavior (user, 2026-10-27). Settings that go into Lead's system prompt (name, persona, style, appearance) refuse any turn that read external text, even the user's own.
- External content cannot change the rules (user, 2026-10-27; spec D10 in `.scratch/unified-message-events/spec.md`). This is the only exception to "any turn". If an external message woke the turn, or Lead read external content in it, the code refuses rule changes. The user's own live turn (a message the user is sending now, from Companion or plc) is exempt (user, 2026-10-27). A turn that a follow-up the user set earlier wakes is not exempt, because the user is not there. Rule changes are the authority table, standing orders, connection settings and settings-page options. The refusal is a structured `external_turn` refusal with the data for a confirm card. Each operation declares `changesRules`. Each Lead tool declares in `packages/lead/src/turn-origin.ts` if its output is external content. Only channel cards and conversations (`get_channel_card`, `read_channel_conversation`) and connection results count. Notes, files, ticket state, child and sub-agent reports and ledger records do not count. One exception: when a light sub-agent read an external system, the run-finished note that hands its result to Lead is external (`.scratch/lead-tools-and-routing/spec.md` D10), so external text cannot reach the rules through a sub-agent. An undeclared tool counts as external for rule changes only. Switching Lead's model is not a rule change; the prompt tells Lead not to switch it because someone in an external channel asked.
- Some operations still need the user's own turn: the ones marked `userTurnOnly`, Lead's name, persona and appearance (they go into Lead's system prompt), and five ticket actions (`set_budget`, `widen_grant`, `open_delivery_file`, `confirm_criterion`, `unconfirm_criterion`; see `packages/engine/src/ticket-actions/authority.ts`). Before you add a restriction on Lead, ask the user (user, 2026-10-27).
- Connection writes are direct by default (user, 2026-10-28: "这些操作不要再让我审批了"). The daemon creates new connections with `direct` and switched the existing `confirm` ones once (`ConnectionHub.relaxWritePolicyOnce`). The user can set a connection back to 「先问我」 in settings.
- Lead approves child approvals and answers decisions addressed to the user in any turn (user, 2026-10-28: "不要啥都让我审批"). The one floor: Lead cannot do them in a turn that read external content (`externalTurnFloor` on the operation). That turn gets the same refusal and confirm card as a rule change.
- Lead decides the other ticket actions itself in any turn: confirm, accept, rework, merge, open a PR, cancel, abandon (user, 2026-10-28: "工单操作让 Lead 自己判断"). The stage table gives `lead` those edges. Two limits stay: Lead cannot do them in a turn that read external content (the user's own live turn is exempt, 2026-10-29), and a turn from a credential without the action's scope (or a revoked one) is refused, so a child cannot use Lead to act for itself. After a coding ticket is delivered, the system also opens a draft PR on its own (user, 2026-10-26; `packages/engine/src/coordinator/auto-pull-request.ts`). It skips the PR when the workspace is not in the repository the ticket names.
- Lead must always have a way through (user, 2026-10-29: "你起码要让 lead agent 有能力处理，最差最差没考虑到的场景应该弹一个授权卡给我授权 lead 处理"). A refusal or a sandbox block is never a dead end and never a command handed to the user to type:
  - A refused ticket action that needs the user's turn stores that exact action and returns an authorization card. On confirm it runs as the user's own action (`packages/lead/src/turn-origin.ts` `authorizationCardResult`, `packages/engine/src/ui-actions/rule-change-confirmations.ts`).
  - What the sandbox cannot do runs on the host only after the user confirms one card for that exact command (`run_on_host`, `packages/engine/src/ui-actions/host-commands.ts`). Read-only host facts get a direct tool (`list_processes`).
  - The daemon does git for sandboxed runs: it fetches origin before each run, cuts new worktrees from origin's default branch, pushes after delivery, and clones a ticket's repository when it is missing (`packages/engine/src/coordinator/workspace-remote.ts`, `repository-checkout.ts`).
  - A new guard must say what Lead does next. If no tool or card exists for that path, add one before adding the guard.
- Lead's bash, edit and write are refused only in a turn that an external message woke. A turn that only read connection results, and the user's own live turn, keep them: the sandbox is the boundary (`packages/lead/src/hands.ts`).
- Follow the shape of `packages/engine/src/ticket-actions/`.

## Agent skills

### Issue tracker

Issues and specs live as local markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage roles, each label string equal to its role name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root, created when needed. See `docs/agents/domain.md`.

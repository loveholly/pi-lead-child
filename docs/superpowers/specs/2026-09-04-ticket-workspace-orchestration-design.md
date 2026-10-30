# Ticket-level Workspace / Worktree Orchestration — Design (Ticket #47)

Status: **proposed, awaiting user confirmation** — no implementation code has been written or
modified for this ticket. See "Decision points requiring confirmation" at the end; nothing
below should be built until those are answered.

## 0. Terminology and scope

Current code uses `Item`/`Run`, not `Ticket`/`Attempt`; this doc keeps the ticket's own
vocabulary (Ticket = `Item` with `kind='task'`, Run = attempt row in `runs`) and calls out the
code identifier in parentheses on first use of each term.

Two prior design docs explicitly declined this feature:

- `docs/superpowers/plans/2026-07-21-m5-reviewer-daemon.md:20` — "worktree 自动化明确不做:
  任意 workdir 的 worktree 语义不清（非 git 目录/共享目录皆常见）… 容器化需求出现时再做".
- `docs/superpowers/specs/2026-07-23-kernel-orchestration-expansion-design.md:838-839` — lists
  "automatic git worktree creation and merge automation" as a non-goal.

This design revisits that decision *only* for the scoped case the ticket asks for
(coding-oriented ticket trees), keeps everything behind an explicit opt-in flag, and does not
touch the shared `item.workdir` semantics for tickets that never opt in. It also closes a
previously-flagged but unimplemented gap: "attempted workspace mutation must fail or invalidate
the review by post-run diff/hash checks" (kernel design doc line 783) — see §7.3.

Today `item.workdir` (`src/store/types.ts:38`) is a bare path string. Every Run — executor
retries, sibling sub-tickets, the reviewer — resolves to and executes inside the *same*
directory (`src/children/manager.ts:318`: `item.workdir ?? process.cwd()`); the only guard is a
path-prefix containment check when a child ticket's workdir is set explicitly
(`src/lead/tools.ts:590`, `src/coordinator/service.ts:134-138`), and overlapping siblings are
only flagged as a soft advisory risk (`workdir_scope_mismatch`,
`src/store/ticket-relations.ts:200`). This design introduces a first-class `Workspace` entity
that sits between "ticket" and "raw filesystem path" so that sharing vs. isolation becomes a
recorded decision instead of an accident of whatever path happened to be on disk.

## 1. Core entity: Workspace

New table `workspaces`, new FK `runs.workspace_id`. A Workspace is a git working copy (either
the project's already-checked-out primary tree, or a `git worktree add`-created isolated tree)
bound to exactly one **owner ticket**.

```
Workspace {
  id
  owner_item_id        -- the ticket this workspace canonically belongs to
  mode                 -- 'shared' | 'isolated'
  kind                 -- 'primary' | 'isolated_child' | 'reviewer' | 'experiment'
  project_id
  repo_root             -- resolved via existing repositoryIdentity()
  path                  -- absolute path on disk
  branch                -- git branch name (null for non-git projects, see D6)
  base_ref              -- commit/branch this was created from
  git_worktree          -- boolean; false for legacy/non-git shared dirs
  source_item_id        -- ticket whose Run triggered creation (may differ from owner_item_id)
  source_run_id          -- run that triggered creation
  reused_from_workspace_id -- non-null when forked from another workspace (reviewer, isolated child)
  state                 -- see state machine §2
  merge_status           -- 'n/a' | 'pending' | 'merged' | 'conflict' | 'abandoned'
  created_at, last_used_at, retained_until, released_at, cleaned_at
}
```

Every `Run` (`src/store/types.ts:43-56`) gets `workspace_id`, captured once at Run start and
immutable thereafter — mirroring how `workdir` is already resolved once at spawn time
(`src/children/manager.ts:318`) rather than re-resolved mid-run. This is what makes the
"必须显式记录 workspace 模式/路径/分支/来源 Ticket/来源 Run/复用关系" requirement structural
instead of free-text: every fact lives in a typed column, queryable the same way
`review-authority.ts` already treats verdict staleness as a "fact layer" rather than prose.

`item.workdir` is kept as a **derived, dual-written cache** of the ticket's resolved primary
workspace path (see Migration §8 Phase 1) so existing runtime adapters
(`src/runtimes/{pi,codex,claude}.ts`) keep working unmodified until they're migrated to read
`workspace.path` directly.

## 2. Workspace state machine

```
requested ──▶ provisioning ──▶ active ⇄ idle
                    │                │
                    ▼                ▼
                 failed         review_hold ──▶ idle/active
                    │                │
              (retry / fallback)     ▼
                              pending_integration ──▶ released
                                       │                 │
                                  (conflict)              ▼
                                       ▼              cleaning ──▶ cleaned
                                    blocked                          │
                                                                      ▼
                                                                  archived (metadata retained forever)
```

- **requested** — a ticket resolved to needing a workspace (first coding dispatch) but nothing
  is on disk yet.
- **provisioning** — `git worktree add` (or, for the primary workspace, verifying the existing
  checkout) is running.
- **active** — at least one Run currently has this `workspace_id`.
- **idle** — no Run currently attached, but retained (between retries, during pause/resume, or
  waiting out its TTL).
- **review_hold** — a reviewer Run is attached under a policy that specifically protects the
  workspace from concurrent executor mutation while review is in flight (see decision table row
  6/7). Distinct from `active` so cleanup and dispatch both know not to touch it.
- **pending_integration** — an `isolated` workspace whose owning ticket reached a terminal stage
  and now needs a merge decision before it can be released.
- **released** — no further Run may attach; physical cleanup has not necessarily happened yet.
- **cleaning** — cleanup capability (git worktree remove + directory removal) in progress.
- **cleaned / archived** — terminal; the Workspace *row* is never deleted (same "never delete
  version metadata" convention as `capabilities`, `src/coordinator/learning.ts:132`), only the
  files are gone.
- **failed** — provisioning or cleanup failed; requires a Lead/user decision (retry, fallback to
  shared mode, or force-release). Never silently retried forever.
- **blocked** — reached from `pending_integration` when merge produces conflicts (see §7).

## 3. Relationship model

```
Ticket (owner, e.g. root_item_id or an explicitly-promoted sub-ticket)
   └─ 1:1 canonical Workspace(mode='shared', kind='primary')
        ├─ Sub-ticket A (default) ──────────────► shares owner's Workspace
        ├─ Sub-ticket B (isolation_reason set) ──► own Workspace(mode='isolated', kind='isolated_child',
        │                                              reused_from_workspace_id = owner's workspace)
        │                                              — B becomes owner of *this* workspace for its own subtree
        └─ Reviewer Run for A or the owner ─────► attaches to the same Workspace by default (read-only
                                                     capability), OR to a forked Workspace(kind='reviewer')
                                                     when clean-room policy applies (decision table row 7)

Run.workspace_id is resolved once at spawn by walking the ticket's parent chain until either:
  (a) an explicit Workspace row with owner_item_id == this ticket is found, or
  (b) the walk reaches a ticket whose Workspace is 'shared' — that is the resolution.
This replaces the informal "child inherits parent.workdir unless overridden" logic in
src/coordinator/service.ts:134-138 with a typed lookup instead of a path-prefix check.
```

Key invariant: **a ticket can become a workspace owner at any depth**, not only at
`root_item_id`. This lets a large sub-tree doing an independent refactor get its own isolated
tree without forcing the whole root tree into isolation (see D1).

## 4. Shared vs. isolated decision table

| # | Trigger | Default decision | Who can override | Notes |
|---|---|---|---|---|
| 1 | Coding root ticket dispatched for the first time, no workspace yet | Create **shared** primary workspace at project's current checkout | — | `git_worktree=false` if this is just the existing dir; true only if the project itself requires a fresh worktree per root (project setting) |
| 2 | Sub-ticket created under a ticket with a resolvable workspace, no isolation flag | **Share** parent's resolved workspace; no new row | — | Zero-cost default; matches ticket ask #1 |
| 3 | Sub-ticket created with explicit `isolation_reason` (`parallel_edit_conflict`\|`experiment`\|`clean_room_validation`) | Create **isolated** workspace, `git worktree add -b <branch>` from parent's current commit | Lead sets the flag at creation time; user can force via `ticket_update` | Sub-ticket becomes its own workspace owner |
| 4 | Two sibling sub-tickets dispatched concurrently with overlapping/unknown declared file scope | **Advisory warning only** (soft, matches current `workdir_scope_mismatch` convention) — does **not** auto-isolate | Lead must explicitly isolate one side, or serialize dispatch, in response to the warning | Hard-blocking this is a decision point (D2) — recommended default is soft |
| 5 | Retry Run for the same ticket, workspace still `active`/`idle`/`review_hold` | **Reuse** same workspace (`Run.workspace_id` = previous) | — | No new worktree per retry |
| 5b | Retry Run, workspace already `cleaned` | Re-provision at the **same branch** if the branch still exists; if the branch is gone, go to `failed` + blocked checkpoint | User must confirm before any recreation that discards history | Never silently fabricate a new branch under the same name |
| 6 | Reviewer Run; runtime has `capabilities.executableReadOnlyReview`; ticket has no clean-room flag | Attach **read-only** to the executor's workspace (`review_hold`) | — | Matches existing Codex `--sandbox read-only` usage |
| 7 | Reviewer Run; ticket flagged `clean_room_review`, or previous review detected drift | Fork an **isolated reviewer workspace** (`kind='reviewer'`, `reused_from_workspace_id` = executor's, `base_ref` = executor workspace's HEAD at hold time) | Lead/user set the flag | Higher cost (extra worktree), used only when asked |
| 8 | Owner ticket reaches `done`/`cancelled` and its workspace `mode='isolated'` | Must pass through `pending_integration` merge step before release | Lead/user can mark `merge_status='abandoned'` explicitly | Never silently drop isolated work |
| 9 | Non-owner ticket (sharer) reaches `done`/`cancelled` | No workspace action — lifecycle is tracked at the **owner**, not per sharer | — | Avoids premature cleanup while siblings still use the shared workspace |
| 10 | Owner ticket itself reaches `done`/`cancelled`, `mode='shared'` | `active`/`idle` → cleanup precondition check (§7) → `released` → `cleaning` | — | See §7 for the checklist |

## 5. Worktree API / tool contract

Follows the existing two-tier pattern: **coordinator-level service** (system capability) +
**agent tool surface** (exposed identically across pi/codex/claude via the existing host-bridge /
MCP bridge, `src/agent-tools/host-bridge.ts`, `src/agent-tools/mcp-server.ts` — not a pi-only
extension, since this must be a kernel invariant, not something re-implemented per runtime).

### 5.1 Coordinator service (`src/coordinator/workspace.ts`, new — mirrors `dispatch.ts`)

```
resolveWorkspace(itemId): WorkspaceView          // read-only, walks parent chain per §3
provisionWorkspace(spec): Workspace              // idempotent create-or-return, leased like dispatch claims
releaseWorkspace(workspaceId, opts): void        // → pending_integration | released, runs checklist §7
cleanupWorkspace(workspaceId): void              // physical removal, only from released/failed
reconcileOrphans(): void                          // daemon-restart recovery, §7.2
```

`provisionWorkspace` takes a lease the same way `dispatch.ts` claims do, so two concurrent
callers requesting isolation for the same ticket can't race into two worktrees for one owner
(failure scenario §7.1 item 2).

### 5.2 Agent-facing tools (added to `AGENT_TOOL_DEFINITIONS`, `src/agent-tools/definitions.ts`)

Lead-facing (lifecycle decisions — coding child never calls these):

- `resolve_workspace(item_id)` — read-only preview before dispatch.
- `provision_workspace(item_id, { mode, isolation_reason, base_workspace_id?, branch_hint? })`
- `release_workspace(workspace_id, { reason, merge_strategy?: 'merged'|'abandoned', force? })` —
  `force=true` requires `request_approval` first, same as other destructive tools.

Coding-child/reviewer-facing (consume only, no lifecycle control):

- Context is injected the same way ticket/run identity already is
  (`PLC_TICKET_ID`/`PLC_ATTEMPT_ID` env vars in host-bridge.ts): new env vars
  `PLC_WORKSPACE_ID` / `PLC_WORKSPACE_PATH` / `PLC_WORKSPACE_MODE` / `PLC_WORKSPACE_BRANCH` /
  `PLC_WORKSPACE_BASE_REF`, set once at Run start. No RPC needed for static facts.
- `get_workspace_diff_summary()` — optional, dynamic (file count/lines changed since base_ref) —
  useful for a coding skill's pre-flight checklist without shelling out to `git` directly.

### 5.3 Runtime capability flag

Add `workspaceIsolation: boolean` to `RuntimeCapabilities` (`src/runtimes/types.ts:4-12`) —
mechanically all three current runtimes can already be pointed at an arbitrary `cwd`/`--cd`, but
the flag makes "can this runtime be safely handed an isolated worktree" an explicit, checkable
fact rather than an assumption, matching how `executableReadOnlyReview` already gates reviewer
eligibility (`src/lead/tools.ts:203-205`).

### 5.4 Skill injection (not baked into prompts)

A new coding-specific block, injected the same way `renderActiveCapabilities()` already splices
project capabilities into the child prompt (`src/lead/tools.ts:207-209`), states the resolved
workspace facts (path/branch/mode/base_ref) and the checklist ("do not `git checkout` a
different branch here", "if you hit a conflicting file, request isolation instead of
force-pushing") — the skill *narrates* facts the tool layer already computed; it never becomes
the sole place an invariant lives.

## 6. Reviewer relationship

- Default: reviewer Run attaches read-only to the executor's current workspace
  (`review_hold` state) — no isolation, minimal cost, matches decision table row 6.
- Clean-room: reviewer Run gets a forked workspace built from the executor workspace's HEAD at
  the moment review starts (row 7). `reused_from_workspace_id` + `base_ref` make the fork's
  provenance queryable, not inferred.
- Integrity check (closes kernel-design gap, §7.3): a content hash of the workspace tree is
  snapshotted immediately before the reviewer Run starts and compared immediately after. Any
  diff invalidates the verdict automatically, regardless of what the reviewer wrote in
  `review_verdict`.

## 7. Cleanup, recovery, and failure scenarios

### 7.1 Cleanup checklist (must all pass; each is a stored fact, not free text)

1. Owner ticket stage is terminal (`done`/`cancelled`); for isolated workspaces additionally
   `merge_status ∈ {merged, abandoned}`.
2. No Run currently attached with `state ∈ {starting, running, paused}`.
3. A final diff/patch snapshot has been persisted as an `Artifact` row (existing `artifacts`
   table) *before* deletion — cleanup must never be the only place work existed.
4. `git status` is clean, or the dirty diff is exactly what was snapshotted in (3).
5. No commits reachable from the workspace's HEAD that aren't already covered by (3).
6. TTL/idle timer elapsed, **or** explicit release request with `force=true` + a recorded
   `request_approval`.

Only after all six pass does `releaseWorkspace` move to `released`, and only `cleanupWorkspace`
(a separate, later step) touches the filesystem — this two-step split gives a safe window to
abort cleanup if something surfaces late (e.g. a straggling artifact upload).

### 7.2 Recovery

- Daemon restart while a workspace is `provisioning`/`cleaning`: reconciliation checks whether
  the directory matches the DB record — present and consistent → `active`/`idle`; partially
  created → retry; ambiguous (e.g. directory missing but state says `active`) → `failed`,
  surfaced as a blocked checkpoint, never auto-recreated silently. This extends the existing
  "daemon restart reclaims all active runtime attempts using the existing orphan policy" pattern
  (kernel design doc) to workspaces.
- Branch deleted/force-pushed externally underneath a retained workspace: integrity check at
  resume verifies `base_ref` is still reachable; if not, `failed` + human decision, never
  silently rebased.

### 7.3 Failure scenarios

1. `git worktree add` fails (dirty index, path exists, detached HEAD) → `failed`, blocked
   checkpoint; Lead chooses retry-with-clean-base or fallback to shared mode.
2. Two concurrent provision requests for one owner race → guarded by a lease
   (`provisionWorkspace`), same pattern as dispatch claim leases (`dispatch.ts`).
3. Reviewer mutates a shared workspace despite read-only sandboxing on a runtime that only has
   soft (non-OS-enforced) restrictions → caught by the pre/post hash check in §6; verdict
   auto-invalidated, not merely flagged.
4. Cleanup races a new dispatch claim for the same ticket → dispatcher must check
   `workspace.state ∉ {released, cleaning}` before claiming; if released, shared-mode
   re-provisions transparently, isolated-mode blocks for human confirmation (history matters).
5. Disk exhaustion from too many concurrent isolated worktrees → a per-project cap on concurrent
   isolated workspaces (same shape as existing `PLC_MAX_PROJECT_CONCURRENCY`), alerting rather
   than silently queuing.
6. Merge conflict at `pending_integration` → structured conflict record (conflicting file list,
   target branch, assigned integration Run) using the **already-modeled** `RunPurpose='integration'`
   (`src/store/types.ts:13`) rather than inventing a new concept; unresolved → ticket `blocked`
   with an explicit `next_step`.

## 8. Migration path

Each phase is independently shippable and reversible; nothing before Phase 3 changes runtime
behavior for any existing ticket.

- **Phase 1 — data model.** Add `workspaces` table + `runs.workspace_id`. Backfill: one
  `workspace` row per existing `item.workdir != null` (`mode='shared'`, `kind='primary'`,
  `git_worktree=false`, `state='active'`). `item.workdir` stays as a dual-written cache column;
  nothing reads `workspace.path` yet.
- **Phase 2 — coordinator service.** `src/coordinator/workspace.ts` + `src/store/workspaces.ts`
  implementing resolve/provision/release/cleanup; wired into
  `children/manager.ts::runItemLifecycle` to resolve a workspace *before* computing `cwd`,
  replacing `item.workdir ?? process.cwd()` — but still writing the resolved path back into
  `item.workdir` for legacy readers.
- **Phase 3 — tool surface + flag.** Add the agent tools and `PLC_WORKSPACE_*` env injection,
  gated behind `PLC_WORKSPACE_ISOLATION_ENABLED` (default **off**), so non-coding tickets and
  existing tests are unaffected.
- **Phase 4 — dispatch integration.** Extend (not replace) the existing
  `workdir_scope_mismatch` risk annotation to be workspace-aware; stays advisory-only unless D2
  says otherwise.
- **Phase 5 — reviewer isolation + integrity hash check** (§6, §7.3 item 3).
- **Phase 6 — cleanup daemon sweep + TTL enforcement** (a new `sweepWorkspaces()` alongside the
  existing `expireInterventions` sweep, `src/daemon/server.ts:1079`).
- **Phase 7 — skill injection** (§5.4), replacing any ad hoc prompt text with structured
  tool/env-sourced facts.

## 9. Decision points requiring user confirmation before any implementation

1. **D1 — ownership granularity.** Recommend: any ticket may be promoted to a local workspace
   owner (nested owners), not only `root_item_id`. Confirm.
2. **D2 — conflict gating.** Recommend: overlapping-file-scope siblings stay a **soft** advisory
   (matches current repo convention), not a hard dispatch block. Confirm, or specify which
   tickets/policies should hard-block.
3. **D3 — default TTLs.** Proposed: isolated-workspace idle TTL 7 days, shared/primary grace
   period after terminal stage 14 days, both env-configurable. Confirm numbers or leave
   unconfigured-by-default (no hardcoded fallback).
4. **D4 — reviewer isolation default.** Recommend: opt-in via an explicit `clean_room_review`
   flag, not default-on for all `independent_reviewer` tickets (cost tradeoff). Confirm.
5. **D5 — integrity-check scope.** Confirm the pre/post workspace-hash reviewer-mutation check
   (§6, §7.3.3) is in scope for this feature's first implementation phase, not deferred again.
6. **D6 — non-git projects.** `item.workdir` today tolerates non-git directories. Recommend:
   isolation is unavailable for non-git coding tickets (forced `shared` mode, documented
   limitation) rather than falling back to full directory copies. Confirm.
7. **D7 — merge-back mechanism.** Recommend: reuse the already-modeled `purpose='integration'`
   Run, auto-driven for fast-forward/no-conflict merges, escalating to `blocked` + a decision
   request on conflict. Confirm, or require human-triggered merge always.
8. **D8 — rollout flag.** Confirm flag name (`PLC_WORKSPACE_ISOLATION_ENABLED`) and which
   environment enables it first (dev-only vs. broader).
9. **D9 — "coding ticket" discriminator.** `ItemKind` today is only `task | reminder` with no
   coding-specific subtype. Recommend adding an explicit discriminator (e.g.
   `item.workflow_kind: 'coding' | 'generic'`) so this entire feature can be scoped narrowly
   without touching non-coding tickets, rather than inferring "is this coding" heuristically from
   `project_id`/`workdir` presence. Confirm, or propose an alternative scoping signal.

No code changes have been made for this ticket. Implementation should not start until the above
are answered (or explicitly deferred with a stated reason) and the plan is broken into
sub-tickets per phase in §8.

## 10. 2026-10-19 修订：编码工单默认隔离

用户在 2026-10-19 确认了下面的改动。它们偏离了上面的几处规定。

### 背景

上线后的 52 个 workspace 全部是 shared/primary，隔离一次都没用过。原因是隔离只能由 Lead 在派发前申请，而 Lead 从来没有申请。结果：

- #89、#92、#93、#95 的 child 在线上主 checkout 里改代码、构建，Lead 随后请求重启，没有提交的代码就上线了。
- PR 评审工单 #85、#96、#98 的 child 在用户的工作副本里 fetch 和 checkout PR 分支。

### 偏离的规定

| 原规定 | 现在 |
|---|---|
| §4 第 1 行：根编码工单直接用项目当前的 checkout | 系统判定为编码工单时，用自己的隔离 worktree（`engine/src/coordinator/workspace-policy.ts`） |
| D9：编码工单由 `workflow_kind` 标记，Lead 建单时填 | 系统按事实判定：workdir 在 git 仓库里，并且这次 Run 会写文件（执行者的 execution、integration、conversation）。判定结果和依据记在工单的活动里（`decision: workspace_policy`），并把 `workflow_kind` 改成 coding |
| §5.2：隔离由 Lead 的 `provision_workspace(isolated)` 申请 | 隔离是默认。Lead 要用共享 checkout 时，调 `provision_workspace(mode='shared', reason)`，理由必填，记在工单上。daemon 自己的仓库（按 git 公共目录判断）一律拒绝共享 |
| D8：`PLC_WORKSPACE_ISOLATION_ENABLED` 开关，缺省关 | 删掉。代码从来没有读过它 |
| D3：隔离 worktree 闲置 7 天后进 `pending_integration` | 工单结束、worktree 有没合并的改动时马上进 `pending_integration`，问用户。没有改动的闲置 7 天后删除 |
| §6：PR 评审没有规定 | Lead 用 `create_task(review_pull_request)` 记下 PR。每个 Run 在 PR head 的临时 detached worktree 里跑（`kind='experiment'`），临时引用在 `refs/plc/review/` 下，不建分支。Run 结束（成功、失败、停止）就删 |

### 清理

- 合并（`integrate_workspace`）或放弃（`release_workspace(merge_status='abandoned')`）以后，马上删 worktree。已合并的 `plc/` 分支用 `git branch -d` 删除。
- 有没合并改动的 worktree 不删：没提交的文件、或者分支上有用户仓库当前 HEAD 没有的 commit。放弃这样的 worktree 要带上用户的原话（`user_confirmation`）。没提交的文件先提交到分支上，分支保留。
- `sweepWorkspaces` 定期扫描：PR 临时检出、结束了的工单的 worktree、`<repo>.plc-workspaces` 下没有登记的孤儿目录（闲置 7 天）。
- 清理和等合并决定的事写进 inbox，出现在 Lead 的当前局面里。等合并决定的 worktree 一直列在「等用户决定的事」里。
- 新的状态转换：`pending_integration → idle`。工单结束后又来了一个 Run（例如工单对话）时用。

### 部署闸门

- `npm run build` 开始时先删掉 `apps/daemon/dist/build-info.json`，构建成功后再写一份新的：构建的 commit，以及构建时源码有没有没提交的改动。构建中途失败时，闸门看到的是「没有记录」。
- 闸门在 Supervisor 的维护入口里（`request_maintenance`），每条重启路径都经过它：Lead 的 `request_runtime_maintenance`、换 Lead 模型以后 daemon 发起的重启、`plc daemon restart` 和 `plc daemon upgrade`。以下情况拒绝，daemon 不动，原因返回给请求方：
  - 主 checkout 里会进构建的代码有没提交的改动：`packages/`、`apps/` 下的改动和新文件，以及仓库根目录下的文件。`docs/`、`artifacts/`、`.scratch/` 和测试文件（`test/` 目录下的、`*.test.*`、`*.spec.*`）不算。
  - dist 没有构建记录，构建时有改动，或者构建的 commit 不在主 checkout 当前分支的历史里。
- 换模型的重启被拒绝时，daemon 写一条叫醒 Lead 的 inbox：新模型要等下一次重启才生效。
- 通过以后，Supervisor 等 Lead 这一轮结束（busy=false）、等接管不了的 Run 排空，再查一次闸门，然后按这个顺序做：
  1. 请 daemon 排空 Lead（drain）。
  2. 在线备份数据库到 `~/.pi-lead-child/backups/`：一步复制全部页面，最多 60 秒。超时或者失败时删掉半成品，不停 daemon，这次维护记成失败；排空了的 daemon 过一会儿自己恢复 Lead 的回合。
  3. 停 daemon、启动、验证 schema。
  重启备份只保留最近 10 份。备份期间 daemon 崩溃时照常拉起：只有维护真正让 daemon 停下以后，它的退出才不算崩溃。
- 用户的 `plc daemon start` 要启动新的 daemon 时也过闸门。拒绝时 desiredState 不改，巡检不会把它当成崩溃再拉起。`plc daemon start --force` 越过闸门启动，Supervisor 的日志里记一笔，命令的输出也写明越过了哪些原因。
- 崩溃以后的自动拉起、开机启动不拦截（拦截就等于停服），Supervisor 只在日志里记下闸门会拒绝的原因。`status` 里的 `deploy` 一项给出闸门的判断，缓存 30 秒；维护请求和 `plc daemon start` 当场再查。
- daemon 直接跑源码（`PLC_DEV`，没有 dist）时没有闸门。
- `npm run build:web` 的网页产物不经过重启就生效，闸门管不到它。

### 2026-10-19 审查后的修正

- workdir 是仓库里没有跟踪、并且已经有文件的目录（例如 `.scratch/` 下）时，派发被拒绝：隔离 worktree 只有 HEAD 的内容，child 看不到这些文件。还不存在的目录照常隔离，child 在 worktree 里新建它；以前这种路径被当成「不是 git 仓库」，目录会建在用户的 checkout 里。
- 合并冲突的 worktree（`blocked`）照样按 TTL 提醒，并且一直列在 Lead 当前局面的「等用户决定的事」里。用户自己合并、解决冲突以后马上清理。
- PR 检出先建行、马上绑定 Run，再 fetch。清理扫描跳过还在准备中的检出，并回收没有对应行的 `refs/plc/review/*`。
- PR 工单的核查者也在 PR head 的临时检出里核查。
- `git worktree add` 中途失败、留下的东西没有改动时（目录不在；或者是干净的、停在起点的 worktree；或者只有一个 `.git` 文件），下一个 Run 作废这一行，重新建一个。`git worktree add` 的超时从 10 秒改成 120 秒。
- 孤儿扫描不跟随符号链接。

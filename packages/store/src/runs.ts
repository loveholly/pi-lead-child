import type { Db } from "./db.js";
import { assertRunAllowed } from "./run-gate.js";
import { resolveWorkspace } from "./workspaces.js";
import type { Run, TypedFailure } from "@pi-lead-child/core";
import type { RootCause } from "@pi-lead-child/protocol";
import { failureNextStep, LOCAL_RUNTIME_ID, runFailure } from "@pi-lead-child/runtime";
import { appendEventGuarded, clipEventText } from "./events.js";
import type { LauncherIdentity } from "@pi-lead-child/runtime";
import type { OutputCursor } from "@pi-lead-child/runtime";

// Run 的终态集合。写成带类型的常量而不是每处一个字符串数组字面量：
// Array<string>.includes(x) 对任何字符串都成立，v16 把 settled/crashed 改成
// finished/failed 时，散落各处的字面量数组一个都不会报错，只会安静地把已结束的 Run
// 当成活的。这里给了类型，改名再漏就是编译错。
export const TERMINAL_RUN_STATES: readonly Run["state"][] = ["finished", "failed", "stopped"];

export function isTerminalRunState(state: Run["state"]): boolean {
  return TERMINAL_RUN_STATES.includes(state);
}

export function createRun(
  db: Db,
  args: {
    itemId: number; role?: "executor" | "reviewer"; workspaceId?: number;
    runtime?: Run["runtime"]; purpose?: Run["purpose"]; model?: string; effort?: string;
    resumedFromRunId?: number; runtimeProfileHash?: string;
  },
): number {
  const role = args.role ?? "executor";
  const purpose = args.purpose ?? (role === "reviewer" ? "review" : "execution");
  if (args.workspaceId !== undefined && args.workspaceId !== null) {
    const workspace = db.prepare(
      "SELECT state, kind, owner_item_id FROM workspaces WHERE id=?",
    ).get(args.workspaceId) as { state: string; kind: string; owner_item_id: number } | undefined;
    if (!workspace) throw new Error(`workspace ${args.workspaceId} not found`);
    if (["released", "cleaning", "cleaned", "archived", "failed", "blocked"].includes(workspace.state)) {
      throw new Error(`workspace ${args.workspaceId} is not attachable in state ${workspace.state}`);
    }
    const resolved = resolveWorkspace(db, args.itemId);
    const reviewerFork = role === "reviewer" && workspace.state !== "cleaned"
      && workspace.kind === "reviewer" && workspace.owner_item_id === args.itemId;
    if (!reviewerFork && (!resolved || resolved.workspace.id !== args.workspaceId)) {
      throw new Error(`workspace ${args.workspaceId} is not the resolved workspace for item #${args.itemId}`);
    }
  }
  // 闸门必须在这里、且看到与 INSERT 完全相同的 role/purpose 缺省值（spec §6.5）：
  // 各自算一遍缺省，reviewer 就会被按 executor 的 stage 集合校验。
  assertRunAllowed(db, { itemId: args.itemId, role, purpose });
  const r = db
    .prepare(
      `INSERT INTO runs (item_id, workspace_id, role, runtime, purpose, model, effort, resumed_from_run_id, runtime_profile_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.itemId,
      args.workspaceId ?? null,
      role,
      // 没有声明 runtime 的 Run 记成本地 runtime，和 runs.runtime 的 DDL 默认值一致。
      args.runtime ?? LOCAL_RUNTIME_ID,
      purpose,
      args.model ?? null,
      args.effort ?? null,
      args.resumedFromRunId ?? null,
      args.runtimeProfileHash ?? null,
    );
  return Number(r.lastInsertRowid);
}

// 先建好的 Run（派发 claim、工单对话）在启动时才定下 effort：补上，已有的不覆盖。
export function updateRunEffort(db: Db, runId: number, effort: string): void {
  db.prepare("UPDATE runs SET effort=? WHERE id=? AND effort IS NULL").run(effort, runId);
}

// 同一个 Run 换了模型和推理强度（工单 08）：pi 在跑时经 RPC 换，暂停的 Run 在继续时用新的。Run 上记的是现在的；
// 换之前用了多少、从什么换成什么，记在 run_profile_changed 这条活动里。
export function setRunModelAndEffort(db: Db, runId: number, profile: { model: string | null; effort: string | null }): void {
  db.prepare("UPDATE runs SET model=?, effort=? WHERE id=?").run(profile.model, profile.effort, runId);
}

// Run 由别处先创建时（工单对话、旧的派发请求）可能还没有 profile hash（工单 05）。执行时补上，已有的不覆盖。
export function recordRunProfileHash(db: Db, runId: number, hash: string): void {
  db.prepare("UPDATE runs SET runtime_profile_hash=? WHERE id=? AND runtime_profile_hash IS NULL").run(hash, runId);
}

export function getRun(db: Db, id: number): Run | undefined {
  return db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Run | undefined;
}

export function listRuns(db: Db, itemId: number): Run[] {
  return db.prepare(
    "SELECT * FROM runs WHERE item_id = ? ORDER BY id",
  ).all(itemId) as Run[];
}

export function activeRun(db: Db, itemId: number): Run | undefined {
  return db.prepare(
    `SELECT * FROM runs
     WHERE item_id = ? AND state IN ('starting','running')
     ORDER BY id DESC LIMIT 1`,
  ).get(itemId) as Run | undefined;
}

// 最近一次启动的、有外部 session 的 Run。恢复一个暂停的 Run 不新建 Run，只多记一条 attempt_start。
// 所以这里按 Run 最近一次 attempt_start 排，不按 Run 的 id 排：暂停期间的工单对话 Run id 更大，
// 可恢复以后的执行 Run 才是最近的进展。没有 attempt_start 的 Run 排在最后，彼此按 id 排。
export function latestSessionRun(db: Db, itemId: number): Run | undefined {
  return db.prepare(
    `SELECT r.* FROM runs r
     LEFT JOIN (
       SELECT run_id, MAX(id) AS last_start FROM activities
       WHERE item_id = ? AND kind = 'attempt_start'
       GROUP BY run_id
     ) starts ON starts.run_id = r.id
     WHERE r.item_id = ? AND r.external_session_id IS NOT NULL
     ORDER BY COALESCE(starts.last_start, 0) DESC, r.id DESC
     LIMIT 1`,
  ).get(itemId, itemId) as Run | undefined;
}

const RUN_STATE_TRANSITIONS: Record<Run["state"], readonly Run["state"][]> = {
  // Reviewer verdicts may settle a claimed-but-not-yet-started Run; the verdict operation
  // itself is the terminal evidence for that Run.
  starting: ["running", "finished", "failed", "stopped"],
  running: ["finished", "failed", "stopped", "paused"],
  paused: ["running", "stopped"],
  finished: [],
  failed: [],
  stopped: [],
};

export function transitionRunState(
  db: Db,
  id: number,
  to: Run["state"],
  patch: Omit<Parameters<typeof updateRun>[2], "state"> = {},
): void {
  const current = getRun(db, id);
  if (!current) throw new Error(`run ${id} not found`);
  if (current.state === to) {
    updateRun(db, id, { ...patch, state: to });
    return;
  }
  if (!RUN_STATE_TRANSITIONS[current.state].includes(to)) {
    throw new Error(`illegal run transition ${current.state} -> ${to} (run #${id})`);
  }
  updateRun(db, id, { ...patch, state: to });
}

export function markRunRunning(db: Db, id: number): void {
  transitionRunState(db, id, "running");
}

export function markRunFinished(
  db: Db, id: number, patch: Omit<Parameters<typeof updateRun>[2], "state"> = {},
): void {
  transitionRunState(db, id, "finished", { ...patch, endedAt: true });
}

export function markRunFailed(
  db: Db, id: number, patch: Omit<Parameters<typeof updateRun>[2], "state"> = {},
): void {
  transitionRunState(db, id, "failed", { ...patch, endedAt: true });
}

export function markRunStopped(
  db: Db, id: number, patch: Omit<Parameters<typeof updateRun>[2], "state"> = {},
): void {
  transitionRunState(db, id, "stopped", { ...patch, endedAt: true });
}

export function updateRun(
  db: Db,
  id: number,
  patch: {
    // 两个会话 id 给 null 时清空：会话已经不存在了（manager.ts 的 startFreshSession）。
    state?: Run["state"]; sessionId?: string | null; sessionPath?: string; pid?: number | null;
    model?: string; lastEntryCursor?: string; endedAt?: boolean;
    runtimeVersion?: string; externalSessionId?: string | null; eventCursor?: string;
    exitCode?: number | null; errorCode?: string | null; errorMessage?: string | null;
    failure?: TypedFailure | null;
    metadata?: Record<string, unknown>; costKnown?: boolean; eventLogDirty?: boolean;
    workspaceId?: number | null; pausedAt?: string | null; pausedMs?: number;
    launcher?: LauncherIdentity | null; outputCursor?: OutputCursor | null;
  },
): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.state) { sets.push("state = ?"); vals.push(patch.state); }
  if (patch.sessionId || patch.sessionId === null) { sets.push("session_id = ?"); vals.push(patch.sessionId); }
  if (patch.sessionPath) { sets.push("session_path = ?"); vals.push(patch.sessionPath); }
  if (patch.pid !== undefined) { sets.push("pid = ?"); vals.push(patch.pid); }
  if (patch.model) { sets.push("model = ?"); vals.push(patch.model); }
  if (patch.lastEntryCursor) { sets.push("last_entry_cursor = ?"); vals.push(patch.lastEntryCursor); }
  if (patch.runtimeVersion) { sets.push("runtime_version = ?"); vals.push(patch.runtimeVersion); }
  if (patch.externalSessionId || patch.externalSessionId === null) {
    sets.push("external_session_id = ?");
    vals.push(patch.externalSessionId);
  }
  if (patch.eventCursor) { sets.push("event_cursor = ?"); vals.push(patch.eventCursor); }
  if (patch.exitCode !== undefined) { sets.push("exit_code = ?"); vals.push(patch.exitCode); }
  if (patch.errorCode !== undefined) { sets.push("error_code = ?"); vals.push(patch.errorCode); }
  if (patch.errorMessage !== undefined) { sets.push("error_message = ?"); vals.push(patch.errorMessage); }
  if (patch.failure !== undefined) {
    sets.push("failure_scope = ?", "failure_retry = ?", "failure_needs = ?", "failure_code = ?", "failure_evidence = ?");
    const failure = patch.failure;
    vals.push(failure?.scope ?? null, failure?.retry ?? null, failure?.needs ?? null,
      failure?.code ?? null, failure?.evidence ?? null);
  }
  if (patch.metadata) { sets.push("metadata = ?"); vals.push(JSON.stringify(patch.metadata)); }
  if (patch.costKnown !== undefined) { sets.push("cost_known = ?"); vals.push(patch.costKnown ? 1 : 0); }
  if (patch.eventLogDirty !== undefined) { sets.push("event_log_dirty = ?"); vals.push(patch.eventLogDirty ? 1 : 0); }
  if (patch.workspaceId !== undefined) { sets.push("workspace_id = ?"); vals.push(patch.workspaceId); }
  if (patch.pausedAt !== undefined) { sets.push("paused_at = ?"); vals.push(patch.pausedAt); }
  if (patch.pausedMs !== undefined) { sets.push("paused_ms = ?"); vals.push(patch.pausedMs); }
  if (patch.launcher !== undefined) {
    sets.push("launcher = ?");
    vals.push(patch.launcher ? JSON.stringify(patch.launcher) : null);
  }
  if (patch.outputCursor !== undefined) {
    sets.push("output_cursor = ?");
    vals.push(patch.outputCursor ? JSON.stringify(patch.outputCursor) : null);
  }
  if (patch.endedAt) { sets.push("ended_at = datetime('now')"); }
  if (!sets.length) return;
  const update = db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`);
  if (!patch.state) {
    update.run(...vals, id);
    return;
  }
  // 状态变了：双写一条 Run 事件（Lead 事件主干，工单 01），和状态写入同一个事务。所有改状态的路径都经过这里
  // （transitionRunState、markRun*、pause/resume，以及 engine 里直接给 state 的 updateRun）。状态没变时不记。
  db.transaction(() => {
    const before = db.prepare("SELECT state, paused_at FROM runs WHERE id = ?").get(id) as
      { state: Run["state"]; paused_at: string | null } | undefined;
    update.run(...vals, id);
    if (before && before.state !== patch.state) recordRunStateEvent(db, id, before);
  })();
}

// Run 状态 → 事件类型。starting 只在创建时出现，不会是变化的目标。
function runEventKind(from: Run["state"], to: Run["state"]): string | null {
  if (to === "running") return from === "paused" ? "run.resumed" : "run.started";
  if (to === "paused" || to === "finished" || to === "failed" || to === "stopped") return `run.${to}`;
  return null;
}

// 失败的根因（spec D1）：有落库的类型化失败就用它，没有就按 error_code 和 error_message 兜底分类（runtime 的 runFailure）。
function runRootCause(run: Run): RootCause {
  const failure = runFailure(run);
  return {
    code: failure.code,
    scope: failure.scope,
    needs: failure.needs,
    retry: failure.retry,
    ...(failure.evidence ? { evidence: clipEventText(failure.evidence) } : {}),
    next_step: failureNextStep(run.runtime, failure),
    ...(run.error_message ? { message: clipEventText(run.error_message) } : {}),
  };
}

function recordRunStateEvent(db: Db, id: number, before: { state: Run["state"]; paused_at: string | null }): void {
  const run = getRun(db, id);
  if (!run) return;
  const kind = runEventKind(before.state, run.state);
  if (!kind) return;
  // 去重的编号（spec D2）：开始和三种结束每个 Run 只有一次；暂停和恢复可以有多次，用那一次暂停的时间区分。
  const sourceRef = kind === "run.paused" ? (run.paused_at ? `run:${id}:paused:${run.paused_at}` : null)
    : kind === "run.resumed" ? (before.paused_at ? `run:${id}:resumed:${before.paused_at}` : null)
    : `run:${id}:${kind.slice("run.".length)}`;
  // 事件出错（例如根因的分类函数抛错）不让 Run 状态的写入回滚（appendEventGuarded）。
  appendEventGuarded(db, () => ({
    source: "run",
    sourceRef,
    kind,
    entityKey: `run:${id}`,
    payload: {
      runId: id, itemId: run.item_id, role: run.role, purpose: run.purpose, runtime: run.runtime,
      from: before.state, to: run.state, exitCode: run.exit_code, errorCode: run.error_code,
    },
    ...(run.state === "failed" ? { rootCause: runRootCause(run) } : {}),
  }));
}

// 暂停 = 终止进程但保留 Run 行与 session（spec §3.2）：Run 是逻辑执行片段，不是操作系统进程。
// 恢复时复用同一行、同一 session、新 pid；跨 Run 的续跑（崩溃后重试）另有 resumed_from_run_id。
// 这两个函数不写 items：Item 与 Run 是两条独立生命周期，暂停期间 item 仍停在 active。
export function pauseRun(db: Db, id: number, at = new Date()): void {
  const row = db.prepare("SELECT state FROM runs WHERE id = ?").get(id) as
    { state: string } | undefined;
  if (!row) throw new Error(`run ${id} not found`);
  // 只有 running 可暂停（spec §6.3）。starting 不行：进程还没起来，此时用户要的是 stop 而非 pause。
  if (row.state !== "running") throw new Error(`cannot pause run in state ${row.state}`);
  transitionRunState(db, id, "paused", { pausedAt: at.toISOString(), pid: null });
}

export function resumeRun(db: Db, id: number, at = new Date()): void {
  const row = db.prepare("SELECT state, paused_at, paused_ms FROM runs WHERE id = ?").get(id) as
    { state: string; paused_at: string | null; paused_ms: number } | undefined;
  if (!row) throw new Error(`run ${id} not found`);
  if (row.state !== "paused") throw new Error(`cannot resume run in state ${row.state}`);
  // paused_at 缺失时把本次暂停记为 0 而不是从 started_at 起算：宁可少扣，也不要凭空
  // 造出一段长得离谱的暂停把 activeExecutionMs 抹成 0。
  const since = row.paused_at ? Date.parse(row.paused_at) : at.getTime();
  const delta = Math.max(0, at.getTime() - since);
  transitionRunState(db, id, "running", { pausedAt: null, pausedMs: row.paused_ms + delta });
}

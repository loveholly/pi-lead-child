// 工单和 Run 的生命周期操作：确认开跑、验收、返工、取消、派核查，以及 Run 的暂停、继续、停下。
//
// 以前它们只在网关的 user-actions.ts 里，一律以 actor='user' 落笔，Lead 没有对应的工具（防冒名）。
// 工单操作层（spec 5.11）要让 Lead 能在你这一轮里代你做，所以实现搬到这里，按「谁做的」（ActionAttribution）落笔：
//   - 你：actor=user，和以前一样。
//   - Lead 代你：actor=lead，带上 onBehalfOf=user 和授权的那一轮。权限矩阵按你查（store 的 transition），
//     不放宽成 lead 的固有权限。
//   - Lead 自己：actor=lead，只能做矩阵本来就允许 lead 做的事（例如停下一个 Run、取消没交付的工单）。
// 网关的 createUserActionService 转调这里（以你的名义），所以 HTTP、plc、「不是我」的撤销走的是同一份实现。
// 这里不发线上事件：调用方（网关的用户操作服务、工单操作层）各自在成功以后发一次。
import type { RuntimeDisabledBy, RuntimeId } from "@pi-lead-child/core";
import type { GrantLocalRepo } from "@pi-lead-child/protocol";
import type { RuntimeProfile } from "@pi-lead-child/runtime";
import type { Db } from "@pi-lead-child/store";
import {
  activeRun, addActivity, appendBody, createRun, getItem, getRun, isTerminalRunState, listRuns, markRunStopped,
  pauseRun as pauseRunRow, resumeRun as resumeRunRow, transition,
} from "@pi-lead-child/store";
import { liveChildren } from "../children/manager.js";
import { changeReviewer, suspendedReviewRuntime } from "../coordinator/change-reviewer.js";
import { createDispatcher } from "../coordinator/dispatch.js";
import type { FileOpener } from "../coordinator/file-opener.js";
import { reviewerProgress, unreviewedDelivery, verificationState } from "../coordinator/review-authority.js";
import { automaticReviewRuntime } from "../pipeline/automatic-review.js";
import { latestDeliveryRunId } from "../pipeline/delivery-run.js";
import { BY_USER, behalfCursor, behalfFields, transitionBy, type ActionAttribution } from "./attribution.js";
import { restoreItemTree, type ItemRestoreMode, type ItemRestoreResult } from "./restore.js";

export interface ResumeRunRequest {
  itemId: number;
  runId: number;
  sessionId: string | null;
}

// 宿主（daemon）注入的东西。恢复和开始要把进程拉起来，这一层不认识运行时；没注入就明确报错，
// 而不是安静地把状态改成 running 却没有进程——那比不能恢复更糟：UI 会显示在跑，实际什么都没有。
// 开始执行时点名的执行者（工单操作 start 的输入，Lead 的 spawn_child 给的）。不给的一项由系统选，和派发一样。
export interface StartRunOptions {
  runtime?: RuntimeId;
  model?: string;
  effort?: string;
}

export interface TicketActionHost {
  resumeRun?: (request: ResumeRunRequest) => void;
  // 拉起执行 agent（daemon 注入 Lead 的 spawnItemChild）。页面的「开始执行」和 Lead 的 spawn_child 都经过工单操作 start 调它。
  // 返回给人看的一句话（例如目标不可用时只排了派发请求）；没有时为 undefined。
  startRun?: (itemId: number, options?: StartRunOptions) => string | void;
  // 用户手动派发独立核查时用哪个 reviewer runtime。daemon 注入与 orchestrator 相同的配置；
  // 不注入时按选核查员的规则选（engine 的 reviewer-choice.ts）。
  reviewerRuntime?: RuntimeId;
  // 健康账本按哪个 profile 查核查员能不能用。daemon 注入派发 gate 用的同一个（childRuntimeProfile）。
  runtimeProfile?: (runtime: RuntimeId) => RuntimeProfile;
  // 还被一个 Run 占着的工单。不给时用本进程的 live 表；Lead 另外算上它自己正在拉起的 child。
  liveItemIds?: () => number[];
  // 放宽权限（widen_grant）时把本地仓库的名字解析成根目录。daemon 用候选仓库；不注入时本地仓库一律解析不了。
  resolveLocalRepo?: (name: string) => GrantLocalRepo | null;
  // 用默认程序打开交付里的文件（工单 07）。daemon 注入 systemFileOpener()，测试注入假的；不注入时打开文件不可用。
  openFile?: FileOpener;
  // 一个停用的执行器是谁停用的（工单 11 审查第 1 条）。daemon 注入 RuntimeSettings.disabledByForDelegation（config.json 的
  // runtimes.disabledBy；没有记录时为 null，当作用户停用的；读不出 config.json 时按 Lead 停用的算）。
  // 不注入时不知道是谁：D11 不把停用的执行器算作不能用。
  runtimeDisabledBy?: (runtime: RuntimeId) => RuntimeDisabledBy | null;
}

export interface ReviewRequestResult {
  dispatchRequestId: number;
  deliveryRunId: number;
}

export function liveItemIdsOf(host: TicketActionHost): number[] {
  return host.liveItemIds ? host.liveItemIds() : [...liveChildren().keys()];
}

// 终止一次 Run 的进程。落库交给调用方——pause 与 stop 要写的状态不同，
// 但"怎么把进程弄死"是同一件事。
async function killRunProcess(itemId: number, runId: number, reason: string): Promise<void> {
  const child = liveChildren().get(itemId);
  if (!child || child.runId !== runId) return;
  liveChildren().delete(itemId);
  if (child.handle) await child.handle.interrupt(reason);
  else child.proc?.kill();
}

function touchItemActivity(db: Db, itemId: number): void {
  db.prepare("UPDATE items SET last_activity_at=datetime('now'), updated_at=datetime('now') WHERE id=?")
    .run(itemId);
}

export function activeUserReworkDispatchRequest(db: Db, itemId: number): number | null {
  const row = db.prepare(
    `SELECT id FROM dispatch_requests
     WHERE item_id=? AND trigger='user-rework' AND state IN ('pending','claimed','started')
     ORDER BY id DESC LIMIT 1`,
  ).get(itemId) as { id: number } | undefined;
  return row?.id ?? null;
}

interface ReviewerVerdictRef {
  runId: number;
  verdict: "pass" | "fail";
  evidence: string;
}

// 只用当前有效的核查结论。返工续接最新的交付 Run，不续接用户提问的对话 Run（delivery-run.ts）。
function currentReviewerVerdict(db: Db, itemId: number): ReviewerVerdictRef | null {
  const current = verificationState(db, itemId).current;
  return current ? { runId: current.run_id, verdict: current.verdict, evidence: current.evidence } : null;
}

function textPayload(raw: string, keys: string[]): string | null {
  try {
    const parsed = JSON.parse(raw || "{}") as Record<string, unknown>;
    for (const key of keys) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  } catch {
    return null;
  }
  return null;
}

function recentLeadComments(db: Db, itemId: number): string[] {
  const rows = db.prepare(
    `SELECT payload FROM activities
     WHERE item_id=? AND kind='comment' AND actor='lead'
     ORDER BY id DESC LIMIT 3`,
  ).all(itemId) as Array<{ payload: string }>;
  return rows
    .map((row) => textPayload(row.payload, ["content", "text", "message"]))
    .filter((value): value is string => value !== null)
    .reverse();
}

function reworkContextSection(input: {
  reason: string;
  reviewer: ReviewerVerdictRef | null;
  leadComments: string[];
  previousExecutorRunId: number | null;
}): string {
  const lines = [
    "【用户返工请求】",
    `reason: ${input.reason}`,
    input.previousExecutorRunId === null
      ? "previous_executor_run: none"
      : `previous_executor_run: #${input.previousExecutorRunId}`,
  ];
  if (input.reviewer) {
    lines.push(
      `reviewer_run: #${input.reviewer.runId}`,
      `reviewer_verdict: ${input.reviewer.verdict}`,
      "reviewer_report:",
      input.reviewer.evidence,
    );
  } else {
    lines.push("reviewer_report: none (no current reviewer verdict for the latest delivery)");
  }
  if (input.leadComments.length > 0) {
    lines.push("lead_rework_notes:");
    for (const comment of input.leadComments) lines.push(`- ${comment}`);
  }
  return lines.join("\n");
}

/** 停掉一张工单上所有没结束的 Run。返回停掉的条数。 */
export async function stopItemRuns(db: Db, itemId: number, reason: string, by: ActionAttribution): Promise<number> {
  const open = listRuns(db, itemId).filter((run) => !isTerminalRunState(run.state));
  for (const run of open) {
    // 先落 stopped 再杀进程：ingest 的退出通路对 stopped 免疫，反过来会把主动停止记成一次 crash。
    markRunStopped(db, run.id);
    addActivity(db, {
      itemId, runId: run.id, actor: by.actor, kind: "decision", ...behalfCursor(by),
      payload: { decision: "停止执行", reason, ...behalfFields(by) },
    });
    await killRunProcess(itemId, run.id, reason);
  }
  return open.length;
}

/** 确认开跑（draft → ready）。诉求 3：这一步就是"建完先别跑"的另一半。只有走到这里，Run 闸门才放行。 */
export function confirmItem(db: Db, itemId: number, by: ActionAttribution, reason?: string): void {
  transition(db, {
    itemId, to: "ready", ...transitionBy(by),
    reason: reason ?? (by.actor === "user" ? "confirmed by user" : "confirmed by lead on behalf of user"),
  });
}

/** 验收（review → done）。 */
export function completeItem(db: Db, itemId: number, by: ActionAttribution, reason?: string): void {
  transition(db, {
    itemId, to: "done", ...transitionBy(by),
    reason: reason ?? (by.actor === "user" ? "accepted by user" : "accepted by lead on behalf of user"),
  });
}

/** 取消。工单上还没结束的 Run 一并停掉（spec §8），否则会留下一个跑着的 child 在为一件已经取消的事花钱。 */
export async function cancelItem(db: Db, itemId: number, reason: string, by: ActionAttribution): Promise<number> {
  transition(db, { itemId, to: "cancelled", ...transitionBy(by), reason });
  return stopItemRuns(db, itemId, `item cancelled: ${reason}`, by);
}

/**
 * 打回返工：在正文里追加返工请求，工单回到 active，排一条续接最新交付 Run 的派发请求。
 * delegationPolicyId：这次返工是授权时顺带启动的，属于那份授权，计入 Lead 的返工额度。手动返工不带它，不占额度。
 */
export function reworkItem(
  db: Db, itemId: number, reason: string, by: ActionAttribution, options: { delegationPolicyId?: number } = {},
): void {
  const item = getItem(db, itemId);
  if (!item) throw new Error(`item ${itemId} not found`);
  const existingRequestId = activeUserReworkDispatchRequest(db, itemId);
  if (existingRequestId !== null && item.stage === "active") {
    addActivity(db, {
      itemId, actor: by.actor, kind: "decision", ...behalfCursor(by),
      payload: { decision: "rework_request_replayed", dispatchRequestId: existingRequestId, reason, ...behalfFields(by) },
    });
    touchItemActivity(db, itemId);
    return;
  }
  // 只用当前有效的核查结论。过期的 FAIL 描述的是更早那次交付，把它当返工指令发出去，
  // executor 就会去修一个已经不存在的问题（#66：Run #43 的 FAIL 针对 Run #42，Run #49 已经交付）。
  const reviewer = currentReviewerVerdict(db, itemId);
  const previousExecutorRunId = latestDeliveryRunId(db, itemId);
  const leadComments = recentLeadComments(db, itemId);
  const idempotencyKey = `user-rework:${itemId}:${item.stage}:${item.stage_changed_at}`;
  db.transaction(() => {
    appendBody(db, itemId, reworkContextSection({ reason, reviewer, leadComments, previousExecutorRunId }));
    transition(db, { itemId, to: "active", ...transitionBy(by), reason });
    const requestId = createDispatcher(db).request({
      itemId,
      role: "executor",
      purpose: !item.purpose || item.purpose === "review" ? "execution" : item.purpose,
      // runtime 和模型不在这里点名：dispatcher 用工单上记着的 runtime（被用户停用时重新选），
      // 模型按 run-choice.ts 的规则跟着 runtime 走。点名了会让停用期间的返工挂起，没有工具能改派（2026-10-19 发布评审）。
      resumeFromRunId: previousExecutorRunId ?? undefined,
      instruction: reviewer
        ? `根据 reviewer 失败证据修复当前工单：${reviewer.evidence}`
        : `按用户的返工要求继续当前工单（基于 Run #${previousExecutorRunId ?? "-"} 的交付）：${reason}`,
      // 代你做的返工也是你的返工（权限按你查），所以和你点的一样记 user-rework。
      trigger: "user-rework",
      idempotencyKey,
    });
    addActivity(db, {
      itemId, actor: by.actor, kind: "decision", ...behalfCursor(by),
      payload: {
        decision: "rework_dispatch_requested",
        dispatchRequestId: requestId,
        idempotencyKey,
        reason,
        reviewerRunId: reviewer?.runId ?? null,
        reviewerVerdict: reviewer?.verdict ?? null,
        reviewerReport: reviewer?.evidence ?? null,
        previousExecutorRunId,
        leadReworkNotes: leadComments,
        ...(options.delegationPolicyId === undefined ? {} : { delegationPolicyId: options.delegationPolicyId }),
        ...behalfFields(by),
      },
    });
    touchItemActivity(db, itemId);
  }).immediate();
}

/**
 * 给最新的交付排一次独立核查（工单 #66）。不是 stage 的一条边：工单停在 review。
 * runtime：点名的核查员（2026-10-20）。给了，或者排着的核查被挂起了，就走 changeReviewer：有排着的核查就改它，没有就新排一条。
 */
export function requestReview(
  db: Db, host: TicketActionHost, itemId: number, by: ActionAttribution, options: { runtime?: RuntimeId; reason?: string } = {},
): ReviewRequestResult {
  const item = getItem(db, itemId);
  if (!item) throw new Error(`item ${itemId} not found`);
  const liveItemIds = liveItemIdsOf(host);
  const choice = host.runtimeProfile ? { profile: host.runtimeProfile } : {};
  // 挂起的核查以前让「派发独立核查」变灰，用户动不了（2026-10-20）。现在点「重新排核查」：原来的核查员还能用就留着它，
  // 只清掉挂起；不能用就换第一个能用的；一个能用的都没有时拒绝并写明原因（2026-10-21 审查 M4）。
  const suspended = reviewerProgress(db, itemId)?.state === "suspended";
  if (options.runtime || suspended) {
    const runtime = options.runtime ?? suspendedReviewRuntime(db, itemId, choice);
    const result = changeReviewer(db, itemId, runtime, {
      actor: by.actor, liveItemIds, ...choice, ...(options.reason ? { reason: options.reason } : {}),
      // 只点「重新排核查」时核查员是系统选的，不记成谁的选择。
      remember: options.runtime !== undefined,
    });
    if (result.deliveryRunId === null || result.dispatchRequestId === null) {
      throw new Error(`item #${itemId} has no unreviewed delivery to send to an independent reviewer`);
    }
    return { dispatchRequestId: result.dispatchRequestId, deliveryRunId: result.deliveryRunId };
  }
  // 判据与控制面投影的 canRequestReview 同源。没有缺口就拒绝：已有核查在路上、
  // 当前交付已经有有效结论，或者工单根本不在等核查——这时再派一次只会重复核查。
  const gap = unreviewedDelivery(db, item, { liveItemIds });
  if (!gap) {
    throw new Error(`item #${itemId} has no unreviewed delivery to send to an independent reviewer`);
  }
  const who = by.actor === "user" ? "user" : "lead";
  const keyPrefix = `${who}-review:${itemId}:delivery-run:${gap.deliveryRunId}:`;
  const prior = (db.prepare(
    "SELECT COUNT(*) AS n FROM dispatch_requests WHERE item_id=? AND idempotency_key LIKE ?",
  ).get(itemId, `${keyPrefix}%`) as { n: number }).n;
  return db.transaction(() => {
    const dispatchRequestId = createDispatcher(db).request({
      itemId,
      role: "reviewer",
      purpose: "review",
      runtime: automaticReviewRuntime(db, itemId, host.reviewerRuntime, choice),
      trigger: `${who}-review`,
      // 同一次交付允许再派：上一条请求失败或被取消后，缺口重新出现。
      idempotencyKey: `${keyPrefix}${prior + 1}`,
    });
    addActivity(db, {
      itemId, actor: by.actor, kind: "decision", ...behalfCursor(by),
      payload: {
        decision: `review_requested_by_${who}`, dispatchRequestId, deliveryRunId: gap.deliveryRunId,
        ...(options.reason ? { reason: options.reason } : {}), ...behalfFields(by),
      },
    });
    touchItemActivity(db, itemId);
    return { dispatchRequestId, deliveryRunId: gap.deliveryRunId };
  }).immediate();
}

/** 暂停一个在跑的 Run。工单的 stage 一个字都不动：Item 与 Run 是两条独立生命周期（spec §3.2）。 */
export async function pauseItemRun(db: Db, runId: number, by: ActionAttribution, at: Date = new Date()): Promise<void> {
  const run = getRun(db, runId);
  if (!run) throw new Error(`run ${runId} not found`);
  // 先落 paused（这一步会校验 running，非 running 直接抛），再杀进程。
  // 顺序不能反：进程先死，ingest 的退出事件会把它记成 crash——用户按了暂停，账本上却是一次崩溃。
  pauseRunRow(db, runId, at);
  addActivity(db, {
    itemId: run.item_id, runId, actor: by.actor, kind: "decision", ...behalfCursor(by),
    payload: { decision: "暂停执行", ...behalfFields(by) },
  });
  await killRunProcess(run.item_id, runId, by.actor === "user" ? "paused by user" : "paused by lead on behalf of user");
}

/** 让 Run 现在能不能恢复。不能时返回原因（和 resumeItemRun 拒绝时的话一样）。 */
export function runResumeBlocker(db: Db, runId: number): string | null {
  const run = getRun(db, runId);
  if (!run) return `run ${runId} not found`;
  if (run.state !== "paused") return `cannot resume run in state ${run.state}`;
  // 核查 Run 核查的是它开始时最新的那次交付。暂停以后又有了新的交付（例如返工），恢复它就是去核查一份已经不存在的成果，
  // 它的 PASS 在委托验收下还会把工单推到 done（发布评审 run-resume F2）。拒绝恢复，状态不动；新交付另派核查。
  if (run.role === "reviewer" && run.purpose === "review") {
    const latestDelivery = latestDeliveryRunId(db, run.item_id);
    if (latestDelivery !== null && latestDelivery > runId) {
      return `cannot resume run ${runId}: delivery run ${latestDelivery} is newer than this review; request a new review instead`;
    }
  }
  // 暂停期间，工单消息另起一个对话 Run 回答。它还在跑时恢复，同一张工单上就有两个 Run：runItem 拒绝第二个，
  // 兜底边界把恢复的 Run 记成失败，还会中断正在回答的对话。所以先拒绝，状态不动。两处都要看：
  // 库里的状态盖住 Run 进 live 表之前的准备阶段；live 表盖住收尾阶段，那时库里已是 finished，进程还在退出。
  const live = liveChildren().get(run.item_id);
  const busyRunId = activeRun(db, run.item_id)?.id ?? (live && live.runId !== runId ? live.runId : null);
  if (busyRunId !== null) {
    return `cannot resume run ${runId}: run ${busyRunId} of item ${run.item_id} is still in progress`;
  }
  return null;
}

/** 恢复一个暂停的 Run：复用同一行、同一 session、新 pid（spec §3.2）。 */
export async function resumeItemRun(
  db: Db, host: TicketActionHost, runId: number, by: ActionAttribution, at: Date = new Date(),
): Promise<void> {
  const run = getRun(db, runId);
  if (!run) throw new Error(`run ${runId} not found`);
  const blocker = runResumeBlocker(db, runId);
  if (blocker) throw new Error(blocker);
  if (!host.resumeRun) {
    throw new Error(`run ${runId} cannot be resumed: no runner is wired to this control plane`);
  }
  // 先把进程拉起来再翻状态？不行——resumeRun 是 fire-and-forget，翻状态必须同步完成，
  // 否则调用方读回来还是 paused。这里的顺序是"记账 → 拉起"，与 pause 对称。
  resumeRunRow(db, runId, at);
  try {
    host.resumeRun({ itemId: run.item_id, runId, sessionId: run.session_id });
  } catch (error) {
    // Run 不能按原样启动（例如闸门不放行）：它回到 paused，原因交给调用方。不留一个没有进程的 running。
    pauseRunRow(db, runId, at);
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot resume run ${runId}: ${reason}`, { cause: error });
  }
  addActivity(db, {
    itemId: run.item_id, runId, actor: by.actor, kind: "decision", ...behalfCursor(by),
    payload: { decision: "恢复执行", ...behalfFields(by) },
  });
}

/** 停下一个 Run。停止是终态，恢复不了。已经结束的 Run 什么都不做。 */
export async function stopItemRun(db: Db, runId: number, reason: string, by: ActionAttribution): Promise<void> {
  const run = getRun(db, runId);
  if (!run) throw new Error(`run ${runId} not found`);
  if (isTerminalRunState(run.state)) return;
  markItemRunStopped(db, runId, reason, by);
  await killRunProcess(run.item_id, runId, reason);
}

/**
 * 停下一个 Run 的账本部分：落 stopped，记一条活动，不碰进程。调用方要把它和别的写入放进同一笔事务时用它
 * （换模型时停下旧 Run 和排续接的请求，工单 08），事务提交以后再 killItemRunProcess。已经结束的 Run 什么都不做。
 */
export function markItemRunStopped(db: Db, runId: number, reason: string, by: ActionAttribution): void {
  const run = getRun(db, runId);
  if (!run) throw new Error(`run ${runId} not found`);
  if (isTerminalRunState(run.state)) return;
  markRunStopped(db, runId);
  addActivity(db, {
    itemId: run.item_id, runId, actor: by.actor, kind: "decision", ...behalfCursor(by),
    payload: { decision: "停止执行", reason, ...behalfFields(by) },
  });
}

/** 停掉一个已经落了 stopped 的 Run 的进程（markItemRunStopped 之后）。 */
export async function killItemRunProcess(itemId: number, runId: number, reason: string): Promise<void> {
  await killRunProcess(itemId, runId, reason);
}

/**
 * 开始执行（ready/blocked → active）。页面的「开始执行」和 Lead 的 spawn_child（执行者）都经过工单操作 start 走到这里，
 * 两边都调宿主的 startRun（ui-action-parity plan.md P03）。返回宿主给的一句话（例如只排了派发请求），没有时为 null。
 */
export function startItem(
  db: Db, host: TicketActionHost, itemId: number, by: ActionAttribution = BY_USER, options: StartRunOptions = {},
): string | null {
  const item = getItem(db, itemId);
  if (!item) throw new Error(`item ${itemId} not found`);
  // daemon 注入的 runner 自己负责通过统一闸门并完成 ready/blocked → active。
  // 必须先调用它：若 runtime/model/workdir 预检失败，工单应保持原状，而不是留下"active 但没有 Run"的假状态。
  if (host.startRun) {
    const note = host.startRun(itemId, options);
    addActivity(db, {
      itemId, actor: by.actor, kind: "decision", ...behalfCursor(by),
      payload: {
        decision: "开始执行",
        ...(options.runtime ? { runtime: options.runtime } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        ...behalfFields(by),
      },
    });
    return typeof note === "string" ? note : null;
  }
  // 没接派发器（测试、没有 daemon 的网关）时也要真的建出 Run（闸门在 createRun 里），而不是只改 stage：
  // 只改 stage 会让 hasRun 仍是 false，UI 上什么都不会出现。这条路没有进程，只给你本人用。
  if (by.actor !== "user") throw new Error(`item #${itemId} cannot be started: no runner is wired to this control plane`);
  if (item.stage === "ready" || item.stage === "blocked") {
    transition(db, { itemId, to: "active", actor: "user", reason: "started by user" });
  }
  createRun(db, { itemId, role: "executor", ...(options.runtime ? { runtime: options.runtime } : {}) });
  return null;
}

/**
 * 停下整张工单（active/blocked → ready）：停掉还没结束的 Run，工单回到待开始。页面的「停下」和 Lead 的 ticket_action
 * 都经过工单操作 stop 走到这里（用户 2026-10-22：Lead 也能停下整张工单，结果和页面一样回到 ready，不转 blocked）。
 * requestedInTurn：Lead 停的、但是用户在自己这一轮里让它停的，那一轮的编号（记在 stage 的变化上）。返回停掉的 Run 条数。
 */
export async function stopItem(
  db: Db, itemId: number, reason: string, by: ActionAttribution, options: { requestedInTurn?: string } = {},
): Promise<number> {
  const stopped = await stopItemRuns(db, itemId, reason, by);
  const item = getItem(db, itemId);
  if (item && (item.stage === "active" || item.stage === "blocked")) {
    transition(db, {
      itemId, to: "ready", ...transitionBy(by), reason,
      ...(options.requestedInTurn ? { requestedInTurn: options.requestedInTurn } : {}),
    });
  }
  return stopped;
}

/** 撤回确认（ready → draft）：待开始的工单回到草稿，要再确认才会开跑。 */
export function unconfirmItem(db: Db, itemId: number, by: ActionAttribution, reason?: string): void {
  transition(db, {
    itemId, to: "draft", ...transitionBy(by),
    reason: reason ?? (by.actor === "user" ? "unconfirmed by user" : "unconfirmed by lead on behalf of user"),
  });
}

/** 确认一条到点的提醒（fired → acked）。acked 是终态。 */
export function ackReminder(db: Db, itemId: number, by: ActionAttribution, reason?: string): void {
  transition(db, {
    itemId, to: "acked", ...transitionBy(by),
    reason: reason ?? (by.actor === "user" ? "acked by user" : "acked by lead on behalf of user"),
  });
}

/**
 * 恢复一张已取消的工单或提醒。提醒的状态机里没有 draft（spec §6.2），它回到 scheduled；工单走 restoreItemTree
 * （回到 draft，或者连同选中的子任务一起恢复）。提醒恢复时返回 null。
 */
export function restoreItem(
  db: Db, itemId: number, by: ActionAttribution,
  options: { mode?: ItemRestoreMode; childItemIds?: number[]; requestedBy?: string; reason?: string; now?: Date } = {},
): ItemRestoreResult | null {
  const item = getItem(db, itemId);
  if (!item) throw new Error(`item ${itemId} not found`);
  if (item.kind === "reminder") {
    transition(db, {
      itemId, to: "scheduled", ...transitionBy(by),
      reason: options.reason ?? (by.actor === "user" ? "restored by user" : "restored by lead on behalf of user"),
    });
    return null;
  }
  return restoreItemTree(db, {
    itemId,
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.childItemIds ? { childItemIds: options.childItemIds } : {}),
    requestedBy: options.requestedBy ?? (by.actor === "user" ? "user" : "lead on behalf of user"),
    sourceTurnId: by.actor === "lead" ? by.onBehalfOf?.sourceTurnId ?? null : null,
    by,
    ...(options.now ? { now: options.now } : {}),
  });
}

// ── 工单对话自己改了工作区：核查结论过期（工单 #66 release review 5，第二轮 N1/N2/N4，第三轮 F1/F4/F5）──
//
// 对话 Run（purpose=conversation）不是交付（delivery-run.ts），所以它不会让核查结论过期。
// 但它能改代码：用户在对话里说"顺手把这里改一下"，agent 就改了。之后卡片仍然写着
// "核查通过，等你验收"，而通过的那份成果已经不在了。
//
// 只量这个 Run 自己的影响（第二轮 N1）。第一版拿当前工作区和 reviewer 结束时的哈希比，于是核查之后
// 工作区里的任何变化都算在对话头上：共用工作区的其他工单、用户自己的改动、测试缓存、一次提交。
// 一个只读的问题也能让 PASS 过期。现在：
//   · Run 启动之前，在这个 Run 自己的工作区上算一次指纹（workspace-tree-hash.ts）；结束之后再算一次。
//     两次不一样，才算这个 Run 改了工作区。
//   · 启动前的指纹会推迟对话开始，只给它几秒（F4）；超时就跳过这次检查，不让结论过期。
//   · 启动前的指纹记在一条活动里（F5）：daemon 重启后接管的 Run 没有内存里的记录，照样能比。
//     没有记录（例如部署之前启动的 Run）时，按明确改文件的工具判断。
//   · 结束后的指纹在 Run 释放之后才算（F1）：算指纹期间用户再发一句话、或点"开始执行"，不会撞上
//     "已有 child 在运行"。这时开始的新 Run 不影响这次记录（第四轮）：新 Run 启动前的指纹已经包含了
//     这次的改动，它自己量不出来，这里不记，PASS 就一直挂着。新 Run 也不会被冤枉：结论只在
//     "结论的 Run 不晚于边界"时过期（review-authority.ts 的 verificationState），更新的核查不受这条记录影响。
//   · 写之前再看一次：工单仍停在 review、仍是同一条当前结论（F1）。
//   · 工作区没有路径时，退一步看这个 Run 有没有用过明确改文件的工具（N4）。
//   · 指纹算不出来或超时：不判定改过，每个 Run 最多记一条失败活动（N2、F4）。
//   · 只在工单停在 review、而且有当前有效的结论时才量（N2）。done、cancelled 的工单从不检查：
//     结论在那里过期，会把旧的失败证据翻回来，给一张已经结束的工单加上派生的 attention
//     （违反 AGENTS.md 的第一条内核不变量）。
// 改过时记一条 decision 活动，review-authority.ts 的 verificationBoundaryRunId 读它。
// 要求独立核查的工单，在同一笔事务里重新排一次自动核查（automatic-review.ts）。否则结论过期以后
// 没有人来核查，卡片写着"独立核查未派发"，要用户手动派发。
import type { Db } from "@pi-lead-child/store";
import { addActivity, getItem, itemUpdatedEvent, publishGatewayEvents } from "@pi-lead-child/store";
import type { RunPurpose, RuntimeId } from "@pi-lead-child/core";
import { createDispatcher } from "../coordinator/dispatch.js";
import { WORKSPACE_CHANGED_AFTER_REVIEW, verificationState } from "../coordinator/review-authority.js";
import {
  automaticReviewNeededAfterWorkspaceChange, automaticReviewRuntime, workspaceChangeReviewRequest,
} from "./automatic-review.js";
import { workspaceTreeHash, type WorkspaceTreeHashOptions } from "./workspace-tree-hash.js";

// 明确改文件的工具（pi、Claude Code、Codex 的工具名，小写比较）。shell 工具（bash、shell、
// exec_command、command_execution）不算：跑测试、git status、cat 都是 shell，算进去一个只读的问题
// 也会让结论过期（N4）。代价是一个漏判：agent 用 shell 改了文件，这里看不到。
// 另一个漏判：Codex 的 file_change 不产生 runtime 事件（runtime/codex.ts 只发命令执行和 MCP 调用）。
const FILE_EDIT_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit", "apply_patch", "file_change"]);

export const WORKSPACE_CHANGE_CHECK_STARTED = "workspace_change_check_started";
export const WORKSPACE_CHANGE_CHECK_FAILED = "workspace_change_check_failed";

// 启动前的指纹推迟对话开始：只给几秒。结束后的指纹在 Run 释放之后才算，可以多给一些时间。
const PRE_RUN_BUDGET_MS = 3_000;
const POST_RUN_BUDGET_MS = 30_000;

export interface ConversationWorkspaceCheck {
  itemId: number;
  runId: number;
  /** 量的时候当前有效的那条结论。 */
  reviewerRunId: number;
  /** 这个 Run 自己的工作区；没有时按工具判断。 */
  path: string | null;
  /** 启动前的指纹；path 为 null 时也为 null。 */
  before: string | null;
}

type TreeHash = (path: string, options: WorkspaceTreeHashOptions) => Promise<string>;

let treeHash: TreeHash = workspaceTreeHash;

/** 测试用：换掉指纹函数，例如让它卡住或失败。不传参数时恢复默认。 */
export function setWorkspaceTreeHashForTesting(hash?: TreeHash): void {
  treeHash = hash ?? workspaceTreeHash;
}

// 还在后台算的检查。测试可以等它们。
const pendingChecks = new Set<Promise<unknown>>();

/** 等后台还在算的对话工作区检查都结束。 */
export async function conversationWorkspaceChecksSettled(): Promise<void> {
  while (pendingChecks.size > 0) await Promise.allSettled([...pendingChecks]);
}

/** 工单停在 review、有当前有效的结论时，返回那条结论的 reviewer Run。 */
function currentReviewUnderReview(db: Db, itemId: number): number | null {
  if (getItem(db, itemId)?.stage !== "review") return null;
  return verificationState(db, itemId).current?.run_id ?? null;
}

function fileEditToolsUsed(db: Db, runId: number): string[] {
  const names = db.prepare(
    `SELECT DISTINCT json_extract(payload, '$.name') AS name FROM runtime_events
     WHERE run_id=? AND event_type='tool.started'`,
  ).all(runId) as Array<{ name: string | null }>;
  return names.map((row) => row.name ?? "").filter((name) => FILE_EDIT_TOOLS.has(name.toLowerCase())).sort();
}

function errorText(error: unknown): string {
  return String(error instanceof Error ? error.message : error).split(/\r?\n/)[0]!.slice(0, 300);
}

function checkActivity(db: Db, runId: number, decision: string): Record<string, unknown> | null {
  const row = db.prepare(
    `SELECT payload FROM activities
     WHERE run_id=? AND kind='decision' AND json_extract(payload, '$.decision')=?
     ORDER BY id DESC LIMIT 1`,
  ).get(runId, decision) as { payload: string } | undefined;
  return row ? JSON.parse(row.payload) as Record<string, unknown> : null;
}

// 量不出来就不判定改过。记下来，排查时看得到为什么这次没有比对。每个 Run 最多一条。
function recordCheckFailure(
  db: Db,
  input: { itemId: number; runId: number; reviewerRunId: number; path: string | null; error: unknown },
): void {
  if (checkActivity(db, input.runId, WORKSPACE_CHANGE_CHECK_FAILED)) return;
  addActivity(db, {
    itemId: input.itemId, runId: input.runId, actor: "system", kind: "decision",
    payload: {
      decision: WORKSPACE_CHANGE_CHECK_FAILED, reviewerRunId: input.reviewerRunId, path: input.path,
      error: errorText(input.error),
    },
  });
}

// 指纹函数自己也有时限；这里再套一层，防止它不守时限。
async function hashWithin(path: string, budgetMs: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      treeHash(path, { timeoutMs: budgetMs }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`workspace hash timed out after ${budgetMs}ms`)), budgetMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 对话 Run 启动之前调用。不需要量、或者启动前的指纹没算出来时返回 null（这次不检查）。 */
export async function beginConversationWorkspaceCheck(
  db: Db,
  input: { itemId: number; runId: number; purpose: RunPurpose; path: string | null },
  options: { budgetMs?: number } = {},
): Promise<ConversationWorkspaceCheck | null> {
  if (input.purpose !== "conversation") return null;
  const reviewerRunId = currentReviewUnderReview(db, input.itemId);
  if (reviewerRunId === null) return null;
  let before: string | null = null;
  if (input.path) {
    try {
      before = await hashWithin(input.path, options.budgetMs ?? PRE_RUN_BUDGET_MS);
    } catch (error) {
      recordCheckFailure(db, { ...input, reviewerRunId, error });
      return null;
    }
  }
  const check: ConversationWorkspaceCheck = {
    itemId: input.itemId, runId: input.runId, reviewerRunId, path: input.path, before,
  };
  // 记下启动前的指纹：daemon 重启后接管这个 Run 时从这里读回（loadConversationWorkspaceCheck）。
  addActivity(db, {
    itemId: input.itemId, runId: input.runId, actor: "system", kind: "decision",
    payload: { decision: WORKSPACE_CHANGE_CHECK_STARTED, reviewerRunId, path: input.path, before },
  });
  return check;
}

/**
 * 接管的对话 Run（daemon 重启、或正常停机时分离）没有内存里的记录：从启动时记下的活动读回。
 * 没有记录、但工单仍在 review 且有当前结论时，按明确改文件的工具判断。启动前就没量成功的，不检查。
 */
export function loadConversationWorkspaceCheck(
  db: Db,
  input: { itemId: number; runId: number; purpose: RunPurpose },
): ConversationWorkspaceCheck | null {
  if (input.purpose !== "conversation") return null;
  if (checkActivity(db, input.runId, WORKSPACE_CHANGE_CHECK_FAILED)) return null;
  const started = checkActivity(db, input.runId, WORKSPACE_CHANGE_CHECK_STARTED);
  if (started) {
    return {
      itemId: input.itemId,
      runId: input.runId,
      reviewerRunId: Number(started.reviewerRunId),
      path: typeof started.path === "string" ? started.path : null,
      before: typeof started.before === "string" ? started.before : null,
    };
  }
  const reviewerRunId = currentReviewUnderReview(db, input.itemId);
  return reviewerRunId === null
    ? null
    : { itemId: input.itemId, runId: input.runId, reviewerRunId, path: null, before: null };
}

// 这条检查此刻还算数吗：工单仍停在 review、仍是同一条当前结论。
function stillApplies(db: Db, check: ConversationWorkspaceCheck): boolean {
  return currentReviewUnderReview(db, check.itemId) === check.reviewerRunId;
}

/**
 * 结论刚过期：要求独立核查的工单重新排一次自动核查，核查改过的工作区。在记下改动的那笔事务里调用，
 * 判断和排队之间插不进别的写：几次对话、或者别的路径同时排核查，同一次交付也只排一条。
 * 排不上时只留一条记录，不撤销过期的记录：卡片照实写"独立核查未派发"，用户可以手动派发。
 */
function requestReviewAfterWorkspaceChange(
  db: Db,
  check: ConversationWorkspaceCheck,
  reviewerRuntime: RuntimeId | undefined,
): void {
  const item = getItem(db, check.itemId);
  if (!item || !automaticReviewNeededAfterWorkspaceChange(db, item)) return;
  try {
    // 内层事务是一个 savepoint：排队写到一半失败时，只撤销排队这一段。
    db.transaction(() => {
      createDispatcher(db).request(
        workspaceChangeReviewRequest(check.itemId, check.runId, automaticReviewRuntime(db, check.itemId, reviewerRuntime)),
      );
    })();
  } catch (error) {
    addActivity(db, {
      itemId: check.itemId, runId: check.runId, actor: "system", kind: "decision",
      payload: { decision: "automatic_review_request_failed", error: errorText(error) },
    });
  }
}

/** 对话 Run 结束之后调用。这个 Run 自己改了工作区时记一条活动，返回 true。 */
export async function finishConversationWorkspaceCheck(
  db: Db,
  check: ConversationWorkspaceCheck | null,
  options: { budgetMs?: number; reviewerRuntime?: RuntimeId } = {},
): Promise<boolean> {
  if (!check || !stillApplies(db, check)) return false;
  let change: Record<string, unknown>;
  if (check.path === null || check.before === null) {
    const tools = fileEditToolsUsed(db, check.runId);
    if (tools.length === 0) return false;
    change = { method: "file_edit_tools", tools };
  } else {
    let after: string;
    try {
      after = await hashWithin(check.path, options.budgetMs ?? POST_RUN_BUDGET_MS);
    } catch (error) {
      recordCheckFailure(db, { ...check, error });
      return false;
    }
    if (after === check.before) return false;
    change = { method: "workspace_hash", path: check.path, before: check.before, after };
  }
  // 算指纹期间情况可能变了（用户验收了、新的核查替换了结论）：写之前在同一笔事务里再看一次。
  const recorded = db.transaction(() => {
    if (!stillApplies(db, check)) return false;
    addActivity(db, {
      itemId: check.itemId,
      runId: check.runId,
      actor: "system",
      kind: "decision",
      payload: { decision: WORKSPACE_CHANGED_AFTER_REVIEW, reviewerRunId: check.reviewerRunId, ...change },
    });
    requestReviewAfterWorkspaceChange(db, check, options.reviewerRuntime);
    return true;
  }).immediate();
  // 卡片的核查状态变了：结论过期了，也可能排上了新的核查。Run 结束时发的那条更新早于这里。
  if (recorded) publishGatewayEvents(db, [itemUpdatedEvent(check.itemId)]);
  return recorded;
}

/**
 * Run 释放以后，在后台跑 finishConversationWorkspaceCheck（F1）：算指纹期间工单不算"有 child 在运行"。
 * 出错只记一条失败活动，不往外抛。reviewerRuntime：结论过期后重新排的核查用哪个 runtime。
 */
export function scheduleConversationWorkspaceCheck(
  db: Db,
  check: ConversationWorkspaceCheck | null,
  options: { reviewerRuntime?: RuntimeId } = {},
): void {
  if (!check) return;
  const pending = finishConversationWorkspaceCheck(db, check, options).catch((error) => {
    try { recordCheckFailure(db, { ...check, error }); } catch { /* 库已经关了：没有地方可记。 */ }
  });
  pendingChecks.add(pending);
  void pending.finally(() => pendingChecks.delete(pending));
}

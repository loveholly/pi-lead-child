// ── 自动独立核查：一次交付进入 review 后，由谁、按什么条件请求 reviewer ──────────
//
// 以前只有 orchestrator 在收尾派发认领（dispatch claim）时请求自动核查。用户点「开始执行」
// 或「重试」时，daemon 直接启动 child，不经过派发队列，也就没有认领可收尾——工单 #66 的
// Run #49 就是这样进了 review，然后再也没有 reviewer 来。
//
// 现在两条路共用这里的条件和幂等键：
//   · orchestrator 收尾认领时照旧请求；
//   · child manager 在每个 Run 的生命周期结束时也请求一次（不管 Run 是怎么启动的）。
// 同一个 Run 两边都请求时，幂等键相同，dispatcher 只建一条请求。
//
// 这条规则只在 Run 结束的那一刻生效，不扫描历史：已经卡在 review、从来没被核查过的旧工单
// 不会被自动补派（启动修复必须有界）。它们由控制面投影成"独立核查未派发"，交给用户决定。
//
// 还有一个时刻：工单对话改了被核查的工作区，结论过期（review-currency.ts）。对话不是交付，
// 但核查过的成果已经变了。要求独立核查的工单在记下改动的那一刻重新排一次核查，条件相同。
import type { Item, Run, RuntimeId } from "@pi-lead-child/core";
import type { Db } from "@pi-lead-child/store";
import { reviewerInFlight } from "../coordinator/review-authority.js";
import { runtimeDisplayName } from "@pi-lead-child/runtime";
import type { DispatchRequestInput } from "../coordinator/dispatch.js";
import {
  pickReviewRuntime, reviewerOptions, reviewerUnavailableReason, reviewRequestRuntime, type ReviewerChoiceOptions,
} from "../coordinator/reviewer-choice.js";

export function automaticReviewKey(itemId: number, runId: number): string {
  return `automatic-review:${itemId}:executor-run:${runId}`;
}

/**
 * 工单要求独立核查：verification_policy 是 independent_reviewer。
 * 以前 items 上旧的 automatic 策略单独也算；v56（工单 09，D12）把它并进了 verification_policy，代码不再读那一列。
 */
export function requiresIndependentReview(item: Pick<Item, "verification_policy">): boolean {
  return item.verification_policy === "independent_reviewer";
}

/**
 * 这个 Run 结束后要不要请求自动核查。
 *
 * - 只看 executor：reviewer 自己的结束不会再请求一次核查。
 * - integration 不在其中：父工单集成之后的验收有自己的路径（与 orchestrator 原有条件相同）。
 * - conversation 不在其中：用户在工单里提问不是交付，不能触发一轮核查。对话改了被核查的工作区时，
 *   由 review-currency.ts 在记下改动时另排（automaticReviewNeededAfterWorkspaceChange）。
 * - outcome_repair 在其中：修复回合补交了成果、把工单推进 review 时，需要有人核查这份成果。
 */
export function automaticReviewDue(
  item: Pick<Item, "stage" | "verification_policy">,
  run: Pick<Run, "role" | "purpose" | "state">,
): boolean {
  return run.role === "executor"
    && run.purpose !== "integration"
    && run.purpose !== "conversation"
    && run.state === "finished"
    && item.stage === "review"
    && requiresIndependentReview(item);
}

/**
 * 现在要不要排这次自动核查：automaticReviewDue 成立，而且还没有核查在路上。
 * 同一次交付只排一条核查（release review 7）：manager 收尾时先关工具桥，这时工单已经不在
 * live 表里，用户可能已经点了"派发独立核查"；再排一条，两个 reviewer 会核查同一份成果。
 */
export function automaticReviewNeeded(
  db: Db,
  item: Pick<Item, "id" | "stage" | "verification_policy">,
  run: Pick<Run, "role" | "purpose" | "state">,
): boolean {
  return automaticReviewDue(item, run) && !reviewerInFlight(db, item.id);
}

/**
 * 工单对话改了被核查的工作区、结论刚过期时，要不要重新排一次自动核查。
 * 和交付结束时同一条规则：工单停在 review、要求独立核查、还没有核查在路上（同一次交付只排一条）。
 * 由用户验收的工单不排：过期的结论留给用户，用户可以手动派发核查。
 */
export function automaticReviewNeededAfterWorkspaceChange(
  db: Db,
  item: Pick<Item, "id" | "stage" | "verification_policy">,
): boolean {
  return item.stage === "review" && requiresIndependentReview(item) && !reviewerInFlight(db, item.id);
}

/**
 * 这张工单的这次核查用哪个 runtime：调用方显式给的 override（测试、daemon 的 reviewerRuntime）照用；
 * 没有时用工单的核查员（reviewer-choice.ts 的 reviewRequestRuntime，工单 09）：Lead 或用户选好的；没选时按
 * PLC_REVIEW_RUNTIME → 能做可执行只读核查的 → 其余的顺序选，跳过停用的和有故障的，优先选和执行者不同的 runtime（D3）。
 */
export function automaticReviewRuntime(
  db: Db,
  itemId: number,
  override?: RuntimeId,
  options: ReviewerChoiceOptions = {},
): RuntimeId {
  return override ?? reviewRequestRuntime(db, itemId, options);
}

export type ReviewerAvailability =
  | { available: true; runtime: RuntimeId }
  | { available: false; runtime: RuntimeId; reason: string };

/**
 * 现在能不能派出一次独立核查（2026-10-19，工单 #88、#89、#92、#93、#98）。
 *
 * 核查用的 runtime 按 reviewer-choice.ts 选。它会跳过停用的和有故障的 runtime，所以派不出去只有一种情况：
 * 一个能用的核查员都没有（2026-10-20 起任何 runtime 都能当核查员）。这时核查请求由派发 gate 挂起，直到有一个恢复。
 * 委托验收靠核查结论，所以委托前要问这一句（delegationPreflight），不能等请求挂起以后才发现。
 */
export function reviewerAvailability(db: Db, override?: RuntimeId): ReviewerAvailability {
  const runtime = override ?? pickReviewRuntime(db);
  const reason = reviewerUnavailableReason(db, runtime);
  if (reason === null) return { available: true, runtime };
  if (override) {
    return { available: false, runtime, reason: `核查用的 ${runtimeDisplayName(runtime)} 现在不可用：${reason}` };
  }
  const why = reviewerOptions(db).map((option) => `${option.displayName}：${option.reason ?? "可用"}`).join("；");
  return { available: false, runtime, reason: `没有能用的核查员（${why}）。` };
}

export function automaticReviewRequest(
  itemId: number,
  runId: number,
  runtime: RuntimeId,
): DispatchRequestInput {
  return {
    itemId,
    role: "reviewer",
    purpose: "review",
    runtime,
    trigger: "automatic-review",
    idempotencyKey: automaticReviewKey(itemId, runId),
  };
}

/**
 * 工单对话改了工作区以后的自动核查。键里写着那个对话 Run：一次对话最多排一条。
 * 它核查的交付由 dispatcher 记在 dispatch_requested 活动里（reviewDeliveryRunId），仍是对话之前那次交付。
 */
export function workspaceChangeReviewRequest(
  itemId: number,
  conversationRunId: number,
  runtime: RuntimeId,
): DispatchRequestInput {
  return {
    itemId,
    role: "reviewer",
    purpose: "review",
    runtime,
    trigger: "automatic-review",
    idempotencyKey: `automatic-review:${itemId}:conversation-run:${conversationRunId}`,
  };
}

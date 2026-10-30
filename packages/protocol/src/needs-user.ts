// 「需要你」的唯一规则。会话底栏、收件箱、导航角标和 Lead 的 list_needs_user 工具都用它，
// 所以这几处的数字和名单总是一样（Core Invariants：每个界面都从同一个 TicketSummary 推导当前状态）。
//
// 实例上曾经是底栏 3、收件箱 4、Lead 说 5：三处各写了一个判断。底栏不看 reviewState，
// 漏了"独立核查未派发"的 #66；底栏和收件箱都只看根工单，漏了父工单已完成、自己还阻塞着的子工单 #75。
//
// 范围是所有工单：子工单和后台工单需要你时也算。列表照样只列根工单，外加需要你的那些。
import type { TicketSummary } from "./index.ts";

export type TicketNeedsUserReason =
  // 有待你批准的审批。
  | "approval"
  // 工单阻塞、执行失败，或者有没处理的 blocker。
  | "blocked"
  // 有等你回答的决策请求（Lead 的决定卡或 agent 的决策请求）；或者核查不通过、证据冲突、返工用尽，要你决定下一步。
  | "decision"
  // 交付进了 review，没有任何独立核查会来（#66）。要你派发核查或直接验收。
  | "review_dispatch"
  // 交付等你验收（由你验收的工单，或者核查已经通过）。
  | "acceptance"
  // Run 很久没有动静。
  | "stalled"
  // 续作在等一个还没部署的能力。
  | "capability"
  // Lead 建的草稿，等你确认才会开始。
  | "confirmation";

const LABELS: Record<TicketNeedsUserReason, string> = {
  approval: "待审批",
  blocked: "需介入",
  decision: "待你决定",
  review_dispatch: "核查未派发",
  acceptance: "待验收",
  stalled: "停滞",
  capability: "等待能力",
  confirmation: "待确认",
};

const TERMINAL: ReadonlySet<TicketSummary["stage"]> = new Set(["done", "cancelled", "acked"]);

// 系统正在自己恢复这次 Run：恢复期间工单可能还停在 blocked，留着 blocker，但不是在等你。
// 恢复失败时 executionState 是 failed，那时才算。
function recovering(ticket: TicketSummary): boolean {
  const execution = ticket.executionState;
  return execution?.kind === "recovery"
    && (execution.state === "requested" || execution.state === "waiting_dispatch"
      || execution.state === "starting" || execution.state === "running");
}

/**
 * 这张工单现在是否在等用户做事；在等时返回原因，否则返回 null。
 *
 * 终态（done、cancelled、acked）一律不算：派生出来的审批、blocker、运行状态都不能盖过 stage。
 * 系统正在自动恢复时不算（审批除外）：恢复失败才轮到你。
 * 已触发的提醒不算：提醒本身已经送到，确认它只是收尾，没有工作在等它。
 * 不阻塞的决策请求不算：工作在继续，阻塞的决策请求本来就是一条 blocker。
 */
export function ticketNeedsUser(ticket: TicketSummary): TicketNeedsUserReason | null {
  if (TERMINAL.has(ticket.stage)) return null;
  if (ticket.attention.pendingApprovalCount > 0) return "approval";
  // 等你回答的决策请求：和审批一样，自动恢复、Lead 处理中、阻塞和核查状态都盖不过它（2026-10-16，
  // 收件箱写「派发独立核查」、决定卡问「并入 #72 / 再返工 / 取消」，说的不是同一件事）。
  if ((ticket.attention.pendingDecisionCount ?? 0) > 0) return "decision";
  if (recovering(ticket)) return null;
  // Lead 正在处理这张工单上的异常：阻塞和失败先不算「需要你」（2026-10-15 用户决定：除非需要用户介入，
  // UI 只给弱反馈）。Lead 处理完了还阻塞着、或者升级给了用户（blockerCount），又算回来。
  const leadHandling = ticket.attention.leadHandling === true && ticket.attention.blockerCount === 0;
  if (!leadHandling && (ticket.stage === "blocked" || ticket.runtime.state === "blocked"
    || ticket.executionState?.state === "blocked" || ticket.executionState?.state === "failed")) {
    return "blocked";
  }
  if (ticket.attention.blockerCount > 0) return "blocked";
  const review = ticket.reviewState;
  if (review?.state === "review_failed" || review?.state === "evidence_conflict" || review?.state === "rework_exhausted") {
    return "decision";
  }
  if (review?.state === "independent_review" && review.canRequestReview === true) {
    // 核查挂起（没有能用的核查员）时也能重新派，换一个核查员。但它派过了，只是现在没人能做，不是「核查未派发」（2026-10-21）。
    return review.reviewProgress === "suspended" ? "blocked" : "review_dispatch";
  }
  if (review?.state === "waiting_user" || review?.state === "review_passed") return "acceptance";
  if (ticket.runtime.state === "stale") return "stalled";
  if (ticket.workflowState === "waiting_capability") return "capability";
  if (ticket.stage === "draft") return "confirmation";
  return null;
}

export function ticketNeedsUserLabel(reason: TicketNeedsUserReason): string {
  return LABELS[reason];
}

/** 需要用户的工单，保持传入的顺序。 */
export function ticketsNeedingUser<T extends TicketSummary>(tickets: readonly T[]): T[] {
  return tickets.filter((ticket) => ticketNeedsUser(ticket) !== null);
}

// 「现在轮到谁」的唯一规则。工单分组、会话底栏、导航角标、项目计数都用它，所以「在执行」在哪里都是同一个数。
//
// 实例上（2026-10-15）工单 tab 写「进行中 6」，会话底栏写「执行中 0」：列表把 ready 算成在跑，
// 底栏只看 active 加运行中的 Run。那 6 张都是 ready、没有任何 Run 的工单。
//
// 按顺序判断：
//   ended    终态（done、cancelled、acked）。派生信号不能盖过 stage。
//   user     ticketNeedsUser 给出了原因。两条规则永远一致：user ⇔ needsUser 非空。
//   running  有 Run 在启动或运行；派发已经发出（含自动恢复）；独立核查在排队或在跑。
//   lead     下一步归 Lead 或系统，但现在没有东西在跑：后台工单（例如系统建的学习工单）；
//            Lead 正在处理的异常（leadHandling，没有升级给你）；停在 review、不等你的工单
//            （核查还没派发或被挂起）；Lead 在续作。
//   queued   其余：没有人在推进，例如 ready 但没有 Run、等别的工单。
// 提醒不是工作：未结束的提醒一律是 queued，已触发的提醒由收件箱单独处理。
export type TicketTurn = "ended" | "user" | "running" | "lead" | "queued";

const DISPATCHED: ReadonlySet<NonNullable<TicketSummary["executionState"]>["state"]> = new Set([
  "requested", "waiting_dispatch", "starting", "running",
]);

export function ticketTurn(ticket: TicketSummary): TicketTurn {
  if (TERMINAL.has(ticket.stage)) return "ended";
  if (ticket.kind === "reminder") return "queued";
  if (ticketNeedsUser(ticket) !== null) return "user";
  if (ticket.runtime.state === "starting" || ticket.runtime.state === "running") return "running";
  if (ticket.executionState && DISPATCHED.has(ticket.executionState.state)) return "running";
  const reviewProgress = ticket.reviewState?.reviewProgress;
  if (reviewProgress === "queued" || reviewProgress === "running") return "running";
  if (ticket.worklistVisibility === "background") return "lead";
  // Lead 正在处理这张工单上的异常、也没有升级给你（和 ticketNeedsUser 同一个判据）。
  if (ticket.attention.leadHandling === true && ticket.attention.blockerCount === 0) return "lead";
  // review 只有两种下一步：你决定，或者系统核查。不等你，就是系统的。
  if (ticket.stage === "review" || ticket.workflowState === "continuing") return "lead";
  return "queued";
}

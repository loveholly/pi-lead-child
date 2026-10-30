// 外部会话不存在时，新会话的上下文（工单 #66 的 Run #71）。
// Claude Code 和 Codex 按保留期删除旧会话的记录。这时内核在同一个 Run 里开一个新会话
// （manager.ts 的 startFreshSession）。新会话不记得原来的对话。
// 工单的说明和正文已经在基础提示里。这一段补上其余的事实：工单的状态、最新一次交付的成果、
// 独立核查的结论、最近几轮工单对话。执行计划不在这里：核查员也拿到这一段，它对照验收标准，不对照计划
// （工单 06 审查 L1）。执行者的计划由 children/manager.ts 的 startRequest 在每次启动时带上。
import type { Db } from "@pi-lead-child/store";
import { getItem, getOutcomeSnapshotForRun, listTurns } from "@pi-lead-child/store";
import { reviewerProgress, verificationState } from "../coordinator/review-authority.js";
import { latestDeliveryRunId } from "./delivery-run.js";

const RECENT_TURNS = 6;
const MAX_TEXT = 800;
const MAX_ITEMS = 8;

// 为什么开新会话：expired 是原来的会话被 CLI 删掉了；runtime_changed 是换了执行 agent（工单 08 的 change_executor_runtime，
// 或者原来的 runtime 被停用、派发时改选了一个），原来的会话属于另一个 CLI，接不上。
export type SessionLossCause = "expired" | "runtime_changed";

const SESSION_LOSS_HEADER: Record<SessionLossCause, string[]> = {
  expired: [
    "## 原来的会话已经不存在",
    "你在这张工单上原来的 runtime 会话已经不存在：CLI 按保留期删除了它的记录。"
      + "这是一个新会话，你不记得之前的对话。下面是工单到现在的事实。",
  ],
  runtime_changed: [
    "## 换了执行 agent",
    "这张工单原来由另一个 agent 执行，现在换成了你。你接不上它的会话："
      + "这是一个新会话，你不记得之前的对话。下面是工单到现在的事实。",
  ],
};

export function expiredSessionContext(db: Db, itemId: number, cause: SessionLossCause = "expired"): string {
  const item = getItem(db, itemId);
  if (!item) throw new Error(`item #${itemId} not found`);
  return [
    ...SESSION_LOSS_HEADER[cause],
    "工作区里的文件是现在的真实状态。需要细节时，先读工作区，不要凭这一段猜测。",
    `### 工单状态\n${item.stage}`,
    `### 最新一次交付的成果\n${deliverySection(db, itemId)}`,
    `### 独立核查\n${reviewSection(db, itemId)}`,
    `### 最近的工单对话\n${turnsSection(db, itemId)}`,
  ].join("\n\n");
}

function deliverySection(db: Db, itemId: number): string {
  const runId = latestDeliveryRunId(db, itemId);
  if (runId === null) return "还没有交付。";
  const outcome = getOutcomeSnapshotForRun(db, runId);
  if (!outcome) return `Run #${runId} 是最新一次交付。它没有登记成果。`;
  return [
    `Run #${runId}：${clip(outcome.summary)}`,
    ...outcome.changes.slice(0, MAX_ITEMS)
      .map((change) => `- 改动 ${change.ref}${change.summary ? `：${clip(change.summary)}` : ""}`),
    ...outcome.deliverables.slice(0, MAX_ITEMS).map((deliverable) => `- 交付物 ${deliverable.ref}：${clip(deliverable.label)}`),
    ...outcome.validations.slice(0, MAX_ITEMS)
      .map((validation) => `- 验证 ${clip(validation.command)}：${validation.outcome}。${clip(validation.summary)}`),
  ].join("\n");
}

function reviewSection(db: Db, itemId: number): string {
  const state = verificationState(db, itemId);
  const lines: string[] = [];
  if (state.current) {
    lines.push(`Run #${state.current.run_id} 的结论是 ${state.current.verdict}。证据：${clip(state.current.evidence)}`);
  } else if (state.latest) {
    lines.push(`Run #${state.latest.run_id} 的结论（${state.latest.verdict}）已经过期：`
      + `之后 Run #${state.supersededByRunId} 又改了成果。现在没有有效的核查结论。`);
  } else {
    lines.push("还没有独立核查的结论。");
  }
  const progress = reviewerProgress(db, itemId);
  if (progress?.state === "running") lines.push("一次独立核查正在进行。");
  if (progress?.state === "queued") lines.push("一次独立核查在排队。");
  if (progress?.state === "suspended") lines.push(`一次独立核查已挂起：${progress.reason ?? "原因没有记录"}。`);
  return lines.join("\n");
}

// 只取完成了的轮次。正在回答的这一轮（就是这一次的消息）不算。
function turnsSection(db: Db, itemId: number): string {
  const turns = listTurns(db, { itemId, limit: RECENT_TURNS * 3 })
    .filter((turn) => turn.state === "completed" && turn.assistant_text.trim())
    .slice(-RECENT_TURNS);
  if (!turns.length) return "这张工单还没有完成的对话。";
  return turns.map((turn) => `- 消息：${clip(turn.user_text)}\n  回答：${clip(turn.assistant_text)}`).join("\n");
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= MAX_TEXT ? flat : `${flat.slice(0, MAX_TEXT)}…`;
}

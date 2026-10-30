// 两台状态机的边与权限矩阵（spec §6.1/§6.2/§6.4），以及"用户控制面动作"对这些边的投影。
//
// **为什么这张表住在 protocol 而不是 src/store 里。** 内核要拿它来拒绝非法跃迁，companion
// 要拿它来决定给用户显示哪几个按钮。两边各写一份必然漂移，而漂移的表现是最难查的那一种：
// UI 摆着一个按钮，点下去被 403；或者一条边合法却没有任何入口——诉求 1 里"用户被自己的
// 闸门锁在外面"就是后者。protocol 是内核与 companion 唯一共有的地基，所以表放这里，
// src/store/stages.ts 与 companion 的动作行都从这里读同一份。
//
// 用户 2026-10-28：「工单操作让 Lead 自己判断」。以前只给 user 的边（确认开跑、撤回确认、验收、返工、丢弃成果、
// 重做、恢复）现在也给 lead：Lead 按自己的判断走，账本写 actor=lead；在用户本人这一轮里走的记成代用户做。
// 读过外部内容的一轮里 Lead 不能走这些边（engine 的 ticket-actions/authority.ts）。只给 system 的边不变。
// 未列出的边一律拒绝（默认 deny）。
import type { TicketKind, TicketStatus } from "./index.ts";

export type StageActor = "user" | "lead" | "child" | "system";

type Edge = `${TicketStatus}->${TicketStatus}`;

// Partial 是必须的：Edge 是两个 stage 枚举的笛卡尔积（100 条），而合法边只有十几条。
// 写成完整 Record 会要求穷举全部乘积，把"未列出即拒绝"的默认 deny 语义反过来。
export type StageEdgeTable = Partial<Record<Edge, StageActor[]>>;

export const TASK_STAGE_EDGES: StageEdgeTable = {
  // 「建完先别跑」由 Lead 遵守用户的话（工单的说明里写着），不再由这张表挡。
  "draft->ready": ["user", "lead"],
  "draft->cancelled": ["user", "lead"],
  "ready->draft": ["user", "lead"],
  "ready->active": ["user", "system"], // system 仅在 run-gate 成功创建 Run 时
  // system 只在代查（purpose=lookup，slack-takeover spec D5）失败或被取消时走这两条边：代查工单跟着代查进终态
  // （D14 的不变量 3）。代查工单不等人验收，也没有用户可以否决的成果。store 的 transition 拒绝 system 取消别的工单。
  "ready->cancelled": ["user", "lead", "system"],
  "active->blocked": ["system", "child"],
  "active->review": ["system", "child"],
  // 手动停下。lead 也能停下整张工单（用户 2026-10-22，ui-action-parity plan.md P03）：例如 Run 卡死、白白消耗 token，
  // 事后必须告诉用户。工单回到 ready，和你在页面上点「停下」一样（工单操作层的 stop）。
  "active->ready": ["user", "lead"],
  "active->cancelled": ["user", "lead", "system"],
  "blocked->active": ["user", "system", "child"],
  "blocked->ready": ["user", "lead"],  // 同上：停下
  "blocked->cancelled": ["user", "lead"],
  // system 仅当工单托管给 Lead 验收、独立核查 PASS（engine 的 delegated-review.ts），由调用方额外校验。
  "review->done": ["user", "lead", "system"],
  "review->active": ["user", "lead", "system"],
  // 只有 system，而且只有一种触发方式：一次交付 Run 结束了，但它交不出任何可登记的成果。
  // review 这个 stage 断言的是"有东西在等你验收"；当那句断言被证伪时，继续停在 review
  // 就是在骗人。它不给 lead，也不给 user：这不是判断，是事实的更正。
  // 只针对交付 Run（engine/pipeline/delivery-run.ts）。工单 #66 曾被当作"三次自我恢复失败"
  // 的例子，那是误诊：其中两次是用户在工单里提问的对话 Run，最后一次交付已经登记了成果。
  "review->blocked": ["system"],
  // 以前只给 user：被告知「赶紧终止掉所有的任务和派发」时 lead 取消了 #5/#6/#10，三张都在 review，是做完了正等验收的
  // 成果。2026-10-28 起由 Lead 判断（提示词：「终止任务」不等于丢弃已经交付的成果）。
  "review->cancelled": ["user", "lead"],
  "done->active": ["user", "lead"],
  // 只有 system，而且只有一种触发方式：用户对这次验收点了「不是我」（工单 15）。验收不是用户做的，
  // done 这个断言是假的，工单回到等用户验收。不给 user：用户自己要重做用 rework（done→active）。不给 lead。
  "done->review": ["system"],
  "cancelled->draft": ["user", "lead"],
  // 根工单恢复方案经用户确认后，由系统原子恢复被选中的后代；不会创建 Run。
  "cancelled->ready": ["system"],
};

export const REMINDER_STAGE_EDGES: StageEdgeTable = {
  "scheduled->fired": ["system"],
  "scheduled->cancelled": ["user", "lead"],
  "fired->acked": ["user", "lead"],
  "fired->cancelled": ["user", "lead"],
  // 只有 system，而且只有一种触发方式：用户（「10 分钟后再提醒」「改时间」）或 Lead（reschedule_reminder）给一条已经到点的提醒
  // 定了新的时间（工单 07，store 的 rescheduleReminder）。这是改时间，不是生命周期的决定：提醒回到等待，到新的时间再响。
  // 终态 acked、cancelled 不能这样拉回来。谁定的新时间记在 stage.changed 的 reason 里。
  "fired->scheduled": ["system"],
  "cancelled->scheduled": ["user", "lead"],
};

export function stageEdges(kind: TicketKind): StageEdgeTable {
  return kind === "task" ? TASK_STAGE_EDGES : REMINDER_STAGE_EDGES;
}

export function canTransitionStage(
  kind: TicketKind, from: TicketStatus, to: TicketStatus, actor: StageActor,
): boolean {
  return (stageEdges(kind)[`${from}->${to}` as Edge] ?? []).includes(actor);
}

export function allowedNextStages(kind: TicketKind, from: TicketStatus): TicketStatus[] {
  return Object.keys(stageEdges(kind))
    .filter((edge) => edge.startsWith(`${from}->`))
    .map((edge) => edge.slice(from.length + 2) as TicketStatus);
}

// ——— 用户控制面动作 ———
//
// 动作 ≠ 边：光有目标 stage 不足以定位一个动作（confirm 与 stop 的 to 都是 ready），
// 所以每条动作显式带上它的起点集合。这张表不是矩阵的第二份拷贝，而是它的一个**投影**：
// test/stages.test.ts 断言两者是双射——矩阵里每一条 actor='user' 的边恰好被一条动作覆盖，
// 且每条动作的每个 (from → to) 都在矩阵里对 user 合法。矩阵一旦增删 user 的边，
// 这张表不跟着改就会当场红。
export const USER_ITEM_ACTION_IDS = [
  "confirm", "start", "complete", "rework", "ack", "stop", "unconfirm", "restore", "cancel",
] as const;

export type UserItemActionId = typeof USER_ITEM_ACTION_IDS[number];

export interface UserItemActionEdge {
  id: UserItemActionId;
  kind: TicketKind;
  from: readonly TicketStatus[];
  to: TicketStatus;
}

// 顺序即呈现顺序：推进类动作在前、撤回/取消在后，这样动作行的第一个按钮总是
// "这一刻最可能想做的那件事"。
export const USER_ITEM_ACTION_EDGES: readonly UserItemActionEdge[] = [
  { id: "confirm", kind: "task", from: ["draft"], to: "ready" },
  { id: "start", kind: "task", from: ["ready", "blocked"], to: "active" },
  { id: "complete", kind: "task", from: ["review"], to: "done" },
  // done→active 与 review→active 是同一件事的两个入口：打回重做。
  { id: "rework", kind: "task", from: ["review", "done"], to: "active" },
  { id: "ack", kind: "reminder", from: ["fired"], to: "acked" },
  { id: "stop", kind: "task", from: ["active", "blocked"], to: "ready" },
  { id: "unconfirm", kind: "task", from: ["ready"], to: "draft" },
  { id: "restore", kind: "task", from: ["cancelled"], to: "draft" },
  // 提醒恢复回 scheduled 而不是 draft——reminder 的状态机里根本没有 draft。
  { id: "restore", kind: "reminder", from: ["cancelled"], to: "scheduled" },
  { id: "cancel", kind: "task", from: ["draft", "ready", "active", "blocked", "review"], to: "cancelled" },
  { id: "cancel", kind: "reminder", from: ["scheduled", "fired"], to: "cancelled" },
];

// 当前 stage 下、actor='user' 合法且有控制面入口的动作，按 USER_ITEM_ACTION_EDGES 的顺序。
// UI 只调这一个函数，不再自己按 stage 写 if/else——那种写法既测不到，也一定会和矩阵分家。
export function userItemActionsFor(kind: TicketKind, stage: TicketStatus): UserItemActionId[] {
  return USER_ITEM_ACTION_EDGES
    .filter((edge) => edge.kind === kind && edge.from.includes(stage))
    .map((edge) => edge.id);
}

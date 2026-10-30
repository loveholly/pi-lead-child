// 高风险的「主人操作」（工单 15 第一步）：清单、凭证的来历、推送还是只记录、「不是我」的线上契约。
//
// child（执行工单的 Codex、Claude Code、pi）和用户是同一个系统用户。它们读得到 plc 存在数据目录里的 CLI 凭证，
// 连得上 plc.sock 换临时 admin token（再建新的配对），也能伪造 Origin 走回环自动配对。所以它们可以冒充用户做下面这些事。
// 第一步不收紧任何 scope，只做到两件事：
//   - 每次发生都记一条事件（owner_action.performed）。来自扫码配对的手机时只记录；来自别的凭证时推送给用户。
//   - 推送和会话卡上有「不是我」：撤销这次操作（能撤销的撤销，不能撤销的说明原因），并作废发出它的凭证。
// 第二步（Touch ID、面容 ID）另做。
// 2026-10-22（.scratch/child-self-approve/options.md 方案 A）：child 不伪造任何东西就能拿到的凭证不再能做用户的决定，
// 见 originMayDecide。
//
// 这张表是清单的唯一出处：网关按它记事件，「不是我」按它撤销，测试核对它和路由、工单动作是一一对应的。
// 这个文件只依赖 typebox 和同包的 events.ts、stages.ts，companion 也读它。
import { Type, type Static, type TProperties, type TSchema } from "typebox";
import { registerEventKind, type EventKindDefinition } from "./events.ts";
import { DEFAULT_LEAD_NAME } from "./lead-profile.ts";
import type { UserItemActionId } from "./stages.ts";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

// ── 清单 ──────────────────────────────────────────────────────────────────────────

export const OWNER_ACTION_IDS = [
  // approvals:respond：用户的决定。
  "approval.resolve",
  "decision.resolve",
  "connection.confirm",
  "memory.switch_confirm",
  "standing_order.proposal_decide",
  // tickets:create：「这台设备是主人」的操作。
  "ticket.confirm",
  "ticket.complete",
  "ticket.stop",
  "ticket.cancel",
  "lead.trust",
  "lead.delegation",
  "connection.settings",
  "channel.credentials",
  "run.pause",
  "run.stop",
  // 子 agent 的权限清单（landing.md 第 5 节）：用户放宽了一个 Run 的清单。
  "run.grant",
  // 带清单的子 agent 经连接中心做了一次写操作（landing.md C3，「Lead 代你」）。
  "connection.agent_write",
  "workspace.release",
  "workspace.cleanup",
  "standing_order.rollback",
  "lead.profile",
  "ui.design",
  "channel.reply_style",
  "memory.preferences",
] as const;
export type OwnerActionId = typeof OWNER_ACTION_IDS[number];

// 「不是我」能不能撤销：conditional 要看现在的状态（例如工单还停在 done）；none 不能撤销。
export type OwnerActionUndoability = "conditional" | "none";

export interface OwnerActionDefinition {
  id: OwnerActionId;
  // 做了什么，动词开头，例如「验收工单」。
  label: string;
  // 这条路由现在要的 scope。第一步不改它们（Mac 网页照常能批准）。
  scope: "approvals:respond" | "tickets:create";
  // 走到这个操作的路由。byAgent 的没有路由。
  routes: readonly string[];
  // 不是经路由做的：带清单的子 agent 经连接中心做的写操作（landing.md C3）。daemon 在连接中心报告写操作时记它。
  byAgent?: true;
  undo: OwnerActionUndoability;
  // 「不是我」时怎么撤销，或者为什么不能撤销。
  undoNote: string;
}

export const OWNER_ACTIONS: readonly OwnerActionDefinition[] = [
  {
    id: "approval.resolve", label: "处理审批", scope: "approvals:respond",
    routes: ["POST /v1/approvals/:id/resolve", "POST /v1/kernel/interventions/approval::id/resolve"],
    undo: "conditional",
    undoNote: "批准改为拒绝，并取消会话豁免。发起的 child 已经读到批准时，被批准的动作已经执行，无法撤回。拒绝不改。",
  },
  {
    id: "decision.resolve", label: "回答决定请求", scope: "approvals:respond",
    routes: ["POST /v1/kernel/interventions/decision::id/resolve"],
    undo: "none",
    undoNote: "回答已经交给发起方（{lead} 或 child），无法撤回。",
  },
  {
    id: "connection.confirm", label: "确认连接的写入", scope: "approvals:respond",
    routes: ["POST /v1/connections/confirmations/:id/resolve"],
    undo: "none",
    undoNote: "允许以后，写入已经发到外部服务，无法撤回。不允许的不改。",
  },
  {
    id: "memory.switch_confirm", label: "确认记忆切换", scope: "approvals:respond",
    routes: ["POST /v1/memory/switches/:id/confirm"],
    undo: "none",
    undoNote: "切换已经开始，系统不自动切回。需要时在设置 → 记忆里切回。不同意的不改。",
  },
  {
    id: "standing_order.proposal_decide", label: "决定常设指令的提议", scope: "approvals:respond",
    routes: ["POST /v1/standing-order-proposals/:id/decision"],
    undo: "conditional",
    undoNote: "批准的修改回滚到批准前的版本。新建的指令没有更早的版本，不能回滚。之后又改过的不自动回滚。拒绝不改。",
  },
  {
    id: "ticket.confirm", label: "确认工单", scope: "tickets:create",
    routes: ["POST /v1/tickets/:id/confirm"],
    undo: "conditional",
    undoNote: "工单回到草稿。已经开始执行的，先停止，再回到草稿。",
  },
  {
    id: "ticket.complete", label: "验收工单", scope: "tickets:create",
    routes: ["POST /v1/tickets/:id/complete"],
    undo: "conditional",
    undoNote: "工单回到待验收（review）。依赖它的工单、父工单的集成已经开始的，不会自动撤回。",
  },
  {
    id: "ticket.stop", label: "停止工单", scope: "tickets:create",
    routes: ["POST /v1/tickets/:id/stop"],
    undo: "none",
    undoNote: "执行的进程已经终止，系统不替你重新开始。需要时在工单里点「开始」。",
  },
  {
    id: "ticket.cancel", label: "取消工单", scope: "tickets:create",
    routes: ["POST /v1/tickets/:id/cancel"],
    undo: "conditional",
    undoNote: "工单恢复到草稿（提醒恢复到待提醒），要你重新确认。被停止的执行不会自动重启。",
  },
  {
    id: "lead.trust", label: "改 {lead} 的授权", scope: "tickets:create",
    routes: ["POST /v1/lead/trust"],
    undo: "conditional",
    undoNote: "新给的授权被撤回。撤回授权更保守，不自动恢复。",
  },
  {
    id: "lead.delegation", label: "改委托验收", scope: "tickets:create",
    routes: ["POST /v1/lead/delegation"],
    undo: "conditional",
    undoNote: "新给的委托被撤回，授权时顺带开始的返工不会自动停止。撤回委托更保守，不自动恢复。",
  },
  {
    // 连接的权限设置（谁能用、写入策略）。放开写入策略以后，child 可以不经确认写外部服务（2026-10-19 审查）。
    id: "connection.settings", label: "改连接的权限设置", scope: "tickets:create",
    routes: ["POST /v1/connections/:key/settings"],
    undo: "conditional",
    undoNote: "这次放开的（新加的角色、改成直接写入）恢复原样。之后又改过的不自动恢复。收紧更保守，不自动恢复。已经执行的写入无法撤回。",
  },
  {
    // 外部通道（例如 Slack）的令牌（设置页「消息通道」，slack-settings 工单 S1）。换成别人的令牌，助手就替别人收发消息；
    // 删掉它，助手就收不到消息。只有本机网页能改，但 child 能伪造回环网页，所以算主人操作。
    id: "channel.credentials", label: "改外部通道的凭据", scope: "tickets:create",
    routes: ["PUT /v1/channels/settings/:source", "DELETE /v1/channels/settings/:source"],
    undo: "conditional",
    undoNote: "删掉设置页里这个通道保存的凭据并断开（Keychain 或环境变量里还有凭据时，用它们重新连上）。之后又改过的不自动删除。"
      + "删除凭据更保守，不自动恢复。",
  },
  {
    id: "run.pause", label: "暂停 Run", scope: "tickets:create",
    routes: ["POST /v1/runs/:id/pause"],
    undo: "conditional",
    undoNote: "Run 还在暂停时，恢复它。",
  },
  {
    id: "run.stop", label: "停止 Run", scope: "tickets:create",
    routes: ["POST /v1/runs/:id/stop"],
    undo: "none",
    undoNote: "停止是终态，进程已经终止，无法撤回。",
  },
  {
    // 放宽以后，正在跑的子 agent 马上能用新加的工具（连接中心每次调用都读最新的清单）。
    id: "run.grant", label: "放宽子 agent 的权限", scope: "tickets:create",
    routes: ["POST /v1/tickets/:id/actions/widen_grant"],
    undo: "conditional",
    undoNote: "这次加上的规则从清单里删掉，子 agent 下一次调用就用不了它们。用新权限已经做了的写操作不会撤回。",
  },
  {
    // 带清单的子 agent 写外部服务（例如在 PR 上发评论、approve）。没有路由：它不是用户点的，而是 Lead 派的工单按清单做的。
    id: "connection.agent_write", label: "子 agent 代你写外部服务", scope: "tickets:create",
    routes: [], byAgent: true,
    undo: "conditional",
    undoNote: "写入已经发到外部服务。连接能撤回的（例如还没提交的 review）由系统撤回；不能撤回的给出链接，请你在那边改或删。",
  },
  {
    id: "workspace.release", label: "释放工作区", scope: "tickets:create",
    routes: ["POST /v1/workspaces/:id/release"],
    undo: "none",
    undoNote: "工作区已经释放，无法撤回。",
  },
  {
    id: "workspace.cleanup", label: "清理工作区", scope: "tickets:create",
    routes: ["POST /v1/workspaces/:id/cleanup"],
    undo: "none",
    undoNote: "工作区的文件已经删除，无法撤回。",
  },
  {
    id: "standing_order.rollback", label: "回滚常设指令", scope: "tickets:create",
    routes: ["POST /v1/standing-orders/:id/rollback"],
    undo: "conditional",
    undoNote: "指令回到回滚前的版本。之后又改过的，不自动回滚。",
  },
  {
    // Lead 的名字、人格和互动风格（设置页「身份与风格」，2026-10-22）。人格和互动风格进 Lead 的系统提示词，
    // 冒充用户改它们就能改 Lead 的说话方式，所以算主人操作。
    id: "lead.profile", label: "改助手的名字和风格", scope: "tickets:create",
    routes: ["POST /v1/lead/profile"],
    undo: "conditional",
    undoNote: "名字、人格和互动风格恢复成改之前的样子。之后又改过的，不自动恢复。",
  },
  {
    // 外观偏好（设置页「外观」，2026-10-22）：密度、圆角、行高、字号、颜色、设计说明。设计说明进 Lead 的提示词，
    // 颜色和字号改的是用户每天看的界面，所以算主人操作。
    id: "ui.design", label: "改界面的外观", scope: "tickets:create",
    routes: ["POST /v1/design/preferences"],
    undo: "conditional",
    undoNote: "外观恢复成改之前的样子。之后又改过的，不自动恢复。",
  },
  {
    // 代回复风格（设置 → 消息通道，2026-10-28，reply-style.ts）。它进 Lead 和子 agent 写回复的提示词，
    // 冒充用户改它就能改代用户说出去的话，所以算主人操作。
    id: "channel.reply_style", label: "改代回复风格", scope: "tickets:create",
    routes: ["POST /v1/channels/reply-style"],
    undo: "conditional",
    undoNote: "代回复风格恢复成改之前的样子。之后又改过的，不自动恢复。",
  },
  {
    // 常驻偏好（设置 → 记忆 → 常驻偏好，2026-10-29，core-memory.ts）。它进 Lead 的系统提示词，
    // 冒充用户改它就能改 Lead 的行为，所以算主人操作。Lead 自己改的走 Lead 动态（带撤销），不记这一项。
    id: "memory.preferences", label: "改常驻偏好", scope: "tickets:create",
    routes: [
      "POST /v1/actions/core_memory/:id/update", "POST /v1/actions/core_memory/:id/delete",
      "POST /v1/actions/core_memory_change/:id/undo",
    ],
    undo: "conditional",
    undoNote: "常驻偏好恢复成改之前的样子。之后又改过的，不自动恢复。",
  },
];

const BY_ID = new Map(OWNER_ACTIONS.map((definition) => [definition.id, definition]));

// 清单和说明里称呼 Lead 的地方写成 {lead}，给人看之前换成 Lead 的名字（设置 → 身份与风格，lead-profile.ts）。
export function ownerActionText(text: string, leadName: string = DEFAULT_LEAD_NAME): string {
  return text.replaceAll("{lead}", leadName);
}

export function ownerActionDefinition(id: string): OwnerActionDefinition | undefined {
  return BY_ID.get(id as OwnerActionId);
}

// 工单动作（POST /v1/tickets/:id/:action，USER_ITEM_ACTION_IDS）里哪些算高风险。每个动作都要在这里写明，
// 测试核对它和 USER_ITEM_ACTION_IDS 是同一组：以后加了动作而没有归类，测试就会失败。
// 算高风险的：越过「建完先别跑」的闸门（confirm）、替用户下终态的判断（complete、cancel）、终止在跑的工作（stop）。
export const ITEM_ACTION_RISK: Readonly<Record<UserItemActionId, { ownerAction: OwnerActionId | null; reason: string }>> = {
  confirm: { ownerAction: "ticket.confirm", reason: "打开「建完先别跑」的闸门，工单可以开跑。" },
  complete: { ownerAction: "ticket.complete", reason: "验收：替用户判断成果合格，工单进入终态 done。" },
  stop: { ownerAction: "ticket.stop", reason: "终止正在执行的工作。" },
  cancel: { ownerAction: "ticket.cancel", reason: "工单进入终态 cancelled，并终止执行。" },
  start: { ownerAction: null, reason: "只对已经确认的工单开跑。确认那一步已经算高风险。" },
  rework: { ownerAction: null, reason: "把工单送回执行。不越过闸门，也不丢掉成果。" },
  unconfirm: { ownerAction: null, reason: "收回确认，比原来更保守。" },
  restore: { ownerAction: null, reason: "取消的工单回到草稿，要再确认才会开跑。" },
  ack: { ownerAction: null, reason: "确认一条提醒，只影响提醒。" },
};

// ── 凭证的来历 ────────────────────────────────────────────────────────────────────

// 一个 binding 是怎么来的（bindings.origin，v47）。v47 之前建的 binding 没有记，按 kind 推断（bindingOriginOf）。
//   cli              plc.sock 上换的凭证（存在数据目录里，同一个用户的进程都读得到）
//   loopback_web     回环自动配对的网页（伪造 Origin 也能拿到）
//   phone_qr         本机网页发的配对邀请，被另一台设备扫码兑换：用户的手机
//   admin_pairing    临时 admin token 建的配对（配对码或二维码）
//   local_invitation 本机网页发的配对邀请，在这台机器上兑换（或者用配对码兑换）：不是手机
//   aish             Slack 网关
//   channel_owner    外部通道里用户本人写给 Lead 的入口（例如 Slack 里发给自己的私信，用户 2026-10-30）。没有令牌，
//                    daemon 凭通道的凭据认出是用户本人；权限和 Companion 一样（store 的 channelOwnerBinding）。
//                    child 拿不到它：要以用户本人在来源里发消息，得有用户的通道令牌，令牌只给 daemon
//   unknown          v47 之前建的 companion、desktop
export const BINDING_ORIGINS = [
  "cli", "loopback_web", "phone_qr", "admin_pairing", "local_invitation", "aish", "channel_owner", "unknown",
] as const;
export type BindingOrigin = typeof BINDING_ORIGINS[number];

// 配对是谁建的（pairings.origin，v47）：本机网页的邀请，还是临时 admin token。
export type PairingOrigin = "web_invitation" | "admin";

export function bindingOriginOf(binding: { kind: string; origin?: string | null }): BindingOrigin {
  const stored = binding.origin;
  if (stored && (BINDING_ORIGINS as readonly string[]).includes(stored)) return stored as BindingOrigin;
  if (binding.kind === "cli") return "cli";
  if (binding.kind === "aish-slack") return "aish";
  return "unknown";
}

/**
 * 兑换一个配对得到的 binding 算哪一种。只有「本机网页发的邀请、经 socket 配对、对端不是这台机器」算手机：
 * child 能伪造回环网页去要邀请，但它在这台机器上，兑换时就会被认出来。临时 admin 建的配对一律不算手机。
 */
export function pairedBindingOrigin(
  pairing: PairingOrigin | null,
  redeem: { via: "socket" | "code"; peerIsThisMachine: boolean },
): BindingOrigin {
  if (pairing === "web_invitation") {
    return redeem.via === "socket" && !redeem.peerIsThisMachine ? "phone_qr" : "local_invitation";
  }
  return "admin_pairing";
}

// 请求来自哪种客户端（写进事件，给人看）：plc 和脚本、浏览器里的网页、手机 App，
// 或者 Lead 在你这一轮对话里代你做（工单操作层，spec 5.11；凭证是那一轮来自的配对凭证），
// 或者 Lead 派的子 agent 按权限清单做（landing.md C3；没有配对凭证，凭证编号是 0，名字是那张工单）。
export type OwnerActionClient = "cli" | "web" | "phone" | "lead" | "agent" | "unknown";

export interface OwnerActionSource {
  client: OwnerActionClient;
  // binding 的显示名（设备名）。
  deviceName: string;
  // 请求的 socket 来自回环地址。
  loopback: boolean;
  // 请求来自这台机器（回环，或者对端地址是本机的网卡地址）。
  fromThisMachine: boolean;
}

export type OwnerActionDelivery = "record" | "push";

/**
 * 只记录还是推送。扫码配对的手机就是用户本人，只记录；但手机的凭证从这台机器上用时照样推送。
 * 其余的（CLI 凭证、回环网页、临时 admin 建的配对、v47 之前的凭证）都推送。
 */
export function ownerActionDelivery(origin: BindingOrigin, source: Pick<OwnerActionSource, "fromThisMachine">): OwnerActionDelivery {
  return origin === "phone_qr" && !source.fromThisMachine ? "record" : "push";
}

// 事件的级别：推送的是 interrupt（spec D3：主会话，同时推送），只记录的是 record。
export function ownerActionLevel(delivery: OwnerActionDelivery): "record" | "interrupt" {
  return delivery === "push" ? "interrupt" : "record";
}

/**
 * 谁能点「不是我」：扫码配对的手机或网页会话（kind 是 companion）。CLI、Slack 不行；
 * child 在这台机器上自己就能拿到的凭证（本机兑换的邀请、plc pair 建的配对）也不行，见 originMayDecide。
 * 作废只作用于发出那次操作的凭证（见网关的 owner-actions.ts），所以冒用者点「不是我」作废不了别的凭证。
 */
export function canDisownOwnerAction(caller: { kind: string; origin: BindingOrigin }): boolean {
  return caller.kind === "companion" && originMayDecide(caller.origin);
}

/**
 * 这个来历的凭证能不能做用户的决定（approvals:respond：上面那 5 种决定、「不是我」）。
 * child 和用户是同一个系统用户（.scratch/child-self-approve/options.md 方案 A）。下面这几种凭证，child 在这台机器上
 * 不伪造任何东西就能拿到，正常使用又不用它们做决定，所以它们不能做：
 *   cli              连上 plc.sock 就能换，plc 还把它存在数据目录里
 *   admin_pairing    plc.sock 的临时 admin token 建的配对（plc pair new）
 *   local_invitation 本机网页发的邀请在这台机器上兑换
 * 本机网页（loopback_web，以及 v47 之前配对的 unknown）和扫码配对的手机照常能做。child 伪造 Origin 拿到的本机网页凭证
 * 也能做，由工单 15 第一步推送给用户；真正的边界是工单 15 第二步（Touch ID、面容 ID）。
 */
export function originMayDecide(origin: BindingOrigin): boolean {
  return origin !== "cli" && origin !== "admin_pairing" && origin !== "local_invitation";
}

const ORIGIN_LABELS: Record<BindingOrigin, string> = {
  cli: "plc 的 CLI 凭证",
  loopback_web: "本机网页",
  phone_qr: "扫码配对的手机",
  admin_pairing: "plc pair 建的配对",
  local_invitation: "在本机兑换的配对邀请",
  aish: "Slack",
  channel_owner: "你在 Slack 里发给自己的私信",
  unknown: "v47 之前的凭证",
};

const CLIENT_LABELS: Record<OwnerActionClient, string> = {
  cli: "CLI", web: "网页", phone: "手机", lead: "{lead} 在对话里代你做", agent: "{lead} 派的子 agent 按权限清单做", unknown: "未知客户端",
};

export function bindingOriginLabel(origin: string): string {
  return ORIGIN_LABELS[origin as BindingOrigin] ?? ORIGIN_LABELS.unknown;
}

export function ownerActionClientLabel(client: string, leadName: string = DEFAULT_LEAD_NAME): string {
  return ownerActionText(CLIENT_LABELS[client as OwnerActionClient] ?? CLIENT_LABELS.unknown, leadName);
}

// ── Lead 代你做的操作（工单操作层，spec 5.11）────────────────────────────────────────
//
// 代做的操作记在那一轮来自的凭证名下，source.client 是 lead。对它点「撤销」，最常见的原因是 Lead 理解错了你的话，
// 不是凭证被盗（工单 03 审查 M5）。所以：
//   - 只撤销这次操作，不作废凭证：你的设备照常能用。那句话不是你说的，就到「设置 → 已配对设备」撤销那台设备。
//   - 它是另一种通知（OWNER_ACTION_ON_BEHALF_NOTIFICATION_KIND）：发出那一轮的设备上照样显示提醒和「撤销」，
//     不当成「你刚刚在这里点的」收起来（那是你自己的凭证做的操作的规则）。
// 你自己的凭证做的操作，「不是我」照旧撤销并作废凭证。

export function isOnBehalfOwnerActionSource(source: { client: string }): boolean {
  return source.client === "lead" || source.client === "agent";
}

export function onBehalfUndoCredentialNote(leadName: string = DEFAULT_LEAD_NAME): string {
  return `这是 ${leadName} 在对话里代你做的：只撤销了这次操作，没有作废凭证。如果那句话不是你说的，请到「设置 → 已配对设备」撤销那台设备。`;
}

/** 推送和会话卡的文字：标题说做了什么，正文说哪个凭证、从哪里来，以及「不是我」（代做的是「撤销」）会做什么。 */
// leadName 是 Lead 的名字（设置 → 身份与风格），不给时用缺省的。
export function ownerActionAlertText(input: {
  summary: string;
  credential: { bindingId: number; name: string; origin: string };
  source: Pick<OwnerActionSource, "client" | "fromThisMachine">;
  // 多给一行说明（例如子 agent 写入的链接）。
  note?: string | null;
  leadName?: string;
}): { title: string; body: string } {
  const lead = input.leadName ?? DEFAULT_LEAD_NAME;
  if (input.source.client === "agent") {
    return {
      title: input.summary,
      body: [
        `${lead} 派的子 agent 按${input.credential.name}的权限清单做的。`,
        ...(input.note ? [input.note] : []),
        "要撤回？点「撤销」：能撤回的系统撤回；已经发到外部服务的，给你链接去那边改或删。",
      ].join("\n"),
    };
  }
  if (isOnBehalfOwnerActionSource(input.source)) {
    return {
      title: input.summary,
      body: [
        `${lead} 在对话里代你做的。那一轮来自：${input.credential.name}（${bindingOriginLabel(input.credential.origin)}，#${input.credential.bindingId}）`,
        `${lead} 理解错了？点「撤销」：撤销这次操作，不作废凭证。如果那句话不是你说的，请到「设置 → 已配对设备」撤销那台设备。`,
      ].join("\n"),
    };
  }
  const where = [ownerActionClientLabel(input.source.client, lead), input.source.fromThisMachine ? "来自这台电脑" : "来自别的设备"].join(" · ");
  return {
    title: input.summary,
    body: [
      `凭证：${input.credential.name}（${bindingOriginLabel(input.credential.origin)}，#${input.credential.bindingId}）· ${where}`,
      "不是你做的？点「不是我」：撤销这次操作，并作废这个凭证。",
    ].join("\n"),
  };
}

/**
 * 只记录的主人操作（扫码配对的手机做的，delivery 是 record）在会话里的一行（画布「代你操作」状态 7）。
 * 不推送，没有「不是我」：手机就是用户本人。标题说做了什么，正文说在哪台设备上。
 */
export function ownerActionRecordText(input: { summary: string; deviceName: string }): { title: string; body: string } {
  return { title: input.summary, body: `在 ${input.deviceName} 上做的（扫码配对的手机）。只记录，不推送。` };
}

// ── 通知和会话卡 ─────────────────────────────────────────────────────────────────

// 推送用的通知（notifications.kind）。daemon 直接推送它（不请 Lead 播报），并在会话里贴一张卡。
// 它不挂工单（item_id 为空）：挂在工单上的通知只在工单等你时才出现，主人操作的提醒不能因此藏起来。
export const OWNER_ACTION_NOTIFICATION_KIND = "owner_action";
// Lead 代你做的操作的提醒（见上面「Lead 代你做的操作」）。daemon 同样直接推送；客户端给「撤销」，不给「是我 / 不是我」。
export const OWNER_ACTION_ON_BEHALF_NOTIFICATION_KIND = "owner_action_on_behalf";

export function isOwnerActionNotificationKind(kind: string): boolean {
  return kind === OWNER_ACTION_NOTIFICATION_KIND || kind === OWNER_ACTION_ON_BEHALF_NOTIFICATION_KIND;
}

export function isOnBehalfOwnerActionNotification(notification: { kind: string }): boolean {
  return notification.kind === OWNER_ACTION_ON_BEHALF_NOTIFICATION_KIND;
}
const DEDUP_PREFIX = "owner_action:";
const TURN_PREFIX = "turn_owner_action_";
const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isOwnerActionEventId(value: string): boolean {
  return EVENT_ID.test(value);
}

// 通知的 dedup_key 和会话卡的轮次编号都带着事件编号和发出操作的凭证编号。客户端用凭证编号判断这是不是自己刚做的操作：
// 是的话只显示一行记录，不显示醒目的提醒和「不是我」（推送照常发，冒用者用的是它自己的凭证）。
export interface OwnerActionRef {
  eventId: string;
  bindingId: number;
}

function parseRef(rest: string, separator: string): OwnerActionRef | null {
  const at = rest.lastIndexOf(separator);
  if (at < 0) return null;
  const eventId = rest.slice(0, at);
  const bindingId = Number(rest.slice(at + separator.length));
  if (!isOwnerActionEventId(eventId) || !Number.isSafeInteger(bindingId) || bindingId < 0) return null;
  return { eventId, bindingId };
}

export function ownerActionNotificationDedupKey(eventId: string, bindingId: number): string {
  return `${DEDUP_PREFIX}${eventId}:${bindingId}`;
}

/** 一条通知是哪次主人操作的提醒、是哪个凭证做的。不是时返回 null。 */
export function ownerActionRefOfNotification(notification: { kind: string; dedupKey: string | null }): OwnerActionRef | null {
  if (!isOwnerActionNotificationKind(notification.kind) || !notification.dedupKey?.startsWith(DEDUP_PREFIX)) return null;
  return parseRef(notification.dedupKey.slice(DEDUP_PREFIX.length), ":");
}

export function ownerActionEventIdOfNotification(notification: { kind: string; dedupKey: string | null }): string | null {
  return ownerActionRefOfNotification(notification)?.eventId ?? null;
}

// 会话里那张卡的轮次编号。客户端从它取出事件编号（去读状态和点「不是我」）和凭证编号。
export function ownerActionTurnId(eventId: string, bindingId: number): string {
  return `${TURN_PREFIX}${eventId}_${bindingId}`;
}

export function ownerActionRefOfTurn(turnId: string | null | undefined): OwnerActionRef | null {
  if (!turnId?.startsWith(TURN_PREFIX)) return null;
  return parseRef(turnId.slice(TURN_PREFIX.length), "_");
}

export function ownerActionEventIdOfTurn(turnId: string | null | undefined): string | null {
  return ownerActionRefOfTurn(turnId)?.eventId ?? null;
}

// ── 事件 ──────────────────────────────────────────────────────────────────────────

export const OWNER_ACTION_PERFORMED_KIND = "owner_action.performed";
export const OWNER_ACTION_DISOWNED_KIND = "owner_action.disowned";

const CredentialPayload = Type.Object({
  // 0 是临时 admin token（它只开管理路由，正常走不到这些操作）。
  bindingId: Type.Integer({ minimum: 0 }),
  kind: Type.String(),
  name: Type.String(),
  origin: Type.String(),
});

const SourcePayload = Type.Object({
  client: Type.String(),
  deviceName: Type.String(),
  loopback: Type.Boolean(),
  fromThisMachine: Type.Boolean(),
});

const TargetPayload = Type.Object({
  // 对象键，和事件的 entity_key 一样，例如 ticket:5、approval:3、standing_order:inbox.wake_lead。
  key: Type.String({ minLength: 1 }),
  label: Type.String(),
  ticketId: Nullable(Type.Integer({ minimum: 1 })),
});

export const OWNER_ACTION_EVENT_KINDS: readonly EventKindDefinition[] = [
  {
    kind: OWNER_ACTION_PERFORMED_KIND,
    sources: ["system"],
    waitSignal: "user_action",
    payload: Type.Object({
      action: Type.String({ minLength: 1 }),
      label: Type.String(),
      // 一句话：做了什么，例如「验收了工单 #5「登录页」」。
      summary: Type.String(),
      target: TargetPayload,
      // 这次操作的参数，例如审批的 decision、授权的 granted。
      detail: Type.Record(Type.String(), Type.Unknown()),
      credential: CredentialPayload,
      source: SourcePayload,
      delivery: Type.Union([Type.Literal("record"), Type.Literal("push")]),
      notificationId: Nullable(Type.Integer({ minimum: 1 })),
      // 「不是我」撤销时要的、操作之前的状态（网关的 owner-actions.ts 读它）。
      undo: Type.Record(Type.String(), Type.Unknown()),
    }),
    description: "一次高风险的主人操作（工单 15）：做了什么、对象、凭证、来源。来自扫码配对的手机时只记录，其余推送给用户。",
  },
  {
    kind: OWNER_ACTION_DISOWNED_KIND,
    sources: ["system"],
    waitSignal: "user_action",
    payload: Type.Object({
      performedSeq: Type.Integer({ minimum: 1 }),
      performedEventId: Type.String({ minLength: 1 }),
      action: Type.String({ minLength: 1 }),
      summary: Type.String(),
      by: CredentialPayload,
      revert: Type.Object({ status: Type.String(), message: Type.String() }),
      credential: Type.Object({
        bindingId: Type.Integer({ minimum: 0 }),
        revoked: Type.Boolean(),
        message: Type.String(),
      }),
    }),
    description: "用户对一次主人操作点了「不是我」：撤销的结果，和发出那次操作的凭证有没有作废。",
  },
];

for (const definition of OWNER_ACTION_EVENT_KINDS) registerEventKind(definition);

// ── 线上契约 ──────────────────────────────────────────────────────────────────────

// 「不是我」撤销的结果。
//   reverted        撤销了
//   executed        已经执行，无法撤回（例如 child 已经读到批准）
//   not_revertible  不能撤销（例如进程已经终止、文件已经删除、状态已经变了）
//   unchanged       不用撤销（例如拒绝、撤回授权：它们本来就是更保守的结果）
export const OwnerActionRevertStatusSchema = Type.Union([
  Type.Literal("reverted"), Type.Literal("executed"), Type.Literal("not_revertible"), Type.Literal("unchanged"),
]);
export type OwnerActionRevertStatus = Static<typeof OwnerActionRevertStatusSchema>;

export const OwnerActionDtoSchema = StrictObject({
  eventId: Type.String({ minLength: 1 }),
  action: Type.String({ minLength: 1 }),
  label: Type.String(),
  summary: Type.String(),
  target: StrictObject({ key: Type.String(), label: Type.String(), ticketId: Nullable(Type.Integer({ minimum: 1 })) }),
  credential: StrictObject({
    bindingId: Type.Integer({ minimum: 0 }), kind: Type.String(), name: Type.String(), origin: Type.String(),
    // 这个凭证现在还有效吗。
    active: Type.Boolean(),
  }),
  source: StrictObject({
    client: Type.String(), deviceName: Type.String(), loopback: Type.Boolean(), fromThisMachine: Type.Boolean(),
  }),
  delivery: Type.Union([Type.Literal("record"), Type.Literal("push")]),
  performedAt: Type.String(),
  undo: StrictObject({
    possible: Type.Union([Type.Literal("conditional"), Type.Literal("none")]),
    note: Type.String(),
  }),
  // 能不能对它点「不是我」：推送过的、还没点过的才能。
  disownable: Type.Boolean(),
  disowned: Nullable(StrictObject({
    at: Type.String(),
    byName: Type.String(),
    revert: StrictObject({ status: OwnerActionRevertStatusSchema, message: Type.String() }),
    credential: StrictObject({ bindingId: Type.Integer({ minimum: 0 }), revoked: Type.Boolean(), message: Type.String() }),
  })),
});
export type OwnerActionDto = Static<typeof OwnerActionDtoSchema>;

// GET /v1/owner-actions/:eventId 和 POST /v1/owner-actions/:eventId/disown 的响应。
export const OwnerActionResponseSchema = StrictObject({ ownerAction: OwnerActionDtoSchema });
export type OwnerActionResponse = Static<typeof OwnerActionResponseSchema>;

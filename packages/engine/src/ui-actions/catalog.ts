// 工单以外的操作清单。每个目标类型一组，每个操作在这里定义一次。
//
// available 是「现在能不能做」的唯一判断：list_actions 读它，runUiAction 执行前也查它。
// run 调已有的实现（daemon 的 RuntimeSettings.update、store 的 revokeBinding……），不另写一份。
import type { Approval, DecisionRequest, Item, RuntimeDisabledBy, RuntimeId, RuntimeSwitchBy, Workspace } from "@pi-lead-child/core";
import {
  KERNEL_RUNTIME_IDS, MILESTONE_KIND_LABELS, REMINDER_SNOOZE_MS, channelConfidenceProblems,
  type ActionPermission, type ChannelCardAction, type ChannelCardDto, type ChannelPolicyParams, type KernelRuntimeId, type LeadModelChoice,
  type LeadModelSwitchResult, type LeadQueue, type LeadQueueEntry, type RuntimeSettingEntry, type UiActionInputOf, type UiActionTargetType,
} from "@pi-lead-child/protocol";
import {
  approvalConsumerLive, approvalOwnerAction, channelPolicy, decisionOwnerAction, getApproval, getBinding, getChannelCard, getDecisionRequest,
  getEvent, getItem, getMilestone, getWorkspace, isStandingOrderProposal, itemUpdatedEvent, labelTimer, planStandingOrderChange, proposeStandingOrderChange,
  publishGatewayEvent, recordReminderTimeSetter, reminderTimeSetter, rescheduleReminder, ReminderRescheduleError, revokeBinding, StandingOrderChangeError,
  updateMilestone, updateStandingOrderByUser, workspaceOwnerAction,
  type Binding, type ChannelCard, type ChannelPolicy, type ItemMilestone, type MilestoneUpdate,
} from "@pi-lead-child/store";
import {
  performWorkspaceAction, workspaceActionBlocker, workspaceActionDone, type WorkspaceActionId, type WorkspaceActionResult,
} from "../coordinator/workspace-actions.js";
import { ackReminder } from "../ticket-actions/lifecycle.js";
import { channelCalibration, confidenceParamsFrom, judgePolicyCase } from "../channels/policy.js";
import type { ChannelReaction, ChannelSentMessage } from "../channels/types.js";
import type { InterventionActor } from "../coordinator/interventions.js";
import { createCoordinator } from "../coordinator/service.js";
import type { ActionAttribution } from "../ticket-actions/attribution.js";
import { AVAILABLE, unavailable } from "../ticket-actions/types.js";
import { latestInstantOf, leadUserTurnOf } from "./authority.js";
import { REPLY_STYLE_ACTIONS, REPLY_STYLE_TARGET } from "./reply-style.js";
import { CHANNEL_HANDBOOK_ACTIONS, CHANNEL_HANDBOOK_TARGET } from "./handbook.js";
import { MODEL_SETTINGS_ACTIONS, MODEL_SETTINGS_TARGET } from "./model-settings.js";
import { MEMORY_SETTINGS_ACTIONS, MEMORY_SETTINGS_TARGET } from "./memory-settings.js";
import { CORE_MEMORY_ACTIONS, CORE_MEMORY_CHANGE_ACTIONS, CORE_MEMORY_CHANGE_TARGET, CORE_MEMORY_TARGET } from "./core-memory.js";
import { MEMORY_FACT_ACTIONS, MEMORY_FACT_TARGET } from "./memory-facts.js";
import { SETUP_HINT_ACTIONS, SETUP_HINT_TARGET } from "./setup-hints.js";
import { RULE_CHANGE_ACTIONS, RULE_CHANGE_TARGET } from "./rule-change-confirmations.js";
import { WIDGET_ACTIONS, WIDGET_BOARD_ACTIONS, WIDGET_BOARD_TARGET, WIDGET_TARGET } from "./widgets.js";
import { TIMER_ACTIONS, TIMER_REQUEST_ACTIONS, TIMER_REQUEST_TARGET, TIMER_TARGET } from "./timers.js";
import {
  UiActionError,
  type ChannelCardActionService, type ChannelMessageService, type ChannelPolicyTestService, type FollowUpEntry, type FollowUpQueueService,
  type LeadModelService, type LeadQueueService,
  type RuntimeSwitchService, type UiActionDefinition, type UiActionEnv,
  type UiActionRun, type UiActionTargetKind,
} from "./types.js";

// 正整数编号（字符串形式）。不是时返回 null：「01」「1.0」都不算。
function positiveId(id: string): number | null {
  const value = Number(id);
  return Number.isSafeInteger(value) && value >= 1 && String(value) === id ? value : null;
}

// ── 执行器（设置 → 执行 → 执行器）─────────────────────────────────────────────────────────

export interface RuntimeTarget extends RuntimeSettingEntry {
  disabledBy: RuntimeDisabledBy | null;
}

function runtimeSwitch(env: UiActionEnv): RuntimeSwitchService {
  const service = env.services.runtimeSettings;
  if (!service) throw new UiActionError("unavailable", "执行器设置还没有启动");
  return service;
}

/**
 * 启用一个执行器要什么权限：Lead 自己停用的（以及本来就启用着的），Lead 自己能启用；用户停用的、来历不明的，只属于用户。
 * 操作层的权限和 daemon 的 RuntimeSettings.refusal 都用这一个函数。
 */
export function runtimeEnablePermission(disabled: boolean, disabledBy: RuntimeDisabledBy | null): ActionPermission {
  if (!disabled) return "lead_allowed";
  return disabledBy?.by === "lead" ? "lead_allowed" : "user_only";
}

/** 操作层的「谁做的」交给执行器开关。Lead 代你做时带上那一轮（RuntimeSettings.refusal 凭它放行用户停用的执行器）。 */
function runtimeSwitchBy(by: ActionAttribution, reason: string): RuntimeSwitchBy {
  if (by.actor === "user") return { actor: "user" };
  return {
    actor: "lead", reason,
    ...(by.onBehalfOf ? { onBehalfOf: { actor: "user", sourceTurnId: by.onBehalfOf.sourceTurnId } } : {}),
  };
}

const RUNTIME_TARGET: UiActionTargetKind<RuntimeTarget> = {
  type: "runtime",
  label: "执行器",
  idHint: KERNEL_RUNTIME_IDS.join("、"),
  load(env, id) {
    if (!(KERNEL_RUNTIME_IDS as readonly string[]).includes(id)) return null;
    const service = runtimeSwitch(env);
    const entry = service.get().runtimes.find((candidate) => candidate.id === id);
    if (!entry) return null;
    return { ...entry, disabledBy: entry.enabled ? null : service.disabledBy(entry.id as RuntimeId) };
  },
  name: (target) => `执行器 ${target.label}`,
  describe: (target) => ({
    id: target.id, label: target.label, enabled: target.enabled, installed: target.installed,
    ...(target.disabledBy ? { disabledBy: target.disabledBy.by, disabledReason: target.disabledBy.reason } : {}),
  }),
};

function runtimeDetail(target: RuntimeTarget, enabled: boolean) {
  return { runtime: target.id, enabled, wasEnabled: target.enabled };
}

// 执行器的开关是设置页的选项：改规则的操作，外部的一轮里 Lead 做不了（external-content.ts）。
const RUNTIME_ACTIONS = {
  disable: {
    target: "runtime", id: "disable", label: "停用执行器", scope: "tickets:create",
    permission: "lead_allowed", changesRules: true, external: false, irreversible: false,
    where: "设置 → 执行 → 执行器",
    hint: "停用以后，派发、选核查员、选型建议和自动换人都跳过它，点名它的派发挂起等改派。reason 写清楚为什么"
      + "（例如账号被停用、用户说不要用它）；停用以后告诉用户你停用了哪个、为什么。",
    defaultReason: "在设置页停用",
    available: () => AVAILABLE,
    run: (run) => runtimeSwitch(run.env).update(
      { runtime: run.target.id as KernelRuntimeId, enabled: false }, runtimeSwitchBy(run.by, run.reason),
    ),
    // 设置页的同一份 RuntimeSettingsDto：只有执行器的名字和开关。
    forLead: (_run, result) => result,
    detail: (run) => runtimeDetail(run.target, false),
  },
  enable: {
    target: "runtime", id: "enable", label: "启用执行器", scope: "tickets:create",
    permission: (target) => runtimeEnablePermission(!target.enabled, target.disabledBy),
    permissionNote: "你自己停用的你可以自己判断；用户停用的属于用户，你也可以启用，reason 写凭什么",
    changesRules: true, external: false, irreversible: false,
    where: "设置 → 执行 → 执行器",
    hint: "重新启用一个停用的执行器。",
    defaultReason: "在设置页启用",
    available: () => AVAILABLE,
    run: (run) => runtimeSwitch(run.env).update(
      { runtime: run.target.id as KernelRuntimeId, enabled: true }, runtimeSwitchBy(run.by, run.reason),
    ),
    forLead: (_run, result) => result,
    detail: (run) => runtimeDetail(run.target, true),
  },
} satisfies Record<string, UiActionDefinition<RuntimeTarget, Record<string, never>>>;

// ── 设备（设置 → 设备 → 已配对设备）───────────────────────────────────────────────────────────

const DEVICE_TARGET: UiActionTargetKind<Binding> = {
  type: "device",
  label: "设备",
  idHint: "配对凭证的编号（整数）",
  load(env, id) {
    const bindingId = positiveId(id);
    return bindingId === null ? null : getBinding(env.db, bindingId) ?? null;
  },
  name: (binding) => `设备「${binding.display_name}」（凭证 #${binding.id}）`,
  // 只给名字、种类和状态：token 的哈希、连接地址和密钥不给。
  describe: (binding) => ({ id: binding.id, name: binding.display_name, kind: binding.kind, status: binding.status }),
};

const DEVICE_ACTIONS = {
  revoke: {
    target: "device", id: "revoke", label: "作废设备凭证", scope: "admin",
    // 注入的指令可以借它把用户的设备全部踢掉（audit.md 第 26 条）。
    permission: "user_direct", changesRules: false, external: false, irreversible: true,
    where: "设置 → 设备 → 已配对设备",
    hint: "作废以后这台设备马上断开，要重新配对。只有用户本人能做。",
    defaultReason: "在设置页作废",
    available: () => AVAILABLE,
    run: (run) => {
      revokeBinding(run.db, run.target.id);
      return getBinding(run.db, run.target.id) ?? null;
    },
    // 凭证这一行有 token 的哈希和连接密钥：只给名字、种类和状态。
    forLead: (_run, result) => (result ? DEVICE_TARGET.describe(result as Binding) : null),
    detail: (run) => ({ bindingId: run.target.id, wasStatus: run.target.status }),
  },
} satisfies Record<string, UiActionDefinition<Binding, Record<string, never>>>;

// ── 审批和决定请求（P02）────────────────────────────────────────────────────────────
// 以前 Lead 的审批工具（resolve_approval，2026-10-28 删掉，现在是 perform_action）让 Lead 自报 channel，记成「user via <渠道>」，不查用户这一轮。现在两个入口都经过这里：
// 页面是你本人，记「user via paired binding:<凭证>」；Lead 只在你本人当前这一轮里代你做，账本写 actor=lead、onBehalfOf=user。
// 同样的决定重发一次，coordinator 回 idempotent（客户端的重试要它），不同的决定报冲突。所以这里不拦已经处理过的。

// coordinator 认的「谁处理的」。resolvedBy 是存进审批和决定请求的那一句，工单的经过和卡片读它。
function interventionActor(run: UiActionRun<unknown, unknown>): InterventionActor {
  if (run.by.actor === "user") {
    return { kind: "user", resolvedBy: run.bindingId === null ? "user via page" : `user via paired binding:${run.bindingId}` };
  }
  if (run.by.onBehalfOf) {
    const sourceTurnId = run.by.onBehalfOf.sourceTurnId;
    return { kind: "lead", resolvedBy: `lead for user via turn:${sourceTurnId}`, onBehalfOf: { actor: "user", sourceTurnId } };
  }
  return { kind: "lead", resolvedBy: "lead" };
}

const APPROVAL_TARGET: UiActionTargetKind<Approval> = {
  type: "approval",
  label: "审批",
  idHint: "审批的编号（整数）",
  load(env, id) {
    const approvalId = positiveId(id);
    return approvalId === null ? null : getApproval(env.db, approvalId) ?? null;
  },
  name: (approval) => `审批 #${approval.id}（${approval.tool}）`,
  // 不给 payload：它是 child 要执行的原始参数。
  describe: (approval) => ({
    id: approval.id, ticketId: approval.item_id, tool: approval.tool, action: approval.action, status: approval.status,
    requestedBy: approval.requested_by, standingOrderProposal: isStandingOrderProposal(approval),
  }),
};

type ApprovalResult = ReturnType<ReturnType<typeof createCoordinator>["resolveApproval"]> & { consumerLive: boolean };

const APPROVAL_ACTIONS = {
  resolve: {
    target: "approval", id: "resolve", label: "处理审批", scope: "approvals:respond",
    // Lead 提议的常设指令修改（工单 10）：Lead 是提议方，只有用户本人能决定（audit.md 第 22 条）。
    permission: (approval) => (isStandingOrderProposal(approval) ? "user_direct" : "user_only"),
    permissionNote: "你可以自己判断批不批，在哪一轮都行；读过外部内容的一轮除外。你自己提议的常设指令修改只有用户本人能决定",
    // 用户 2026-10-28：「lead agent 能自己审批吗，不要啥都让我审批」。放开 userTurnOnly。child 不能借 Lead 批准自己：
    // child 的凭证没有 approvals:respond（d6f48e49），Lead 批不批由 Lead 判断。外部的话不能替用户批（externalTurnFloor）。
    externalTurnFloor: "这是批准 child 的动作",
    // 批准常设指令的提议会改规则，但它是 user_direct，Lead 在哪一轮都做不了；别的审批不改规则。
    changesRules: false, external: false, irreversible: false,
    where: (approval) => (isStandingOrderProposal(approval)
      ? "会话里的确认卡，或者 设置 → Lead → 常设指令"
      : "会话里的审批卡、工单详情，或者 Slack 消息上的批准按钮"),
    hint: "child 执行不可逆动作（发邮件、下单、删除）前要的审批。decision：approve 批准，reject 拒绝，"
      + "approve_session 批准，并且这张工单里同类动作以后不再问。先看工单的目标和这个动作：符合用户要做的事就批，"
      + "不确定、或者动作会伤到用户（删数据、花钱、以用户的名义对外说话而用户没要过）时问用户。reason 写你凭什么批。",
    defaultReason: "在审批卡上处理",
    available: (approval) => {
      if (isStandingOrderProposal(approval)) {
        return unavailable("这是 Lead 提议的常设指令修改，只能在确认卡或者 设置 → Lead → 常设指令 里决定。");
      }
      if (approval.item_id === null) return unavailable(`审批 #${approval.id} 没有挂在工单上，不能在这里处理。`);
      return AVAILABLE;
    },
    run: (run): ApprovalResult => {
      // 发起审批的 Run 还活着吗：处理之前看（「不是我」撤销时要它）。
      const consumerLive = approvalConsumerLive(run.db, run.target);
      const result = createCoordinator({ db: run.db, now: () => run.env.now }).resolveApproval({
        approvalId: run.target.id,
        decision: run.input.decision,
        actor: interventionActor(run),
        ...(run.reasonGiven ? { reason: run.reason } : {}),
      });
      return { ...result, consumerLive };
    },
    // 只给状态：审批这一行的 payload 是 child 原样传入的，可能有密钥或注入文字（审查 2026-10-22 第 1 条）。
    forLead: (_run, result) => {
      const { status, approval } = result as ApprovalResult;
      return { status, approval: { id: approval.id, status: approval.status, sessionExempt: Boolean(approval.session_exempt) } };
    },
    appearedAt: (approval) => latestInstantOf(approval.created_at),
    detail: (run, result) => ({
      approvalId: run.target.id, decision: run.input.decision,
      status: (result as ApprovalResult).approval.status, idempotent: (result as ApprovalResult).status === "idempotent",
    }),
    ownerActionInput: (run, result) => {
      const done = result as ApprovalResult;
      if (run.target.status !== "pending" || done.status !== "resolved") return null;
      return approvalOwnerAction(run.db, run.target, run.input.decision, done.consumerLive);
    },
  },
} satisfies Record<string, UiActionDefinition<Approval, UiActionInputOf<"approval", "resolve">>>;

const DECISION_TARGET: UiActionTargetKind<DecisionRequest> = {
  type: "decision",
  label: "决定请求",
  idHint: "决定请求的编号（整数）",
  load(env, id) {
    const requestId = positiveId(id);
    return requestId === null ? null : getDecisionRequest(env.db, requestId) ?? null;
  },
  name: (request) => `决定请求 #${request.id}`,
  describe: (request) => ({
    id: request.id, ticketId: request.itemId, audience: request.audience, state: request.state, prompt: request.prompt,
    options: request.options.map((option) => ({ id: option.id, label: option.label })), allowCustom: request.allowCustom,
  }),
};

type DecisionResult = ReturnType<ReturnType<typeof createCoordinator>["resolveDecision"]>;

const DECISION_ACTIONS = {
  resolve: {
    target: "decision", id: "resolve", label: "回答决定请求", scope: "approvals:respond",
    // 按受众分档（用户 2026-10-22）：lead、lead_or_user 你可以自己决定；user 只属于用户。
    permission: (request) => (request.audience === "user" ? "user_only" : "lead_allowed"),
    permissionNote: "你可以自己判断，在哪一轮都行。audience 是 user 的（child 指名问用户）在读过外部内容的一轮里不能替用户答",
    // 用户 2026-10-28：「不要啥都让我审批」。放开 userTurnOnly：child 指名问用户的，Lead 也能答（coordinator 的
    // audienceAllows）。外部的话不能替用户答（externalTurnFloor）。
    externalTurnFloor: (request) => (request.audience === "user" ? "这是替用户回答 child 指名问用户的决定" : null),
    changesRules: false, external: false, irreversible: false,
    where: "工单详情的介入卡，或者会话里的决定卡",
    hint: "decision：select 选一个选项（optionId），respond 回答一句话（resolution），dismiss 不处理（原因写在 reason）。"
      + "你知道用户会怎么选时就自己答，reason 写你的依据；真的只有用户能答的（他的偏好、钱、对外的承诺）再问他。"
      + "不要把你自己的选择说成是用户的决定。",
    defaultReason: "在决定卡上处理",
    available: () => AVAILABLE,
    run: (run): DecisionResult => {
      const coordinator = createCoordinator({ db: run.db, now: () => run.env.now });
      const actor = interventionActor(run);
      const input = run.input;
      if (input.decision === "select") {
        return coordinator.resolveDecision({ requestId: run.target.id, decision: "select", optionId: input.optionId, actor });
      }
      if (input.decision === "respond") {
        return coordinator.resolveDecision({ requestId: run.target.id, decision: "respond", resolution: input.resolution, actor });
      }
      return coordinator.resolveDecision({
        requestId: run.target.id, decision: "dismiss", actor, ...(run.reasonGiven ? { reason: run.reason } : {}),
      });
    },
    forLead: (_run, result) => {
      const { status, request } = result as DecisionResult;
      return { status, request: { id: request.id, state: request.state, audience: request.audience } };
    },
    appearedAt: (request) => latestInstantOf(request.createdAt),
    detail: (run, result) => ({
      requestId: run.target.id, decision: run.input.decision, audience: run.target.audience,
      state: (result as DecisionResult).request.state, idempotent: (result as DecisionResult).status === "idempotent",
    }),
    ownerActionInput: (run, result) => (run.target.state === "pending" && (result as DecisionResult).status === "resolved"
      ? decisionOwnerAction(run.db, run.target, run.input.decision)
      : null),
  },
} satisfies Record<string, UiActionDefinition<DecisionRequest, UiActionInputOf<"decision", "resolve">>>;

// ── 外部消息卡（会话里 Slack 这类来源的卡）──────────────────────────────────────────────────
// 卡上的按钮和 Lead 代你回复是同一个操作（用户 2026-10-23：「不想离开工作界面，直接用自然语言让 agent 代我回复」）。
// 发回复、撤回是对外的：Lead 在哪一轮都能做（用户 2026-10-27）。在你本人当前这一轮里做时账本写 actor=lead、onBehalfOf=user，
// 被定时器、Slack 事件叫醒的一轮写 actor=lead。卡的状态和发送都在 daemon 的
// 通道 hub 里（适配器和凭据在那里），这里经 services.channelCards 调它。

// 卡和它最新一条外部消息收到的时间（appearedAt 用：你这一轮开始以后对方又发来的，你说话时还没见过）。
export interface ChannelCardTarget extends ChannelCard {
  lastMessageAt: string;
}

function channelCards(env: UiActionEnv): ChannelCardActionService {
  const service = env.services.channelCards;
  if (!service) throw new UiActionError("unavailable", "还没有接任何外部消息来源");
  return service;
}

// 写进卡的账本的「谁做的」。页面入口照原来的路由写设备名和凭证号；Lead 代你做时写那一轮。
function channelCardBy(run: UiActionRun<ChannelCardTarget, unknown>): string {
  if (run.by.actor === "user") {
    const binding = run.bindingId === null ? undefined : getBinding(run.db, run.bindingId);
    return binding ? `user via ${binding.display_name}（binding ${binding.id}）` : "user via page";
  }
  return run.by.onBehalfOf ? `lead for user via turn:${run.by.onBehalfOf.sourceTurnId}` : "lead";
}

const CHANNEL_CARD_TARGET: UiActionTargetKind<ChannelCardTarget> = {
  type: "channel_card",
  label: "外部消息卡",
  idHint: "卡的编号（整数，消息事件和会话里的卡上有）",
  load(env, id) {
    const cardId = positiveId(id);
    const card = cardId === null ? undefined : getChannelCard(env.db, cardId);
    if (!card) return null;
    return { ...card, lastMessageAt: getEvent(env.db, card.lastSeq)?.receivedAt ?? card.updatedAt };
  },
  name: (card) => `外部消息卡 #${card.id}（${card.sender.name}）`,
  // 不给原文：对方的话是不可信的外部文字，要看时用 read_channel_conversation（包在不可信的标签里）。
  describe: (card) => ({
    id: card.id, source: card.source, sender: card.sender.name, trust: card.sender.trust, state: card.state,
    hasDraft: Boolean(card.draft), messageCount: card.messageCount,
  }),
};

const CARD_WHERE = "会话里的外部消息卡";

type ChannelCardActionInput = { expectedVersion?: number; text?: string; note?: string; emoji?: string; react?: boolean };

// 一个卡片动作的定义。permission：发出去、撤回、不回、我自己回、已处理只属于你；稍后、停掉工单你可以自己判断。
function cardAction(
  id: ChannelCardAction, label: string, options: { permission: ActionPermission; external: boolean; hint: string; defaultReason: string },
): UiActionDefinition<ChannelCardTarget, ChannelCardActionInput> {
  return {
    target: "channel_card", id, label, scope: "tickets:create",
    permission: options.permission, changesRules: false, external: options.external, irreversible: false,
    where: CARD_WHERE, hint: options.hint, defaultReason: options.defaultReason,
    available: (card, env) => (channelCards(env).actionsFor(card.id).includes(id)
      ? AVAILABLE
      : unavailable(`外部消息卡 #${card.id} 现在（${card.state}）不能「${label}」。`)),
    run: (run) => channelCards(run.env).act(run.target.id, id, {
      by: channelCardBy(run), forUser: forUserOf(run),
      ...(run.input.expectedVersion !== undefined ? { expectedVersion: run.input.expectedVersion } : {}),
      ...(run.input.text !== undefined ? { text: run.input.text } : {}),
      ...(run.input.note !== undefined ? { note: run.input.note } : {}),
      ...(run.input.emoji !== undefined ? { emoji: run.input.emoji } : {}),
      ...(run.input.react !== undefined ? { react: run.input.react } : {}),
    }),
    // 只给卡的状态和发出去的字（发出去的是你的话或者卡上的草稿，不是对方的原文）。
    forLead: (_run, result) => {
      const card = result as ChannelCardDto;
      return { card: { id: card.id, state: card.state, sentText: card.sentText, actions: card.actions } };
    },
    // 你这一轮开始以后对方又发来了消息：你说话时还没见过，不算代你做，记成 Lead 自己做的。
    appearedAt: (card) => latestInstantOf(card.lastMessageAt),
    detail: (run, result) => ({ cardId: run.target.id, from: run.target.state, to: (result as ChannelCardDto).state }),
  };
}

const CHANNEL_CARD_ACTIONS = {
  send_draft: cardAction("send_draft", "用草稿回复", {
    permission: "user_only", external: true, defaultReason: "在卡上点了用草稿回复",
    hint: "把卡上的草稿发出去，开头带「confirmed by 用户」的署名。用户让你代他回复、但没有逐字给出原话时："
      + "用 reply_to_source 写你的话直接回复。不在用户这一轮里时，回复由你判断，带 auto-reply 署名发出。",
  }),
  reply_myself: cardAction("reply_myself", "我自己回", {
    permission: "user_only", external: false, defaultReason: "在卡上点了我自己回",
    hint: "用户说他会自己回：卡马上结束，不再推送，也不再等他在来源里回复。",
  }),
  snooze: cardAction("snooze", "稍后", {
    permission: "lead_allowed", external: false, defaultReason: "在卡上点了稍后",
    hint: "过一会儿再提醒用户（缺省一小时）。",
  }),
  dismiss: cardAction("dismiss", "不回", {
    permission: "user_only", external: false, defaultReason: "在卡上点了不回",
    hint: "用户说这条不用回：卡结束。",
  }),
  undo_auto_reply: cardAction("undo_auto_reply", "撤回自动回复", {
    permission: "user_only", external: true, defaultReason: "在卡上点了撤回",
    hint: "撤回窗口里撤回代用户发出的自动回复（来源里的那条消息会被删掉）。",
  }),
  send_edited: cardAction("send_edited", "改一下再发", {
    permission: "user_only", external: true, defaultReason: "在卡上改了草稿再发",
    hint: "把 text 原样发出去，不加署名：发出去的是用户自己的话。只用于用户逐字给出的原话；"
      + "你自己组织的话用 reply_to_source（带署名）。不在用户这一轮里时，回复由你判断，带 auto-reply 署名发出。",
  }),
  cancel_lookup: cardAction("cancel_lookup", "停掉工单", {
    permission: "lead_allowed", external: false, defaultReason: "在卡上点了停掉工单",
    hint: "停掉卡上正在跑的子 agent 工单（你派的，你可以自己判断）。",
  }),
  handled: cardAction("handled", "已处理", {
    permission: "user_only", external: true, defaultReason: "卡上的事在别处做完了",
    hint: "用户让你做卡上的事，你在别处做完了（例如照对方说的私信了别人）：卡结束，note 写做了什么。"
      + "缺省在对方的消息上回 ✅，让对方知道收到并照做了；emoji 换一个（来源里的名字，例如 +1），react=false 不回。"
      + "在卡的这个对话里回复过对方时不回表情（回复就是回应）。",
  }),
} satisfies Record<ChannelCardAction, UiActionDefinition<ChannelCardTarget, ChannelCardActionInput>>;

// ── 外部来源里的一个对话（私信某个人、频道、thread）────────────────────────────────────────
// Lead 代你直接发消息，不经过卡片（用户 2026-10-23：「我需要 lead 具备直接发 slack 的消息能力，而不是依赖于通道卡片」）。
// 发消息是对外的：Lead 在哪一轮都能做（用户 2026-10-27：定时器到点、Slack 事件叫醒的一轮也要能发）。不在用户这一轮里发的
// 署名写 auto-reply。发不发由 Lead 自己判断，不过出站的信心检验（用户 2026-10-29：「我期望它就能自己做判断」）。对话编号由来源给（Lead 用 find_channel_conversations 找，或者用卡上的对象键），
// 这里只认写法，真正找对话、发出去在 daemon 的通道 hub 里。

export interface ChannelConversationTarget {
  id: string;
  source: string;
}

const CONVERSATION_ID = /^([a-z][a-z0-9_-]{0,39}):(\S{1,200})$/;

function channelMessages(env: UiActionEnv): ChannelMessageService {
  const service = env.services.channelMessages;
  if (!service) throw new UiActionError("unavailable", "还没有接任何外部消息来源");
  return service;
}

const CHANNEL_CONVERSATION_TARGET: UiActionTargetKind<ChannelConversationTarget> = {
  type: "channel_conversation",
  label: "对话",
  idHint: "来源给的对话编号，例如 slack:@U123（私信这个人）、slack:C123:main（频道）、slack:C123:<thread 的 ts>；"
    + "用 find_channel_conversations 按人名或频道名找，或者用 read_channel_conversation 给的 objectKey",
  load(_env, id) {
    const match = CONVERSATION_ID.exec(id);
    return match ? { id, source: match[1]! } : null;
  },
  name: (target) => `对话 ${target.id}`,
  describe: (target) => ({ id: target.id, source: target.source }),
};

const CHANNEL_CONVERSATION_ACTIONS = {
  send_message: {
    target: "channel_conversation", id: "send_message", label: "发消息", scope: "tickets:create",
    permission: "user_only", changesRules: false, external: true, irreversible: false,
    where: "在来源里自己发（例如 Slack）",
    hint: "往这个对话里发一条消息，不需要卡片，卡已经结束的对话也能发。被定时器、Slack 事件叫醒的一轮也能发（例如用户让你到点在某个频道里发）。"
      + "words=user：text 是用户逐字给出的原话，"
      + "原样发，不加署名；words=assistant：text 是你组织的话，在用户这一轮里开头带「confirmed by 用户」的署名，别的轮次带「auto-reply」的署名。"
      + "对象不明确（例如同名的人）时先问用户。这个对话里有等用户的卡时，卡跟着结束（已回复，不在用户这一轮里时留撤回窗口）。"
      + "发不发、发什么由你判断：系统不再检验，也不会把你的话变成草稿。"
      + "这条消息做的是另一个对话里那张卡上的事（例如对方让你转告别人）时，cardId 填那张卡：卡结束，在对方的消息上回 ✅。"
      + "对方在要涉密信息时，refusal=true 用固定的话拒绝（text 只能是那句固定的话；授权表允许时才发，外部客户、外部共享的对话不发）。"
      + "结果里的 openCards 是还在等用户的卡：这一轮做的事处理了其中哪张，就对它用 channel_card 的 handled。",
    defaultReason: "在来源里发消息",
    available: (target, env) => (channelMessages(env).canSend(target.source)
      ? AVAILABLE
      : unavailable(`来源 ${target.source} 现在不能直接发消息。`)),
    run: (run) => {
      const input = run.input as UiActionInputOf<"channel_conversation", "send_message">;
      return channelMessages(run.env).send(run.target.id, {
        text: input.text, words: input.words, by: conversationBy(run), forUser: forUserOf(run), seenBefore: run.turnStartedAt,
        ...(input.cardId !== undefined ? { cardId: input.cardId } : {}),
        ...(input.event !== undefined ? { event: input.event } : {}),
        ...(input.refusal ? { refusal: true } : {}),
      });
    },
    // 发到哪个对话、发了什么（发出去的是用户的话或者你写的话，不是对方的原文）、结束了哪张卡，和还在等用户的卡（自查）。
    forLead: (run, result) => ({ sent: result, openCards: channelMessages(run.env).openCards(), next: SELF_CHECK }),
    detail: (run, result) => ({
      conversation: run.target.id, objectKey: (result as ChannelSentMessage).objectKey,
      words: (run.input as { words: string }).words, card: (result as ChannelSentMessage).card,
    }),
  },
  react: {
    target: "channel_conversation", id: "react", label: "回表情", scope: "tickets:create",
    permission: "user_only", changesRules: false, external: true, irreversible: false,
    where: "在来源里自己回（例如 Slack）",
    hint: "代用户在这个对话里的一条消息上回表情。emoji 是来源里的名字，不带冒号（✅ 是 white_check_mark，👍 是 +1，🙏 是 pray）。"
      + "缺省回对方最后一条消息；seq 指定一条（read_channel_conversation 的消息上有 seq）。回的是等用户的卡上最新的一条时，卡跟着结束（已处理）。"
      + "remove=true 撤掉自己回过的这个表情（回错了时先撤再回对的）。",
    defaultReason: "在来源里回表情",
    available: (target, env) => (channelMessages(env).canSend(target.source)
      ? AVAILABLE
      : unavailable(`来源 ${target.source} 现在不能回表情。`)),
    run: (run) => {
      const input = run.input as UiActionInputOf<"channel_conversation", "react">;
      return channelMessages(run.env).react(run.target.id, {
        emoji: input.emoji, by: conversationBy(run), seenBefore: run.turnStartedAt,
        ...(input.seq !== undefined ? { seq: input.seq } : {}), ...(input.remove ? { remove: true } : {}),
      });
    },
    forLead: (run, result) => ({ reacted: result, openCards: channelMessages(run.env).openCards(), next: SELF_CHECK }),
    detail: (run, result) => ({
      conversation: run.target.id, seq: (result as ChannelReaction).seq, emoji: (result as ChannelReaction).emoji,
      removed: (run.input as { remove?: boolean }).remove === true, card: (result as ChannelReaction).card,
    }),
  },
} satisfies Record<string, UiActionDefinition<ChannelConversationTarget, any>>;

// 你本人做的，或者 Lead 在你这一轮里代你做的（出站扩展据此定署名，统一消息事件 spec D9）。
function forUserOf(run: UiActionRun<any, unknown>): boolean {
  return run.by.actor === "user" || Boolean(run.by.onBehalfOf);
}

// 账本和卡上的「谁做的」：你本人、Lead 代你（哪一轮）、Lead。
function conversationBy(run: UiActionRun<ChannelConversationTarget, unknown>): string {
  return run.by.actor === "user" ? "user" : run.by.onBehalfOf ? `lead for user via turn:${run.by.onBehalfOf.sourceTurnId}` : "lead";
}

// 发完自查（用户 2026-10-26：说了让 Lead 去做，卡不应该还等着用户点）。
const SELF_CHECK = "openCards 是还在等用户的卡。这一轮做的事处理了其中哪张（例如照对方的话发了消息），"
  + "就对它用 perform_action（target_type=channel_card，action=handled，input.note 写做了什么）；没处理的不要动。";

// ── 一个来源的自动代你处理（设置 → 消息通道，2026-10-23）──────────────────────────────────────
// 开关、授权表和信心模型的参数存在常设指令 channel.authority（来源自己的一条，或者所有来源共用的 "*"），有版本和历史。
// 打开开关、放宽参数等于给 Lead 更大的权力：update 只有你本人能做（Lead 拿到结构化的拒绝）。关掉开关、收紧参数只减少
// Lead 代你做的事：tighten Lead 可以自己判断（和常设指令的规则一样：收紧 Lead 能直接改），有一项放宽就拒绝；改了照常
// 写一条 standing_order.changed（摘要级别），告诉你。test、replay 只读：test 让请求 A、B 真的给一条消息打分；replay 用过去 24 小时
// 的消息（请求 A 当时的结果，草稿没记下分数的现在调请求 B）。上一次的分数换参数再算是纯函数。

export interface ChannelPolicyTarget {
  source: string;
  policy: ChannelPolicy;
}

const POLICY_SOURCE = /^[a-z][a-z0-9_-]{0,39}$/;
const POLICY_WHERE = "设置 → 消息通道 → 自动代你处理";

function channelPolicyTests(env: UiActionEnv): ChannelPolicyTestService {
  const service = env.services.channelPolicyTests;
  if (!service) throw new UiActionError("unavailable", "还没有接任何外部消息来源");
  return service;
}

function policyStandingOrderParams(target: ChannelPolicyTarget, params: ChannelPolicyParams): Record<string, unknown> {
  return { source: target.policy.scope, intents: params.intents, autoReply: params.autoReply, model: params.confidence };
}

// 键按字母排的 JSON：比较两份参数时不看键的顺序。
function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    : item));
}

function policyProblems(params: ChannelPolicyParams): void {
  const problems = channelConfidenceProblems(params.confidence);
  if (problems.length) throw new UiActionError("invalid_input", problems.join("；"));
}

function standingOrderError(error: unknown): never {
  if (error instanceof StandingOrderChangeError) {
    throw new UiActionError(error.code === "invalid_request" ? "invalid_input" : error.code === "conflict" ? "stale" : error.code, error.message);
  }
  throw error;
}

// 写一个新版本。你本人：作者 user，直接生效（放宽也一样）。Lead：只能收紧，作者 lead，写 standing_order.changed 告诉你。
function writeChannelPolicy(run: UiActionRun<ChannelPolicyTarget, ChannelPolicyParams>, mode: "update" | "tighten"): unknown {
  policyProblems(run.input);
  const order = run.target.policy.order;
  if (order.action.type !== "rule") throw new UiActionError("unavailable", `常设指令 ${order.id} 不是规则`);
  const patch = { action: { ...order.action, params: policyStandingOrderParams(run.target, run.input) } };
  const reason = run.reason;
  // 和最新版本写的一样：不写新版本（写明缺省值也算一样）。
  if (sortedJson(run.input) === sortedJson(run.target.policy.requested)) {
    return { order: { id: order.id, version: order.version }, unchanged: true };
  }
  try {
    if (run.by.actor === "user") {
      const { written } = updateStandingOrderByUser(run.db, {
        id: order.id, patch, reason, resolvedBy: "user via 设置 → 消息通道", now: run.env.now,
      });
      return { order: { id: written.order.id, version: written.order.version } };
    }
    const plan = planStandingOrderChange(run.db, { op: "update", id: order.id, patch, reason });
    if (!plan.classification.changed) return { order: { id: order.id, version: order.version }, unchanged: true };
    if (mode === "tighten" && plan.classification.tier !== "conservative") {
      const loosened = plan.classification.findings.filter((item) => item.tier !== "conservative").map((item) => item.detail);
      throw new UiActionError("user_direct", `这次改动有放宽的（${loosened.join("；")}），只有用户本人能改：请他在 ${POLICY_WHERE} 里自己改。`);
    }
    const proposed = proposeStandingOrderChange(run.db, { op: "update", id: order.id, patch, reason }, { now: run.env.now });
    if (proposed.outcome !== "applied") throw new UiActionError("forbidden", `没有改成（${proposed.outcome}）：${proposed.plan.summary}`);
    return { order: { id: proposed.written.order.id, version: proposed.written.order.version } };
  } catch (error) {
    standingOrderError(error);
  }
}

const CHANNEL_POLICY_TARGET: UiActionTargetKind<ChannelPolicyTarget> = {
  type: "channel_policy",
  label: "自动代你处理",
  idHint: "来源，例如 slack",
  load(env, id) {
    if (!POLICY_SOURCE.test(id)) return null;
    const policy = channelPolicy(env.db, id);
    return policy ? { source: id, policy } : null;
  },
  name: (target) => `${target.source} 的自动代你处理`,
  describe: (target) => ({
    source: target.source,
    autoReply: target.policy.params.autoReply,
    intents: target.policy.params.intents,
    confidence: target.policy.params.confidence,
    order: { id: target.policy.order.id, version: target.policy.order.version, scope: target.policy.scope },
  }),
};

// 自动代你处理（授权表）：update 和 tighten 都是改规则的操作。只读的 test、replay 不是。
const CHANNEL_POLICY_ACTIONS = {
  update: {
    target: "channel_policy", id: "update", label: "改自动代你处理", scope: "tickets:create",
    permission: "user_direct", changesRules: true, external: false, irreversible: false,
    where: POLICY_WHERE,
    hint: "打开开关、放宽门槛和权重、放开授权表：只有用户本人能做。只收紧时用 tighten。",
    defaultReason: "在设置页改了自动代你处理",
    available: () => AVAILABLE,
    run: (run) => writeChannelPolicy(run as UiActionRun<ChannelPolicyTarget, ChannelPolicyParams>, "update"),
    forLead: (_run, result) => result,
    detail: (run, result) => ({ autoReply: (run.input as ChannelPolicyParams).autoReply, order: (result as { order?: unknown }).order ?? null }),
  },
  tighten: {
    target: "channel_policy", id: "tighten", label: "收紧自动代你处理", scope: "tickets:create",
    permission: "lead_allowed", changesRules: true, external: false, irreversible: false,
    where: POLICY_WHERE,
    hint: "input 是改完以后的一整份（先用 list_actions 看现在的 autoReply、intents、confidence，只改要收紧的项）："
      + "关掉自动代你处理（autoReply=false）、提高门槛、调高指数、把授权表的一项改成问你。有一项放宽就会被拒绝。"
      + "改了会告诉用户。用户说「先别自动回了」「review 也先问我」这类话时用。",
    defaultReason: "收紧自动代你处理",
    available: () => AVAILABLE,
    run: (run) => writeChannelPolicy(run as UiActionRun<ChannelPolicyTarget, ChannelPolicyParams>, "tighten"),
    forLead: (_run, result) => result,
    detail: (run, result) => ({ autoReply: (run.input as ChannelPolicyParams).autoReply, order: (result as { order?: unknown }).order ?? null }),
  },
  test: {
    target: "channel_policy", id: "test", label: "测一条消息", scope: "tickets:view",
    permission: "lead_allowed", changesRules: false, external: false, irreversible: false, readOnly: true,
    where: POLICY_WHERE,
    hint: "按给的参数（不给时用现在生效的）算一条消息的结论：能否代处理、能否代回、落在哪一档、信心的每一项。"
      + "case 是 {kind=message, text, audience, sender, draft?, assumeFound}（请求 A、B 真的打分，calls 写明哪个后端、用了多久），"
      + "或者 {kind=scored, scored}（上一次的分数，换了参数再算，不调模型）。只读，不发任何东西。",
    defaultReason: "测一条消息",
    available: () => AVAILABLE,
    // 上一次的分数不调模型，这里直接算；一条消息交给通道 hub，让请求 A、B 打分。
    run: (run) => {
      const request = run.input as UiActionInputOf<"channel_policy", "test">;
      if (request.case.kind === "message") return channelPolicyTests(run.env).test(run.target.source, request);
      return judgePolicyCase(request.case.scored, confidenceParamsFrom(request.params ?? run.target.policy.params), channelCalibration(run.db, run.target.source));
    },
    forLead: (_run, result) => result,
  },
  replay: {
    target: "channel_policy", id: "replay", label: "评估过去 24 小时的消息", scope: "tickets:view",
    permission: "lead_allowed", changesRules: false, external: false, irreversible: false, readOnly: true,
    where: POLICY_WHERE,
    hint: "过去 24 小时别人发来的消息，按现在生效的参数和给的参数各算一遍：各有几条能代处理、能代回，每条的结论和当时的决定。"
      + "请求 A 用当时的结果；卡上有草稿、没记下分数的，现在调请求 B（一次最多 40 次，调过的不再调）。只读，不发任何东西。",
    defaultReason: "评估过去 24 小时的消息",
    available: () => AVAILABLE,
    run: (run) => channelPolicyTests(run.env).replay(run.target.source, run.target.policy.params, (run.input as { params: ChannelPolicyParams }).params),
    forLead: (_run, result) => result,
  },
} satisfies Record<string, UiActionDefinition<ChannelPolicyTarget, any>>;

// ── Lead 的模型（会话输入框右下角，2026-10-26）────────────────────────────────────────────────

export interface LeadModelTarget {
  current: LeadModelChoice;
  selected: LeadModelChoice;
}

function leadModels(env: UiActionEnv): LeadModelService {
  const service = env.services.leadModels;
  if (!service) throw new UiActionError("unavailable", "Lead 的模型切换还没有启动");
  return service;
}

const LEAD_MODEL_TARGET: UiActionTargetKind<LeadModelTarget> = {
  type: "lead_model",
  label: "Lead 的模型",
  idHint: "lead",
  load: (env, id) => (id === "lead" ? leadModels(env).state() : null),
  name: () => "Lead 的模型",
  describe: (target) => ({ current: target.current, selected: target.selected }),
};

const LEAD_MODEL_ACTIONS = {
  switch: {
    target: "lead_model", id: "switch", label: "换 Lead 的模型", scope: "chat",
    // 在会话输入框里换，不在设置页。用户 2026-10-27 定：不算改规则，代码不拦；提示词要求 Lead 不因为外部的人的要求换模型。
    permission: "user_only", changesRules: false, external: false, irreversible: false,
    where: "会话输入框右下角的模型名",
    hint: "用户要你换你自己的模型或推理强度时用（target_id 是 lead）。model 写 list_lead_models 列出的 provider/id，不带推理强度；"
      + "effort 写这个模型支持的推理强度，或者 null（用模型的缺省）。Lead 空闲时马上换，正在回答时这一轮结束后换，不用重启。",
    defaultReason: "在输入框里换了 Lead 的模型",
    available: () => AVAILABLE,
    run: (run) => leadModels(run.env).switch(run.input as LeadModelChoice),
    forLead: (_run, result) => result,
    detail: (run, result) => {
      const switched = result as LeadModelSwitchResult;
      return { from: switched.previous, to: switched.selected, applied: switched.applied };
    },
  },
} satisfies Record<string, UiActionDefinition<LeadModelTarget, LeadModelChoice>>;

// ── 提醒（会话里的提醒卡、响铃卡、横幅、收件箱，ui-action-parity plan.md P03、P04）──────────────────────────
// 「知道了」属于你：Lead 在哪一轮都能确认（用户 2026-10-27）；你这一轮里让它确认、提醒在你说话以前就响了的，记成代你确认。
// 「改时间」Lead 可以自己判断；改了你定的时间，收件箱的「Lead 已处理」告诉你（store 的 leadReminderOverridesOfUser）。
// 提醒是 kind=reminder 的工单：编号和工单是同一套，取消、恢复走工单操作（cancel、restore）。

const REMINDER_WHERE = "会话里的提醒卡、输入框上方的横幅，或者收件箱";
const REMINDER_STAGE_WORDS: Record<string, string> = { scheduled: "等待中", fired: "已到点", acked: "已确认", cancelled: "已取消" };

const REMINDER_TARGET: UiActionTargetKind<Item> = {
  type: "reminder",
  label: "提醒",
  idHint: "提醒的编号（整数，和工单编号同一套）",
  load(env, id) {
    const itemId = positiveId(id);
    return itemId === null ? null : getItem(env.db, itemId) ?? null;
  },
  name: (item) => `提醒 #${item.id}「${item.display_title ?? item.title}」`,
  describe: (item) => ({
    id: item.id, kind: item.kind, title: item.display_title ?? item.title, stage: item.stage, remindAt: item.remind_at,
  }),
};

function reminderBlocker(item: Item, stages: readonly string[], what: string): string | null {
  if (item.kind !== "reminder") {
    return `#${item.id} 是工单，不是提醒，不能${what}：要它到点再出现用 defer_item，要提醒用 create_reminder。`;
  }
  return stages.includes(item.stage) ? null : `提醒 #${item.id} 现在是「${REMINDER_STAGE_WORDS[item.stage] ?? item.stage}」，不能${what}。`;
}

interface ReminderRescheduleResult {
  reminder: Item;
  from: string | null;
  to: string;
  // Lead 自己改了用户定的时间（收件箱要告诉用户）。
  overrodeUser: boolean;
}

const REMINDER_ACTIONS = {
  ack: {
    target: "reminder", id: "ack", label: "知道了", scope: "tickets:create",
    permission: "user_only", changesRules: false, external: false, irreversible: false,
    where: REMINDER_WHERE,
    hint: "确认一条已经到点的提醒（fired → acked，终态）。用户说「交了」「做了」「知道了」时代他确认；"
      + "你确定这件事已经做完时也可以自己确认，reason 写凭什么。",
    defaultReason: "acked by user",
    available: (item) => {
      const blocker = reminderBlocker(item, ["fired"], "确认（只有到点的提醒要确认）");
      return blocker ? unavailable(blocker) : AVAILABLE;
    },
    run: (run) => {
      ackReminder(run.db, run.target.id, run.by, run.by.actor === "user" && !run.reasonGiven ? undefined : run.reason);
      publishGatewayEvent(run.db, itemUpdatedEvent(run.target.id, run.env.now));
      return getItem(run.db, run.target.id) ?? null;
    },
    forLead: (run, result) => ({ reminderId: run.target.id, stage: (result as Item | null)?.stage ?? null }),
    // 响铃（scheduled → fired）的时间：你这一轮开始以后才响的，你说话时还没见过它，记成 Lead 自己确认的。
    appearedAt: (item) => latestInstantOf(item.stage_changed_at),
    detail: (run, result) => ({ reminderId: run.target.id, from: run.target.stage, to: (result as Item | null)?.stage ?? null }),
  },
  reschedule: {
    target: "reminder", id: "reschedule", label: "改时间", scope: "tickets:create",
    permission: "lead_allowed", changesRules: false, external: false, irreversible: false,
    where: REMINDER_WHERE,
    hint: "给提醒改时间（唯一能改提醒时间的入口）：remindAt 是新的时刻（ISO，带时区），或者 snoozeMinutes（多少分钟以后再提醒，"
      + "都不给时是 10 分钟以后）。已经到点、用户还没确认的提醒也能改：它回到等待，到新的时间再响。已确认、已取消的不能改。"
      + "时间是用户定的也可以改，但收件箱的「Lead 已处理」会告诉用户你改了它和理由，所以 reason 写清楚为什么。",
    defaultReason: "rescheduled by user",
    available: (item) => {
      const blocker = reminderBlocker(item, ["scheduled", "fired"], "改时间");
      return blocker ? unavailable(blocker) : AVAILABLE;
    },
    run: (run): ReminderRescheduleResult => {
      const input = run.input as UiActionInputOf<"reminder", "reschedule">;
      const at = input.remindAt !== undefined
        ? new Date(input.remindAt)
        : new Date(run.env.now.getTime() + (input.snoozeMinutes !== undefined ? input.snoozeMinutes * 60_000 : REMINDER_SNOOZE_MS));
      if (Number.isNaN(at.getTime())) throw new UiActionError("invalid_input", `remindAt 不是一个时间：${input.remindAt}`);
      // 这次的时间算谁定的：你本人，或者你在这一轮里让 Lead 改的，算你定的；Lead 自己决定改的算 Lead 定的。
      // Lead 自己改了你定的时间才算覆盖（收件箱要告诉你）。
      const askedIn = leadUserTurnOf(run.db, run.by, run.turnId, "reminder.reschedule", "tickets:create");
      const setBy = run.by.actor === "user" || askedIn !== null ? "user" : "lead";
      const overrodeUser = setBy === "lead" && reminderTimeSetter(run.db, run.target.id) === "user";
      // 谁要求改的（spec D16）：外部的一轮里 Lead 的工具给来源；别的按谁定的算。
      const origin = run.timerOrigin ?? (setBy === "user" ? { kind: "user" as const, turnId: askedIn } : { kind: "system" as const });
      try {
        const reminder = rescheduleReminder(run.db, run.target.id, at, { by: run.by.actor, now: run.env.now });
        recordReminderTimeSetter(run.db, run.target.id, {
          remindAt: at.toISOString(), setBy, actor: run.by.actor, sourceTurnId: askedIn, origin,
        });
        // 用户改了没问就设的外部来源提醒：校准样本「改了」。
        if (setBy === "user") labelTimer(run.db, "reminder", run.target.id, "edited", "user", run.env.now);
        return { reminder, from: run.target.remind_at, to: at.toISOString(), overrodeUser };
      } catch (error) {
        if (!(error instanceof ReminderRescheduleError)) throw error;
        throw new UiActionError(
          error.code === "not_found" ? "not_found" : error.code === "invalid_time" ? "invalid_input" : "unavailable", error.message,
        );
      }
    },
    forLead: (run, result) => {
      const done = result as ReminderRescheduleResult;
      return {
        reminderId: run.target.id, remindAt: done.to, stage: done.reminder.stage,
        ...(done.overrodeUser ? { note: "这个时间是用户定的：收件箱会告诉用户你改了它和理由" } : {}),
      };
    },
    detail: (run, result) => {
      const done = result as ReminderRescheduleResult;
      return { reminderId: run.target.id, from: done.from, to: done.to, overrodeUser: done.overrodeUser };
    },
  },
} satisfies Record<string, UiActionDefinition<Item, any>>;

// ── 工作区（工单详情的工作区一栏，P04）──────────────────────────────────────────────────
// 释放：共享工作区 Lead 可以自己判断。清理：共享的 Lead 可以自己判断；隔离 worktree 的清理删掉目录，不可逆，只属于你。
// 「现在能不能做」是 workspace-actions.ts 的 workspaceActionBlocker，工单详情的按钮读的也是它。已经做过的再做一次什么都不改，放行。

const WORKSPACE_WHERE = "工单详情的工作区一栏";

const WORKSPACE_TARGET: UiActionTargetKind<Workspace> = {
  type: "workspace",
  label: "工作区",
  idHint: "工作区的编号（整数；按工单找时用 release_workspace、cleanup_workspace 的 item_id）",
  load(env, id) {
    const workspaceId = positiveId(id);
    return workspaceId === null ? null : getWorkspace(env.db, workspaceId) ?? null;
  },
  name: (workspace) => `工作区 #${workspace.id}（工单 #${workspace.owner_item_id}）`,
  describe: (workspace) => ({
    id: workspace.id, ownerTicketId: workspace.owner_item_id, mode: workspace.mode, kind: workspace.kind, state: workspace.state,
    mergeStatus: workspace.merge_status, worktree: Boolean(workspace.git_worktree),
  }),
};

function workspaceAction(
  action: WorkspaceActionId,
  options: Pick<UiActionDefinition<Workspace>, "label" | "permission" | "permissionNote" | "irreversible" | "confirm" | "hint" | "defaultReason">,
): UiActionDefinition<Workspace, { mergeStatus?: "merged" | "abandoned"; confirm?: true }> {
  return {
    target: "workspace", id: action, scope: "tickets:create", changesRules: false, external: false, where: WORKSPACE_WHERE, ...options,
    available: (workspace, env) => {
      if (workspaceActionDone(workspace, action)) return AVAILABLE;
      const blocker = workspaceActionBlocker(env.db, workspace, action);
      return blocker ? unavailable(blocker) : AVAILABLE;
    },
    run: (run) => {
      const result = performWorkspaceAction(run.db, {
        action, workspaceId: run.target.id, by: run.by,
        ...(run.reasonGiven || run.by.actor === "lead" ? { reason: run.reason } : {}),
        ...(action === "release" && run.input.mergeStatus ? { mergeStatus: run.input.mergeStatus } : {}),
      });
      publishGatewayEvent(run.db, itemUpdatedEvent(result.itemId, run.env.now));
      return result;
    },
    forLead: (_run, result) => {
      const done = result as WorkspaceActionResult;
      return {
        action: done.action, ticketId: done.itemId, status: done.status,
        workspace: { id: done.workspace.id, state: done.workspace.state, mode: done.workspace.mode },
      };
    },
    detail: (run, result) => ({
      workspaceId: run.target.id, ticketId: (result as WorkspaceActionResult).itemId, from: run.target.state,
      status: (result as WorkspaceActionResult).status,
    }),
    // 真的释放或清理了才记（already_* 什么也没改）。
    ownerActionInput: (run, result) => {
      const done = result as WorkspaceActionResult;
      return done.status === "already_released" || done.status === "already_cleaned"
        ? null
        : workspaceOwnerAction(run.db, run.target.id, action, done);
    },
  };
}

const WORKSPACE_ACTIONS = {
  release: workspaceAction("release", {
    label: "释放工作区", permission: "lead_allowed", irreversible: false,
    hint: "工单结束以后交还它的共享工作区（不改工单的 stage）。隔离 worktree 不在这里释放：合并用 integrate_workspace，"
      + "放弃用工单操作 abandon。",
    defaultReason: "released by user",
  }),
  cleanup: workspaceAction("cleanup", {
    label: "清理工作区",
    permission: (workspace) => (workspace.git_worktree ? "user_only" : "lead_allowed"),
    permissionNote: "共享工作区你可以自己判断；隔离 worktree 的清理会删掉 worktree 目录，不可逆，要带 confirm=true，想清楚再做",
    irreversible: (workspace) => Boolean(workspace.git_worktree),
    // 已经清理过的再清理一次什么都不改，不用确认。
    confirm: (workspace) => (workspace.git_worktree && !workspaceActionDone(workspace, "cleanup")
      ? `清理工作区 #${workspace.id} 会删掉隔离 worktree 的目录（${workspace.path}），不能撤销；分支和快照留着。`
      : null),
    hint: "清理已经释放的工作区。清理前检查没有在跑的 Run、工作区干净；有没保存的改动或者还没释放时拒绝。"
      + "隔离 worktree 的清理要确认：确定可以删掉时，input 带 confirm=true。",
    defaultReason: "cleaned by user",
  }),
} satisfies Record<WorkspaceActionId, UiActionDefinition<Workspace, any>>;

// ── 工单的日期节点（日程、左栏，P04）────────────────────────────────────────────────────
// Lead 可以自己改（截止、提测、发布……），日期是你定的也可以改：收件箱的「Lead 已处理」告诉你改了什么、为什么
// （store 的 leadOverridesOfUser）。节点的出处（谁、哪一轮、理由）记在 item_milestone_changes。

const MILESTONE_TARGET: UiActionTargetKind<ItemMilestone> = {
  type: "milestone",
  label: "日期节点",
  idHint: "节点的编号（整数，list_milestones 里有）",
  load(env, id) {
    const milestoneId = positiveId(id);
    return milestoneId === null ? null : getMilestone(env.db, milestoneId) ?? null;
  },
  name: (milestone) => `节点 #${milestone.id}（工单 #${milestone.item_id} 的「${milestone.label ?? MILESTONE_KIND_LABELS[milestone.kind]}」）`,
  describe: (milestone) => ({
    id: milestone.id, ticketId: milestone.item_id, kind: milestone.kind, label: milestone.label, at: milestone.at,
    allDay: Boolean(milestone.all_day), state: milestone.state, setBy: milestone.source_actor,
  }),
};

const MILESTONE_ACTIONS = {
  update: {
    target: "milestone", id: "update", label: "改日期节点", scope: "tickets:create",
    permission: "lead_allowed", changesRules: false, external: false, irreversible: false,
    where: "日程，或者工单详情的日期",
    hint: "改一个工单节点：改时间（at，ISO）、全天（allDay）、显示名（label），标完成（state=done）、没赶上（missed）、"
      + "取消（cancelled）或恢复（planned）。只改给出的字段。日期是用户定的也可以改，但收件箱的「Lead 已处理」会把你改了什么、"
      + "为什么告诉用户，所以 reason 写清楚。",
    defaultReason: "changed by user",
    available: () => AVAILABLE,
    run: (run): MilestoneUpdate => {
      const input = run.input as UiActionInputOf<"milestone", "update">;
      let result: MilestoneUpdate;
      try {
        result = updateMilestone(run.db, run.target.id, {
          ...(input.at === undefined ? {} : { at: input.at }),
          ...(input.allDay === undefined ? {} : { allDay: input.allDay }),
          ...(input.label === undefined ? {} : { label: input.label }),
          ...(input.state === undefined ? {} : { state: input.state }),
        }, run.by.actor === "user"
          ? { actor: "user", ...(run.reasonGiven ? { reason: run.reason } : {}), now: run.env.now }
          : { actor: "lead", turnId: run.turnId, reason: run.reason, now: run.env.now });
      } catch (error) {
        throw new UiActionError("invalid_input", error instanceof Error ? error.message : String(error));
      }
      if (result.change) publishGatewayEvent(run.db, itemUpdatedEvent(result.milestone.item_id, run.env.now));
      return result;
    },
    forLead: (run, result) => {
      const done = result as MilestoneUpdate;
      return {
        milestoneId: run.target.id, change: done.change?.change ?? null, at: done.milestone.at, state: done.milestone.state,
        ...(done.overrodeUser ? { note: "这个日期是用户定的：收件箱会告诉用户你改了它和理由" } : {}),
      };
    },
    detail: (run, result) => {
      const done = result as MilestoneUpdate;
      return {
        milestoneId: run.target.id, ticketId: run.target.item_id, change: done.change?.change ?? null,
        overrodeUser: done.overrodeUser,
      };
    },
  },
} satisfies Record<string, UiActionDefinition<ItemMilestone, any>>;

// ── Lead 忙时排着的外部消息（主对话输入框上方的排队状态栏，工单 10）────────────────────────────────
// 排到下一个只改 Lead 处理的先后：Lead 可以自己判断。移出队列等于在卡上点「我自己回」（卡结束，Lead 不再处理），
// 和卡上的按钮一样只属于你：Lead 在哪一轮都能做，在你本人这一轮里做时记成代你做。排队在 daemon 里，这里经 services.leadQueue 调它。

export type LeadQueueTarget = LeadQueueEntry;

function leadQueue(env: UiActionEnv): LeadQueueService {
  const service = env.services.leadQueue;
  if (!service) throw new UiActionError("unavailable", "Lead 的排队还没有启动");
  return service;
}

const QUEUE_WHERE = "主对话输入框上方的排队状态栏";

// 给 Lead 看的排队：没有对方的原话（不可信的外部文字，要看时用 get_channel_card）。
function queueForLead(queue: LeadQueue): Record<string, unknown> {
  return {
    busy: queue.busy,
    entries: queue.entries.map((entry) => ({
      key: entry.key, conversation: entry.conversation, source: entry.source, senders: entry.senders, count: entry.count,
      cardIds: entry.cardIds, next: entry.next,
    })),
  };
}

const LEAD_QUEUE_TARGET: UiActionTargetKind<LeadQueueTarget> = {
  type: "lead_queue",
  label: "排着的外部消息",
  idHint: "对话的对象键，例如 slack:@U123（卡上的 objectKey）",
  load: (env, id) => leadQueue(env).snapshot().entries.find((entry) => entry.key === id) ?? null,
  name: (entry) => `排着的${entry.conversation}（${entry.count} 条）`,
  describe: (entry) => ({
    key: entry.key, conversation: entry.conversation, source: entry.source, senders: entry.senders, count: entry.count,
    cardIds: entry.cardIds, next: entry.next,
  }),
};

// 「谁做的」写进卡的账本，和卡上的按钮一样（channelCardBy）。排着的追问的取消也这样写。
function queueBy(run: UiActionRun<unknown, unknown>): string {
  if (run.by.actor === "user") {
    const binding = run.bindingId === null ? undefined : getBinding(run.db, run.bindingId);
    return binding ? `user via ${binding.display_name}（binding ${binding.id}）` : "user via page";
  }
  return run.by.onBehalfOf ? `lead for user via turn:${run.by.onBehalfOf.sourceTurnId}` : "lead";
}

const LEAD_QUEUE_ACTIONS = {
  move_next: {
    target: "lead_queue", id: "move_next", label: "排到下一个", scope: "chat",
    // 只改 Lead 处理的先后，不是改规则（external-content.ts）：外部的一轮里也能做。
    permission: "lead_allowed", changesRules: false, external: false, irreversible: false,
    where: QUEUE_WHERE,
    hint: "这一轮结束以后先处理这个对话排着的消息（例如用户说先看某个人的）。只改先后，不处理消息。",
    defaultReason: "在排队里点了排到下一个",
    available: (entry) => (entry.actions.includes("move_next") ? AVAILABLE : unavailable(`${entry.conversation}已经是下一个。`)),
    run: (run) => leadQueue(run.env).moveNext(run.target.key),
    forLead: (_run, result) => queueForLead(result as LeadQueue),
    detail: (run) => ({ key: run.target.key, cardIds: run.target.cardIds, count: run.target.count }),
  },
  remove: {
    target: "lead_queue", id: "remove", label: "移出队列", scope: "tickets:create",
    // 和卡上的「我自己回」一样，不是改规则。
    permission: "user_only", changesRules: false, external: false, irreversible: false,
    where: QUEUE_WHERE,
    hint: "用户说这个对话他自己处理：排着的消息移出队列，它们的卡结束（和卡上的「我自己回」一样），你不再处理它们。",
    defaultReason: "在排队里点了移出队列",
    available: () => AVAILABLE,
    run: (run) => leadQueue(run.env).remove(run.target.key, queueBy(run)),
    forLead: (_run, result) => queueForLead(result as LeadQueue),
    // 你这一轮开始以后这个对话又进来了消息：你说话时还没见过，不算代你做，记成 Lead 自己做的。
    appearedAt: (entry) => latestInstantOf(entry.lastAt),
    detail: (run) => ({ key: run.target.key, cardIds: run.target.cardIds, count: run.target.count }),
  },
} satisfies Record<string, UiActionDefinition<LeadQueueTarget, any>>;

// ── Lead 忙时用户排着的追问（主对话输入框上方的状态栏，用户 2026-10-28）────────────────────────────────
// 用户选「排队」发出的话（pi 的 followUp），或者因为这一轮读过外部内容、要单独开一轮的话（daemon 的 carryOverTurns）。
// 插进这一轮（steer）：只属于用户，Lead 在哪一轮都能做，读过外部内容的一轮里不能做（externalTurnFloor）。
// 不再发给 Lead（cancel）：user_direct，Lead 永远不能删掉用户说过的话。排队在 daemon 里，这里经 services.followUps 调它。

function followUps(env: UiActionEnv): FollowUpQueueService {
  const service = env.services.followUps;
  if (!service) throw new UiActionError("unavailable", "Lead 的会话还没有启动");
  return service;
}

const FOLLOW_UP_WHERE = "主对话输入框上方的状态栏";
// 给 Lead 看的用户原话最多这么多字。
const FOLLOW_UP_TEXT_MAX = 200;

function clipText(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

const FOLLOW_UP_TARGET: UiActionTargetKind<FollowUpEntry> = {
  type: "follow_up",
  label: "排着的追问",
  idHint: "用户那一轮的 turn id（turn_ 开头）",
  load: (env, id) => followUps(env).snapshot().find((entry) => entry.turnId === id) ?? null,
  name: (entry) => `排着的追问「${clipText(entry.text, 30)}」`,
  describe: (entry) => ({
    turnId: entry.turnId, text: clipText(entry.text, FOLLOW_UP_TEXT_MAX), at: entry.at, heldForOwnTurn: entry.heldForOwnTurn,
  }),
};

const FOLLOW_UP_ACTIONS = {
  steer: {
    target: "follow_up", id: "steer", label: "插进这一轮", scope: "chat",
    // 用户 2026-10-28：只属于用户；外部的话不能替用户把他排着的话插进来（和替用户批准一样的底线）。
    permission: "user_only", externalTurnFloor: "这是把用户排着的话插进正在做的这一轮",
    changesRules: false, external: false, irreversible: false,
    where: FOLLOW_UP_WHERE,
    hint: "把用户排着的一条追问插进你正在做的这一轮（和他发送时选「插话」一样），例如他说「先看我刚才那句」。"
      + "读过外部内容的一轮里做不了。",
    defaultReason: "在状态栏点了 Steer",
    available: (entry) => (entry.heldForOwnTurn
      ? unavailable(`${entry.heldReason ?? "这一轮读过外部内容，这条要单独开一轮"}。`)
      : AVAILABLE),
    run: (run) => followUps(run.env).steer(run.target.turnId),
    forLead: (_run, result) => result,
    // 你这一轮开始以后才发来的追问：你说话时还没见过它，不算代你做，记成 Lead 自己做的。
    appearedAt: (entry) => latestInstantOf(entry.at),
    detail: (run, result) => ({ turnId: run.target.turnId, placement: (result as { placement?: unknown }).placement ?? null }),
  },
  cancel: {
    target: "follow_up", id: "cancel", label: "不再发给 Lead", scope: "chat",
    // 用户 2026-10-28：Lead 永远不能删掉用户说过的话。Lead 调用总是拿到拒绝，告诉用户去状态栏点。
    permission: "user_direct", changesRules: false, external: false, irreversible: false,
    where: FOLLOW_UP_WHERE,
    hint: "用户排着的一条追问不再发给你，你不回答它。只有用户本人能做：你不能替用户收回他说过的话。",
    defaultReason: "在状态栏点了 ×",
    available: () => AVAILABLE,
    run: (run) => followUps(run.env).cancel(run.target.turnId, queueBy(run)),
    forLead: (_run, result) => result,
    detail: (run, result) => ({
      turnId: run.target.turnId, heldForOwnTurn: run.target.heldForOwnTurn,
      placement: (result as { placement?: unknown }).placement ?? null,
    }),
  },
} satisfies Record<string, UiActionDefinition<FollowUpEntry, any>>;

// ── 清单 ─────────────────────────────────────────────────────────────────────────

export const UI_ACTION_TARGETS: { readonly [T in UiActionTargetType]: UiActionTargetKind<any> } = {
  runtime: RUNTIME_TARGET,
  device: DEVICE_TARGET,
  approval: APPROVAL_TARGET,
  decision: DECISION_TARGET,
  channel_card: CHANNEL_CARD_TARGET,
  channel_conversation: CHANNEL_CONVERSATION_TARGET,
  channel_policy: CHANNEL_POLICY_TARGET,
  lead_model: LEAD_MODEL_TARGET,
  reminder: REMINDER_TARGET,
  workspace: WORKSPACE_TARGET,
  milestone: MILESTONE_TARGET,
  rule_change: RULE_CHANGE_TARGET,
  lead_queue: LEAD_QUEUE_TARGET,
  timer: TIMER_TARGET,
  timer_request: TIMER_REQUEST_TARGET,
  follow_up: FOLLOW_UP_TARGET,
  reply_style: REPLY_STYLE_TARGET,
  channel_handbook: CHANNEL_HANDBOOK_TARGET,
  model_settings: MODEL_SETTINGS_TARGET,
  memory_settings: MEMORY_SETTINGS_TARGET,
  core_memory: CORE_MEMORY_TARGET,
  core_memory_change: CORE_MEMORY_CHANGE_TARGET,
  memory_fact: MEMORY_FACT_TARGET,
  setup_hint: SETUP_HINT_TARGET,
  widget_board: WIDGET_BOARD_TARGET,
  widget: WIDGET_TARGET,
};

export const UI_ACTIONS: { readonly [T in UiActionTargetType]: Readonly<Record<string, UiActionDefinition>> } = {
  runtime: RUNTIME_ACTIONS,
  device: DEVICE_ACTIONS,
  approval: APPROVAL_ACTIONS,
  decision: DECISION_ACTIONS,
  channel_card: CHANNEL_CARD_ACTIONS,
  channel_conversation: CHANNEL_CONVERSATION_ACTIONS,
  channel_policy: CHANNEL_POLICY_ACTIONS,
  lead_model: LEAD_MODEL_ACTIONS,
  reminder: REMINDER_ACTIONS,
  workspace: WORKSPACE_ACTIONS,
  milestone: MILESTONE_ACTIONS,
  // 改规则被拦下以后的确认卡（工单 09）：定义在 rule-change-confirmations.ts，它要执行别的操作。
  rule_change: RULE_CHANGE_ACTIONS,
  lead_queue: LEAD_QUEUE_ACTIONS,
  // 定时器（spec D16，工单 12）：提醒列表里的取消，和外部的人要求设的定时器的确认卡。定义在 timers.ts。
  timer: TIMER_ACTIONS,
  timer_request: TIMER_REQUEST_ACTIONS,
  follow_up: FOLLOW_UP_ACTIONS,
  // 代回复风格（2026-10-28）：改和提炼。定义在 reply-style.ts。
  reply_style: REPLY_STYLE_ACTIONS,
  channel_handbook: CHANNEL_HANDBOOK_ACTIONS,
  // 设置 → 模型（2026-10-29）：大脑和直觉的分工、服务商、直觉的每一条。定义在 model-settings.ts。
  model_settings: MODEL_SETTINGS_ACTIONS,
  memory_settings: MEMORY_SETTINGS_ACTIONS,
  // 常驻偏好（2026-10-29）：改、删和撤销一次改动。定义在 core-memory.ts。
  core_memory: CORE_MEMORY_ACTIONS,
  core_memory_change: CORE_MEMORY_CHANGE_ACTIONS,
  // Hindsight 里一条事实的失效和恢复（2026-10-29）。定义在 memory-facts.ts。
  memory_fact: MEMORY_FACT_ACTIONS,
  // 建议卡的「以后再说」「不用再提」（首次启动引导，2026-10-30）。定义在 setup-hints.ts。
  setup_hint: SETUP_HINT_ACTIONS,
  // 自定义控件（2026-10-30，.scratch/custom-views/spec.md）：建、排序、视图改名、改、删。定义在 widgets.ts。
  widget_board: WIDGET_BOARD_ACTIONS,
  widget: WIDGET_ACTIONS,
};

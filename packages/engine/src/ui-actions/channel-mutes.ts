// 静音一个外部对话（工单 #533，protocol 的 channel-mutes.ts、engine 的 channels/mute.ts）：channel_conversation 的 mute、unmute。
// 页面（POST /v1/actions/channel_conversation/<对象键>/<操作>，「Lead 动态」卡上的「取消静音」「撤销」）和 Lead（perform_action）
// 调同一个定义：
//   - mute：静音 N 分钟（最长按常设指令 channel.mute 的 maxMuteMs）。只减少处理、不放开权限：不算改规则，
//     外部消息叫醒的一轮也能做。防滥用：带着外部内容的一轮（用户本人正在说话的一轮除外）只能静音叫醒这一轮的对话
//     （ExternalContentSource.conversation），不能借外部消息去静音别的对话。被拒时写明 Lead 下一步怎么做。
//   - unmute：提前取消。现在没在静音时做不了（卡上的按钮跟着消失）。
// 每次都在「Lead 动态」里记一笔（channel_mute.started / ended）。
import { getChannelLane, activeChannelMute, channelMutePolicy, type Db } from "@pi-lead-child/store";
import { muteConversation, unmuteConversation } from "../channels/mute.js";
import { AVAILABLE, unavailable } from "../ticket-actions/types.js";
import { isLiveUserTurn } from "./authority.js";
import type { ChannelConversationTarget } from "./catalog.js";
import { UiActionError, type UiActionDefinition, type UiActionRun } from "./types.js";

const MINUTE = 60_000;
const SCOPE = "tickets:create" as const;
export const CHANNEL_MUTE_WHERE = "「Lead 动态」里静音的那张卡";

// 这个对话收到过消息没有（有道，或者有这个对象的事件）：Lead 写错了编号（例如用了 slack:@U123 而不是对象键）时，静音不会生效。
function knownConversation(db: Db, objectKey: string): boolean {
  if (getChannelLane(db, objectKey)) return true;
  return db.prepare("SELECT 1 FROM events WHERE entity_key = ? LIMIT 1").get(objectKey) !== undefined;
}

/**
 * 带着外部内容的一轮能静音哪些对话：叫醒这一轮的外部消息所在的对话。不受限时（你本人做、这一轮没有外部内容、
 * 用户本人正在说话的一轮）是 null。
 */
function externalMuteScope(run: UiActionRun<ChannelConversationTarget, unknown>): Set<string> | null {
  if (run.by.actor === "user" || run.externalContent === null) return null;
  if (isLiveUserTurn(run.db, run.turnId, SCOPE)) return null;
  return new Set(run.externalContent.flatMap((source) => (source.via === "message" && source.conversation ? [source.conversation] : [])));
}

function muteRun(run: UiActionRun<ChannelConversationTarget, { minutes: number }>) {
  const { params } = channelMutePolicy(run.db);
  const max = Math.max(1, Math.floor(params.maxMuteMs / MINUTE));
  const minutes = run.input.minutes;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > max) {
    throw new UiActionError("invalid_input", `minutes 要在 1 到 ${max} 之间（最长静音 ${max} 分钟）`);
  }
  if (!knownConversation(run.db, run.target.id)) {
    throw new UiActionError("not_found",
      `认不出对话 ${run.target.id}：用消息事件里的 conversation.key、卡上的对象键，或者 read_channel_conversation 给的 objectKey`);
  }
  const scope = externalMuteScope(run);
  if (scope !== null && !scope.has(run.target.id)) {
    throw new UiActionError("external_turn",
      `这一轮带着外部内容，只能静音叫醒这一轮的对话（${scope.size ? [...scope].join("、") : "这一轮不是外部消息叫醒的"}），`
      + `不能借外部消息去静音别的对话（${run.target.id}）。要静音它，告诉用户为什么，等用户在他自己的一轮里让你做。`);
  }
  const by = run.by.actor === "user" ? "user" as const : "lead" as const;
  const muted = run.db.transaction(() => muteConversation(run.db, {
    objectKey: run.target.id, minutes, by, reason: run.reason, now: run.env.now,
  }))();
  return { conversation: run.target.id, until: muted.record.until, minutes, by };
}

function unmuteRun(run: UiActionRun<ChannelConversationTarget, unknown>) {
  const by = run.by.actor === "user" ? "user" as const : "lead" as const;
  const ended = run.db.transaction(() => unmuteConversation(run.db, {
    objectKey: run.target.id, by, reason: run.reason, now: run.env.now,
  }))();
  if (!ended) throw new UiActionError("stale", `对话 ${run.target.id} 现在没在静音`);
  return { conversation: run.target.id, unmuted: true, by };
}

export const CHANNEL_CONVERSATION_MUTE_ACTIONS = {
  mute: {
    target: "channel_conversation", id: "mute", label: "静音这个对话", scope: SCOPE,
    permission: "lead_allowed", changesRules: false, external: false, irreversible: false,
    where: CHANNEL_MUTE_WHERE,
    hint: "静音一个外部对话 N 分钟（input.minutes；最长多久以常设指令 channel.mute 的 maxMuteMs 为准，超了会告诉你上限）：这段时间它的消息照常记录，"
      + "但不开卡、不叫醒你、不调快模型，到点自动恢复。用在同一个对话反复叫醒你、每次都不用管的时候（例如机器人刷进度、占位、删消息）。"
      + "编号用消息事件里的 conversation.key（也是卡上的对象键）。只减少处理、不放开权限：外部消息叫醒的一轮也能用，"
      + "但那一轮只能静音叫醒它的那个对话。会在「Lead 动态」里记一笔，用户能撤销。reason 写清为什么静音，用户会看到。"
      + "同一个对话短时间里反复叫醒你、你每次都判断不用管时，系统会按常设指令 channel.mute 自己静音它一会儿。",
    defaultReason: "静音这个对话",
    available: () => AVAILABLE,
    run: (run) => muteRun(run as UiActionRun<ChannelConversationTarget, { minutes: number }>),
    forLead: (_run, result) => result,
    detail: (_run, result) => result as Record<string, unknown>,
  },
  unmute: {
    target: "channel_conversation", id: "unmute", label: "取消静音", scope: SCOPE,
    permission: "lead_allowed", changesRules: false, external: false, irreversible: false,
    where: CHANNEL_MUTE_WHERE,
    hint: "提前取消一个对话的静音：它的消息照常处理。会在「Lead 动态」里记一笔。",
    defaultReason: "取消静音",
    available: (target, env) => (activeChannelMute(env.db, target.id, env.now) ? AVAILABLE : unavailable(`对话 ${target.id} 现在没在静音`)),
    run: (run) => unmuteRun(run),
    forLead: (_run, result) => result,
    detail: (_run, result) => result as Record<string, unknown>,
  },
} satisfies Record<string, UiActionDefinition<ChannelConversationTarget, any>>;

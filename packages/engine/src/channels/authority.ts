// 授权表（落地计划 A5，.scratch/confidence-model/landing.md）：按对方的意图，决定通道该做什么。纯函数，不读库、不调模型。
//
// 用户 2026-10-22 定的原则：
//   - 不打扰：机器人或应用发的；多半不用回、也没人请你做事的。
//   - 代你拒绝：问涉密信息的（意图是涉密，或者问到了敏感信息），用固定的话拒绝，记进摘要。
//   - 提醒你：会议的邀约和提醒，不代你回。
//   - 收尾：对方谢你、附和或感叹，回表情；你该谢对方、告别，私信里代你说一句，频道里回表情。
//   - 要干活：代码 review、请你 approve、业务和技术咨询、项目进度。以后交给 Lead 派工单（落地计划 B）。
//   - 别的：问你。
// 底线：外部客户、外部共享的对话（问不到也算），什么都不代你发，只问你。
// 2026-10-27（spec D3，.scratch/unified-message-events/spec.md）：先看要不要回，再看是不是要干活。
//   顺序：机器人 → 底线 → 涉密 → 会议 → 收尾 → 要回的概率低于门槛 → 要干活的意图 → 别的。
//   要回的概率低于门槛的不当成要干活，只记录。例外：你本人或者 Lead 替你在这个对话里最近 30 分钟说过话，
//   对方多半在接着回答：告诉你（tell），不派活。例子：你问 Kent 一个仓库是谁维护的，Kent 回答「不是对外的，是 内部服务」。
// 授权表是用户的授权，按意图写，存成常设指令 channel.authority（缺省值是 protocol 的 CHANNEL_AUTHORITY_DEFAULTS）；
// 信心模型（confidence-model.ts）不按意图分支，它调这里的规则算前面这几步。
// 这里不出现任何具体来源的名字。
import {
  CHANNEL_AUTHORITY_DEFAULTS, CHANNEL_INTENT_LABELS, CHANNEL_WORK_INTENTS, NEVER_DELEGATED_TRUST,
  type ChannelAuthorityTable, type ChannelClosingKind, type ChannelIntent, type ChannelReactionEmoji, type SenderTrust,
} from "@pi-lead-child/protocol";

/** 敏感查询的概率不低于它，就算问到了敏感信息。 */
export const AUTHORITY_SENSITIVE_LIMIT = 0.5;
/** 要回的概率低于它、又没人请你做事的，不打扰（hub 的 noReplyBelow 可以改它）。 */
export const AUTHORITY_NO_REPLY_BELOW = 0.3;
/** 你本人或者 Lead 替你在这个对话里说过话以后多久之内，要回的概率低的消息算在接着回答你：告诉你，不派活。 */
export const AUTHORITY_ANSWER_WINDOW_MS = 30 * 60_000;

/** 代你拒绝时说的固定的话。署名由 hub 加（「auto-reply for 你」）。 */
export const AUTHORITY_REFUSAL_TEXT = "抱歉，这涉及个人或公司的敏感信息，我这边不方便提供。";
/** 代你拒绝以后的撤回窗口。 */
export const AUTHORITY_REVOKE_WINDOW_MS = 10 * 60_000;
/** 读不到常设指令时（库里没有、版本不合格），事件和处置里记的依据：代码里的缺省，版本记 0。 */
export const AUTHORITY_ORDER = { id: "channel.authority", version: 0 } as const;

/** 回复会被谁看到：1 对 1 私信、群聊、频道。 */
export type ChannelAudienceKind = "direct" | "group" | "channel";

export interface AuthorityInput {
  // 请求 A 的回答。意图没问到时是 null（按「别的」）。
  intent: ChannelIntent | null;
  closing: ChannelClosingKind | null;
  reaction: ChannelReactionEmoji | null;
  needsReply: number | null;
  // 6 个敏感查询的概率。null：没问到。
  sensitive: Readonly<Record<string, number>> | null;
  sender: { trust: SenderTrust; bot: boolean };
  // null：问不到，按外部共享对待。
  externalShared: boolean | null;
  audience: ChannelAudienceKind | null;
  // 这个来源能做的出站动作，和这条消息能不能被回表情（有自己的引用）。
  capabilities: { reply: boolean; react: boolean };
  reactable: boolean;
  // 要回的概率低于它就不打扰。缺省 AUTHORITY_NO_REPLY_BELOW。
  noReplyBelow?: number;
  // 你本人或者 Lead 替你在这个对话里最近一次说话，到这条消息过了多久（毫秒）。null 或者没给：没说过，或者不知道。
  ownMessageAgoMs?: number | null;
}

/**
 * 结论：
 *   skip 不打扰（只记录）；react 回表情；refuse 用固定的话代你拒绝；remind 提醒你（不回）；
 *   closing_reply 代你说一句（收尾）；work 要干活（查、review、approve）；ask 问你；
 *   tell 告诉你（对方在接着回答你最近说的话，权限上限里没有派活）。
 */
export type AuthorityAction =
  | { kind: "skip"; reason: string }
  | { kind: "react"; emoji: ChannelReactionEmoji; reason: string }
  | { kind: "refuse"; reason: string }
  | { kind: "remind"; reason: string }
  | { kind: "closing_reply"; closing: ChannelClosingKind; reason: string }
  | { kind: "work"; intent: ChannelIntent; reason: string }
  | { kind: "ask"; reason: string }
  | { kind: "tell"; reason: string };

const DEFAULT_REACTION: Record<ChannelClosingKind, ChannelReactionEmoji> = {
  they_thank_you: "pray", you_thank_them: "pray", farewell: "smile", remark: "smile", they_agree: "heart",
};

/** 收尾时回哪个表情：请求 A 选的，没选时按收尾的种类。 */
export function closingReaction(closing: ChannelClosingKind | null, reaction: ChannelReactionEmoji | null): ChannelReactionEmoji {
  return reaction ?? DEFAULT_REACTION[closing ?? "remark"];
}

const probability = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/** 按授权表决定通道该做什么。纯函数。 */
export function decideChannelAuthority(input: AuthorityInput, table: ChannelAuthorityTable = CHANNEL_AUTHORITY_DEFAULTS): AuthorityAction {
  const intent: ChannelIntent = input.intent ?? "other";
  if (input.sender.bot) return { kind: "skip", reason: "机器人或应用发的，只记录" };

  // 底线：外部客户、外部共享的对话，什么都不代你发。
  const floor = NEVER_DELEGATED_TRUST.includes(input.sender.trust) ? "发信人是外部客户"
    : input.externalShared !== false ? (input.externalShared === null ? "问不到是不是外部共享的对话" : "这是和外部组织共享的对话")
    : null;

  // 涉密：意图是涉密，或者真的问到了敏感信息（没问到不算）。
  const asked = Object.entries(input.sensitive ?? {}).filter(([, value]) => probability(value) && value >= AUTHORITY_SENSITIVE_LIMIT);
  if (intent === "secret" || asked.length) {
    const what = asked.length ? `问到了敏感信息（${asked.map(([name, value]) => `${name} ${Math.round(value * 100)}%`).join("、")}）` : "问的是涉密信息";
    if (floor) return { kind: "ask", reason: `${what}，${floor}，不代你回` };
    if (table.secret.action === "refuse" && input.capabilities.reply) return { kind: "refuse", reason: `${what}，用固定的话拒绝` };
    return { kind: "ask", reason: `${what}，问你` };
  }

  if (intent === "meeting" && table.meeting.action === "remind") return { kind: "remind", reason: "会议的邀约或提醒：不回，提醒你" };

  if (intent === "closing" && table.closing.action === "auto") {
    if (floor) return { kind: "skip", reason: `收尾的消息，${floor}，不代你回` };
    const closing = input.closing ?? "remark";
    const react = (reason: string): AuthorityAction => input.capabilities.react && input.reactable
      ? { kind: "react", emoji: closingReaction(closing, input.reaction), reason }
      : { kind: "skip", reason: `${reason}（这个来源回不了表情，不打扰你）` };
    if (closing === "they_thank_you") return react("对方在道谢（你帮了他）：在他的消息上回个表情");
    if (closing === "remark") return react("对方附和或感叹，话题结束了：回个表情，不发文字");
    if (closing === "they_agree") return react("对方答应了你的请求：回个表示感谢的表情，不发文字");
    if (input.audience !== "direct" && input.audience !== "group") return react("频道里的收尾：回个表情，不发文字");
    if (!input.capabilities.reply) return react("这个来源不能回复：回个表情");
    return { kind: "closing_reply", closing, reason: closing === "you_thank_them" ? "对方帮了你：代你道谢" : "对方告别：代你说一句" };
  }

  // 先看要不要回（spec D3）：要回的概率低的不当成要干活。对方在接着回答你最近说的话时告诉你，不派活。
  if (probability(input.needsReply) && input.needsReply < (input.noReplyBelow ?? AUTHORITY_NO_REPLY_BELOW)) {
    const needs = `要回 ${Math.round(input.needsReply * 100)}%`;
    const ago = input.ownMessageAgoMs;
    if (typeof ago === "number" && Number.isFinite(ago) && ago >= 0 && ago <= AUTHORITY_ANSWER_WINDOW_MS) {
      const when = ago < 60_000 ? "刚才" : ` ${Math.round(ago / 60_000)} 分钟前`;
      return { kind: "tell", reason: `对方多半在接着回答你${when}在这个对话里说的话（${needs}）：告诉你，不派活` };
    }
    if (CHANNEL_WORK_INTENTS.includes(intent)) {
      return { kind: "skip", reason: `像是${CHANNEL_INTENT_LABELS[intent]}，可是多半不用回（${needs}）：只记录，不当成要干活` };
    }
    return { kind: "skip", reason: `多半不用回（${needs}），只记录` };
  }

  if (CHANNEL_WORK_INTENTS.includes(intent)) {
    if (floor) return { kind: "ask", reason: `${floor}，不代你处理` };
    if (table[intent].action === "auto") return { kind: "work", intent, reason: "要干活：查、review 或者 approve" };
    return { kind: "ask", reason: "授权表没让代你处理这类请求" };
  }
  return { kind: "ask", reason: "要你本人决定或者做事" };
}

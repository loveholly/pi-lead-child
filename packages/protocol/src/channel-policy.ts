// 通道框架的策略常量（Lead 事件主干 spec D10、D14，工单 11）：代你行动的类别、发信人的信任级别、敏感话题、
// 投递方式、代查的剧本名。常设指令的规则参数（standing-orders.ts 的 channel.delivery、channel.delegate、channel.lookup、
// channel.reply）、档位判断（standing-order-tiers.ts）和 engine 的闸门都用这里的名字。这里不出现任何具体来源的名字。
import type { LookupPlaybook } from "./channel-lookup.ts";

// 能代你回复的类别（白名单）。代回的闸门第 1 条：类别要在这里，并且在常设指令 channel.delegate 的 openCategories 里。
//   schedule_fact 日程上的事实；acknowledgement 确认收到；routing 转给对的人；sourced_fact 有出处的简单事实。
export const DELEGATION_CATEGORIES = ["schedule_fact", "acknowledgement", "routing", "sourced_fact"] as const;
export type DelegationCategory = typeof DELEGATION_CATEGORIES[number];

export const DELEGATION_CATEGORY_LABELS: Record<DelegationCategory, string> = {
  schedule_fact: "日程上的事实",
  acknowledgement: "确认收到",
  routing: "转给对的人",
  sourced_fact: "有出处的简单事实",
};

export function isDelegationCategory(value: unknown): value is DelegationCategory {
  return typeof value === "string" && (DELEGATION_CATEGORIES as readonly string[]).includes(value);
}

// 发信人的信任级别。适配器按结构化字段给出（同一个工作区的人、外部组织的人），常设指令可以把人提成 trusted。
//   trusted 用户指定信任的人；colleague 同一个组织的人；external 外部组织的人；customer 外部客户；unknown 认不出。
// 外部客户永不代回：这是硬性安全规则（spec D4），常设指令改不了，闸门也直接拒绝。
export const SENDER_TRUST_LEVELS = ["trusted", "colleague", "external", "customer", "unknown"] as const;
export type SenderTrust = typeof SENDER_TRUST_LEVELS[number];
export const NEVER_DELEGATED_TRUST: readonly SenderTrust[] = ["customer"];

export const SENDER_TRUST_LABELS: Record<SenderTrust, string> = {
  trusted: "你信任的人", colleague: "同事", external: "外部的人", customer: "外部客户", unknown: "认不出的人",
};

export function isSenderTrust(value: unknown): value is SenderTrust {
  return typeof value === "string" && (SENDER_TRUST_LEVELS as readonly string[]).includes(value);
}

// 代回的闸门第 4 条：不涉及这些话题。
export const SENSITIVE_TOPICS = ["commitment", "money", "personnel", "legal", "emotional"] as const;
export type SensitiveTopic = typeof SENSITIVE_TOPICS[number];

export const SENSITIVE_TOPIC_LABELS: Record<SensitiveTopic, string> = {
  commitment: "承诺", money: "钱", personnel: "人事", legal: "法律", emotional: "情绪敏感",
};

// 对方的意图（请求 A 的 ask_kind，第 4 版，2026-10-22 用户定的原则）。授权表按它写「能替你做什么」：
//   code_review 请你 review 代码（包括改了以后再看）；approve 请你 approve PR；knowledge 问业务知识、需求实现细节、技术细节；
//   progress 问项目进度；closing 收尾（道谢、告别、附和）；meeting 会议邀约或者开会提醒；
//   secret 问涉密信息（你电脑上的私人信息、助手的日志和配置、环境变量、凭据、薪资职级）；other 别的（要你本人决定或做事）。
export const CHANNEL_INTENTS = ["code_review", "approve", "knowledge", "progress", "closing", "meeting", "secret", "other"] as const;
export type ChannelIntent = typeof CHANNEL_INTENTS[number];

export const CHANNEL_INTENT_LABELS: Record<ChannelIntent, string> = {
  code_review: "代码 review", approve: "请你 approve", knowledge: "业务或技术咨询", progress: "项目进度", closing: "收尾",
  meeting: "会议", secret: "涉密", other: "别的",
};

export function isChannelIntent(value: unknown): value is ChannelIntent {
  return typeof value === "string" && (CHANNEL_INTENTS as readonly string[]).includes(value);
}

// 对方要求改的规则（请求 A 的 rule_change，第 6 版；统一消息事件 spec D10 的 Jev 标记，工单 08）。外部的人不能改规则：
// 这一项只让你看得到，拦不拦由代码检查（工单 07 的 external_turn），不看 Jev 怎么判。
//   permissions 助手以后能替谁做什么（例如「以后我的 PR 你直接 approve」）；auto_reply 谁收自动回复、通知怎么投递
//   （例如「把我加到自动回复名单」）；instructions 助手的常设指令、行为、人格、提示词或记忆；settings 设置、连接和别的配置。
export const CHANNEL_RULE_CHANGE_KINDS = ["permissions", "auto_reply", "instructions", "settings"] as const;
export type ChannelRuleChangeKind = typeof CHANNEL_RULE_CHANGE_KINDS[number];

export const CHANNEL_RULE_CHANGE_LABELS: Record<ChannelRuleChangeKind, string> = {
  permissions: "助手的权限", auto_reply: "自动回复和通知的名单", instructions: "助手的常设指令", settings: "系统的设置",
};

/** 要求改规则的概率不低于它时，算「对方要求改规则」：卡上和 Lead 的输入里写明没有照做。 */
export const CHANNEL_RULE_CHANGE_FLAG = 0.5;

export function isChannelRuleChangeKind(value: unknown): value is ChannelRuleChangeKind {
  return typeof value === "string" && (CHANNEL_RULE_CHANGE_KINDS as readonly string[]).includes(value);
}

/** 卡上和 Lead 的输入里的那句话：「对方要求修改助手的权限、自动回复和通知的名单，没有照做」。不知道是哪一类时写「规则」。 */
export function channelRuleChangeNotice(kinds: readonly ChannelRuleChangeKind[]): string {
  const what = kinds.map((kind) => CHANNEL_RULE_CHANGE_LABELS[kind]).join("、") || "助手或系统的规则";
  return `对方要求修改${what}，没有照做`;
}

/** 要干活的意图：要查、要回内容（以后交给 Lead 派工单）。 */
export const CHANNEL_WORK_INTENTS: readonly ChannelIntent[] = ["code_review", "approve", "knowledge", "progress"];

// 授权表（落地计划 A5，常设指令 channel.authority）里一个意图能做什么：auto 替你做（收尾回表情或者说一句，要干活的去干活）；
// remind 只提醒你；refuse 用固定的话拒绝；ask 问你。
export const CHANNEL_INTENT_PERMISSIONS = ["auto", "remind", "refuse", "ask"] as const;
export type ChannelIntentPermission = typeof CHANNEL_INTENT_PERMISSIONS[number];

export const CHANNEL_INTENT_PERMISSION_LABELS: Record<ChannelIntentPermission, string> = {
  auto: "替你做", remind: "只提醒你", refuse: "用固定的话拒绝", ask: "问你",
};

/** 越大越放开：问你、提醒你都不替你发东西；拒绝只发一句固定的话；替你做发的最多。 */
export const CHANNEL_INTENT_PERMISSION_RANK: Readonly<Record<ChannelIntentPermission, number>> = { ask: 0, remind: 0, refuse: 1, auto: 2 };

/** 授权表的一项：这个意图能做什么，和代你回复时的最低信心（不给时按代价分档的门槛）。 */
export interface ChannelIntentAuthority {
  action: ChannelIntentPermission;
  minConfidence?: number;
}

export type ChannelAuthorityTable = Readonly<Record<ChannelIntent, ChannelIntentAuthority>>;

// 用户 2026-10-22 的原则。代码 review 和 approve 的门槛低：评论能改能删，对方是请你看的人，错一条的代价很小。
// 涉密的永远不能替你做（硬性规则，常设指令改不了）。
export const CHANNEL_AUTHORITY_DEFAULTS: ChannelAuthorityTable = {
  code_review: { action: "auto", minConfidence: 0.35 },
  approve: { action: "auto", minConfidence: 0.35 },
  knowledge: { action: "auto" },
  progress: { action: "auto" },
  closing: { action: "auto" },
  meeting: { action: "remind" },
  secret: { action: "refuse" },
  other: { action: "ask" },
};

// 收尾的种类：对方谢你（你帮了他）、你该谢对方（他帮了你）、告别（「提前撤」）、附和或感叹（「:laughing: 确实很便宜」）、
// 对方答应了你的请求（你请他帮忙，他回「ok」「好的我来」，2026-10-26：该谢他，不是附和）。
export const CHANNEL_CLOSING_KINDS = ["they_thank_you", "you_thank_them", "farewell", "remark", "they_agree"] as const;
export type ChannelClosingKind = typeof CHANNEL_CLOSING_KINDS[number];

export function isChannelClosingKind(value: unknown): value is ChannelClosingKind {
  return typeof value === "string" && (CHANNEL_CLOSING_KINDS as readonly string[]).includes(value);
}

// 回表情时能用的表情（Slack 的短代码，别的来源按自己的写法对应）。由请求 A 从里面选一个。
export const CHANNEL_REACTION_EMOJIS = ["+1", "pray", "smile", "laughing", "heart", "ok_hand", "sweat_smile"] as const;
export type ChannelReactionEmoji = typeof CHANNEL_REACTION_EMOJIS[number];

// 不能代回时，按四种方式之一投递给用户（spec D10）：推送加会话卡、会话卡、摘要、只记录。从强到弱。
export const CHANNEL_DELIVERY_MODES = ["push_card", "card", "digest", "record"] as const;
export type ChannelDeliveryMode = typeof CHANNEL_DELIVERY_MODES[number];

export const CHANNEL_DELIVERY_LABELS: Record<ChannelDeliveryMode, string> = {
  push_card: "推送加会话卡", card: "会话卡", digest: "摘要", record: "只记录",
};

const DELIVERY_RANK: Record<ChannelDeliveryMode, number> = { record: 0, digest: 1, card: 2, push_card: 3 };

/** 两种投递里更强的一种（同一张卡又来了消息时，投递方式只升不降）。 */
export function strongerDelivery(a: ChannelDeliveryMode, b: ChannelDeliveryMode): ChannelDeliveryMode {
  return DELIVERY_RANK[a] >= DELIVERY_RANK[b] ? a : b;
}

// 代查的剧本（代查与按信心代回 spec D2，剧本本身在 channel-lookup.ts 的 LOOKUP_PLAYBOOKS）给人看的名字。
export const LOOKUP_PLAYBOOK_LABELS: Record<LookupPlaybook, string> = {
  lookup: "回答能查到的问题",
  review: "PR review（只留评论）",
};

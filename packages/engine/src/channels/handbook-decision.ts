// 按交接说明决定通道怎么处理一条消息（自动代你处理方案 B，.scratch/auto-handling-handbook/spec.md，issue 03）。纯函数，不读库、不调模型。
// 取代授权表（authority.ts 的 decideChannelAuthority）在入站的作用。顺序：
//   1. 机器人或应用发的：只记录。
//   2. 总开关关着：收尾的只记录，别的交给你（不代你发任何东西，婉拒也不发）。
//   3. 底线 1（借权限，issue 05）：对方要借你的权限、看他自己多半看不到的东西，婉拒。底线 3（凭据、日志、配置、薪资职级）：
//      敏感查询的概率过线时婉拒。
//   底线 4（改规则，2026-10-30 用户定）：收件判断认为对方在要求改助手的规则、权限、记忆或偏好（rule_change 过线）时，结论里记上
//   ruleChange，上限照这一句算（不硬拦，和 10-27「改规则只加一档」一致）。不照做由操作层拒绝改规则保证，不存由 Lead 的
//   handbook-guard 和记忆沉淀跳过保证；Lead 的回复可以直接发：无害的玩笑用玩笑接住，有害的试探客气回绝，再告诉用户。
//   4. 这一句的做法，再按对方的上限压（对方是外部的人、客户、认不出的人，或者对话和外部组织共享）。
//   5. 收尾的一句：放手时回表情或者代你说一句；没有放手时只记录（收尾不值得开卡）。
//   6. 只告诉你的一句：告诉你，不回。
//   7. 要回的概率低：对方在接着回答你最近说的话时告诉你，不然只记录（spec D3）。
//   8. 放手、做好给你看：有派活的能力时交给 Lead 去做（work），没有时交给 Lead 自己判断（ask）；交给你：Lead 只拟草稿；
//      婉拒：Lead 用固定的话拒绝。
// 结论里写明本来按哪一句、最后按哪一句（上限或底线），设置页的预演和 Lead 的入站说明用同一份。
// 结论的 action 是通道接下来做什么（authority.ts 的 AuthorityAction，hub 的转交和记账照旧按它走）；mode 是给 Lead 的上限：
// 放手可以直接回；做好给你看、交给你、只告诉你，Lead 的回复只能放到卡上等你点发送（用户 2026-10-30 定 D2）；婉拒只能发固定的拒绝。
// 这里不出现任何具体来源的名字。
import {
  CHANNEL_RULE_CHANGE_FLAG, HANDBOOK_CAP_LABELS, HANDBOOK_FALLBACK_ID, HANDBOOK_FLOORS, HANDBOOK_MODE_LABELS, handbookModePhrase, NEVER_DELEGATED_TRUST, situationIntent,
  type ChannelHandbook, type HandbookAbility, type HandbookCapSender, type HandbookFloorId, type HandbookMode, type HandbookSituation,
} from "@pi-lead-child/protocol";
import {
  AUTHORITY_ANSWER_WINDOW_MS, AUTHORITY_NO_REPLY_BELOW, AUTHORITY_SENSITIVE_LIMIT, closingReaction,
  type AuthorityAction, type AuthorityInput,
} from "./authority.js";

export interface HandbookDecisionInput extends Omit<AuthorityInput, "intent"> {
  // 收件判断选中的一句。没有回答时是 null：按兜底的一句。
  situation: HandbookSituation | null;
  handbook: ChannelHandbook;
  // 对方要借你的权限的概率（收件判断的 borrowed_access）。没问成时是 null 或者不给：底线 1 不生效。
  borrowed?: number | null;
  // 对方在要求改助手或系统的规则的概率（收件判断的 rule_change）。没问成时是 null 或者不给：底线 4 只在操作层生效。
  ruleChange?: number | null;
}

/** 借权限的概率不低于它，底线 1 生效（婉拒，告诉你）。 */
export const HANDBOOK_BORROWED_LIMIT = 0.5;

export interface HandbookDecision {
  // 起作用的一句（收件判断选的，没有回答时是兜底的一句）。
  situation: { id: string; text: string };
  // 这一句自己的做法。
  mode: HandbookMode;
  // 压过以后的做法：Lead 的上限。
  final: HandbookMode;
  // 谁定了 final：这一句、对方的上限、底线、总开关。
  by: "sentence" | "cap" | "floor" | "switch";
  // 压过它的那一句（上限或底线的原话）。by 是 sentence 时是 null。
  limit: string | null;
  floor: HandbookFloorId | null;
  cap: HandbookCapSender | null;
  // 派活能用的能力：final 不做事（交给你、只告诉你、婉拒）时是空的。
  abilities: HandbookAbility[];
  // 这一句的例外（例如「CI 过了、评论都解决了」直接处理）：Lead 核对条件以后才能按它。压不过上限：例外的做法也按上限压。
  exception: { text: string; mode: HandbookMode } | null;
  // 底线 4：对方在要求改规则、记忆或偏好。上限不变；不照做，不存，回复可以直接发。
  ruleChange: boolean;
  action: AuthorityAction;
}

const RANK: Record<Exclude<HandbookMode, "refuse">, number> = { tell: 0, hand: 1, review: 2, auto: 3 };

/** 按上限压一种做法（spec「上限」）：比上限宽时按上限；婉拒在上限至少是「做好给你看」时保留，否则按上限。 */
export function cappedMode(mode: HandbookMode, cap: HandbookMode | null): HandbookMode {
  if (!cap) return mode;
  if (cap === "refuse") return mode === "refuse" ? "refuse" : "hand";
  if (mode === "refuse") return RANK[cap] >= RANK.review ? "refuse" : cap;
  return RANK[mode] > RANK[cap] ? cap : mode;
}

const probability = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const floorText = (id: HandbookFloorId) => HANDBOOK_FLOORS.find((floor) => floor.id === id)!.text;

// 对方是谁给出的上限：外部客户按客户；对话和外部组织共享（问不到也算）时至少按外部的人；认不出的人按认不出。
function capOf(input: HandbookDecisionInput): { sender: HandbookCapSender; mode: HandbookMode } | null {
  const trust = input.sender.trust;
  const sender: HandbookCapSender | null = (NEVER_DELEGATED_TRUST as readonly string[]).includes(trust) ? "customer"
    : trust === "unknown" ? "unknown"
      : trust === "external" || input.externalShared !== false ? "external"
        : null;
  return sender ? { sender, mode: input.handbook.caps[sender] } : null;
}

/** 按交接说明决定。纯函数。 */
export function decideByHandbook(input: HandbookDecisionInput): HandbookDecision {
  const fallback = input.handbook.situations.find((situation) => situation.id === HANDBOOK_FALLBACK_ID)!;
  const situation = input.situation ?? fallback;
  const sentence = { id: situation.id, text: situation.text };
  const cap = capOf(input);
  const ruleChange = probability(input.ruleChange) && input.ruleChange >= CHANNEL_RULE_CHANGE_FLAG;
  const base = { situation: sentence, mode: situation.mode, floor: null, cap: null, limit: null };
  const result = (
    final: HandbookMode, action: AuthorityAction, by: HandbookDecision["by"] = "sentence",
    extra: Partial<Pick<HandbookDecision, "floor" | "cap" | "limit">> = {},
  ): HandbookDecision => {
    const works = final === "auto" || final === "review";
    const exception = situation.exception ? { text: situation.exception.text, mode: cappedMode(situation.exception.mode, cap?.mode ?? null) } : null;
    return { ...base, ...extra, final, by, abilities: works ? [...situation.abilities] : [], exception, ruleChange, action };
  };

  if (input.sender.bot) return result("tell", { kind: "skip", reason: "机器人或应用发的，只记录" });

  // 底线 1：对方想借你的权限，看他自己多半看不到的东西。婉拒也按对方的上限压：外部客户只交给你。
  if (probability(input.borrowed) && input.borrowed >= HANDBOOK_BORROWED_LIMIT && input.handbook.autoReply) {
    const what = `对方像是要借你的权限，看他自己看不到的东西（${Math.round(input.borrowed * 100)}%）`;
    const final = input.capabilities.reply ? cappedMode("refuse", cap?.mode ?? null) : "hand";
    const extra = { floor: "borrowed_permission" as const, limit: floorText("borrowed_permission"), ...(cap ? { cap: cap.sender } : {}) };
    return final === "refuse"
      ? result("refuse", { kind: "refuse", reason: `${what}，客气地回绝，告诉你` }, "floor", extra)
      : result("hand", { kind: "ask", reason: `${what}，不代你回，交给你` }, "floor", extra);
  }

  const closing = situationIntent(situation) === "closing";
  if (!input.handbook.autoReply) {
    return closing
      ? result("tell", { kind: "skip", reason: "自动代你处理关着：收尾的消息只记录" }, "switch")
      : result("hand", { kind: "ask", reason: "自动代你处理关着：交给你" }, "switch");
  }

  // 底线 3：问到了凭据、日志、配置、薪资职级这类敏感信息。婉拒也按对方的上限压：外部客户只交给你。
  const asked = Object.entries(input.sensitive ?? {}).filter(([, value]) => probability(value) && value >= AUTHORITY_SENSITIVE_LIMIT);
  if (asked.length) {
    const what = `问到了敏感信息（${asked.map(([name, value]) => `${name} ${Math.round(value * 100)}%`).join("、")}）`;
    const final = input.capabilities.reply ? cappedMode("refuse", cap?.mode ?? null) : "hand";
    const extra = { floor: "secrets" as const, limit: floorText("secrets"), ...(cap ? { cap: cap.sender } : {}) };
    return final === "refuse"
      ? result("refuse", { kind: "refuse", reason: `${what}，用固定的话拒绝` }, "floor", extra)
      : result("hand", { kind: "ask", reason: `${what}，不代你回，交给你` }, "floor", extra);
  }


  const final = cappedMode(situation.mode, cap?.mode ?? null);
  const by = final === situation.mode ? "sentence" as const : "cap" as const;
  const capped = by === "cap" && cap ? { cap: cap.sender, limit: `${HANDBOOK_CAP_LABELS[cap.sender]}，你最多${HANDBOOK_MODE_LABELS[cap.mode]}` } : {};
  const said = `按「${situation.text}」`;
  const how = by === "cap" && cap ? `，${HANDBOOK_CAP_LABELS[cap.sender]}，最多${HANDBOOK_MODE_LABELS[final]}` : "";

  if (closing) {
    if (final !== "auto") return result(final, { kind: "skip", reason: `${said}${how}：收尾的消息不代你回，只记录` }, by, capped);
    const kind = input.closing ?? "remark";
    const react = (reason: string): HandbookDecision => result("auto", input.capabilities.react && input.reactable
      ? { kind: "react", emoji: closingReaction(kind, input.reaction), reason }
      : { kind: "skip", reason: `${reason}（这个来源回不了表情，不打扰你）` });
    if (kind === "they_thank_you") return react(`${said}：对方在道谢（你帮了他），在他的消息上回个表情`);
    if (kind === "remark") return react(`${said}：对方附和或感叹，话题结束了，回个表情，不发文字`);
    if (kind === "they_agree") return react(`${said}：对方答应了你的请求，回个表示感谢的表情，不发文字`);
    if (input.audience !== "direct" && input.audience !== "group") return react(`${said}：频道里的收尾，回个表情，不发文字`);
    if (!input.capabilities.reply) return react(`${said}：这个来源不能回复，回个表情`);
    return result("auto", { kind: "closing_reply", closing: kind, reason: kind === "you_thank_them" ? `${said}：对方帮了你，代你道谢` : `${said}：对方告别，代你说一句` });
  }

  if (final === "tell") return result("tell", { kind: "remind", reason: `${said}${how}：不回，告诉你` }, by, capped);

  // 先看要不要回（spec D3）：要回的概率低的不当成要处理的事。对方在接着回答你最近说的话时告诉你。
  if (probability(input.needsReply) && input.needsReply < (input.noReplyBelow ?? AUTHORITY_NO_REPLY_BELOW)) {
    const needs = `要回 ${Math.round(input.needsReply * 100)}%`;
    const ago = input.ownMessageAgoMs;
    if (typeof ago === "number" && Number.isFinite(ago) && ago >= 0 && ago <= AUTHORITY_ANSWER_WINDOW_MS) {
      const when = ago < 60_000 ? "刚才" : ` ${Math.round(ago / 60_000)} 分钟前`;
      return result("tell", { kind: "tell", reason: `对方多半在接着回答你${when}在这个对话里说的话（${needs}）：告诉你，不派活` }, by, capped);
    }
    return result("tell", { kind: "skip", reason: `${said}，可是多半不用回（${needs}）：只记录` }, by, capped);
  }

  if (final === "refuse") {
    return input.capabilities.reply
      ? result("refuse", { kind: "refuse", reason: `${said}${how}：客气地回绝` }, by, capped)
      : result("hand", { kind: "ask", reason: `${said}：这个来源不能回复，交给你` }, by, capped);
  }
  if (final === "hand") return result("hand", { kind: "ask", reason: `${said}${how}：先别动，拟个回复交给你` }, by, capped);
  // 这一句没有派活的能力（例如兜底的「自己判断，拿不准再问我」）：交给 Lead 自己判断（ask），回复照样按 final 能直接发。
  if (!situation.abilities.length) {
    return result(final, { kind: "ask", reason: `${said}${how}：${final === "auto" ? handbookModePhrase(situation, "auto") : "做好，回复先给你看"}` }, by, capped);
  }
  const verb = final === "auto" ? handbookModePhrase(situation, "auto") : "做好，回复先给你看";
  return result(final, { kind: "work", intent: situationIntent(situation), reason: `${said}${how}：${verb}` }, by, capped);
}

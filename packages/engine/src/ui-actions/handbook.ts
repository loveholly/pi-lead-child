// 交接说明（设置 → 消息通道 → 自动代你处理，方案 B，.scratch/auto-handling-handbook，issue 06/07）的操作。
// 页面（gateway 的 handbook-routes.ts）和 Lead（perform_action）调同一个定义：
//   - update：改交接说明，可以放宽（一句的做法、对方的上限、打开开关、加一句）。放宽等于给 Lead 更大的权力，只有你本人能做
//     （user_direct）。输入是改完以后的一整份。
//   - tighten：只收紧，Lead 可以自己判断（和常设指令的规则一样：收紧 Lead 能直接改），有一项放宽就拒绝，说明去哪里改。
//   - rehearse：预演一条消息。只读，不发任何东西。
//   - propose：把一句随口的话整理成交接说明里的一句（handbook-propose.ts）。只读，不保存，要调一次便宜模型。
//   - suggestions、accept_suggestion、dismiss_suggestion：页边批注（channels/handbook-suggestions.ts，issue 08）。接受一条等于改交接说明：
//     你本人按 update，Lead 按 tighten（放宽的被拒绝，告诉它去哪里点）。不用了的以后不再出现。
// 都存在常设指令 channel.handbook（有版本和历史）。放宽和收紧的判断在 protocol 的 standing-order-tiers.ts。
import {
  CHANNEL_HANDBOOK_RESOURCE, channelHandbookProblems, stableJson,
  type ChannelHandbook, type ChannelHandbookDto, type HandbookProposalRequest, type HandbookRehearsalRequest, type HandbookSuggestionKey,
} from "@pi-lead-child/protocol";
import {
  CHANNEL_HANDBOOK_ORDER_ID, channelHandbookDto, getStandingOrder, planStandingOrderChange, proposeStandingOrderChange, publishGatewayEvent,
  StandingOrderChangeError, updateStandingOrderByUser,
} from "@pi-lead-child/store";
import { handbookSuggestions, handbookWithSuggestion, settleHandbookSuggestion } from "../channels/handbook-suggestions.js";
import { proposeHandbookSituation } from "../handbook-propose.js";
import { AVAILABLE } from "../ticket-actions/types.js";
import { UiActionError, type UiActionDefinition, type UiActionEnv, type UiActionRun, type UiActionTargetKind } from "./types.js";

export const HANDBOOK_WHERE = "设置 → 消息通道 → 自动代你处理";

export const CHANNEL_HANDBOOK_TARGET: UiActionTargetKind<ChannelHandbookDto> = {
  type: "channel_handbook",
  label: "交接说明（自动代你处理）",
  idHint: "handbook",
  load: (env, id) => (id === "handbook" ? channelHandbookDto(env.db) : null),
  name: () => "交接说明",
  describe: (dto) => ({ handbook: dto.handbook, requested: dto.requested, order: dto.order }),
};

function rehearsal(env: UiActionEnv) {
  const service = env.services.channelHandbookRehearsal;
  if (!service) throw new UiActionError("unavailable", "还没有接任何外部消息来源，预演要用的收件判断没有启动");
  return service;
}

// 页边批注的建议。有文字模型时顺便归类（一天最多一次）；没有时用上一次的归类。
function suggestionsOf(run: UiActionRun<ChannelHandbookDto, unknown>) {
  let complete = null;
  try {
    complete = run.env.services.textModel?.() ?? null;
  } catch {
    complete = null;
  }
  return handbookSuggestions(run.db, { handbook: run.target.handbook, now: run.env.now, complete });
}

async function acceptSuggestion(run: UiActionRun<ChannelHandbookDto, HandbookSuggestionKey>) {
  const current = await handbookSuggestions(run.db, { handbook: run.target.handbook, now: run.env.now });
  const suggestion = current.suggestions.find((item) => item.key === run.input.key);
  if (!suggestion) throw new UiActionError("stale", "这条建议已经没有了（处理过，或者依据变了）：刷新一下再看");
  const next = handbookWithSuggestion(run.target.requested, suggestion);
  if (!next) throw new UiActionError("stale", "交接说明刚刚改过，这条建议过时了：刷新一下再看");
  const written = writeHandbook(run, run.by.actor === "user" ? "update" : "tighten", next);
  settleHandbookSuggestion(run.db, suggestion.key, run.env.now);
  return { ...written, accepted: { key: suggestion.key, kind: suggestion.kind } };
}

function textModel(env: UiActionEnv) {
  const complete = env.services.textModel?.() ?? null;
  if (!complete) throw new UiActionError("unavailable", "整理要用的模型还没有启动（Lead 的会话还没建好，或者没有配置 LLM 后端）");
  return complete;
}

function changeError(error: unknown): never {
  if (error instanceof StandingOrderChangeError) {
    throw new UiActionError(error.code === "invalid_request" ? "invalid_input" : error.code === "conflict" ? "stale" : error.code, error.message);
  }
  throw error;
}

// 写一个新版本。你本人：作者 user，直接生效（放宽也一样）。Lead：只能收紧，作者 lead，写 standing_order.changed 告诉你。
function writeHandbook(
  run: UiActionRun<ChannelHandbookDto, unknown>, mode: "update" | "tighten", next: ChannelHandbook = run.input as ChannelHandbook,
): { order: { id: string; version: number }; unchanged?: true } {
  const problems = channelHandbookProblems(next);
  if (problems.length) throw new UiActionError("invalid_input", problems.join("；"));
  const order = getStandingOrder(run.db, CHANNEL_HANDBOOK_ORDER_ID);
  if (!order || order.action.type !== "rule") throw new UiActionError("unavailable", "库里没有交接说明（channel.handbook）");
  if (stableJson(next) === stableJson(run.target.requested)) return { order: { id: order.id, version: order.version }, unchanged: true };
  const patch = { action: { ...order.action, params: next as unknown as Record<string, unknown> } };
  try {
    let written: { id: string; version: number };
    if (run.by.actor === "user") {
      written = updateStandingOrderByUser(run.db, {
        id: order.id, patch, reason: run.reason, resolvedBy: `user via ${HANDBOOK_WHERE}`, now: run.env.now,
      }).written.order;
    } else {
      const plan = planStandingOrderChange(run.db, { op: "update", id: order.id, patch, reason: run.reason });
      if (!plan.classification.changed) return { order: { id: order.id, version: order.version }, unchanged: true };
      if (mode === "tighten" && plan.classification.tier !== "conservative") {
        const loosened = plan.classification.findings.filter((item) => item.tier !== "conservative").map((item) => item.detail);
        throw new UiActionError("user_direct", `这次改动有放宽的（${loosened.join("；")}），只有用户本人能改：请他在 ${HANDBOOK_WHERE} 里自己改。`);
      }
      const proposed = proposeStandingOrderChange(run.db, { op: "update", id: order.id, patch, reason: run.reason }, { now: run.env.now });
      if (proposed.outcome !== "applied") throw new UiActionError("forbidden", `没有改成（${proposed.outcome}）：${proposed.plan.summary}`);
      written = proposed.written.order;
    }
    publishGatewayEvent(run.db, { type: "snapshot.required", requiredScope: "tickets:view", payload: { resource: CHANNEL_HANDBOOK_RESOURCE } });
    return { order: { id: written.id, version: written.version } };
  } catch (error) {
    changeError(error);
  }
}

export const CHANNEL_HANDBOOK_ACTIONS = {
  update: {
    target: "channel_handbook", id: "update", label: "改交接说明", scope: "tickets:create",
    permission: "user_direct", changesRules: true, external: false, irreversible: false,
    where: HANDBOOK_WHERE,
    hint: "改一句的做法、对方的上限、打开开关、加一句，可以放宽：只有用户本人能做。只收紧时用 tighten。",
    defaultReason: "在设置页改了交接说明",
    available: () => AVAILABLE,
    run: (run) => writeHandbook(run, "update"),
    forLead: (_run, result) => result,
  },
  tighten: {
    target: "channel_handbook", id: "tighten", label: "收紧交接说明", scope: "tickets:create",
    permission: "lead_allowed", changesRules: true, external: false, irreversible: false,
    where: HANDBOOK_WHERE,
    hint: "input 是改完以后的一整份交接说明（先用 list_actions 看现在的 handbook，只改要收紧的项）：把一句改严（例如「直接处理」改成"
      + "「做好，先给我看再发」）、把对方的上限改严、关掉开关、加一句不比兜底的一句宽的。有一项放宽就会被拒绝。改了会告诉用户。"
      + "用户说「以后 review 先给我看」「先别自动回了」这类话时用。",
    defaultReason: "收紧交接说明",
    available: () => AVAILABLE,
    run: (run) => writeHandbook(run, "tighten"),
    forLead: (_run, result) => result,
  },
  rehearse: {
    target: "channel_handbook", id: "rehearse", label: "预演一条消息", scope: "tickets:view",
    permission: "lead_allowed", changesRules: false, external: false, irreversible: false, readOnly: true,
    where: HANDBOOK_WHERE,
    hint: "拿一条消息试一下：收件判断真的选一句，再按交接说明和对方是谁算结论（按哪一句、被什么压过、最后怎么做）。"
      + "input 是 {text, sender: colleague|external|customer|unknown, handbook?}；不给 handbook 时用现在生效的。只读，不发任何东西。",
    defaultReason: "预演一条消息",
    available: () => AVAILABLE,
    run: (run) => rehearsal(run.env).rehearse(run.input as HandbookRehearsalRequest),
    forLead: (_run, result) => result,
  },
  propose: {
    target: "channel_handbook", id: "propose", label: "整理成交接说明里的一句", scope: "tickets:create",
    permission: "lead_allowed", changesRules: false, external: false, irreversible: false, readOnly: true,
    where: HANDBOOK_WHERE,
    hint: "把用户随口说的一句（例如「以后有人请我看线上日志，你查完直接回他」）整理成交接说明里的一句：说法、例句、做法、会做什么、能力。"
      + "input 是 {text}。只读，不保存，要调一次模型。结果先原样给用户看；same 不是 null 时，说明已有那一句，改它的做法就行。"
      + "用户确认以后：只收紧的（做法不比兜底的一句宽）可以用 tighten 加上；放宽的只有用户本人能在设置页加。",
    defaultReason: "整理成交接说明里的一句",
    available: () => AVAILABLE,
    run: (run) => proposeHandbookSituation(run.input as HandbookProposalRequest, {
      complete: textModel(run.env), handbook: run.target.handbook,
    }),
    forLead: (_run, result) => result,
  },
  suggestions: {
    target: "channel_handbook", id: "suggestions", label: "看交接说明的建议", scope: "tickets:view",
    permission: "lead_allowed", changesRules: false, external: false, irreversible: false, readOnly: true,
    where: HANDBOOK_WHERE,
    hint: "页边批注：一句的草稿用户连续原样发出时建议放宽一档；落到兜底一句的消息里有一批相近的时建议加一句；底线最近 7 天拦下几次。"
      + "只读（有时会调一次便宜模型归类）。input 是 {}。",
    defaultReason: "看交接说明的建议",
    available: () => AVAILABLE,
    run: (run) => suggestionsOf(run),
    forLead: (_run, result) => result,
  },
  accept_suggestion: {
    target: "channel_handbook", id: "accept_suggestion", label: "接受交接说明的一条建议", scope: "tickets:create",
    permission: "lead_allowed", changesRules: true, external: false, irreversible: false,
    where: HANDBOOK_WHERE,
    hint: "input 是 {key}（suggestions 里的编号）。放宽的建议只有用户本人能接受（你调用会被拒绝，告诉用户去设置页点）；"
      + "加一句的建议做法不比兜底的一句宽时你可以接受。接受以后同一条不再出现。",
    defaultReason: "接受交接说明的一条建议",
    available: () => AVAILABLE,
    run: (run) => acceptSuggestion(run as UiActionRun<ChannelHandbookDto, HandbookSuggestionKey>),
    forLead: (_run, result) => result,
  },
  dismiss_suggestion: {
    target: "channel_handbook", id: "dismiss_suggestion", label: "不用交接说明的一条建议", scope: "tickets:create",
    permission: "lead_allowed", changesRules: false, external: false, irreversible: false,
    where: HANDBOOK_WHERE,
    hint: "input 是 {key}。以后同一条不再出现，它依据的消息也不再拿去归类。不改交接说明。",
    defaultReason: "不用交接说明的一条建议",
    available: () => AVAILABLE,
    run: (run) => {
      settleHandbookSuggestion(run.db, (run.input as HandbookSuggestionKey).key, run.env.now);
      return { dismissed: (run.input as HandbookSuggestionKey).key };
    },
    forLead: (_run, result) => result,
  },
} satisfies Record<string, UiActionDefinition<ChannelHandbookDto, any>>;

// 代回复风格（设置 → 消息通道 → 代回复风格，2026-10-28，.scratch/channel-reply-style/spec.md）的操作：改（update）和提炼（extract）。
// 页面（gateway 的 reply-style-routes.ts）和 Lead（perform_action）调同一个定义。
//   - update：user_only + userTurnOnly（用户 2026-10-28 定：你本人，或者 Fairy 在你的一轮里），改规则，promptSetting：
//     它进 Lead 和子 agent 写回复的提示词，带着外部内容的一轮一律拒绝，用户本人的一轮也一样。每次修改记主人操作，能撤销。
//   - extract：只读，Lead 可以自己做。结果是预览，要用户看过、确认以后才 update（hint 里写明）。
import {
  REPLY_STYLE_RESOURCE, REPLY_STYLE_TEXT_MAX_LENGTH, replyStyleLength,
  type ReplyStyleDto, type ReplyStyleUpdateRequest, type UiActionInputOf,
} from "@pi-lead-child/protocol";
import { getReplyStyle, publishGatewayEvent } from "@pi-lead-child/store";
import { extractReplyStyle } from "../reply-style-extract.js";
import { ReplyStyleError, replyStyleChangeSummary, updateReplyStyle, type ReplyStyleUpdateOutcome } from "../reply-style.js";
import { AVAILABLE } from "../ticket-actions/types.js";
import { UiActionError, type UiActionDefinition, type UiActionEnv, type UiActionTargetKind } from "./types.js";

export const REPLY_STYLE_WHERE = "设置 → 消息通道 → 代回复风格";

export const REPLY_STYLE_TARGET: UiActionTargetKind<ReplyStyleDto> = {
  type: "reply_style",
  label: "代回复风格",
  idHint: "user",
  load: (env, id) => (id === "user" ? getReplyStyle(env.db) : null),
  name: () => "代回复风格",
  describe: (style) => ({
    text: style.text, length: replyStyleLength(style.text), max: REPLY_STYLE_TEXT_MAX_LENGTH,
    updatedAt: style.updatedAt, updatedBy: style.updatedBy,
  }),
};

function textModel(env: UiActionEnv) {
  const complete = env.services.textModel?.() ?? null;
  if (!complete) throw new UiActionError("unavailable", "提炼要用的模型还没有启动（Lead 的会话还没建好，或者没有配置 LLM 后端）");
  return complete;
}

export const REPLY_STYLE_ACTIONS = {
  update: {
    target: "reply_style", id: "update", label: "改代回复风格", scope: "tickets:create",
    permission: "user_only", userTurnOnly: true,
    permissionNote: "只属于用户：只有用户在这一轮明确要求时代他改（例如「以后代我回复别用感叹号」）",
    changesRules: true, promptSetting: true, external: false, irreversible: false,
    where: REPLY_STYLE_WHERE,
    hint: "用户要你记下代他回复的写法时用。mode=append 在后面追加一段（原来的不动，带日期小标题），mode=replace 换掉整段"
      + "（先用 list_actions 看现在的 text，在它的基础上改）。最多 2000 字。",
    defaultReason: "在设置页改了代回复风格",
    available: () => AVAILABLE,
    run: (run) => {
      let outcome: ReplyStyleUpdateOutcome;
      try {
        outcome = updateReplyStyle(run.db, { request: run.input as ReplyStyleUpdateRequest, by: run.by.actor === "user" ? "user" : "lead", now: run.env.now });
      } catch (error) {
        if (error instanceof ReplyStyleError) throw new UiActionError("invalid_input", error.message);
        throw error;
      }
      if (outcome.changed) {
        publishGatewayEvent(run.db, { type: "snapshot.required", requiredScope: "tickets:view", payload: { resource: REPLY_STYLE_RESOURCE } });
      }
      return outcome;
    },
    forLead: (_run, result) => {
      const outcome = result as ReplyStyleUpdateOutcome;
      if (!outcome.changed) return { result: "unchanged", length: replyStyleLength(outcome.after) };
      return {
        result: "updated", length: replyStyleLength(outcome.after),
        next: "已经保存，从下一轮起代用户写的话按新的风格。用一句话告诉用户改了什么；用户可以在通知里撤销，或者在设置 → 消息通道里再改。",
      };
    },
    detail: (run, result) => ({
      mode: (run.input as ReplyStyleUpdateRequest).mode, changed: (result as ReplyStyleUpdateOutcome).changed,
      length: replyStyleLength((result as ReplyStyleUpdateOutcome).after),
    }),
    ownerActionInput: (run, result) => {
      const outcome = result as ReplyStyleUpdateOutcome;
      if (!outcome.changed) return null;
      const mode = (run.input as ReplyStyleUpdateRequest).mode;
      return {
        action: "channel.reply_style",
        target: { key: "channel:reply_style", label: "代回复风格", ticketId: null },
        summary: replyStyleChangeSummary(outcome.before, outcome.after, mode),
        detail: { mode, length: replyStyleLength(outcome.after) },
        undo: { kind: "reply_style", before: outcome.before, after: outcome.after },
      };
    },
  },
  extract: {
    target: "reply_style", id: "extract", label: "从最近的消息提炼代回复风格", scope: "tickets:create",
    permission: "lead_allowed", changesRules: false, external: false, irreversible: false, readOnly: true,
    where: REPLY_STYLE_WHERE,
    hint: "从最近 days 天（缺省 15，最多 30）用户本人在来源里发的话提炼风格特征。只读，要调一次模型。"
      + "结果是预览：把 proposal 和 conflicts 原样给用户看，用户确认（可以改）以后，再用 update（mode=append，label 用结果里的 label）追加。"
      + "不要不经用户确认就追加。",
    defaultReason: "提炼代回复风格",
    available: () => AVAILABLE,
    run: (run) => extractReplyStyle(run.input as UiActionInputOf<"reply_style", "extract">, {
      db: run.db, complete: textModel(run.env), now: run.env.now, existing: run.target.text,
    }),
    forLead: (_run, result) => result,
  },
} satisfies Record<string, UiActionDefinition<ReplyStyleDto, any>>;

// 改代回复风格（设置 → 消息通道 → 代回复风格，2026-10-28，.scratch/channel-reply-style/spec.md）。
// 两个入口都经操作层的 reply_style.update（ui-actions/catalog.ts）：设置页的 POST /v1/channels/reply-style，和 Lead 的 perform_action。
// 授权在操作层：user_only + userTurnOnly（Lead 只在用户本人这一轮、用户明确要求时代他改），带着外部内容的一轮一律拒绝
// （promptSetting：它进 Lead 和子 agent 写回复的提示词，用户本人的一轮也不例外）。
// 这里只算新的整段、校验、写库；主人操作（channel.reply_style）由操作层按 ownerActionInput 记。
import {
  ReplyStyleUpdateRequestSchema, nextReplyStyleText, replyStyleProblem,
  type ReplyStyleAuthor, type ReplyStyleDto, type ReplyStyleUpdateRequest,
} from "@pi-lead-child/protocol";
import { getReplyStyle, writeReplyStyle, type Db } from "@pi-lead-child/store";
import { Value } from "typebox/value";

export class ReplyStyleError extends Error {
  constructor(readonly code: "invalid_input", message: string) {
    super(message);
  }
}

export interface ReplyStyleUpdateOutcome {
  replyStyle: ReplyStyleDto;
  changed: boolean;
  before: string;
  after: string;
}

/** 主人操作的一句话：改了什么。 */
export function replyStyleChangeSummary(before: string, after: string, mode: ReplyStyleUpdateRequest["mode"]): string {
  if (!after) return "清空了代回复风格";
  if (mode === "append") return "在代回复风格后面追加了一段";
  return before ? "改了代回复风格" : "写了代回复风格";
}

/** 改代回复风格。授权已经由操作层做过。没有变化时什么也不写。 */
export function updateReplyStyle(
  db: Db, input: { request: ReplyStyleUpdateRequest; by: ReplyStyleAuthor; now: Date },
): ReplyStyleUpdateOutcome {
  if (!Value.Check(ReplyStyleUpdateRequestSchema, input.request)) {
    throw new ReplyStyleError("invalid_input", "input 是 { mode: replace 或 append, text, label? }");
  }
  return db.transaction(() => {
    const current = getReplyStyle(db);
    const after = nextReplyStyleText(current.text, input.request, input.now);
    const problem = replyStyleProblem(input.request, after);
    if (problem) throw new ReplyStyleError("invalid_input", problem);
    if (after === current.text) return { replyStyle: current, changed: false, before: current.text, after };
    const replyStyle = writeReplyStyle(db, after, { by: input.by, at: input.now });
    return { replyStyle, changed: true, before: current.text, after };
  }).immediate();
}

/** 「不是我」/「撤销」：现在还是那次改完的样子时，恢复成改之前的样子。之后又改过的不动。 */
export function revertReplyStyle(
  db: Db, undo: { before: string; after: string }, options: { now?: Date } = {},
): "reverted" | "changed_since" | "unchanged" {
  const current = getReplyStyle(db).text;
  if (current === undo.before) return "unchanged";
  if (current !== undo.after) return "changed_since";
  db.transaction(() => writeReplyStyle(db, undo.before, { by: "user", at: options.now ?? new Date() })).immediate();
  return "reverted";
}

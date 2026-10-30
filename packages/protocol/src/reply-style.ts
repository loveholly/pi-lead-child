// 代回复风格（设置 → 消息通道 → 代回复风格，2026-10-28，.scratch/channel-reply-style/spec.md）的线上契约。
// - 一段用户写的文字。Lead 和它派出的子 agent 以用户的名义写给别人的话都按它写：Lead 的系统提示词里有一节（lead 的
//   reply-style.ts），子 agent 的系统提示词里有一行（lead 的 agent-task/prompt.ts）。不分来源：现在只有 Slack，以后的来源也用它。
// - 存在 plc.db 的 kv（channel.reply_style）。改用操作层的 reply_style.update（页面和 Lead 的 perform_action 调同一个函数），
//   权限是 user_only；它写进 Lead 的系统提示词，所以带着外部内容的一轮一律拒绝，用户本人的一轮也一样（AGENTS.md）。
//   每次修改记一次主人操作（channel.reply_style），能撤销。
// - 提炼（reply_style.extract）读最近 N 天用户本人在来源里发的话，让便宜模型写出风格特征，交给用户预览。它不写任何东西：
//   用户改完点「追加」才调 update（mode=append）。
// - 变化时网关发 snapshot.required，payload 是 {resource: "reply-style"}，客户端重新 GET。
import { Type, type Static, type TProperties, type TSchema } from "typebox";
import { normalizeLeadProfileText } from "./lead-profile.ts";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const REPLY_STYLE_TEXT_MAX_LENGTH = 2_000;
export const REPLY_STYLE_LABEL_MAX_LENGTH = 60;
export const REPLY_STYLE_RESOURCE = "reply-style";
// 提炼的时间范围（天）。页面给 7、15、30 三档，缺省 15。
export const REPLY_STYLE_EXTRACT_DAY_CHOICES = [7, 15, 30] as const;
export const REPLY_STYLE_EXTRACT_DEFAULT_DAYS = 15;
export const REPLY_STYLE_EXTRACT_MAX_DAYS = 30;
// 提炼出来的提案最多多少字，冲突最多几条。
export const REPLY_STYLE_PROPOSAL_MAX_LENGTH = 600;
export const REPLY_STYLE_CONFLICTS_MAX = 5;

export const ReplyStyleAuthorSchema = Type.Union([Type.Literal("user"), Type.Literal("lead")]);
export type ReplyStyleAuthor = Static<typeof ReplyStyleAuthorSchema>;

export const ReplyStyleDtoSchema = StrictObject({
  // 空字符串表示没写：按 Lead 缺省的写法。
  text: Type.String({ maxLength: REPLY_STYLE_TEXT_MAX_LENGTH }),
  // 最近一次修改。从没改过时都是 null。
  updatedAt: Nullable(Type.String()),
  // user：用户在设置页改的；lead：Lead 在用户的一轮里代他改的。
  updatedBy: Nullable(ReplyStyleAuthorSchema),
});
export type ReplyStyleDto = Static<typeof ReplyStyleDtoSchema>;

export const ReplyStyleResponseSchema = StrictObject({ replyStyle: ReplyStyleDtoSchema });
export type ReplyStyleResponse = Static<typeof ReplyStyleResponseSchema>;

export const DEFAULT_REPLY_STYLE: ReplyStyleDto = Object.freeze({ text: "", updatedAt: null, updatedBy: null });

// reply_style.update 的输入（POST /v1/channels/reply-style 的请求体）。
//   replace：text 是改完以后的整段，空字符串表示清空。
//   append：text 接在现在的内容后面，前面加一行小标题「### {label}（月-日）」，label 不给时是「追加」。原来的内容不动。
// 长度在这里放宽一点，按整理以后的文字检查（replyStyleProblem）。
export const ReplyStyleUpdateRequestSchema = StrictObject({
  mode: Type.Union([Type.Literal("replace"), Type.Literal("append")]),
  text: Type.String({ maxLength: REPLY_STYLE_TEXT_MAX_LENGTH * 2 }),
  label: Type.Optional(Type.String({ maxLength: REPLY_STYLE_LABEL_MAX_LENGTH * 2 })),
});
export type ReplyStyleUpdateRequest = Static<typeof ReplyStyleUpdateRequestSchema>;

// reply_style.extract 的输入（POST /v1/channels/reply-style/extract 的请求体）。days 不给时是 15，source 不给时是 slack。
export const REPLY_STYLE_DEFAULT_SOURCE = "slack";
export const ReplyStyleExtractRequestSchema = StrictObject({
  days: Type.Optional(Type.Integer({ minimum: 1, maximum: REPLY_STYLE_EXTRACT_MAX_DAYS })),
  source: Type.Optional(Type.String({ pattern: "^[a-z][a-z0-9_-]{0,39}$" })),
});
export type ReplyStyleExtractRequest = Static<typeof ReplyStyleExtractRequestSchema>;

export const ReplyStyleConflictSchema = StrictObject({
  // 框里现在写的（原文里的一句）。
  existing: Type.String({ maxLength: 300 }),
  // 最近的消息里看到的做法。
  observed: Type.String({ maxLength: 300 }),
});
export type ReplyStyleConflict = Static<typeof ReplyStyleConflictSchema>;

export const ReplyStyleExtractResultSchema = StrictObject({
  // ok：有提案（可能是空的：模型没写出能用的特征）；too_few：用户本人的消息太少，没有调模型。
  status: Type.Union([Type.Literal("ok"), Type.Literal("too_few")]),
  // 提炼出的风格特征，一行一条。用户改完以后用 update（mode=append）追加。
  proposal: Type.String({ maxLength: REPLY_STYLE_PROPOSAL_MAX_LENGTH * 2 }),
  conflicts: Type.Array(ReplyStyleConflictSchema, { maxItems: REPLY_STYLE_CONFLICTS_MAX }),
  // 依据：读了几天、几条用户本人的消息、几个对话、最早和最晚一条的时间。
  basis: StrictObject({
    days: Type.Integer({ minimum: 1 }),
    messages: Type.Integer({ minimum: 0 }),
    conversations: Type.Integer({ minimum: 0 }),
    from: Nullable(Type.String()),
    to: Nullable(Type.String()),
  }),
  // 代码去掉的行数：抄了原文、带着人名或对话名的行。
  dropped: Type.Integer({ minimum: 0 }),
  // 追加时用的小标题，例如「从 Slack 提炼：最近 15 天，87 条」。
  label: Type.String({ maxLength: REPLY_STYLE_LABEL_MAX_LENGTH }),
  // 给用户看的一句话（条数太少、模型没写出能用的特征）。没有时为 null。
  note: Nullable(Type.String()),
});
export type ReplyStyleExtractResult = Static<typeof ReplyStyleExtractResultSchema>;

export const ReplyStyleExtractResponseSchema = StrictObject({ result: ReplyStyleExtractResultSchema });
export type ReplyStyleExtractResponse = Static<typeof ReplyStyleExtractResponseSchema>;

/** 整段文字：去掉控制字符，统一换行，去掉两头的空白（和人格同一套）。 */
export function normalizeReplyStyleText(text: string): string {
  return normalizeLeadProfileText(text);
}

/** 小标题的文字压成一行。 */
export function normalizeReplyStyleLabel(label: string): string {
  return normalizeLeadProfileText(label).replace(/\s+/gu, " ").replace(/^#+\s*/u, "");
}

export const replyStyleLength = (text: string): number => [...text].length;

/** 追加的那一段的小标题：「### 从 Slack 提炼：最近 15 天，87 条（10-28）」。日期按 daemon 所在机器的本地时间。 */
export function replyStyleAppendHeading(label: string | undefined, at: Date): string {
  const name = label !== undefined ? normalizeReplyStyleLabel(label) : "";
  const day = `${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
  return `### ${name || "追加"}（${day}）`;
}

/** 按请求算出改完以后的整段（已经整理过）。不检查长度：用 replyStyleProblem。 */
export function nextReplyStyleText(current: string, request: ReplyStyleUpdateRequest, at: Date): string {
  const text = normalizeReplyStyleText(request.text);
  if (request.mode === "replace") return text;
  const section = `${replyStyleAppendHeading(request.label, at)}\n${text}`;
  return current ? `${current}\n\n${section}` : section;
}

/** 这次修改有什么问题，用户能看懂的一句话。没有问题时返回 null。 */
export function replyStyleProblem(request: ReplyStyleUpdateRequest, next: string): string | null {
  if (request.mode === "append" && !normalizeReplyStyleText(request.text)) return "追加的内容是空的";
  if (request.label !== undefined && replyStyleLength(normalizeReplyStyleLabel(request.label)) > REPLY_STYLE_LABEL_MAX_LENGTH) {
    return `小标题最多 ${REPLY_STYLE_LABEL_MAX_LENGTH} 个字`;
  }
  const length = replyStyleLength(next);
  if (length > REPLY_STYLE_TEXT_MAX_LENGTH) {
    const over = length - REPLY_STYLE_TEXT_MAX_LENGTH;
    return request.mode === "append"
      ? `代回复风格最多 ${REPLY_STYLE_TEXT_MAX_LENGTH} 字，追加以后是 ${length} 字，超了 ${over} 字。先删掉一些再追加`
      : `代回复风格最多 ${REPLY_STYLE_TEXT_MAX_LENGTH} 字，现在是 ${length} 字，超了 ${over} 字`;
  }
  return null;
}

// 引用回复（2026-11-18，设计规范 P17、主题 11.22）。
//
// 用户在会话里选中一段话，可以对它说一句，再和这条消息一起发给 Lead。一条消息可以带好几段引用。
// 能引用的有三种：Lead 的回答、用户自己发的消息、外来消息卡里对方的话（P17.1）。
//
// 线上契约（和图片一样，chat-images.ts）：
//   · 旧 daemon 严格校验命令、不认识 quotes：客户端只在 hello.v2 的 capabilities 里有 CHAT_QUOTES_CAPABILITY 时带它。
//   · 会话快照里的 quotes 只在 ?include=quotes 时才有：旧客户端严格校验整条记录。
//   · 只有 Lead 的会话收引用。
//   · 引用的原文必须真的出现在来源里（P17.2）：daemon 用 chatQuoteAppearsIn 核对，对不上的整条消息拒收。
//     Lead 看到的原文因此和会话里的一样，客户端改不了字。
//   · 外来消息卡里的话照旧是外部内容（P17.9）：daemon 把它放进 untrusted_external_text，不放进用户的话里。
import { Type, type Static } from "typebox";

export const CHAT_QUOTES_CAPABILITY = "chat.quotes.v1";
// GET /v1/conversation/turns?include=quotes：每一轮带上用户这条消息里的引用。
export const CHAT_QUOTES_INCLUDE = "quotes";

// 一条消息最多带几段引用。
export const CHAT_QUOTE_MAX_COUNT = 10;
// 一段引用的原文最长多少个字符。更长的要先缩短范围。
export const CHAT_QUOTE_TEXT_MAX_LENGTH = 4000;
// 对一段引用的说明最长多少个字符。
export const CHAT_QUOTE_NOTE_MAX_LENGTH = 4000;
// 客户端自己用的定位信息（跳回原文时找到那一段）最长多少个字符。daemon 原样存、原样还，不解读。
export const CHAT_QUOTE_ANCHOR_MAX_LENGTH = 200;

// 引用的来源。turn：会话里的一轮，role 说是 Lead 的回答还是用户的话。card：一张外来消息卡（对方的话）。
export const ChatQuoteSourceSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("turn"),
    turnId: Type.String({ minLength: 1, maxLength: 128 }),
    role: Type.Union([Type.Literal("assistant"), Type.Literal("user")]),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("card"),
    cardId: Type.Integer({ minimum: 1 }),
  }, { additionalProperties: false }),
]);
export type ChatQuoteSource = Static<typeof ChatQuoteSourceSchema>;

// chat.send 里的一段引用。
export const ChatQuoteInputSchema = Type.Object({
  source: ChatQuoteSourceSchema,
  text: Type.String({ minLength: 1, maxLength: CHAT_QUOTE_TEXT_MAX_LENGTH }),
  note: Type.Optional(Type.String({ maxLength: CHAT_QUOTE_NOTE_MAX_LENGTH })),
  anchor: Type.Optional(Type.String({ maxLength: CHAT_QUOTE_ANCHOR_MAX_LENGTH })),
}, { additionalProperties: false });
export type ChatQuoteInput = Static<typeof ChatQuoteInputSchema>;

export const ChatQuotesInputSchema = Type.Array(ChatQuoteInputSchema, { minItems: 1, maxItems: CHAT_QUOTE_MAX_COUNT });

// 原文是谁说的：lead、user（用户自己）、external（外来消息卡里的对方）。daemon 按来源写，客户端不能指定。
export const ChatQuoteAuthorSchema = Type.Union([Type.Literal("lead"), Type.Literal("user"), Type.Literal("external")]);
export type ChatQuoteAuthor = Static<typeof ChatQuoteAuthorSchema>;

// 会话快照里用户的一轮带的一段引用（include=quotes），按加入的顺序。
export const ChatQuoteRefSchema = Type.Object({
  source: ChatQuoteSourceSchema,
  author: ChatQuoteAuthorSchema,
  text: Type.String({ minLength: 1 }),
  note: Type.Optional(Type.String()),
  anchor: Type.Optional(Type.String()),
}, { additionalProperties: false });
export type ChatQuoteRef = Static<typeof ChatQuoteRefSchema>;

// 核对用的写法：Unicode 规范化（NFKC），转小写，只留字母和数字。
// 会话里显示的是 Markdown 渲染后的文字（去掉了 **、链接语法、列表符号，相邻的片段合在一起），
// 存着的是 Markdown 原文。两边都只比字母和数字，渲染时去掉或加上的符号和空白就不影响核对。
export function chatQuoteMatchKey(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

// Markdown 链接和图片的地址：`[文字](地址)`、`![说明](地址)`，地址可以带标题。
const MARKDOWN_LINK_DESTINATION =
  /(!?\[[^\]\n]*\])\((?:<[^>\n]*>|[^()\s]*(?:\([^()\s]*\)[^()\s]*)*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)/gu;
// 引用式链接：`[文字][名字]` 只显示文字；定义行（`[名字]: https://…`）整行不显示。
const MARKDOWN_LINK_REFERENCE = /(\[[^\]\n]*\])\[[^\]\n]*\]/gu;
const MARKDOWN_LINK_DEFINITION = /^ {0,3}\[[^\]\n]+\]:[^\n]*$/gmu;

// 来源的 Markdown 原文换成会话里看得到的字：链接只显示文字，地址不显示（plc:ticket/12、https://…）。
// 只去掉符号还不够：地址里的字母和数字留在原文里，选区一跨过链接（「三张单都通过了：#12（收不到…」），
// 选中的字在原文里就连不上，「回复」不出现，daemon 也会拒收。没有说明的图片显示的是地址，留着它。
export function chatQuoteSourceText(markdown: string): string {
  return markdown
    .replace(MARKDOWN_LINK_DESTINATION, (whole, label: string) => (label === "![]" ? whole : label))
    .replace(MARKDOWN_LINK_DEFINITION, "")
    .replace(MARKDOWN_LINK_REFERENCE, "$1");
}

// 引用的原文是不是出现在来源的文字里。sources 是来源的几段 Markdown 原文（一轮的回答，或者一张卡里对方的几条消息）。
// 原文里没有字母和数字（只选中了标点）时算对不上。
export function chatQuoteAppearsIn(quote: string, sources: readonly string[]): boolean {
  const key = chatQuoteMatchKey(quote);
  if (!key) return false;
  return sources.some((source) => chatQuoteMatchKey(chatQuoteSourceText(source)).includes(key));
}

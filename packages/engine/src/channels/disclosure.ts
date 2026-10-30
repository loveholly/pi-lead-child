// 出站的披露署名（代查与按信心代回 spec D8，硬性规则）。署名由 hub 加，适配器不负责；只有 hub 能调出站。
// 署名是消息开头的一行，写明这条消息是助手发的（用户 2026-10-21：英文写，排成小号灰字）。下面的例子用缺省的助手名 Paimon：
//   - 代查开始时的一句「正在处理」：「Paimon (Assistant) is checking…」，动作词由请求 A 从 HANDLING_VERBS 里选；
//   - 自动发出的回复（子 agent 工单的结果、Lead 写的回复、收尾的一句、授权表代你拒绝的话）：「Paimon (Assistant) · auto-reply for <主人名>」；
//   - 用户点「直接回复」发出的助手草稿（工单的草稿、Lead 改过的草稿）：「Paimon (Assistant) · confirmed by <主人名>」；
//   - 用户点「改一下再发」发出的文字：是用户自己的话，不加署名。
//   PR 上的 review 由子 agent 在工具的规矩里发（落地计划 D1），通道不再往 PR 上发东西。
// 不加 🤖（用户 2026-10-21）：「(Assistant)」已经写明是助手，来源可以在名字前面加自己的标记（见下）。
// 署名和正文分开交给适配器（DisclosedText.parts）：有自己样式的来源把署名排成小字；
// text 总是完整的一条消息（署名一行加正文），没有样式的来源照样发它，署名也不会丢。
// 主人名：凭据里的 accountName（来源里用户本人的名字），其次配置 channels.ownerName，最后「用户」。
// 助手名：配置 channels.assistantName；没有配置时是 Lead 的名字（设置 → 身份与风格，用户 2026-10-22：Slack 的署名和它对齐，
// 以前写死成 Fairy）。daemon 把它交给 hub（assistantName）。来源可以在助手名前面加自己的标记（适配器的 disclosureMark，例如自定义 emoji），
// 只加在发到这个来源的署名里。
// 这里不出现任何具体来源的名字。
import { DEFAULT_LEAD_NAME } from "@pi-lead-child/protocol";

/** 取不到名字时用的称呼。 */
export const OWNER_NAME_FALLBACK = "用户";
/** 助手的名字：配置 channels.assistantName 和 Lead 的名字都取不到时用（缺省的 Lead 名字）。 */
export const ASSISTANT_NAME_DEFAULT = DEFAULT_LEAD_NAME;

/**
 * 「正在处理」里的动作词：请求 A 的 handling_verb 从这里选一个（固定的几个，模型不能写别的字进对外的消息）。
 * 值是选项名，HANDLING_PHRASES 是发出去的英文。
 */
export const HANDLING_VERBS = ["checking", "reviewing", "looking_into", "investigating", "working_on"] as const;
export type HandlingVerb = typeof HANDLING_VERBS[number];

export const HANDLING_PHRASES: Record<HandlingVerb, string> = {
  checking: "checking",
  reviewing: "reviewing",
  looking_into: "looking into this",
  investigating: "investigating",
  working_on: "working on this",
};

/** 请求 A 没有选出动作词时，按剧本用的缺省值。 */
export function defaultHandlingVerb(playbook: string): HandlingVerb {
  return playbook === "review" ? "reviewing" : "checking";
}

export function isHandlingVerb(value: unknown): value is HandlingVerb {
  return typeof value === "string" && (HANDLING_VERBS as readonly string[]).includes(value);
}

/** 一条带署名的消息：parts 给有样式的来源，text 是完整的一条（署名一行加正文）。 */
export interface DisclosedText {
  text: string;
  parts: { byline: string; body: string | null };
}

const oneLine = (name: string | null | undefined): string => name?.replace(/\s+/g, " ").trim() ?? "";

/** 署名里的主人名：按顺序取第一个非空的名字，压成一行，最多 60 个字。 */
export function disclosureOwnerName(...names: Array<string | null | undefined>): string {
  for (const name of names) {
    const clean = oneLine(name);
    if (clean) return clean.slice(0, 60);
  }
  return OWNER_NAME_FALLBACK;
}

/** 署名里的助手名：给的名字压成一行，最多 40 个字；没有时是 ASSISTANT_NAME_DEFAULT。 */
export function disclosureAssistantName(name?: string | null): string {
  return oneLine(name).slice(0, 40) || ASSISTANT_NAME_DEFAULT;
}

const assistantLabel = (assistant: string) => `${assistant} (Assistant)`;

/** 带署名的一条消息。正文是空的时只有署名。 */
export function disclosed(byline: string, body: string | null): DisclosedText {
  const clean = body?.trim() ? body : null;
  return { text: clean ? `${byline}\n${clean}` : byline, parts: { byline, body: clean } };
}

/** 代查开始时的一句「正在处理」。只有署名，没有正文。 */
export function handlingNotice(assistant: string, verb: HandlingVerb): DisclosedText {
  return disclosed(`${assistantLabel(assistant)} is ${HANDLING_PHRASES[verb]}…`, null);
}

/** 自动发出的回复。 */
export function autoReplyDisclosure(assistant: string, owner: string, text: string): DisclosedText {
  return disclosed(`${assistantLabel(assistant)} · auto-reply for ${owner}`, text);
}

/** 回给用户本人的话（用户发给自己的私信那一轮的回复）：只署助手的名字，和用户自己写的话分开。 */
export function ownerReplyDisclosure(assistant: string, text: string): DisclosedText {
  return disclosed(assistantLabel(assistant), text);
}

/** 用户确认以后发出的助手草稿。 */
export function confirmedDraftDisclosure(assistant: string, owner: string, text: string): DisclosedText {
  return disclosed(`${assistantLabel(assistant)} · confirmed by ${owner}`, text);
}


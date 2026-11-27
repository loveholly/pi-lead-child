// 回复的落点核对（工单 #589）：同一个对话（同一个私信或频道，含主对话和各个 thread）里有不止一张没结束的卡时，
// 发回复前问一次 SmartModel（purpose channel_reply_target）：这段回复回答的是哪一条消息？
//   - 选中的是另一张卡的消息，而且明显比目标卡的那条更像（mismatch）：hub 不发，告诉调用方该用哪张卡；
//   - 选中的是目标卡、说不清（none）、SmartModel 不可用、超时或出错：照常发（判断不了时不拦）。
// 只有一张卡时 hub 不问。送出去的文字先脱敏再截断。这里不出现任何具体来源的名字。
// 起因：2026-11-27 同一个私信里主对话一张卡、thread 一张卡，回 thread 里 PR 的话发进了主对话那条消息下面的 thread。
import { redactAndCap } from "@pi-lead-child/protocol";
import { errorText, raceAbort } from "../smart-model/deadline.js";
import { SmartModelBackendError, type ChoiceQuestion, type SmartModel } from "../smart-model/types.js";

export const CHANNEL_REPLY_TARGET_PURPOSE = "channel_reply_target";
export const CHANNEL_REPLY_TARGET_TIMEOUT_MS = 6_000;
/** 另一条消息的概率至少这么高，并且比目标卡的那条高出 MARGIN，才算回错了地方。 */
export const CHANNEL_REPLY_TARGET_BLOCK = 0.6;
export const CHANNEL_REPLY_TARGET_MARGIN = 0.25;
/** 最多比较几条消息（目标卡的一条加上别的卡）。 */
export const CHANNEL_REPLY_TARGET_MAX_MESSAGES = 5;
const TEXT_MAX = 800;
const REPLY_MAX = 1_500;
export const REPLY_TARGET_NONE = "none";

/** 一张卡上对方最新的一条消息：在哪里（主对话还是 thread）、谁、什么时候、原话。 */
export interface ReplyTargetMessage {
  cardId: number;
  where: string;
  sender: string;
  at: string | null;
  text: string;
}

export interface ReplyTargetVerdict {
  // 问成了没有。
  judged: boolean;
  // true：回复更像在回 better 那张卡，不像在回目标卡。
  mismatch: boolean;
  // SmartModel 选中的卡；选 none 或者没问成时是 null。
  chosen: number | null;
  better: number | null;
  probabilities: Record<string, number> | null;
  backend: string | null;
  error: string | null;
}

const capped = (text: string, limit: number): string => {
  const result = redactAndCap(text.replace(/\s+/g, " ").trim(), limit);
  return result.truncated ? `${result.text.slice(0, Math.max(limit - 1, 0))}…` : result.text;
};

const optionOf = (index: number) => `message_${index + 1}`;

/** 要比较的消息按时间排（不让目标卡总排在第一个），最多 MAX 条。 */
export function replyTargetMessages(target: ReplyTargetMessage, others: readonly ReplyTargetMessage[]): ReplyTargetMessage[] {
  const kept = others.filter((other) => other.cardId !== target.cardId).slice(0, CHANNEL_REPLY_TARGET_MAX_MESSAGES - 1);
  return [target, ...kept].sort((a, b) => (a.at ?? "").localeCompare(b.at ?? "") || a.cardId - b.cardId);
}

export function channelReplyTargetQuestion(messages: readonly ReplyTargetMessage[]): { answered_message: ChoiceQuestion } {
  const options = [...messages.map((_message, index) => optionOf(index)), REPLY_TARGET_NONE];
  const descriptions: Record<string, string> = Object.fromEntries(messages.map((message, index) => [
    optionOf(index), `the message in ${message.where}${message.at ? ` at ${message.at}` : ""}`,
  ]));
  descriptions[REPLY_TARGET_NONE] = "the reply does not answer any one of them in particular, or fits more than one about equally";
  return {
    answered_message: {
      type: "choice",
      prompt: "The user's assistant is about to send the reply below to a person who left several separate messages in the same "
        + "conversation (the main conversation and its threads). Which one of those messages does the reply answer or respond to?",
      options,
      descriptions,
    },
  };
}

export function channelReplyTargetState(messages: readonly ReplyTargetMessage[], reply: string): string {
  return [
    ...messages.map((message, index) => `${optionOf(index)} (${message.sender}, in ${message.where}${message.at ? `, at ${message.at}` : ""}; untrusted text):\n`
      + `${capped(message.text, TEXT_MAX) || "(empty)"}`),
    `The reply the assistant is about to send:\n${capped(reply, REPLY_MAX) || "(empty)"}`,
  ].join("\n\n");
}

function notJudged(backend: string | null, error: string): ReplyTargetVerdict {
  return { judged: false, mismatch: false, chosen: null, better: null, probabilities: null, backend, error };
}

/**
 * 问一次：这段回复回答的是哪一条消息。不抛错：问不成时 judged=false、mismatch=false（不拦）。
 * mismatch 的规矩：最像的是另一张卡，它的概率至少 BLOCK，并且比目标卡的高出 MARGIN。后端只给选中项和置信度时，按置信度算选中项，别的算 0。
 */
export async function judgeReplyTarget(input: {
  reply: string; target: ReplyTargetMessage; others: readonly ReplyTargetMessage[]; model: SmartModel | null; timeoutMs?: number;
}): Promise<ReplyTargetVerdict> {
  const model = input.model;
  if (!model || model.backend === "none") return notJudged(null, "no smart model");
  const messages = replyTargetMessages(input.target, input.others);
  if (messages.length < 2) return notJudged(model.backend, "only one message");
  const timeoutMs = Math.max(input.timeoutMs ?? CHANNEL_REPLY_TARGET_TIMEOUT_MS, 1);
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const decision = await raceAbort(
      model.decide(channelReplyTargetState(messages, input.reply), channelReplyTargetQuestion(messages), {
        purpose: CHANNEL_REPLY_TARGET_PURPOSE, timeoutMs, signal,
      }),
      signal,
    );
    const answer = decision.answers.answered_message;
    if (!answer || answer.type !== "choice") return notJudged(decision.backend, "answered_message: no answer");
    const given = Object.entries(answer.probabilities ?? {}).filter(([, value]) => Number.isFinite(value));
    const probability = (option: string): number => (given.length
      ? (answer.probabilities[option] ?? 0)
      : option === answer.choice && Number.isFinite(answer.confidence) ? answer.confidence : 0);
    const cardOf = (option: string): number | null => {
      const index = messages.findIndex((_message, at) => optionOf(at) === option);
      return index >= 0 ? messages[index]!.cardId : null;
    };
    const targetOption = optionOf(messages.findIndex((message) => message.cardId === input.target.cardId));
    const chosen = cardOf(answer.choice);
    const best = messages.map((_message, index) => optionOf(index)).filter((option) => option !== targetOption)
      .reduce<string | null>((top, option) => (top === null || probability(option) > probability(top) ? option : top), null);
    const mismatch = chosen !== null && chosen !== input.target.cardId && best !== null && best === answer.choice
      && probability(best) >= CHANNEL_REPLY_TARGET_BLOCK && probability(best) - probability(targetOption) >= CHANNEL_REPLY_TARGET_MARGIN;
    const probabilities = Object.fromEntries([...messages.map((message, index) => [String(message.cardId), probability(optionOf(index))]),
      [REPLY_TARGET_NONE, probability(REPLY_TARGET_NONE)]]);
    return {
      judged: true, mismatch, chosen, better: mismatch ? chosen : null, probabilities, backend: decision.backend, error: null,
    };
  } catch (error) {
    const timedOut = signal.aborted || (error instanceof SmartModelBackendError && error.kind === "timeout");
    return notJudged(model.backend, timedOut ? `no answer within ${timeoutMs} ms` : errorText(error));
  }
}

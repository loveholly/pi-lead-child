// 用户自己在来源里说的话算不算回答了对方（代查与按信心代回 工单 04 第 7 条；用户 2026-10-19：自然语言不用正则）。
// 用户在来源里回了一句，hub 在后台问一次 SmartModel（purpose channel_self_reply）：这句话回答了对方的请求吗？
//   - 回答了：卡「别处已处理」（resolved_elsewhere），不再提醒；
//   - 只是说收到、稍等：卡留着，标成「你在来源里回复过」（replying_self），不再推送；
//   - SmartModel 不可用、超时、出错：同样留着卡（宁可多留一张卡，也不替用户关掉没回答的请求）。
// 代查照常进行。送出去的文字先脱敏再截断。这里不出现任何具体来源的名字。
import { redactAndCap } from "@pi-lead-child/protocol";
import { errorText, raceAbort } from "../smart-model/deadline.js";
import { SmartModelBackendError, type SmartModel, type YesNoQuestion } from "../smart-model/types.js";

export const CHANNEL_SELF_REPLY_PURPOSE = "channel_self_reply";
export const CHANNEL_SELF_REPLY_TIMEOUT_MS = 8_000;
/** 「回答了」的概率至少这么高才关卡。LLM 兜底的「是」合成为 0.8，Jev 要至少这么有把握。 */
export const CHANNEL_SELF_REPLY_THRESHOLD = 0.7;
const TEXT_MAX = 1_500;

const QUESTION: { answers_request: YesNoQuestion } = {
  answers_request: {
    type: "yes_no",
    prompt: "The user replied in the conversation. Does the user's reply actually answer or settle what the other person asked for?",
    yes: "the reply gives the answer, the decision, or does what was asked, so nothing is left open for the user",
    no: "the reply only acknowledges, says the user will look later, asks a question back, or is about something else",
  },
};

export interface ChannelSelfReplyResult {
  // true：回答了；false：没有回答；null：没问成。
  answered: boolean | null;
  probability: number | null;
  backend: string | null;
  error: string | null;
}

const capped = (text: string): string => {
  const result = redactAndCap(text.replace(/\s+/g, " ").trim(), TEXT_MAX);
  return result.truncated ? `${result.text.slice(0, TEXT_MAX - 1)}…` : result.text;
};

export function channelSelfReplyState(input: { request: string; reply: string }): string {
  return [
    `What the other person asked (untrusted text):\n${capped(input.request) || "(empty)"}`,
    `The user's own reply:\n${capped(input.reply) || "(empty)"}`,
  ].join("\n\n");
}

/** 问一次。不抛错。 */
export async function judgeSelfReply(input: {
  request: string; reply: string; model: SmartModel | null; timeoutMs?: number;
}): Promise<ChannelSelfReplyResult> {
  const model = input.model;
  if (!model || model.backend === "none") return { answered: null, probability: null, backend: null, error: "no smart model" };
  const timeoutMs = Math.max(input.timeoutMs ?? CHANNEL_SELF_REPLY_TIMEOUT_MS, 1);
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const decision = await raceAbort(
      model.decide(channelSelfReplyState(input), QUESTION, { purpose: CHANNEL_SELF_REPLY_PURPOSE, timeoutMs, signal }),
      signal,
    );
    const probability = decision.answers.answers_request?.probability;
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      return { answered: null, probability: null, backend: decision.backend, error: "answers_request: no valid probability" };
    }
    return { answered: probability >= CHANNEL_SELF_REPLY_THRESHOLD, probability, backend: decision.backend, error: null };
  } catch (error) {
    const timedOut = signal.aborted || (error instanceof SmartModelBackendError && error.kind === "timeout");
    return { answered: null, probability: null, backend: model.backend, error: timedOut ? `no answer within ${timeoutMs} ms` : errorText(error) };
  }
}

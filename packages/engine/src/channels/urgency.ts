// 别人发来的消息紧不紧急（Lead 事件主干 spec D3、D10、D14；用户 2026-10-19：理解自然语言一律不用正则或关键词表，用快模型）。
// 通道内核对所有来源问同一个问题。来源插件只交出结构化的事实（发信人、信任、文字……），不给结论。
//
// 用哪个模型：hub 的 smartModel 选项。daemon 注入 Lead 会话的 SmartModel（Jev 优先，LLM 兜底），这里不自己建。
// 结果写进事件 payload 的 urgent，来源的投递指令按它决定推不推送（例如 pushWhen 里的 payload.urgent）。
// 依据写进 payload 的 urgency，用来审计。调用本身由 SmartModel 记成 decision_model.called（purpose 是 channel_urgency），
// get_system_usage 按用途统计。
// 规则：
//   - 只问别人发来的消息。用户本人的话、推回来的回复不是消息，hub 不问。机器人发的消息、没有文字的消息也不问，按不紧急处理。
//     紧急也只会记录的消息（投递指令里即使紧急也是 record，例如订阅频道里的普通消息）hub 也不问：问了也不改变什么，只花 token。
//   - 送出去的只有消息的文字：先按 redactSecretText 的规则脱敏，再截断（redactAndCap）。不送发信人的名字和来源。
//   - 宁可少推送：阈值很高（CHANNEL_URGENCY_THRESHOLD）。
//   - 不阻塞：每次调用有短的超时（CHANNEL_URGENCY_TIMEOUT_MS）。调用方不理会取消时，raceAbort 照样按时放弃等待。
//     SmartModel 不可用、超时、出错时按不紧急处理（照常入库、开卡，不推送），依据里写明是兜底。
import { redactAndCap } from "@pi-lead-child/protocol";
import { errorText, raceAbort } from "../smart-model/deadline.js";
import { SmartModelBackendError, type SmartModel, type YesNoQuestion } from "../smart-model/types.js";
import type { ChannelInbound } from "./types.js";

/** 决策日志和 decision_model.called 事件里的用途。 */
export const CHANNEL_URGENCY_PURPOSE = "channel_urgency";
/** 问题的版本。改了问题的措辞或者标准时加 1：审计时分得开新旧判断。 */
export const CHANNEL_URGENCY_QUESTION_VERSION = 1;
/**
 * 「需要马上看到」的概率至少这么高才算紧急。取 0.8 的理由：
 *   - 用户要求外部来源的打断阈值很高，宁可少推送。Jev 的概率是校准过的：0.8 表示这样的消息五条里有四条真的要用户马上看。
 *   - LLM 兜底的概率没有校准，只有「是」和「否」：「是」合成为 (1 + LLM_FIXED_CONFIDENCE) / 2 = 0.8（llm.ts）。
 *     阈值再高，没有 Jev 的 key 时就永远不推送了。所以取 0.8：LLM 明确说「是」才推送，Jev 要至少这么有把握。
 *   - 这只是推送的一道条件。来源的投递指令另有条件（例如只有你信任的人、只在私信里）。
 */
export const CHANNEL_URGENCY_THRESHOLD = 0.8;
/** 最多等多久。Jev 平时几百毫秒回答，LLM 兜底一两秒。超过时按不紧急处理：消息晚几秒开卡可以接受，不能更久。 */
export const CHANNEL_URGENCY_TIMEOUT_MS = 3_000;
/** 送给模型的文字最多多少字。紧不紧急看前面就够了。 */
export const CHANNEL_URGENCY_TEXT_MAX = 1_000;

const QUESTION = "needs_user_now";

/** 问 SmartModel 的问题：一个 yes_no，写明「是」和「否」的标准。 */
export function channelUrgencyQuestions(): { [QUESTION]: YesNoQuestion } {
  return {
    [QUESTION]: {
      type: "yes_no",
      prompt: "Someone sent the user this message. Does the user need to see it right now, even if that interrupts what they are doing?",
      yes: "something is broken or at risk right now (an outage, an incident, a security problem, lost data or money), "
        + "someone is blocked and waiting on the user, or a deadline is minutes or a few hours away",
      no: "it can wait until the user next reads messages: questions, requests, reviews, updates, thanks, plans and chat; "
        + "also when the message itself says there is no hurry. Words such as 'urgent' or 'ASAP' alone do not make it urgent",
    },
  };
}

/** 送给 SmartModel 的状态文本：只有消息的文字，先脱敏再截断。 */
export function channelUrgencyState(text: string): string {
  const capped = redactAndCap(text.replace(/\s+/g, " ").trim(), CHANNEL_URGENCY_TEXT_MAX);
  const clean = capped.truncated ? `${capped.text.slice(0, CHANNEL_URGENCY_TEXT_MAX - 1)}…` : capped.text;
  return `A message someone sent to the user:\n${clean}`;
}

/**
 * 兜底和不问的原因。
 *   unavailable：没有 SmartModel，或者它一个后端都没有。timeout：没有按时回答。error：调用失败或者回答不合法。
 *   bot：机器人发的消息。empty：消息没有文字。record_only：紧急也只会记录（不开卡、不推送），不用问。
 */
export type ChannelUrgencyReason = "unavailable" | "timeout" | "error" | "bot" | "empty" | "record_only";

/** 写进事件 payload 的 urgency：这条消息的 urgent 是怎样定的。 */
export interface ChannelUrgencyBasis {
  // smart_model：SmartModel 回答了。fallback：没有问成，按不紧急处理。not_asked：不用问，按不紧急处理。
  by: "smart_model" | "fallback" | "not_asked";
  reason: ChannelUrgencyReason | null;
  // 回答的后端（jev、llm）。没有问成时是模型的后端名；没有模型时是 null。
  backend: string | null;
  model: string | null;
  // 「需要马上看到」的概率。没有回答时是 null。
  probability: number | null;
  threshold: number;
  // SmartModel 里前一个后端失败、换了后端时（例如 Jev 失败、LLM 兜底），前一个后端。
  fallbackFrom: string | null;
  // 出错时的一行说明（已脱敏、截短）。
  error: string | null;
  questionVersion: number;
}

export interface ChannelUrgency {
  urgent: boolean;
  basis: ChannelUrgencyBasis;
}

function notUrgent(by: "fallback" | "not_asked", reason: ChannelUrgencyReason, backend: string | null, error: string | null = null): ChannelUrgency {
  return {
    urgent: false,
    basis: {
      by, reason, backend, model: null, probability: null, threshold: CHANNEL_URGENCY_THRESHOLD, fallbackFrom: null, error,
      questionVersion: CHANNEL_URGENCY_QUESTION_VERSION,
    },
  };
}

/** 不用问：按不紧急处理，依据里写明原因。 */
export function channelUrgencyNotAsked(reason: ChannelUrgencyReason): ChannelUrgency {
  return notUrgent("not_asked", reason, null);
}

/** 判断别人发来的一条消息紧不紧急。不抛错：问不成时按不紧急处理。 */
export async function judgeChannelUrgency(input: {
  item: Pick<ChannelInbound, "text" | "sender">;
  model: SmartModel | null;
  timeoutMs?: number;
}): Promise<ChannelUrgency> {
  if (input.item.sender.bot) return notUrgent("not_asked", "bot", null);
  if (!input.item.text.trim()) return notUrgent("not_asked", "empty", null);
  const model = input.model;
  if (!model || model.backend === "none") return notUrgent("fallback", "unavailable", null);
  const timeoutMs = Math.max(input.timeoutMs ?? CHANNEL_URGENCY_TIMEOUT_MS, 1);
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const decision = await raceAbort(
      model.decide(channelUrgencyState(input.item.text), channelUrgencyQuestions(), {
        purpose: CHANNEL_URGENCY_PURPOSE, timeoutMs, signal,
      }),
      signal,
    );
    const probability = decision.answers[QUESTION]?.probability;
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      return notUrgent("fallback", "error", decision.backend, `${QUESTION}: no valid probability in the answer`);
    }
    return {
      urgent: probability >= CHANNEL_URGENCY_THRESHOLD,
      basis: {
        by: "smart_model", reason: null, backend: decision.backend, model: decision.model, probability,
        threshold: CHANNEL_URGENCY_THRESHOLD, fallbackFrom: decision.fallbackFrom?.backend ?? null, error: null,
        questionVersion: CHANNEL_URGENCY_QUESTION_VERSION,
      },
    };
  } catch (error) {
    const timedOut = signal.aborted || (error instanceof SmartModelBackendError && error.kind === "timeout");
    return timedOut
      ? notUrgent("fallback", "timeout", model.backend, `no answer within ${timeoutMs} ms`)
      : notUrgent("fallback", "error", model.backend, errorText(error));
  }
}

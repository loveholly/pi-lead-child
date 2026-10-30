// 一段理由是不是在说「我自己核验过」（2026-10-19）。
//
// 只在这一轮什么都没读过（TurnEvidence 是空的）时才问：读过东西的，系统把清单附进记录就够了。
// 问 SmartModel（Jev 优先，LLM 兜底），不用关键词表：用户 2026-10-19 的规则是理解自然语言一律交给快模型。
// 「核验」「验证」「实测」也可能出现在转述里（「子 agent 验证了……」），只有模型分得清是谁做的。
// 问不成（没有 SmartModel、超时、出错）时不拦，记录里写明没有判断（unavailable）。
import { redactAndCap } from "@pi-lead-child/protocol";
import type { SmartModel, YesNoQuestion } from "@pi-lead-child/engine";

export const VERIFICATION_CLAIM_PURPOSE = "lead_verification_claim";
/**
 * 「作者自己核验过」的概率至少这么高才拦。取 0.8：LLM 兜底只有是和否，「是」合成为 0.8（engine 的 llm.ts）；
 * 再高，没有 Jev 的 key 时就永远不拦了。
 */
export const VERIFICATION_CLAIM_THRESHOLD = 0.8;
export const VERIFICATION_CLAIM_TIMEOUT_MS = 5_000;
const TEXT_MAX = 2_000;
const QUESTION = "claims_own_check";

export function verificationClaimQuestions(): { [QUESTION]: YesNoQuestion } {
  return {
    [QUESTION]: {
      type: "yes_no",
      prompt: "An assistant wrote this reason for a decision. Does it claim that the assistant itself checked, verified, "
        + "inspected or tested something (read the code or files, ran or reproduced something), rather than relaying "
        + "what another agent or a report said?",
      yes: "it says or implies the author did the check itself, for example 'I verified', 'read-only inspection on site', "
        + "'tested and confirmed', or states facts as personally confirmed",
      no: "it relays another agent's or reviewer's result, cites a report or run, states a plan or a preference, "
        + "or makes no verification claim at all",
    },
  };
}

export type VerificationClaim =
  | { by: "smart_model"; claims: boolean; probability: number; backend: string }
  | { by: "unavailable"; reason: string };

export async function judgeVerificationClaim(text: string, model: SmartModel | null | undefined): Promise<VerificationClaim> {
  if (!model || model.backend === "none") return { by: "unavailable", reason: "no SmartModel" };
  const capped = redactAndCap(text.replace(/\s+/g, " ").trim(), TEXT_MAX);
  try {
    const decision = await model.decide(`The reason the assistant wrote:\n${capped.text}`, verificationClaimQuestions(), {
      purpose: VERIFICATION_CLAIM_PURPOSE, timeoutMs: VERIFICATION_CLAIM_TIMEOUT_MS,
      signal: AbortSignal.timeout(VERIFICATION_CLAIM_TIMEOUT_MS),
    });
    const probability = decision.answers[QUESTION]?.probability;
    if (typeof probability !== "number" || !Number.isFinite(probability)) return { by: "unavailable", reason: "no valid answer" };
    return { by: "smart_model", claims: probability >= VERIFICATION_CLAIM_THRESHOLD, probability, backend: decision.backend };
  } catch (error) {
    return { by: "unavailable", reason: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) };
  }
}

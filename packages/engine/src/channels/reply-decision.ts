// 回复决定（落地计划 A6）：一份要代你发的草稿交给信心模型（confidence-model.ts），结论写成卡上显示的形状：信心、门槛、
// 校准、检查、否决项、原因。和代查的 verification 是同一个形状，卡片的线上契约不变。纯函数，不读库、不调模型。
// 结论只有三种：auto_send 代你发；ask_user 问你（以后交回 Lead，落地计划 B4）；hand_over 交给你（没查到、没查成、没有草稿）。
// 信心模型说 approve 时也问你：批准是 GitHub 工具自己的动作，由它的规矩检查（落地计划 C2），通道不批准。
// 这里不出现任何具体来源的名字。
import type { ChannelLookupCheckStatus, ChannelReplyDecision } from "@pi-lead-child/protocol";
import { CONFIDENCE_MODEL_DEFAULTS, type ConfidenceModelParams, type ConfidenceModelResult } from "./confidence-model.js";

export interface ChannelReplyDecisionCheck {
  id: string;
  label: string;
  status: ChannelLookupCheckStatus;
  value: number | null;
  detail: string;
}

export interface ChannelReplyDecisionResult {
  decision: ChannelReplyDecision;
  // 信心模型自己的结论（auto_send、approve、ask_user、hand_over，还有授权表的几种）。
  model: ConfidenceModelResult["decision"];
  confidence: number | null;
  threshold: number | null;
  calibration: { bucket: number; samples: number; agreed: number; minSamples: number } | null;
  checks: ChannelReplyDecisionCheck[];
  // 拦住代你发的：碰了的底线、不满足的前提。卡上单独显示。
  vetoes: string[];
  reasons: string[];
}

const pct = (value: number) => `${Math.round(value * 100)}%`;

/** 把信心模型的结论写成卡上显示的形状。 */
export function channelReplyDecision(
  result: ConfidenceModelResult, params: ConfidenceModelParams = CONFIDENCE_MODEL_DEFAULTS,
): ChannelReplyDecisionResult {
  const decision: ChannelReplyDecision = result.decision === "auto_send" ? "auto_send"
    : result.decision === "hand_over" ? "hand_over" : "ask_user";
  const reasons = result.decision === "approve"
    ? [...result.reasons, "批准由 GitHub 工具自己的规矩做，通道不批准：先问你"]
    : result.reasons;
  // 每一项乘进信心的倍数：不低于 0.9 算过，不低于 0.6 算弱，再低算没过。事实（核实）的值是条数，不是概率。
  const checks: ChannelReplyDecisionCheck[] = result.factors.map((factor) => ({
    id: factor.id, label: factor.label,
    status: factor.factor >= 0.9 ? "pass" : factor.factor >= 0.6 ? "weak" : "fail",
    value: factor.kind === "fact" ? null : factor.value,
    detail: `${factor.detail}（×${factor.factor.toFixed(2)}${result.raw === null ? "" : `，${Math.round(factor.points)}`}）`,
  }));
  checks.push({
    id: "cost", label: "代价", status: result.threshold === null ? "fail" : "pass", value: null,
    detail: `L${result.cost.level}${result.cost.name ? ` ${result.cost.name}` : ""}：`
      + `${result.cost.steps.map((step) => `${step.label} +${step.levels}（${step.detail}）`).join("，") || "没有加档"}`
      + `${result.threshold === null ? "，最高档不自动发" : `，门槛 ${pct(result.threshold)}`}`,
  });
  // 真的拦住了的底线：原因里有它（review 和 approve 的「替你承诺」不拦，见 confidence-model.ts）。
  const blocked = result.locks.filter((lock) => lock.hit && result.reasons.some((reason) => reason.startsWith(`底线：${lock.label}`)));
  for (const lock of blocked) checks.push({ id: `lock_${lock.id}`, label: lock.label, status: "fail", value: lock.value, detail: lock.detail });
  const calibration = result.calibration
    ? { bucket: result.calibration.bucket, samples: result.calibration.samples, agreed: result.calibration.agreed, minSamples: params.coldStartSamples }
    : null;
  return {
    decision, model: result.decision, confidence: result.confidence, threshold: result.threshold, calibration, checks,
    vetoes: [...blocked.map((lock) => lock.label), ...result.preconditions],
    reasons,
  };
}

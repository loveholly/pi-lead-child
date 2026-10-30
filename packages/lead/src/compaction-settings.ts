import type { SettingsManager } from "@earendil-works/pi-coding-agent";

// Lead 会话的压缩参数（2026-10-17 和 2026-10-28 上下文满了的根因）。
// pi 的自动压缩让模型写一段摘要。摘要最多 min(0.8 × compaction.reserveTokens, model.maxTokens) 个 token
// （pi-coding-agent 的 compaction.ts，generateSummaryWithUsage），写到上限就算压缩失败。reserveTokens 缺省 16384，上限是 13107。
// 每次压缩都把上一份摘要并进新的一份：Lead 的摘要从 7 月的 5 千字长到 10 月的 2.2 万–2.7 万字，贴着上限。
// 2026-10-28 09:44–10:23 压缩连续失败 10 次，每一轮的回答都被截成空的。
// 这里把 reserveTokens 调到 20480：0.8 × 20480 = 16384，正好是 Lead 模型的 maxTokens 缺省值（model-config.ts），
// 摘要能用满模型的输出上限。再大没有用（受 maxTokens 限制），只会让压缩更早。500K 窗口时 pi 在约 47.95 万 token 压缩。
// 只调上限挡不住摘要一直变长：daemon 在自动压缩失败以后自己压缩一次，带上长度预算（leadCompactionInstructions）。
export const LEAD_COMPACTION_RESERVE_TOKENS = 20_480;

// 用户在 pi 的 settings.json（数据目录下的 agent/settings.json）里写了 compaction.reserveTokens 时用用户的，返回 null。
// PLC_LEAD_COMPACTION_RESERVE_TOKENS 可以改缺省值。applyOverrides 只改内存里的设置，不写文件；
// pi 的 session.reload() 会重读设置文件，覆盖就没了，所以重新加载以后要再调一次。
export function applyLeadCompactionReserve(
  settingsManager: Pick<SettingsManager, "getGlobalSettings" | "getProjectSettings" | "applyOverrides">,
  env: Record<string, string | undefined> = process.env,
): number | null {
  const configured = [settingsManager.getGlobalSettings(), settingsManager.getProjectSettings()]
    .some((settings) => settings.compaction?.reserveTokens !== undefined);
  if (configured) return null;
  const fromEnv = Number(env.PLC_LEAD_COMPACTION_RESERVE_TOKENS);
  const reserveTokens = Number.isSafeInteger(fromEnv) && fromEnv > 0 ? fromEnv : LEAD_COMPACTION_RESERVE_TOKENS;
  settingsManager.applyOverrides({ compaction: { reserveTokens } });
  return reserveTokens;
}

// daemon 自己压缩时给摘要的长度（字）。中文大约一个字一个 token：8000 字离 16384 的上限还有一半的余量；
// 第一次还是写到上限时，第二次按 4000 字写。
export const LEAD_COMPACTION_BUDGETS = { normal: 8_000, strict: 4_000 } as const;

/**
 * daemon 自己压缩时给 pi 的 customInstructions（pi 的 session.compact）：摘要的长度预算和删减的标准。
 * strict 是第一次写到上限以后的第二次。
 */
export function leadCompactionInstructions(level: keyof typeof LEAD_COMPACTION_BUDGETS): string {
  const lines = [
    `这份摘要接替前面的全部对话。整份摘要不超过 ${LEAD_COMPACTION_BUDGETS[level]} 字。`,
    "只留后面还要用的事：正在做的事和它的下一步、没解决的问题、用户的偏好和决定、在等的事。",
    "工单、提醒、跟进、笔记写编号和一句话。细节已经在工单、笔记和事件日志里，不抄原文。",
    "做完了、不再影响后面的事删掉。上一份摘要里的内容也按这个标准删减，不要原样保留。",
  ];
  if (level === "strict") {
    lines.unshift(`上一次按 ${LEAD_COMPACTION_BUDGETS.normal} 字写，写到了输出上限。这一次更严：`);
  }
  return lines.join("\n");
}

/** pi 的摘要写到输出上限时的错误（compaction.ts：「generation hit the token cap and the summary is incomplete」）。 */
export function isSummaryTokenCapError(message: string): boolean {
  return /hit the token cap|summary is incomplete/i.test(message);
}

import { DEFAULT_LEAD_NAME } from "@pi-lead-child/protocol";

export const LEAD_MODEL_SWITCH_NOTICE_PREFIX = "【系统】";

export interface LeadModelSwitchRequest {
  previous: string;
  selected: string;
  reason: string;
}

// name 是 Lead 的名字（设置 → 身份与风格），不给时用缺省的。
export function leadModelSwitchStatusMessage(previous: string, selected: string, name: string = DEFAULT_LEAD_NAME): string {
  return `${LEAD_MODEL_SWITCH_NOTICE_PREFIX}正在把 ${name} 的模型从 ${previous} 切换到 ${selected}。当前对话会短暂中断，起来后使用新模型。`;
}

export function isLeadModelSwitchStatus(text: string): boolean {
  const value = text.trim();
  return value.startsWith(LEAD_MODEL_SWITCH_NOTICE_PREFIX) && value.includes("切换");
}

export function shouldFailEmptyLeadTurn(input: {
  assistantText: string;
  pendingModelSwitch: boolean;
  // 这一轮用 render_ui 画了定稿的卡片：卡片本身就是回答（generative UI）。
  drewSurface?: boolean;
}): boolean {
  return !input.assistantText.trim() && !input.pendingModelSwitch && !input.drewSurface;
}

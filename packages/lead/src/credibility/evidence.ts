// 这一轮 Lead 实际读过什么（2026-10-19）。
//
// 起因：Lead 没有 bash，却多次在 record_decision 的理由里写「实地只读核验」，测试结果全部转述自子 agent。
// 所以系统自己记下这一轮 Lead 成功调用过的取证工具（读文件、查账本、读外部账号），record_decision 和
// ticket_action 的验收（complete）把这份清单附进记录。清单是空的、理由又说自己核验过时，拒绝这次记录（verification-claim.ts）。
//
// 「一轮」是 pi 的一次 agent run：从一条输入（用户消息、系统事件）开始，到 Lead 停下为止（pi 的 agent_settled）。
export interface EvidenceItem {
  tool: string;
  // 读了什么：路径、工单号、Run 号或者调用的外部工具。
  target: string;
}

const MAX_ITEMS = 50;
const MAX_TARGET = 160;

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clip(text: string): string {
  return text.length > MAX_TARGET ? `${text.slice(0, MAX_TARGET - 1)}…` : text;
}

/** 一次工具调用读了什么，写成一短句。认不出参数时写工具名和参数的开头。 */
export function evidenceTarget(tool: string, args: unknown): string {
  const input = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const path = str(input.path);
  if (tool === "read") return path ?? "（没有路径）";
  if (tool === "grep") return `${str(input.pattern) ?? "?"} in ${path ?? "."}`;
  if (tool === "find" || tool === "ls") return `${path ?? "."}${str(input.pattern) ? ` (${str(input.pattern)})` : ""}`;
  if (tool === "call_connection_tool") return `${str(input.connection) ?? "?"}/${str(input.tool) ?? "?"}`;
  const ticket = num(input.ticket_id) ?? num(input.item_id);
  const run = num(input.run_id);
  const parts = [ticket !== null ? `#${ticket}` : null, run !== null ? `Run #${run}` : null].filter(Boolean);
  if (parts.length) return parts.join(" ");
  const raw = JSON.stringify(input);
  return clip(raw === "{}" ? "（无参数）" : raw);
}

export class TurnEvidence {
  private items: EvidenceItem[] = [];

  reset(): void {
    this.items = [];
  }

  record(tool: string, args: unknown): void {
    const item = { tool, target: clip(evidenceTarget(tool, args)) };
    if (this.items.some((existing) => existing.tool === item.tool && existing.target === item.target)) return;
    if (this.items.length < MAX_ITEMS) this.items.push(item);
  }

  list(): EvidenceItem[] {
    return [...this.items];
  }
}

/** 写进记录的一行：这一轮读过的东西，或者写明什么都没读。 */
export function describeEvidence(items: readonly EvidenceItem[]): string {
  if (items.length === 0) return "这一轮没有读过文件或工具结果";
  return items.map((item) => `${item.tool} ${item.target}`).join("；");
}

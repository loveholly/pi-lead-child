import type { MessagePart } from '../../state/types';

// 这一轮回复的依据（2026-10-15 方案 A）：按这一轮实际调用过、并且完成了的读取工具生成，不用 Lead 写的话。
// 只认识下面这些读取工具；改变外部状态的工具、失败或没结束的调用、render_ui 都不算依据。
const PROVENANCE: Record<string, (args: Record<string, unknown>) => string> = {
  read_run_events: (args) => typeof args.run_id === 'number' ? `Run #${args.run_id} 的事件` : 'Run 的事件',
  get_ticket: (args) => typeof args.id === 'number' ? `工单 #${args.id} 的账本` : '工单账本',
  query_tickets: () => '工单列表',
  list_needs_user: () => '等你处理的工单',
  read_inbox: () => '系统通知',
  read_notifications: () => '通知',
  get_runtime_health: () => '运行状态',
  get_model_catalog: () => '模型目录',
};

type ToolPart = Extract<MessagePart, { kind: 'tool' }>;

function readTools(parts: readonly MessagePart[]): Array<{ part: ToolPart; label: string; args: Record<string, unknown> }> {
  return parts.flatMap((part) => {
    if (part.kind !== 'tool' || part.state !== 'completed') return [];
    const label = PROVENANCE[part.name];
    if (!label) return [];
    const args = parseObject(part.args?.preview);
    return [{ part, label: label(args), args }];
  });
}

export function provenanceLabels(parts: readonly MessagePart[]): string[] {
  const labels: string[] = [];
  for (const { label } of readTools(parts)) {
    if (!labels.includes(label)) labels.push(label);
  }
  return labels;
}

// ——— 依据点开以后：Lead 具体读了什么（2026-10-16 用户要求）———
//
// 来源和标签出自同一份数据：这一轮工具调用的参数和结果（展示投影，脱敏，最多 2000 字）。
// 读取工具的结果是一行一条的文本，例如 list_needs_user 的「#1 [review] 成果快照与登记机制 — 核查未派发」。
//   · 工单类（等你处理的工单、工单列表）：行首的 #编号是工单号，界面按编号显示实时的标题和状态，可以点开。
//   · 工单账本：参数里的工单号。
//   · Run 的事件：参数里的 Run 号，加上读到的事件行。
//   · 通知类：每一行去掉编号、状态和时间戳，留下说明。
//   · 其他：读到的原文行。
// 结果在 2000 字处被截断时，能读出来的照样列出，并说明后面还有。

export type ProvenanceSource =
  | { kind: 'ticket'; ticketId: number }
  | { kind: 'run'; runId: number }
  | { kind: 'line'; text: string };

export type ProvenanceGroup = { label: string; sources: ProvenanceSource[]; truncated: boolean };

/** 每个依据标签点开以后列出的来源。同一个标签的多次调用合在一起。 */
export function provenanceSources(parts: readonly MessagePart[]): ProvenanceGroup[] {
  const groups: ProvenanceGroup[] = [];
  for (const { part, label, args } of readTools(parts)) {
    let group = groups.find((entry) => entry.label === label);
    if (!group) {
      group = { label, sources: [], truncated: false };
      groups.push(group);
    }
    const result = resultText(part.result?.preview);
    group.truncated ||= Boolean(part.result?.truncated);
    for (const source of sourcesOf(part.name, args, result)) {
      if (!group.sources.some((existing) => sameSource(existing, source))) group.sources.push(source);
    }
  }
  return groups;
}

const MAX_LINES = 20;

function sourcesOf(tool: string, args: Record<string, unknown>, result: string): ProvenanceSource[] {
  const lines = result.split('\n').map((line) => line.trim()).filter(Boolean);
  if (tool === 'get_ticket') {
    return typeof args.id === 'number' ? [{ kind: 'ticket', ticketId: args.id }] : [];
  }
  if (tool === 'list_needs_user' || tool === 'query_tickets') {
    return lines.flatMap((line) => {
      const match = /^#(\d+)\b/.exec(line);
      return match ? [{ kind: 'ticket' as const, ticketId: Number(match[1]) }] : [];
    });
  }
  if (tool === 'read_run_events') {
    const run: ProvenanceSource[] = typeof args.run_id === 'number' ? [{ kind: 'run', runId: args.run_id }] : [];
    // 第一行是「Run #49 · 3 条事件」这样的总述，已经由 Run 那一行说了。
    const events = lines.filter((line) => !/^Run #\d+ ·/.test(line)).slice(0, MAX_LINES);
    return [...run, ...events.map((text) => ({ kind: 'line' as const, text }))];
  }
  if (tool === 'read_inbox' || tool === 'read_notifications') {
    // 「#12 [attention/structural/pending] 2026-10-15 10:00:00 说明」：只留说明。
    return lines.slice(0, MAX_LINES).map((line) => ({
      kind: 'line' as const,
      text: line.replace(/^#\d+\s+\[[^\]]*\]\s+\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\s+/, ''),
    }));
  }
  return lines.slice(0, MAX_LINES).map((text) => ({ kind: 'line' as const, text }));
}

function sameSource(left: ProvenanceSource, right: ProvenanceSource): boolean {
  if (left.kind === 'ticket' && right.kind === 'ticket') return left.ticketId === right.ticketId;
  if (left.kind === 'run' && right.kind === 'run') return left.runId === right.runId;
  if (left.kind === 'line' && right.kind === 'line') return left.text === right.text;
  return false;
}

function parseObject(preview: string | undefined): Record<string, unknown> {
  if (!preview) return {};
  try {
    const parsed = JSON.parse(preview) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    // 截断过的参数解析不了：按没有参数算。
    return {};
  }
}

// 工具结果的展示投影是 { content: [{ type: 'text', text }] } 的 JSON。被截断时 JSON 不完整：
// 按 "text": "..." 的样子把能读的部分取出来。
function resultText(preview: string | undefined): string {
  if (!preview) return '';
  try {
    const parsed = JSON.parse(preview) as { content?: Array<{ type?: string; text?: unknown }> } | string;
    if (typeof parsed === 'string') return parsed;
    return (parsed.content ?? []).flatMap((block) => typeof block.text === 'string' ? [block.text] : []).join('\n');
  } catch {
    const match = /"text":\s*"((?:[^"\\]|\\.)*)/.exec(preview);
    if (!match) return '';
    const body = match[1]!.replace(/\\$/, '').replace(/\\u[0-9a-fA-F]{0,3}$/, '');
    try {
      return JSON.parse(`"${body}"`) as string;
    } catch {
      return body.replace(/\\n/g, '\n');
    }
  }
}

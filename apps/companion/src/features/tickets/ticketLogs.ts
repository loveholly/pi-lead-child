import type { AgentLogEntry, ToolDisplayProjection } from '@/state/types';

const PREVIEW_LIMIT = 120;
const PREVIEW_LINE_LIMIT = 3;

export type TicketLogStatus = 'running' | 'success' | 'failed' | 'info';

export type TicketLogPresentation = {
  id: string;
  kind: 'tool' | 'event';
  createdAt: string;
  title: string;
  status: TicketLogStatus;
  statusLabel: string;
  meta: string | null;
  preview: string | null;
  detail: string | null;
  expandLabel: string;
  monospaceTitle: boolean;
};

type ToolGroup = {
  attemptId: number;
  callId: string;
  name: string;
  firstSeq: number;
  startedAt: string;
  endedAt: string | null;
  phase: 'started' | 'updated' | 'completed' | 'failed';
  args: ToolDisplayProjection | null;
  result: ToolDisplayProjection | null;
  error: string | null;
  command: string | null;
  cwd: string | null;
  exitCode: number | null;
  output: ToolDisplayProjection | null;
};

export function buildTicketLogPresentation(entries: readonly AgentLogEntry[]): TicketLogPresentation[] {
  const tools = collectToolGroups(entries);
  return entries.flatMap((entry) => {
    if (!entry.tool) return [eventPresentation(entry)];
    const group = tools.get(toolKey(entry.attemptId, entry.tool.callId));
    return group?.firstSeq === entry.seq ? [toolPresentation(group)] : [];
  });
}

function collectToolGroups(entries: readonly AgentLogEntry[]): Map<string, ToolGroup> {
  const groups = new Map<string, ToolGroup>();
  for (const entry of entries) {
    const tool = entry.tool;
    if (!tool) continue;
    const key = toolKey(entry.attemptId, tool.callId);
    const current = groups.get(key);
    const next: ToolGroup = current ?? {
      attemptId: entry.attemptId,
      callId: tool.callId,
      name: tool.name,
      firstSeq: entry.seq,
      startedAt: entry.occurredAt,
      endedAt: null,
      phase: tool.phase,
      args: null,
      result: null,
      error: null,
      command: null,
      cwd: null,
      exitCode: null,
      output: null,
    };
    next.firstSeq = Math.min(next.firstSeq, entry.seq);
    if (tool.phase === 'started') next.startedAt = entry.occurredAt;
    if (tool.phase === 'completed' || tool.phase === 'failed') next.endedAt = entry.occurredAt;
    next.name = tool.name;
    next.phase = tool.phase;
    next.args = tool.args ?? next.args;
    next.result = tool.result ?? next.result;
    next.error = tool.error ?? next.error;
    next.command = tool.command ?? next.command;
    next.cwd = tool.cwd ?? next.cwd;
    next.exitCode = tool.exitCode ?? next.exitCode;
    next.output = tool.output ?? next.output;
    groups.set(key, next);
  }
  return groups;
}

function toolPresentation(group: ToolGroup): TicketLogPresentation {
  const command = group.name === 'command_execution' && group.command
    ? displayCommand(group.command, group.cwd)
    : null;
  const status = group.phase === 'failed'
    ? 'failed'
    : group.phase === 'completed'
      ? 'success'
      : 'running';
  const resultText = group.error ?? group.output?.preview ?? group.result?.preview ?? null;
  const argsText = group.args?.preview ?? null;
  const title = command
    ? middleEllipsis(command.summary, PREVIEW_LIMIT)
    : genericToolTitle(group.name, argsText);
  const detailParts = command?.full && command.full !== title ? [`完整命令\n${command.full}`] : [];
  if (!command && argsText) detailParts.push(`参数\n${argsText}`);
  if (group.error) detailParts.push(`错误\n${group.error}`);
  else if (resultText) detailParts.push(`${command ? '输出' : '结果'}\n${resultText}`);
  const detail = detailParts.join('\n\n') || null;
  const preview = resultText ? previewText(resultText) : null;
  const needsFold = Boolean(
    (command?.full && command.full !== title) ||
    (argsText && exceedsPreview(argsText)) ||
    (resultText && exceedsPreview(resultText)),
  );
  return {
    id: `${group.attemptId}:tool:${group.callId}`,
    kind: 'tool',
    createdAt: group.startedAt,
    title,
    status,
    statusLabel: status === 'failed' ? '失败' : status === 'success' ? '成功' : '执行中',
    meta: toolMeta(group, command !== null, resultText),
    preview,
    detail: needsFold ? detail : null,
    expandLabel: group.error ? '完整错误' : command ? '完整输出' : '调用详情',
    monospaceTitle: true,
  };
}

function eventPresentation(entry: AgentLogEntry): TicketLogPresentation {
  const failed = entry.kind === 'runtime.stderr' || entry.kind === 'run.failed';
  const success = entry.kind === 'run.completed';
  const title = eventTitle(entry.kind);
  const long = exceedsPreview(entry.text);
  return {
    id: `${entry.attemptId}:${entry.seq}`,
    kind: 'event',
    createdAt: entry.occurredAt,
    title,
    status: failed ? 'failed' : success ? 'success' : 'info',
    statusLabel: failed ? '错误' : success ? '完成' : '信息',
    meta: title === entry.kind ? null : entry.kind,
    preview: entry.text ? previewText(entry.text) : null,
    detail: long ? entry.text : null,
    expandLabel: entry.kind === 'message.completed' ? '完整输出' : failed ? '完整错误' : '完整内容',
    monospaceTitle: title === entry.kind,
  };
}

function toolMeta(group: ToolGroup, command: boolean, resultText: string | null): string {
  const parts = [command ? '命令执行' : '工具调用'];
  if (group.exitCode !== null) parts.push(`exit ${group.exitCode}`);
  const duration = durationMs(group.startedAt, group.endedAt);
  if (duration !== null) parts.push(formatDuration(duration));
  if (resultText) parts.push(outputSize(resultText));
  if (group.output?.truncated || group.result?.truncated) parts.push('已截断');
  return parts.join(' · ');
}

function genericToolTitle(name: string, argsText: string | null): string {
  const shortName = name.split('.').at(-1) ?? name;
  const label = TOOL_LABELS[shortName] ?? shortName;
  const primary = primaryArgument(argsText);
  return middleEllipsis(primary ? `${label} · ${primary}` : label, PREVIEW_LIMIT);
}

function primaryArgument(argsText: string | null): string | null {
  if (!argsText) return null;
  try {
    const value = JSON.parse(argsText) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return previewText(argsText);
    const record = value as Record<string, unknown>;
    for (const key of ['ticket_id', 'ticketId', 'item_id', 'itemId']) {
      if (typeof record[key] === 'number') return `#${record[key]}`;
    }
    for (const key of ['path', 'file', 'query', 'mode', 'status', 'title']) {
      if (typeof record[key] === 'string' && record[key]) return shortenHome(record[key]);
    }
  } catch {
    return previewText(argsText);
  }
  return null;
}

function displayCommand(command: string, cwd: string | null): { summary: string; full: string } {
  let full = unwrapShell(command.trim());
  if (cwd) full = full.replaceAll(cwd, '.');
  full = shortenHome(full);
  const lines = full.split('\n').map((line) => line.trim()).filter(Boolean);
  const suffix = lines.length > 1 ? ` · 另有 ${lines.length - 1} 条` : '';
  const summary = `${middleEllipsis(lines[0] ?? full, Math.max(1, PREVIEW_LIMIT - suffix.length))}${suffix}`;
  return { summary, full };
}

function unwrapShell(command: string): string {
  const match = command.match(/^(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+([\s\S]+)$/);
  if (!match) return command;
  const body = match[1]!.trim();
  if (body.length >= 2 && ((body.startsWith('"') && body.endsWith('"')) || (body.startsWith("'") && body.endsWith("'")))) {
    return body.slice(1, -1).replaceAll('\\"', '"');
  }
  return body;
}

function previewText(value: string): string {
  const normalized = value.trim();
  const lines = normalized.split('\n').slice(0, PREVIEW_LINE_LIMIT);
  const preview = lines.join('\n');
  return preview.length > PREVIEW_LIMIT
    ? `${preview.slice(0, PREVIEW_LIMIT - 1).trimEnd()}…`
    : exceedsPreview(normalized) ? `${preview.trimEnd()}…` : preview;
}

function exceedsPreview(value: string): boolean {
  return value.length > PREVIEW_LIMIT || value.split('\n').length > PREVIEW_LINE_LIMIT;
}

function middleEllipsis(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const tail = Math.min(40, Math.floor((limit - 1) / 3));
  return `${value.slice(0, limit - tail - 1).trimEnd()}…${value.slice(-tail).trimStart()}`;
}

function shortenHome(value: string): string {
  return value.replace(/\/Users\/[^/\s'"\\]+\//g, '~/');
}

function durationMs(startedAt: string, endedAt: string | null): number | null {
  if (!endedAt) return null;
  const started = Date.parse(startedAt);
  const ended = Date.parse(endedAt);
  return Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : null;
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`;
}

function outputSize(value: string): string {
  const lines = value ? value.split('\n').length : 0;
  const bytes = new TextEncoder().encode(value).length;
  const size = bytes < 1_024 ? `${bytes} B` : `${(bytes / 1_024).toFixed(1)} KB`;
  return `输出 ${lines} 行 · ${size}`;
}

function eventTitle(kind: string): string {
  return EVENT_LABELS[kind] ?? kind;
}

function toolKey(attemptId: number, callId: string): string {
  return `${attemptId}:${callId}`;
}

const TOOL_LABELS: Record<string, string> = {
  create_task: '创建工单',
  create_ticket: '创建工单',
  get_ticket: '获取工单',
  get_ticket_tree: '获取任务树',
  query_tickets: '查询工单',
  request_approval: '请求审批',
  request_decision: '请求决策',
  restore_task_from_user_request: '恢复任务',
  spawn_child: '启动 Child',
  submit_checkpoint: '提交进度记录',
  ticket_update: '更新工单',
};

const EVENT_LABELS: Record<string, string> = {
  'message.completed': 'Agent 输出',
  'message.delta': 'Agent 输出片段',
  'run.completed': '运行完成',
  'run.failed': '运行失败',
  'run.started': '开始运行',
  'runtime.stderr': '标准错误',
  'session.updated': '会话更新',
  'usage.updated': 'Token 用量',
};

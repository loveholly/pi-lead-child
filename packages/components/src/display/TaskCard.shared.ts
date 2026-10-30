// 任务卡的模型：收起时那一行写什么、展开时怎么分组、参数怎么缩写。web 和原生实现都从这里取。
import type { ColorToken } from '../theme/tokens';
import type { TaskCardNote, TaskCardProps, TaskCardStep, TaskCardTool, TaskStepState } from './TaskCard.types';

// 参数和结果在进卡片之前已经脱敏（protocol 的 projectToolDisplay，网关和客户端共用一套规则）。
// 这里只排版：缩成一行、JSON 排成多行。一行摘要里不列出已经脱敏的字段。
function isRedacted(value: string): boolean {
  return value.startsWith('[REDACTED');
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = text.trim();
  if (!/^[[{"]/.test(trimmed)) return { ok: false };
  try { return { ok: true, value: JSON.parse(trimmed) }; }
  catch { return { ok: false }; }
}

// pi 的工具结果包在 { content: [{ type: 'text', text }] } 里，有用的是里面的文字。
function unwrapToolContent(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) return value;
  if (!content.every((item) => item && typeof item === 'object' && (item as { type?: unknown }).type === 'text'
    && typeof (item as { text?: unknown }).text === 'string')) return value;
  return content.map((item) => (item as { text: string }).text).join('\n');
}

// ——— 参数缩写 ———
const MAX_SUMMARY = 120;
// 最能说明这次调用的参数：命令、路径、查询、网址。找到一个就只显示它。
const PRIMARY_KEYS = [
  ['command', 'cmd', 'script'],
  ['file_path', 'filePath', 'path', 'notebook_path', 'file', 'filename', 'dir', 'directory', 'cwd'],
  ['query', 'q', 'pattern', 'search', 'prompt'],
  ['url', 'uri'],
];
const PATH_KEYS = new Set(PRIMARY_KEYS[1]);
const TICKET_KEYS = ['ticket_id', 'ticketId', 'item_id', 'itemId'];

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function shorten(text: string, max: number, keep: 'start' | 'end' = 'start'): string {
  if (text.length <= max) return text;
  return keep === 'end' ? `…${text.slice(text.length - max + 1)}` : `${text.slice(0, max - 1)}…`;
}

function scalarText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() ? value : null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

// 一次调用的参数缩成一行：优先命令、路径、查询、工单号；都没有时列出几个简单的 键=值。
// 已经脱敏的字段不出现。
export function summarizeToolArgs(args: string | null): string {
  if (!args) return '';
  const parsed = parseJson(args);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    const text = parsed.ok && typeof parsed.value === 'string' ? parsed.value : args;
    return shorten(oneLine(text), MAX_SUMMARY);
  }
  const record = parsed.value as Record<string, unknown>;
  for (const keys of PRIMARY_KEYS) {
    for (const key of keys) {
      const value = scalarText(record[key]);
      if (value === null || isRedacted(value)) continue;
      return shorten(oneLine(value), MAX_SUMMARY, PATH_KEYS.has(key) ? 'end' : 'start');
    }
  }
  const parts: string[] = [];
  const ticketKey = TICKET_KEYS.find((key) => scalarText(record[key]) !== null);
  if (ticketKey) parts.push(`#${scalarText(record[ticketKey])}`);
  for (const [key, value] of Object.entries(record)) {
    if (parts.length >= 3) break;
    if (key === ticketKey) continue;
    const text = scalarText(value);
    if (text === null || isRedacted(text)) continue;
    parts.push(`${key}=${shorten(oneLine(text), 40)}`);
  }
  return shorten(parts.join(' '), MAX_SUMMARY);
}

// 展开一次调用时的完整参数或结果：JSON 排成多行。
export function formatToolDetail(text: string | null): string {
  if (!text) return '';
  const parsed = parseJson(text);
  if (!parsed.ok) return text;
  const value = unwrapToolContent(parsed.value);
  if (typeof value === 'string') {
    const inner = parseJson(value);
    if (inner.ok && inner.value !== null && typeof inner.value === 'object') return JSON.stringify(inner.value, null, 2);
    return value;
  }
  if (value === null || typeof value !== 'object') return String(value);
  return JSON.stringify(value, null, 2);
}

// ——— 分组 ———
export type TaskTimelineItem =
  | { kind: 'note'; id: string; step: TaskCardNote }
  | { kind: 'tool'; id: string; step: TaskCardTool }
  | { kind: 'group'; id: string; name: string; state: TaskStepState; steps: TaskCardTool[] };

export function groupStateOf(steps: readonly TaskCardTool[]): TaskStepState {
  if (steps.some((step) => step.state === 'running')) return 'running';
  if (steps.some((step) => step.state === 'failed')) return 'failed';
  if (steps.some((step) => step.state === 'stopped')) return 'stopped';
  return 'done';
}

// 连续调用同一个工具合成一组。中间隔了一句话或别的工具就不合。
export function groupTaskSteps(steps: readonly TaskCardStep[]): TaskTimelineItem[] {
  const items: TaskTimelineItem[] = [];
  let run: TaskCardTool[] = [];
  const flush = () => {
    if (run.length === 1) items.push({ kind: 'tool', id: run[0]!.id, step: run[0]! });
    else if (run.length > 1) {
      items.push({ kind: 'group', id: `group:${run[0]!.id}`, name: run[0]!.name, state: groupStateOf(run), steps: run });
    }
    run = [];
  };
  for (const step of steps) {
    if (step.kind === 'note') {
      flush();
      items.push({ kind: 'note', id: step.id, step });
      continue;
    }
    if (run.length > 0 && run[0]!.name !== step.name) flush();
    run.push(step);
  }
  flush();
  return items;
}

// 一组调用的一行：各次调用不同的参数。
export function summarizeGroupArgs(steps: readonly TaskCardTool[]): string {
  const summaries = [...new Set(steps.map((step) => summarizeToolArgs(step.args)).filter(Boolean))];
  return shorten(summaries.join(' · '), MAX_SUMMARY);
}

// ——— 收起时的一行 ———
export type TaskCardTone = 'running' | 'done' | 'failed';

export type TaskCardSummary = {
  tone: TaskCardTone;
  title: string;
  // 跑着的工具的参数。
  detail: string | null;
};

export function formatDuration(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.max(1, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分` : `${hours} 小时`;
}

export function taskCardSummary({ status, steps, durationMs }: Pick<TaskCardProps, 'status' | 'steps' | 'durationMs'>): TaskCardSummary {
  const tools = steps.filter((step): step is TaskCardTool => step.kind === 'tool');
  const duration = formatDuration(durationMs);
  if (status === 'thinking' || status === 'working') {
    // 还在跑：调用方给了用时（这一轮开始到现在）就写在后面，例如「Thinking · 12 秒」。
    const running = [...tools].reverse().find((step) => step.state === 'running');
    if (status === 'thinking' || !running) return { tone: 'running', title: 'Thinking', detail: duration };
    return { tone: 'running', title: running.name, detail: [summarizeToolArgs(running.args), duration].filter(Boolean).join(' · ') || null };
  }
  const count = tools.length ? `${tools.length} 个工具` : null;
  if (status === 'failed') {
    // 这一轮失败了，做完的工具照样做完了（例如提醒已经建好）：写出来，免得用户以为什么都没做、再发一次。
    const done = tools.filter((step) => step.state === 'done').length;
    const work = !count || done === 0 ? count
      : done === tools.length ? `${tools.length} 个工具已完成` : `${count}，${done} 个已完成`;
    // 说「回复未完成」：「未完成 · 1 个工具已完成」读起来自相矛盾（发布评审 3688968）。
    return { tone: 'failed', title: ['回复未完成', work, duration].filter(Boolean).join(' · '), detail: null };
  }
  const failed = tools.filter((step) => step.state === 'failed').length;
  const stopped = tools.filter((step) => step.state === 'stopped').length;
  const parts = [
    count ?? '已完成',
    failed ? `${failed} 个失败` : null,
    stopped ? `${stopped} 个未完成` : null,
    duration,
  ].filter(Boolean);
  return { tone: 'done', title: parts.join(' · '), detail: null };
}

// 无障碍名称里的状态。
export const stepStateLabel: Record<TaskStepState, string> = {
  running: '运行中',
  done: '完成',
  failed: '失败',
  stopped: '未完成',
};

// ——— 视觉规格 ———
export const taskCardSpec = {
  headerMinHeight: 40,
  paddingX: 12,
  markerBox: 16,
  markerIcon: 10,
  noteDot: 6,
  railWidth: 1.5,
  railColor: 'border-strong' as ColorToken,
  markerColor: {
    running: 'accent',
    done: 'success',
    failed: 'danger',
    stopped: 'text-muted',
  } satisfies Record<TaskStepState, ColorToken>,
  markerBackground: {
    running: 'accent-soft',
    done: 'success-soft',
    failed: 'danger-soft',
    stopped: 'surface-muted',
  } satisfies Record<TaskStepState, ColorToken>,
  border: {
    running: 'border',
    done: 'border',
    failed: 'danger-border',
  } satisfies Record<TaskCardTone, ColorToken>,
} as const;

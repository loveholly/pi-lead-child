// plc sched trace <单元编号 | turn id>（lead-scheduler spec D12 的查询入口）：把一个工作单元的调度记录合成一条时间线。
//
// 三个地方各记一种粒度，这里按时间合在一起：
//   · daemon 日志里的 [sched] 行：每个决定、每一步的阶段耗时、每次中止；单元的时间窗里的宿主探针和后台作业也列上，
//     卡住时能看到当时宿主在忙什么；
//   · Lead 的会话文件里 customType=scheduler 的记录（每一步的阶段、单元的开始和结束）；
//   · events 表里的 scheduler.* 事件。
// 它只读文件、只读打开账本，不经过 daemon：daemon 卡住时照样能查。
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { EventRecord } from "@pi-lead-child/store";

// 空闲车道的作业（P4）编号是 idle_<种类>_…：它的日志带 id=idle_…，events 表里的 unitId 也是它。
export const SCHED_TRACE_ID = /^(unit|turn|idle)_[A-Za-z0-9_-]{4,80}$/u;

export interface SchedTraceEntry {
  at: number;
  source: "log" | "session" | "event";
  text: string;
}

export interface SchedTraceSources {
  // daemon 日志里的行（已经按 id 或 [sched] 粗筛过）。
  logLines: readonly string[];
  // 会话文件里 customType=scheduler 的记录的 data。
  sessionEntries: ReadonlyArray<Record<string, unknown>>;
  // events 表里这些单元的 scheduler.* 事件。
  events: readonly EventRecord[];
}

const LOG_TIME = /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\]\s*/u;
const UNIT_FIELD = /\bunit=(unit_[A-Za-z0-9-]+)/gu;
// 单元时间窗里也列出的宿主记录：探针和后台作业（P0 的 host-probes.ts、host-jobs.ts）。
const HOST_LINE = /\[sched\] (probe|job)\./u;

function logTime(line: string): number | null {
  const match = LOG_TIME.exec(line);
  return match ? Date.parse(match[1]!) : null;
}

/** 这个 id 关联到哪些单元：本身是单元编号，或者日志、会话文件、事件里和这个 turn 一起出现的单元。 */
export function unitsOf(id: string, sources: SchedTraceSources, unitsFromEvents: readonly string[] = []): string[] {
  if (id.startsWith("unit_")) return [id];
  // 空闲车道的作业：连同它开的单元（整理笔记那一轮）一起查。
  if (id.startsWith("idle_")) {
    const units = new Set([id]);
    for (const line of sources.logLines) {
      if (!line.includes(`id=${id}`)) continue;
      for (const match of line.matchAll(UNIT_FIELD)) units.add(match[1]!);
    }
    return [...units];
  }
  const units = new Set(unitsFromEvents);
  for (const line of sources.logLines) {
    if (!line.includes(`turn=${id}`)) continue;
    for (const match of line.matchAll(UNIT_FIELD)) units.add(match[1]!);
  }
  for (const entry of sources.sessionEntries) {
    if (entry.turnId === id && typeof entry.unitId === "string") units.add(entry.unitId);
  }
  return [...units];
}

function fields(data: Record<string, unknown>, skip: ReadonlySet<string>): string {
  return Object.entries(data)
    .filter(([key, value]) => !skip.has(key) && value !== null && value !== undefined && typeof value !== "object")
    .map(([key, value]) => `${key}=${String(value)}`).join(" ");
}

/** 合成时间线：按时间排好的条目。units 为空时只按 turn id 找。 */
export function schedTrace(id: string, units: readonly string[], sources: SchedTraceSources): SchedTraceEntry[] {
  const unitSet = new Set(units);
  const turnId = id.startsWith("turn_") ? id : null;
  const mentions = (line: string) => [...unitSet].some((unit) => line.includes(`unit=${unit}`) || line.includes(`id=${unit}`))
    || (turnId !== null && line.includes(`turn=${turnId}`));
  const entries: SchedTraceEntry[] = [];
  const own: Array<{ at: number; line: string }> = [];
  const host: Array<{ at: number; line: string }> = [];
  for (const line of sources.logLines) {
    const at = logTime(line);
    if (at === null) continue;
    const text = line.replace(LOG_TIME, "");
    if (mentions(text)) own.push({ at, line: text });
    else if (HOST_LINE.test(text)) host.push({ at, line: text });
  }
  for (const { at, line } of own) entries.push({ at, source: "log", text: line });
  // 宿主的记录只取这个单元的时间窗（前后各留 1 秒）。
  if (own.length) {
    const from = Math.min(...own.map((entry) => entry.at)) - 1_000;
    const to = Math.max(...own.map((entry) => entry.at)) + 1_000;
    for (const { at, line } of host) if (at >= from && at <= to) entries.push({ at, source: "log", text: line });
  }
  const skip = new Set(["kind", "at", "tools"]);
  for (const data of sources.sessionEntries) {
    const unit = typeof data.unitId === "string" ? data.unitId : null;
    if (!((unit && unitSet.has(unit)) || (turnId !== null && data.turnId === turnId))) continue;
    const at = typeof data.at === "string" ? Date.parse(data.at) : NaN;
    if (!Number.isFinite(at)) continue;
    const tools = Array.isArray(data.tools)
      ? ` tools=${(data.tools as Array<{ name?: unknown; ms?: unknown }>).map((tool) => `${String(tool.name)}:${String(tool.ms)}`).join(",") || "-"}`
      : "";
    entries.push({ at, source: "session", text: `${String(data.kind ?? "?")} ${fields(data, skip)}${tools}`.trim() });
  }
  for (const event of sources.events) {
    const at = Date.parse(event.occurredAt);
    if (!Number.isFinite(at)) continue;
    entries.push({ at, source: "event", text: `${event.kind} ${fields(event.payload, new Set())}`.trim() });
  }
  const order = { event: 0, session: 1, log: 2 } as const;
  return entries.sort((a, b) => a.at - b.at || order[a.source] - order[b.source]);
}

/** 一条时间线的文本：本地时间、来源、内容。 */
export function formatSchedTrace(entries: readonly SchedTraceEntry[]): string[] {
  return entries.map((entry) => {
    const date = new Date(entry.at);
    const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}.${String(date.getMilliseconds()).padStart(3, "0")}`;
    return `${time} ${entry.source.padEnd(7)} ${entry.text}`;
  });
}

// ── 读文件（流式，大日志也不整个读进内存）─────────────────────────────────────

/** 日志里和这个 id 有关、或者是宿主探针和后台作业的 [sched] 行。 */
export async function readTraceLogLines(paths: readonly string[], id: string): Promise<string[]> {
  const lines: string[] = [];
  for (const path of paths) {
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    const reader = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of reader) {
      if (!line.includes("[sched]")) continue;
      if (line.includes(id) || line.includes("unit=") || HOST_LINE.test(line)) lines.push(line);
    }
  }
  return lines;
}

function jsonlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).map(String).filter((name) => name.endsWith(".jsonl")).map((name) => join(dir, name));
}

/** 会话文件里 customType=scheduler 的记录（只留提到 id 或某个单元的）。 */
export async function readTraceSessionEntries(sessionsDir: string): Promise<Array<Record<string, unknown>>> {
  const entries: Array<Record<string, unknown>> = [];
  for (const file of jsonlFiles(sessionsDir)) {
    const reader = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of reader) {
      if (!line.includes("\"scheduler\"")) continue;
      try {
        const entry = JSON.parse(line) as { customType?: unknown; data?: unknown };
        if (entry.customType === "scheduler" && entry.data && typeof entry.data === "object") entries.push(entry.data as Record<string, unknown>);
      } catch { /* 写到一半的行 */ }
    }
  }
  return entries;
}

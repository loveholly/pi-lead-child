// render_ui 的 SourceQuote：引用工单正文或一条 checkpoint 的原文（2026-10-19，spec D3）。
//
// 2026-10-19 16:55，Lead 把 #98 子 agent 的评审报告重新打了一遍，转述里多出 3 个不存在的文件。报告原文是对的。
// 所以转述改成引用：Lead 只给位置，这里从账本取原文。取不到（工单不在、checkpoint 不属于这张工单、
// 原文里没有那一节或那句话）时报错，Lead 收到原因。原文先脱敏，再按上限截断。
import { redactSecretText } from "@pi-lead-child/protocol";
import { getItem, type Db } from "@pi-lead-child/store";

export const SOURCE_QUOTE_MAX = 1_500;
// 标题行：# 开头的 Markdown 标题，或者【开头（我们自己的模板，例如「【独立核查报告】」）。
const HEADING_LINE = /^\s*(?:#{1,6}\s|【)/;

export interface SourceQuoteLocation {
  ticket: number;
  source: "body" | "checkpoint";
  checkpoint?: number;
  heading?: string;
  contains?: string;
}

export interface ResolvedQuote {
  text: string;
  label: string;
  truncated: boolean;
}

// 一节：从含 heading 的那一行开始，到下一个标题行（# 开头，或者【开头，例如「【独立核查报告】」）之前。
function section(text: string, heading: string): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.includes(heading));
  if (start === -1) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (HEADING_LINE.test(lines[index]!)) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

// 一段：包含这段原文的那一段。段落以空行或者标题行分开；标题行本身属于它下面的那一段。
function paragraph(text: string, contains: string): string | null {
  const at = text.indexOf(contains);
  if (at === -1) return null;
  const lines = text.split("\n");
  const first = text.slice(0, at).split("\n").length - 1;
  const last = text.slice(0, at + contains.length).split("\n").length - 1;
  let start = first;
  while (start > 0 && lines[start - 1]!.trim() && !HEADING_LINE.test(lines[start]!)) start -= 1;
  let end = last + 1;
  while (end < lines.length && lines[end]!.trim() && !HEADING_LINE.test(lines[end]!)) end += 1;
  return lines.slice(start, end).join("\n").trim();
}

function checkpointText(db: Db, ticket: number, id: number): { text: string; runId: number | null } {
  const row = db.prepare("SELECT run_id, title, summary, key_facts FROM checkpoints WHERE id=? AND item_id=?")
    .get(id, ticket) as { run_id: number | null; title: string; summary: string; key_facts: string } | undefined;
  if (!row) throw new Error(`SourceQuote：工单 #${ticket} 没有 checkpoint #${id}`);
  let facts: string[] = [];
  try {
    const parsed = JSON.parse(row.key_facts) as unknown;
    if (Array.isArray(parsed)) facts = parsed.map((fact) => (typeof fact === "string" ? fact : JSON.stringify(fact)));
  } catch { /* 坏的 key_facts 不影响标题和摘要 */ }
  return { text: [row.title, row.summary, ...facts.map((fact) => `- ${fact}`)].filter(Boolean).join("\n"), runId: row.run_id };
}

export function resolveSourceQuote(db: Db, location: SourceQuoteLocation): ResolvedQuote {
  const item = getItem(db, location.ticket);
  if (!item) throw new Error(`SourceQuote 指向的工单 #${location.ticket} 不存在`);
  let text: string;
  let label: string;
  if (location.source === "checkpoint") {
    if (location.checkpoint === undefined) throw new Error("SourceQuote：source 是 checkpoint 时要给 checkpoint 的编号");
    const found = checkpointText(db, location.ticket, location.checkpoint);
    text = found.text;
    label = `工单 #${location.ticket} · checkpoint #${location.checkpoint}${found.runId !== null ? `（Run #${found.runId}）` : ""}`;
  } else {
    text = item.body?.trim() ?? "";
    if (!text) throw new Error(`SourceQuote：工单 #${location.ticket} 的正文是空的`);
    label = `工单 #${location.ticket} 正文`;
  }
  if (location.heading) {
    const part = section(text, location.heading);
    if (part === null) throw new Error(`SourceQuote：原文里没有含「${location.heading}」的一行`);
    text = part;
    label += ` ·「${location.heading}」`;
  }
  if (location.contains) {
    const part = paragraph(text, location.contains);
    if (part === null) throw new Error(`SourceQuote：原文里没有这段话：「${location.contains.slice(0, 60)}」。contains 要逐字抄原文`);
    text = part;
    label += " · 节选";
  }
  const clean = redactSecretText(text);
  const truncated = clean.length > SOURCE_QUOTE_MAX;
  return { text: truncated ? `${clean.slice(0, SOURCE_QUOTE_MAX - 1)}…` : clean, label, truncated };
}

/** 不能显示卡片的地方（plc、Slack、推送）看到的文字：Lead 写的 fallback 后面加上引用的原文，不超过 max。 */
export function fallbackWithQuotes(fallback: string, quotes: readonly ResolvedQuote[], max: number): string {
  let out = fallback.trim();
  for (const quote of quotes) {
    const block = `\n\n${quote.label}：\n${quote.text.split("\n").map((line) => `> ${line}`).join("\n")}`;
    const room = max - out.length;
    if (room <= 20) break;
    out += block.length <= room ? block : `${block.slice(0, room - 1)}…`;
  }
  return out;
}

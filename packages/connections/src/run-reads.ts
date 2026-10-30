// 一个 Run 读过的东西（slack-takeover spec D5；2026-10-22 从代查挪到连接中心，连接中心按 Run 记）。两份：
//   - 审计（LookupReadRecord）：每次工具调用一条，拒绝的也记，带 refused。不含内容，卡上显示。
//   - 内容：读到的行原文，只留在内存里，给出处核实用（lead 的 lookup/provenance.ts）。不落库。
import type { LookupReadRecord } from "@pi-lead-child/protocol";
import type { DiffLine } from "./unified-diff.js";

export type RunReadVia = "local" | "github";

/** 出处核实看的内容。可以序列化，测试直接构造它。 */
export interface RunReadContent {
  // 读到的文件内容：行号到原文。ref 是读的时候的 HEAD sha（本地）或 ref / sha（GitHub）。
  files: Array<{ via: RunReadVia; repo: string; path: string; ref?: string; lines: Record<number, string> }>;
  // 读到的 PR diff 里的行。review 的评论只能落在这些行上。
  diffLines: Array<{ repo: string; path: string; side: "RIGHT" | "LEFT"; line: number }>;
  // 连接的只读工具返回的原文（例如 CDP、Jira 的查询结果）。connections 是这个连接的名字（调用时用的 key、真实的 key、别名）。
  // 子 agent 的出处可以引用它们（via connection），引用的原文要在这里找得到。代查不用它。
  texts?: Array<{ connections: string[]; tool: string; text: string }>;
}

// 内存里留的内容的上限。超过以后不再留：之后读到的行核实不了出处，结果只能问用户（保守）。
const MAX_KEPT_CHARS = 4_000_000;

/** 出处的路径写法：去掉开头的 ./ 和 /，用 / 分隔。 */
export function normalizeSourcePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
}

const fileKey = (via: RunReadVia, repo: string, path: string): string =>
  `${via}\u0000${repo.toLowerCase()}\u0000${normalizeSourcePath(path)}`;

export class RunReadLedger {
  readonly #records: LookupReadRecord[] = [];
  readonly #files = new Map<string, RunReadContent["files"][number]>();
  readonly #diffLines: RunReadContent["diffLines"] = [];
  readonly #texts: NonNullable<RunReadContent["texts"]> = [];
  #keptChars = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** 记一条审计。 */
  record(entry: Omit<LookupReadRecord, "at">): void {
    const record: LookupReadRecord = { ...entry, at: this.now().toISOString() };
    if (record.path !== undefined) record.path = record.path.slice(0, 1_000);
    if (record.refused !== undefined) record.refused = record.refused.slice(0, 300);
    if (record.ref !== undefined) record.ref = record.ref.slice(0, 200);
    record.tool = record.tool.slice(0, 100);
    record.repo = (record.repo || "-").slice(0, 200);
    this.#records.push(record);
  }

  /** 记下读到的一段行。startLine 从 1 开始。 */
  addLines(via: RunReadVia, repo: string, path: string, startLine: number, lines: readonly string[], ref?: string): void {
    const key = fileKey(via, repo, path);
    let file = this.#files.get(key);
    if (!file) {
      file = { via, repo, path: normalizeSourcePath(path), ...(ref ? { ref } : {}), lines: {} };
      this.#files.set(key, file);
    }
    if (ref && !file.ref) file.ref = ref;
    lines.forEach((text, index) => {
      const line = startLine + index;
      if (file!.lines[line] !== undefined) return;
      if (this.#keptChars + text.length > MAX_KEPT_CHARS) return;
      this.#keptChars += text.length;
      file!.lines[line] = text;
    });
  }

  /** 记下读到的 PR diff。新代码那一边（RIGHT）的行同时算读过的文件内容。 */
  addDiff(repo: string, lines: readonly DiffLine[], ref?: string): void {
    for (const line of lines) {
      this.#diffLines.push({ repo, path: normalizeSourcePath(line.path), side: line.side, line: line.line });
      if (line.side === "RIGHT") this.addLines("github", repo, line.path, line.line, [line.text], ref);
    }
  }

  /** 记下一个连接的只读工具返回的原文。超过上限以后不再留（之后的出处核实不了，结果只能交给用户判断）。 */
  addText(connections: readonly string[], tool: string, text: string): void {
    if (!text || this.#keptChars + text.length > MAX_KEPT_CHARS) return;
    this.#keptChars += text.length;
    this.#texts.push({ connections: [...new Set(connections.map((name) => name.toLowerCase()))], tool, text });
  }

  records(): LookupReadRecord[] {
    return this.#records.map((record) => ({ ...record }));
  }

  content(): RunReadContent {
    return {
      files: [...this.#files.values()].map((file) => ({ ...file, lines: { ...file.lines } })),
      diffLines: [...this.#diffLines],
      texts: this.#texts.map((entry) => ({ ...entry, connections: [...entry.connections] })),
    };
  }
}

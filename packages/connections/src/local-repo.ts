// 连接中心自带的本地仓库读取（landing.md 第 5 节）：带清单的 Run 读本地仓库只能用它，不用 runtime 自带的读文件工具
// （例如 Claude 的 Read 能读本机任何文件）。三个只读工具：list_dir、read_file（一次最多 400 行）、search（按字面搜）。
//
// 规则全部在代码里，和清单一起执行：
//   - 只能读清单里的仓库（清单的 localRepos 给根目录，规则按 repo 参数放行）；没有清单的调用方用不了它。
//   - 路径是不可信的输入：先按文本规则拒绝，再 realpath，必须留在仓库根目录里（repo-paths.ts）；
//     禁止名单（.env、凭据、私钥、日志）和助手自己的数据目录不列出、不读、不搜。这是硬性底线，清单放不开。
//   - 读到的行记进这个 Run 的读取记录（run-reads.ts），交回结果时出处按它核实。
// 返回的是普通文本；交给模型时由调用方包进不可信的标签。
import { readdirSync } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { GrantLocalRepo } from "@pi-lead-child/protocol";
import { headSha } from "./local-git.js";
import { deniedSegment, isDeniedName, readScopedFile, resolveScopedPath, SEARCH_SKIPPED_DIRS, type ScopedPath } from "./repo-paths.js";
import type { RunReadLedger } from "./run-reads.js";

export const LOCAL_REPO_TOOLS = ["list_dir", "read_file", "search"] as const;

export interface LocalRepoLimits {
  maxReadLines: number;
  maxFileBytes: number;
  maxResultChars: number;
  maxSearchResults: number;
  maxSearchFiles: number;
}

export const DEFAULT_LOCAL_REPO_LIMITS: LocalRepoLimits = {
  maxReadLines: 400,
  maxFileBytes: 1_000_000,
  maxResultChars: 30_000,
  maxSearchResults: 50,
  maxSearchFiles: 5_000,
};

const MAX_LINE_CHARS = 1_000;
const MAX_SEARCH_LINE_CHARS = 300;
const MAX_LIST_ENTRIES = 300;

export interface LocalToolDefinition {
  name: typeof LOCAL_REPO_TOOLS[number];
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: true;
}

const repoProperty = { type: "string", maxLength: 200, description: "清单里的本地仓库名" };

export function localRepoToolDefinitions(limits: LocalRepoLimits = DEFAULT_LOCAL_REPO_LIMITS): LocalToolDefinition[] {
  return [
    {
      name: "list_dir", title: "List directory", readOnly: true,
      description: "列出清单里一个本地仓库的目录。path 是仓库根目录下的相对路径，缺省是根目录。",
      inputSchema: {
        type: "object", additionalProperties: false, required: ["repo"],
        properties: { repo: repoProperty, path: { type: "string", maxLength: 1_000 } },
      },
    },
    {
      name: "read_file", title: "Read file", readOnly: true,
      description: `读清单里一个本地仓库的文件，带行号。一次最多 ${limits.maxReadLines} 行，用 offset（从 1 开始）和 limit 翻页。`
        + "出处的行号用这里给的行号，quote 从这里的原文原样复制。",
      inputSchema: {
        type: "object", additionalProperties: false, required: ["repo", "path"],
        properties: {
          repo: repoProperty,
          path: { type: "string", minLength: 1, maxLength: 1_000 },
          offset: { type: "integer", minimum: 1 },
          limit: { type: "integer", minimum: 1, maximum: limits.maxReadLines },
        },
      },
    },
    {
      name: "search", title: "Search files", readOnly: true,
      description: "在清单里一个本地仓库的文件内容里按字面搜（不是正则），排除 .git 和 node_modules。"
        + "结果是「路径:行号: 原文」，这些行也算读过，可以当出处引用。",
      inputSchema: {
        type: "object", additionalProperties: false, required: ["repo", "query"],
        properties: {
          repo: repoProperty,
          query: { type: "string", minLength: 2, maxLength: 200 },
          path: { type: "string", maxLength: 1_000, description: "只在这个子目录里搜" },
          case_sensitive: { type: "boolean" },
        },
      },
    },
  ];
}

export interface LocalToolResult {
  text: string;
  truncated: boolean;
  isError: boolean;
  // 调用的对象（审计用），例如 pi-lead-child:src/a.ts。
  target: string;
}

export class LocalToolRefusal extends Error {
  constructor(readonly reason: string, readonly target: string) {
    super(reason);
  }
}

function stringArg(args: Record<string, unknown>, name: string, options: { required?: boolean; max: number; min?: number }): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) {
    if (options.required) throw new LocalToolRefusal(`要给 ${name}`, "-");
    return undefined;
  }
  if (typeof value !== "string" || value.length > options.max || value.length < (options.min ?? 0)) {
    throw new LocalToolRefusal(`${name} 要是不超过 ${options.max} 个字符的字符串`, "-");
  }
  return value;
}

function intArg(args: Record<string, unknown>, name: string, max?: number): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || (max !== undefined && value > max)) {
    throw new LocalToolRefusal(`${name} 要是${max !== undefined ? ` 1 到 ${max} 之间的` : "正"}整数`, "-");
  }
  return value;
}

function numbered(lines: readonly string[], start: number): string {
  return lines.map((line, index) => {
    const shown = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
    return `${String(start + index).padStart(6)}\t${shown}`;
  }).join("\n");
}

function clip(body: string, max: number): { body: string; clipped: boolean } {
  return body.length > max ? { body: body.slice(0, max), clipped: true } : { body, clipped: false };
}

const bytesOf = (body: string): number => Buffer.byteLength(body, "utf8");

/**
 * 调一个本地仓库工具。repos 是清单里的本地仓库（名字到根目录），deniedRoots 是不能读的目录（助手的数据目录）。
 * 不能做时抛 LocalToolRefusal（连接中心把它记成拒绝）。读到的东西记进 ledger。
 */
export async function callLocalRepoTool(input: {
  tool: string;
  args: Record<string, unknown>;
  repos: readonly GrantLocalRepo[];
  ledger: RunReadLedger;
  deniedRoots?: readonly string[];
  limits?: Partial<LocalRepoLimits>;
  signal?: AbortSignal;
}): Promise<LocalToolResult> {
  const limits: LocalRepoLimits = { ...DEFAULT_LOCAL_REPO_LIMITS, ...input.limits };
  const { args, ledger } = input;
  const repoName = stringArg(args, "repo", { required: true, max: 200 })!;
  const repo = input.repos.find((entry) => entry.name.toLowerCase() === repoName.trim().toLowerCase());
  if (!repo) throw new LocalToolRefusal("仓库不在清单里", repoName);
  const resolve = (path: string): Extract<ScopedPath, { ok: true }> => {
    const resolved = resolveScopedPath(repo.root, path, { deniedRoots: input.deniedRoots ?? [] });
    if (!resolved.ok) throw new LocalToolRefusal(resolved.reason, `${repo.name}:${path}`);
    return resolved;
  };

  if (input.tool === "list_dir") {
    const resolved = resolve(stringArg(args, "path", { max: 1_000 }) ?? ".");
    let entries: string[];
    try {
      entries = readdirSync(resolved.absolute, { withFileTypes: true })
        .filter((entry) => entry.name.toLowerCase() !== ".git" && !isDeniedName(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.isSymbolicLink() ? `${entry.name}@` : entry.name);
    } catch {
      throw new LocalToolRefusal("不是目录", `${repo.name}:${resolved.relative}`);
    }
    const shown = entries.slice(0, MAX_LIST_ENTRIES);
    const body = `${resolved.relative}（${entries.length} 项${entries.length > shown.length ? `，只列出前 ${shown.length} 项` : ""}）\n${shown.join("\n")}`;
    ledger.record({ tool: "list_dir", repo: repo.name, path: resolved.relative, bytes: bytesOf(body) });
    return { text: body, truncated: entries.length > shown.length, isError: false, target: `${repo.name}:${resolved.relative}` };
  }

  if (input.tool === "read_file") {
    const resolved = resolve(stringArg(args, "path", { required: true, max: 1_000, min: 1 })!);
    const offset = intArg(args, "offset");
    const limit = intArg(args, "limit", limits.maxReadLines);
    const read = readScopedFile(resolved, limits.maxFileBytes);
    if (!read.ok) throw new LocalToolRefusal(read.reason, `${repo.name}:${resolved.relative}`);
    const all = read.text.split(/\r?\n/);
    const start = Math.min(offset ?? 1, Math.max(all.length, 1));
    const count = Math.min(limit ?? limits.maxReadLines, limits.maxReadLines);
    const slice = all.slice(start - 1, start - 1 + count);
    const end = start + Math.max(slice.length, 1) - 1;
    const ref = headSha(repo.root) ?? undefined;
    ledger.addLines("local", repo.name, resolved.relative, start, slice, ref);
    const { body, clipped } = clip(numbered(slice, start), limits.maxResultChars);
    ledger.record({ tool: "read_file", repo: repo.name, path: resolved.relative, lines: [start, end], ...(ref ? { ref } : {}), bytes: bytesOf(body) });
    const header = `${repo.name}:${resolved.relative}：第 ${start}-${end} 行，共 ${all.length} 行${read.truncated ? "（文件太大，只读了开头）" : ""}`
      + `${ref ? `，HEAD ${ref.slice(0, 12)}` : ""}${clipped ? "（结果太长，截断了）" : ""}`;
    return { text: `${header}\n${body}`, truncated: clipped || read.truncated, isError: false, target: `${repo.name}:${resolved.relative}` };
  }

  if (input.tool === "search") {
    const query = stringArg(args, "query", { required: true, max: 200, min: 2 })!;
    const resolved = resolve(stringArg(args, "path", { max: 1_000 }) ?? ".");
    const caseSensitive = args.case_sensitive === true;
    const ref = headSha(repo.root) ?? undefined;
    const hits = await searchLiteral(resolved.absolute, resolved.relative === "." ? "" : resolved.relative, query, caseSensitive, limits, input.signal);
    for (const hit of hits.results) ledger.addLines("local", repo.name, hit.path, hit.line, [hit.text], ref);
    const lines = hits.results.map((hit) => {
      const shown = hit.text.length > MAX_SEARCH_LINE_CHARS ? `${hit.text.slice(0, MAX_SEARCH_LINE_CHARS)}…` : hit.text;
      return `${hit.path}:${hit.line}: ${shown}`;
    });
    const note = hits.results.length === 0 ? "没有找到。"
      : `${hits.results.length} 条${hits.truncated ? `（只给前 ${limits.maxSearchResults} 条或者看了 ${limits.maxSearchFiles} 个文件就停了）` : ""}`;
    const { body } = clip(lines.join("\n"), limits.maxResultChars);
    ledger.record({ tool: "search", repo: repo.name, path: resolved.relative, ...(ref ? { ref } : {}), bytes: bytesOf(body) });
    return { text: body ? `${note}\n${body}` : note, truncated: hits.truncated, isError: false, target: `${repo.name}:${resolved.relative}` };
  }

  throw new LocalToolRefusal(`没有工具 ${input.tool}`, repo.name);
}

interface SearchHit { path: string; line: number; text: string }

// 按字面搜：不跟随符号链接，跳过 .git、node_modules、禁止名单里的文件和目录、二进制文件、太大的文件。
// 用异步的文件读写，大仓库也不卡住 daemon 的事件循环。
async function searchLiteral(
  dir: string, relDir: string, query: string, caseSensitive: boolean, limits: LocalRepoLimits, signal?: AbortSignal,
): Promise<{ results: SearchHit[]; truncated: boolean }> {
  const results: SearchHit[] = [];
  const needle = caseSensitive ? query : query.toLowerCase();
  let files = 0;
  let truncated = false;
  const walk = async (abs: string, rel: string): Promise<void> => {
    if (truncated || signal?.aborted) return;
    let names: string[];
    try {
      names = (await readdir(abs)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (truncated || signal?.aborted) return;
      if (SEARCH_SKIPPED_DIRS.has(name) || isDeniedName(name)) continue;
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      if (deniedSegment(childRel)) continue;
      let stat;
      try {
        stat = await lstat(childAbs);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        await walk(childAbs, childRel);
        continue;
      }
      if (!stat.isFile() || stat.size > limits.maxFileBytes) continue;
      files += 1;
      if (files > limits.maxSearchFiles) {
        truncated = true;
        return;
      }
      let content: string;
      try {
        const buffer = await readFile(childAbs);
        if (buffer.subarray(0, 8_000).includes(0)) continue;
        content = buffer.toString("utf8");
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        if (!(caseSensitive ? line : line.toLowerCase()).includes(needle)) continue;
        results.push({ path: childRel, line: index + 1, text: line });
        if (results.length >= limits.maxSearchResults) {
          truncated = true;
          return;
        }
      }
    }
  };
  await walk(dir, relDir);
  return { results, truncated };
}

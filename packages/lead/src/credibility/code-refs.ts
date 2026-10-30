// Lead 写出去的代码引用（`路径:行号`、带目录的文件路径）在发出之前核对（2026-10-19）。
//
// 起因：10-19 16:55，Lead 转述 #98 子 agent 的评审报告时写出 3 个不存在的文件（extensions/aish-guard/wrapper.ts、
// src/auth/session.ts、src/auth/token-refresher.ts），PR #93 的评论行号也写错了。提示词里早就要求「证据可定位」，
// 但没有任何东西检查它。
//
// 这里只认机器文本的写法（路径是显式的语法，不是自然语言）：带目录、扩展名在白名单里的文件路径，后面可以带
// `:行号` 或 `:起-止`。不认 URL 里的路径、没有目录的裸文件名、模型名（vibeproxy/gemini-3.8-flash-high 没有白名单扩展名）。
// 敏感文件（.env、密钥、凭证）不核对，也不打开（组织的安全规范）。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, relative, resolve } from "node:path";

export interface CodeRef {
  // 文字里的原样写法，例如 packages/lead/src/tools.ts:1976。
  raw: string;
  path: string;
  line: number | null;
  endLine: number | null;
}

export type CodeRefStatus = "ok" | "missing" | "line_out_of_range" | "unverifiable";

export interface CodeRefCheck {
  ref: CodeRef;
  status: CodeRefStatus;
  // 给 Lead 看的一句话：在哪些目录里找过、文件有几行。
  detail: string;
}

const EXTENSIONS = [
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "json", "jsonc", "md", "mdx", "py", "go", "rs", "java", "kt", "kts",
  "swift", "rb", "php", "cs", "c", "h", "cc", "cpp", "hpp", "m", "mm", "sh", "bash", "zsh", "yml", "yaml", "toml", "ini",
  "sql", "css", "scss", "less", "html", "vue", "svelte", "proto", "graphql", "gradle", "tf", "txt",
].join("|");

// 前面不能紧挨着路径字符、冒号或 @（排除 URL 和 user@host:path），后面不能紧挨着路径字符。
const REF_PATTERN = new RegExp(
  String.raw`(?<![\w./@:~-])((?:~\/|\.{1,2}\/|\/)?(?:[\w@+.-]+\/)+[\w@+.-]+\.(?:${EXTENSIONS}))(?::(\d{1,7})(?:[-–](\d{1,7}))?)?(?![\w/-])`,
  "g",
);

// 一段文字里最多核对多少条，避免一段很长的报告拖慢一次工具调用。
export const MAX_REFS_PER_TEXT = 40;
// 超过这个大小的文件不数行数，行号算「核对不了」。
const MAX_LINE_COUNT_BYTES = 4 * 1024 * 1024;

const SENSITIVE_NAMES = [
  /^\.env(?:\..*)?$/i, /\.(?:pem|key|p12|pfx)$/i, /^id_(?:rsa|ed25519|ecdsa)(?:\..*)?$/i, /^credentials/i, /^secrets\./i,
];

export function isSensitivePath(path: string): boolean {
  const name = basename(path);
  if (/^\.env\.(?:example|sample|template)$/i.test(name)) return false;
  return SENSITIVE_NAMES.some((pattern) => pattern.test(name));
}

export function extractCodeRefs(text: string): CodeRef[] {
  const seen = new Map<string, CodeRef>();
  for (const match of text.matchAll(REF_PATTERN)) {
    const path = match[1]!;
    if (path.includes("://")) continue;
    const line = match[2] ? Number(match[2]) : null;
    const end = match[3] ? Number(match[3]) : null;
    const raw = match[0];
    if (!seen.has(raw)) seen.set(raw, { raw, path, line, endLine: end });
    if (seen.size >= MAX_REFS_PER_TEXT) break;
  }
  return [...seen.values()];
}

function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

// git 里某个提交的文件内容。提交号和路径都先核对格式，参数用数组传（不经过 shell）。
// 返回 null：这个仓库里没有这个提交（核对不了）；返回 undefined：提交在，文件不在。
function gitBlob(root: string, commit: string, path: string): string | null | undefined {
  if (!/^[0-9a-f]{7,40}$/i.test(commit) || path.startsWith("-") || path.includes("\0")) return null;
  const git = (args: string[]): string => execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000, maxBuffer: MAX_LINE_COUNT_BYTES,
  });
  try {
    git(["cat-file", "-e", `${commit}^{commit}`]);
  } catch {
    return null;
  }
  try {
    return git(["show", `${commit}:${path}`]);
  } catch {
    return undefined;
  }
}

function lineProblem(ref: CodeRef, lines: number): string | null {
  if (ref.line === null) return null;
  const end = ref.endLine ?? ref.line;
  if (ref.line < 1 || end < ref.line || end > lines) return `文件只有 ${lines} 行`;
  return null;
}

export interface VerifyOptions {
  // GitHub 评论所在的提交（commit_id）。给了时只在这个提交里找：本地没有这个提交时核对不了，不拦，
  // 也不改看工作区（PR 新增的行在工作区里可能不存在，拦下以后 Lead 会按本地文件把行号「改错」，2026-10-19 发布评审）。
  commit?: string | null;
  // 这些目录只是「所有登记的仓库」这种兜底，没有一个是这件事相关的工作目录或仓库：找不到文件时算核对不了，不算不存在。
  // 用户可能在说一个没有登记的仓库（2026-10-19 发布评审）。
  fallbackOnly?: boolean;
}

/** 在根目录里核对一组引用。roots 为空时全部算「核对不了」。 */
export function verifyCodeRefs(refs: readonly CodeRef[], roots: readonly string[], options: VerifyOptions = {}): CodeRefCheck[] {
  const usable = [...new Set(roots.map((root) => resolve(root)))].filter((root) => {
    try {
      return statSync(root).isDirectory();
    } catch {
      return false;
    }
  });
  return refs.map((ref): CodeRefCheck => {
    if (isSensitivePath(ref.path)) return { ref, status: "unverifiable", detail: "敏感文件，不核对" };
    const expanded = ref.path.startsWith("~/") ? resolve(homedir(), ref.path.slice(2)) : ref.path;
    const candidates = isAbsolute(expanded)
      ? usable.filter((root) => within(root, expanded)).map((root) => ({ root, file: expanded }))
      : usable.map((root) => ({ root, file: resolve(root, expanded) })).filter(({ root, file }) => within(root, file));
    if (candidates.length === 0) {
      return { ref, status: "unverifiable", detail: usable.length ? "不在已知的仓库和工作目录里" : "不知道该在哪个目录里核对" };
    }
    let lengthProblem: string | null = null;
    let unknown = false;
    for (const { root, file } of candidates) {
      let content: string;
      // 给了提交号：只看那个提交。提交在、文件不在，这个目录里就是没有；这个仓库里没有那个提交时，这个目录核对不了。
      const blob = options.commit ? gitBlob(root, options.commit, relative(root, file)) : null;
      if (blob === undefined) continue;
      if (options.commit && blob === null) {
        unknown = true;
        continue;
      }
      if (typeof blob === "string") {
        content = blob;
      } else {
        if (!existsSync(file)) continue;
        const stat = statSync(file);
        if (!stat.isFile()) continue;
        if (ref.line === null) return { ref, status: "ok", detail: file };
        if (stat.size > MAX_LINE_COUNT_BYTES) return { ref, status: "unverifiable", detail: "文件太大，没有数行数" };
        content = readFileSync(file, "utf8");
      }
      const problem = lineProblem(ref, countLines(content));
      if (!problem) return { ref, status: "ok", detail: file };
      lengthProblem ??= `${file} ${problem}`;
    }
    if (lengthProblem) return { ref, status: "line_out_of_range", detail: lengthProblem };
    if (unknown) return { ref, status: "unverifiable", detail: `本地仓库里没有提交 ${options.commit}` };
    if (options.fallbackOnly) return { ref, status: "unverifiable", detail: "没有和这件事相关的工作目录，登记的仓库里也没有这个文件" };
    return { ref, status: "missing", detail: `在这些目录里都没有找到：${usable.join("、")}` };
  });
}

/** 核对失败的条目（找不到文件、行号超出）。核对不了的不算失败。 */
export function failedChecks(checks: readonly CodeRefCheck[]): CodeRefCheck[] {
  return checks.filter((check) => check.status === "missing" || check.status === "line_out_of_range");
}

/** 给 Lead 看的失败清单，一条一行。 */
export function describeFailures(failures: readonly CodeRefCheck[]): string {
  return failures.map((check) => `- \`${check.ref.raw}\`：${check.status === "missing" ? "文件不存在" : "行号超出"}（${check.detail}）`)
    .join("\n");
}

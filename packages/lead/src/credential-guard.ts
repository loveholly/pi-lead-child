// Lead 的只读工具（read、grep、find、ls）的凭证防护（2026-10-19 审查）。
//
// 10-18 Lead 用 read 读了 ~/.cli-proxy-api 下的 OAuth 授权文件，access_token 和 refresh_token 进了模型上下文，
// 也存进了 lead-sessions 下的会话记录。pi 的内置工具没有路径限制，所以这里用一个扩展（pi 的 tool_call、
// tool_result 钩子）补上三件事：
//   1. 读凭证文件：直接拦住（tool_call 返回 block）。清单见 credentialPathReason。
//      数据目录（~/.pi-lead-child）照常可以读：logs/、runtime-events/、sessions/、plc.db 都要用来排查问题。
//      只拦里面的凭证：cli-credential.json、保险库的密钥文件（*.key）、Lead 自己的 agent/auth.json。
//   2. 搜索和列目录：起点在凭证目录里的拦住；起点在上层（例如 ~）时照常执行，结果里指向凭证的行去掉。
//   3. 所有结果脱敏：协议里的那套规则（redactSecretText）、已知密钥变量的值（daemon 环境里的、config.json
//      env 段里的），以及像 token 的长串（redactTokenLikeRuns）。config.json 里的密钥字段就是这样盖掉的。
import { realpathSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { REDACTED, redactKnownValues, redactSecretText, secretEnvValues } from "@pi-lead-child/protocol";

export const GUARDED_LEAD_TOOLS = ["read", "grep", "find", "ls"] as const;
// bash 的输出也用完整的规则脱敏（lead-tools-and-routing spec D5）：沙箱挡住了凭证文件，但命令的输出里仍可能带着令牌。
const FULLY_SCRUBBED_TOOLS = [...GUARDED_LEAD_TOOLS, "obs_recall", "bash"] as const;

// 整个目录都是凭证的地方（相对 home）。
const CREDENTIAL_DIRS = [
  ".ssh", ".aws", ".cli-proxy-api", ".gnupg", ".password-store", ".config/gcloud", ".azure", ".kube",
];
// 单个的凭证文件（相对 home）。
const CREDENTIAL_FILES = [
  ".docker/config.json", ".config/gh/hosts.yml", ".codex/auth.json", ".claude/.credentials.json",
  ".gemini/oauth_creds.json", ".pi/agent/auth.json",
];
// 在哪里都算凭证的文件名（小写比较）。
const CREDENTIAL_NAMES = new Set([
  ".env", ".netrc", ".git-credentials", "auth.json", "oauth_creds.json", ".credentials.json", "cli-credential.json",
  "application_default_credentials.json",
]);
const CREDENTIAL_EXTENSIONS = [".pem", ".key", ".p12", ".pfx"];
const CREDENTIAL_PREFIXES = ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", "secrets."];
// credentials 开头、后面没有别的或者接着 . - _ 的名字算凭证：credentials、credentials.json、credentials.bak.json、
// credentials_old 都算（2026-10-19 复审：备份名不能放行）。后面紧跟字母的（credentialStore.ts）和源码、文档
// （credentials.ts、credentials-helper.md）不算。
const CREDENTIALS_PREFIX = "credentials";
const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".kt", ".rb", ".swift", ".c", ".h",
  ".cc", ".cpp", ".cs", ".php", ".scala", ".vue", ".svelte", ".md", ".mdx",
]);

function credentialsLikeName(lowerName: string): boolean {
  if (!lowerName.startsWith(CREDENTIALS_PREFIX)) return false;
  const rest = lowerName.slice(CREDENTIALS_PREFIX.length);
  if (rest && !/^[._-]/.test(rest)) return false;
  return !SOURCE_EXTENSIONS.has(extname(lowerName));
}
// .env.* 里的示例文件不算凭证。
const ENV_EXAMPLES = new Set([".env.example", ".env.sample", ".env.template"]);

export interface CredentialGuardContext {
  home: string;
  // 相对路径的起点（Lead 的 cwd，就是数据目录）。
  cwd: string;
}

function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function lower(path: string): string {
  return path.toLowerCase();
}

/** 一个文件名本身是不是凭证文件。 */
export function credentialFileName(name: string): boolean {
  const lowerName = name.toLowerCase();
  if (CREDENTIAL_NAMES.has(lowerName)) return true;
  if (lowerName.startsWith(".env.")) return !ENV_EXAMPLES.has(lowerName);
  if (CREDENTIAL_EXTENSIONS.some((extension) => lowerName.endsWith(extension))) return true;
  if (credentialsLikeName(lowerName)) return true;
  return CREDENTIAL_PREFIXES.some((prefix) => lowerName.startsWith(prefix));
}

// 一个绝对路径（已经展开、规范化）为什么是凭证。不是时返回 null。macOS 的文件系统不分大小写，所以按小写比较。
function reasonFor(path: string, home: string): string | null {
  const lowerPath = lower(path);
  const lowerHome = lower(home);
  for (const dir of CREDENTIAL_DIRS) {
    if (within(lowerPath, join(lowerHome, dir))) return `${join("~", dir)} 是凭证目录`;
  }
  for (const file of CREDENTIAL_FILES) {
    if (lowerPath === join(lowerHome, file)) return `${join("~", file)} 是凭证文件`;
  }
  // 路径中间的任何一段是凭证目录名时也算（例如别处的 .ssh）。
  const segments = lowerPath.split(sep);
  if (segments.some((segment) => segment === ".ssh" || segment === ".aws" || segment === ".gnupg" || segment === ".cli-proxy-api")) {
    return "路径在凭证目录里";
  }
  if (credentialFileName(basename(path))) return `${basename(path)} 是凭证文件`;
  return null;
}

// pi 的工具怎样解析路径（pi-coding-agent 的 utils/paths.js 的 normalizePath + resolvePath，没有从包里导出，这里照做）：
// 去掉开头的 @，把各种 Unicode 空格换成普通空格，展开 ~，file:// 转成本地路径，相对路径按 cwd 解析。
// 必须和 pi 一致：pi 认得的写法这里认不出，就会被放行（2026-10-19 审查：file:///Users/…/.config/gh/hosts.yml）。
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

export function resolveLikePi(input: string, context: CredentialGuardContext): string {
  let path = input.trim().replace(UNICODE_SPACES, " ");
  if (path.startsWith("@")) path = path.slice(1);
  path = expandHome(path, context.home);
  if (/^file:\/\//i.test(path)) {
    try {
      path = fileURLToPath(path);
    } catch {
      // 写坏的 file URL：pi 也打不开它，按原样判断。
    }
  }
  return resolve(context.cwd, path);
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // 不存在的路径：解析它的上一级（上一级可能是指向凭证目录的符号链接）。
    try {
      return join(realpathSync(dirname(path)), basename(path));
    } catch {
      return path;
    }
  }
}

/**
 * 一个工具参数里的路径为什么不能读。可以读时返回 null。
 * 相对路径按 cwd 解析，~ 展开成 home；符号链接按它指向的地方再判断一次。
 */
export function credentialPathReason(input: string, context: CredentialGuardContext): string | null {
  const absolute = resolveLikePi(input, context);
  return reasonFor(absolute, context.home) ?? reasonFor(realOrSelf(absolute), context.home);
}

/** 工具调用要不要拦。返回拦的原因（给模型看），不拦时返回 null。 */
export function guardLeadToolCall(toolName: string, input: Record<string, unknown>, context: CredentialGuardContext): string | null {
  if (!(GUARDED_LEAD_TOOLS as readonly string[]).includes(toolName)) return null;
  const path = typeof input.path === "string" && input.path.trim() ? input.path : ".";
  const reason = credentialPathReason(path, context);
  if (!reason) return null;
  return `不能读凭证：${reason}。凭证文件、令牌和密钥不进你的上下文。`
    + "需要确认凭证状态时，请用户自己查看，或者用 get_runtime_health、list_connections 这类不带密钥的工具。";
}

// ——— 结果的过滤和脱敏 ———

// grep 的一行：<路径>:<行号>: <文字>，上下文行是 <路径>-<行号>- <文字>。
const GREP_LINE = /^(.*?)[:-](\d+)[:-] /;

/** 结果里一行指向的路径（相对搜索起点）。认不出时返回 null。 */
function listedPath(toolName: string, line: string): string | null {
  if (!line.trim()) return null;
  if (toolName === "grep") return GREP_LINE.exec(line)?.[1] ?? null;
  if (toolName === "find" || toolName === "ls") return line.replace(/\/$/, "");
  return null;
}

/** 去掉 grep、find、ls 结果里指向凭证的行。返回过滤后的文字和去掉了几行。 */
export function dropCredentialLines(
  toolName: string, text: string, searchRoot: string, context: CredentialGuardContext,
): { text: string; dropped: number } {
  if (toolName !== "grep" && toolName !== "find" && toolName !== "ls") return { text, dropped: 0 };
  let dropped = 0;
  const kept = text.split("\n").filter((line) => {
    const listed = listedPath(toolName, line);
    if (listed === null) return true;
    // ls 列的是目录里的名字：目录本身（.ssh/）可以看到名字，里面的东西不行，所以只看文件名。
    const absolute = resolve(searchRoot, listed);
    const reason = toolName === "ls"
      ? (credentialFileName(basename(absolute)) ? "file" : null)
      : reasonFor(absolute, context.home);
    if (reason) dropped += 1;
    return !reason;
  });
  return { text: kept.join("\n"), dropped };
}

// 像 token 的长串：32 个字符以上的字母、数字、_ - + =，大小写字母和数字都有，并且字符类别频繁切换。
// 随机的 token 里相邻两个字符大约一半以上类别不同；标识符、路径段、单词串几乎不切换。
// 只有小写和数字的（git 提交号、UUID）不算：它们没有大写字母。
const TOKEN_RUN = /[A-Za-z0-9_+=-]{32,}/g;

function looksLikeToken(run: string): boolean {
  const core = run.replace(/[_+=-]/g, "");
  if (core.length < 32 || !/[A-Z]/.test(core) || !/[a-z]/.test(core) || !/[0-9]/.test(core)) return false;
  const kind = (char: string) => (char >= "A" && char <= "Z" ? 0 : char >= "a" && char <= "z" ? 1 : 2);
  let switches = 0;
  for (let i = 1; i < core.length; i += 1) if (kind(core[i]!) !== kind(core[i - 1]!)) switches += 1;
  return switches / core.length >= 0.3;
}

export function redactTokenLikeRuns(text: string): string {
  return text.replace(TOKEN_RUN, (run) => (looksLikeToken(run) ? REDACTED : run));
}

/** 已知密钥的值：环境变量里的（protocol 的 secretEnvValues），和 config.json env 段里名字、值都像密钥的。 */
export function knownSecretValues(env: Record<string, string | undefined>, configJsonPath: string | null): string[] {
  const values = new Set<string>(secretEnvValues(env));
  if (configJsonPath) {
    try {
      const parsed = JSON.parse(readFileSync(configJsonPath, "utf8")) as { env?: Record<string, { value?: unknown }> };
      const configured = Object.fromEntries(Object.entries(parsed.env ?? {})
        .map(([name, spec]) => [name, typeof spec?.value === "string" ? spec.value : undefined]));
      for (const value of secretEnvValues(configured)) values.add(value);
    } catch {
      // 没有 config.json 或者写坏了：只用环境变量。
    }
  }
  return [...values].sort((a, b) => b.length - a.length);
}

/** 一段结果文字的完整脱敏。 */
export function scrubLeadToolText(text: string, secretValues: readonly string[]): string {
  return redactTokenLikeRuns(redactSecretText(redactKnownValues(text, secretValues)));
}

export interface CredentialGuardOptions {
  cwd: string;
  home?: string;
  // 已知密钥的值。每次结果都重新取：config.json 和环境可能变了。
  secretValues: () => readonly string[];
  log?: (line: string) => void;
}

/** pi 扩展：拦凭证路径，过滤并脱敏 read、grep、find、ls 的结果。 */
export function credentialGuardExtension(options: CredentialGuardOptions): ExtensionFactory {
  const context: CredentialGuardContext = { cwd: options.cwd, home: options.home ?? homedir() };
  return (pi) => {
    pi.on("tool_call", (event) => {
      const reason = guardLeadToolCall(event.toolName, event.input as Record<string, unknown>, context);
      if (!reason) return undefined;
      options.log?.(`[lead] credential guard blocked ${event.toolName}`);
      return { block: true, reason };
    });
    // 结果的脱敏：读文件的四个工具和 SoL-Pi 的 obs_recall（它按页读回存下的大结果，存的时候可能还没脱敏）
    // 用完整的规则；别的工具（Lead 自己的工具已经各自脱敏）只盖已知密钥的值。
    pi.on("tool_result", (event) => {
      const full = (FULLY_SCRUBBED_TOOLS as readonly string[]).includes(event.toolName);
      const input = event.input as Record<string, unknown>;
      const rawRoot = typeof input.path === "string" && input.path.trim() ? input.path.trim() : ".";
      const searchRoot = resolveLikePi(rawRoot, context);
      const secrets = options.secretValues();
      let changed = false;
      const content = event.content.map((part) => {
        if (part.type !== "text") return part;
        if (!full) {
          const text = redactKnownValues(part.text, secrets);
          if (text === part.text) return part;
          changed = true;
          return { ...part, text };
        }
        const filtered = dropCredentialLines(event.toolName, part.text, searchRoot, context);
        let text = scrubLeadToolText(filtered.text, secrets);
        if (filtered.dropped > 0) text += `\n（${filtered.dropped} 行指向凭证文件，已去掉。）`;
        if (text === part.text) return part;
        changed = true;
        return { ...part, text };
      });
      return changed ? { content } : undefined;
    });
  };
}

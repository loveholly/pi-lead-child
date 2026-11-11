// 命令筛查器（docs/ticket-246-user-turn-bypass.md 第 4 节）。免沙箱开关打开时，bash 和 run_on_host 要在沙箱外跑的命令
// 先过这里。结果三种：allow 直接在沙箱外跑；floor 碰到底线；unknown 筛查器读不懂。floor 和 unknown 都退回今天的做法
// （bash 回沙箱，run_on_host 发确认卡），所以这里宁可多拦：拦错的代价是多一张卡，放错的代价改不回来。
//
// 怎么读一条命令（4.1）：
//   1. 按 shell 的词法拆：;、&&、||、|、&、换行和括号分开简单命令，每个简单命令取程序名和参数，去掉引号。
//   2. 读不懂的写法直接 unknown：反引号、进程替换、$((…))；eval、exec、source、.；xargs；bash -c 这类直接写代码的；
//      sudo、su、doas；程序名或参数的值来自筛查器不知道的变量或者 $(…)。
//      两处放宽（用户 2026-11-11：「推个 PR 都这么谨慎的吗」）：$(…) 里的命令逐条按同样的规则筛查，它的值按不知道算，
//      只在 echo、printf 和 git、gh 的文字参数里放行（unreadableDynamicArg）；heredoc 的正文是标准输入，只给把它当数据读的
//      程序（HEREDOC_READERS）。命令的长度只受 screenedCommand 限制：直接跑的命令不发卡，不受卡上 400 字的限制。
//   3. bash <脚本>：脚本在 lead-scratch 下的，读出内容逐行同样筛查，结果里带上内容；执行的一方用 copyScreenedScripts
//      写成副本再跑副本，筛查和执行是同一份内容。脚本在别处的 unknown。
//   4. 路径先展开 ~、按 cwd 解析相对路径（cd 会改后面命令的 cwd），再解析符号链接，然后比较。macOS 的文件系统不分
//      大小写，比较按小写。
//   5. 重定向 >、>>、tee 的目标按写入处理；> 和不带 -a 的 tee 会清空文件，也按删除处理。
//
// 纯函数：输入命令、cwd、允许的根、数据目录，输出结果和规则名。不读数据库，不跑命令。碰文件系统的只有两件事，都经
// ScreenFs：解析符号链接、读 lead-scratch 下的脚本。认凭证路径的 credentialPathReason 在 lead 包里（lead 依赖 engine），
// 由调用方传进来。
//
// 沙箱的清单直接 import（sandbox-policy.ts），不另写一份，免得两边漂开；只有程序名的清单是这里自己的。
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  DATA_DIR_ALWAYS_DENY_WRITE, DATA_DIR_DENY_READ, SANDBOX_DENY_READ_HOME, SANDBOX_DENY_WRITE_HOME, SANDBOX_SECRET_HOSTS,
} from "@pi-lead-child/core";
import type { Locale } from "@pi-lead-child/protocol";
import { HOST_COMMAND_LIMITS } from "../ui-actions/host-commands.js";
import { screenMessages } from "./screen.messages.js";

export type ScreenVerdict = "allow" | "floor" | "unknown";

export const SCREEN_RULES = {
  // 五条底线（4.2）
  credentials: "floor",
  "ledger-write": "floor",
  "delete-outside-roots": "floor",
  launchd: "floor",
  "spends-money": "floor",
  // 四条保守规则（4.2，用户 11-05 13:45 定）
  "privilege-escalation": "unknown",
  "startup-file-write": "floor",
  "plc-cli": "floor",
  "too-long": "unknown",
  // 读不懂（4.1 第 2、3 条）
  "command-substitution": "unknown",
  eval: "unknown",
  xargs: "unknown",
  "find-exec": "unknown",
  "inline-code": "unknown",
  heredoc: "unknown",
  "dynamic-word": "unknown",
  "shell-construct": "unknown",
  "stdin-shell": "unknown",
  "script-outside-scratch": "unknown",
  "script-not-screened": "unknown",
  unterminated: "unknown",
} as const satisfies Record<string, Exclude<ScreenVerdict, "allow">>;

export type ScreenRule = keyof typeof SCREEN_RULES;

/** 筛查过、可以执行的脚本：执行的一方跑这份内容的副本（copyScreenedScripts）。span 是脚本路径在命令里的位置。 */
export interface ScreenedScript {
  path: string;
  content: string;
  span: readonly [number, number];
}

export interface ScreenResult {
  verdict: ScreenVerdict;
  /** 命中的规则。allow 时为 null。 */
  rule: ScreenRule | null;
  /** 命中的那一段：程序名、路径或写法。 */
  detail?: string;
  /** 命中的行号，从 1 数。在脚本里命中时是脚本的行号。 */
  line?: number;
  /** 在脚本里命中时，脚本的真实路径。 */
  script?: string;
  scripts: ScreenedScript[];
}

/** 筛查器碰文件系统只经过这两个函数。测试可以换成假的。 */
export interface ScreenFs {
  /** 解析符号链接后的真实路径。路径不存在时，解析最近的存在的上级，再接上后面的部分。 */
  realPath(path: string): string;
  /** 读一个文件的文字。读不了时为 null。 */
  readFile(path: string): string | null;
}

export const nodeScreenFs: ScreenFs = {
  realPath(path) {
    let head = path;
    const rest: string[] = [];
    for (;;) {
      try {
        return join(realpathSync(head), ...[...rest].reverse());
      } catch {
        const parent = dirname(head);
        if (parent === head) return path;
        rest.push(basename(head));
        head = parent;
      }
    }
  },
  readFile(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
};

export interface ScreenInput {
  command: string;
  /** 命令在哪个目录跑（绝对路径）。 */
  cwd: string;
  /** 删除能落在哪些根下面：leadWritableRoots（lead-scratch 加隔离 worktree）加上工单的 workdir。 */
  allowedRoots: readonly string[];
  /** plc 的数据目录。lead-scratch 在它下面。 */
  dataDir: string;
  /** 缺省是 os.homedir()。 */
  home?: string;
  /** Fairy 自报这条命令会花钱（工具参数 spends_money）。 */
  spendsMoney?: boolean;
  /** lead 的 credential-guard.ts 的 credentialPathReason：一个路径为什么是凭证，不是时为 null。 */
  credentialPathReason: (path: string, context: { home: string; cwd: string }) => string | null;
  fs?: ScreenFs;
}

/** 筛查一条命令。见文件头。 */
export function screenHostCommand(input: ScreenInput): ScreenResult {
  const fs = input.fs ?? nodeScreenFs;
  const home = fs.realPath(resolve(input.home ?? homedir()));
  const dataDir = fs.realPath(resolve(input.dataDir));
  const cwd = fs.realPath(resolve(input.cwd));
  const env: ScreenEnv = {
    fs,
    home,
    dataDir,
    scratch: join(dataDir, "lead-scratch"),
    roots: input.allowedRoots.map((root) => fs.realPath(resolve(root))),
    credentialPathReason: input.credentialPathReason,
    protectedRead: [
      join(home, "Library", "Keychains"),
      ...SANDBOX_DENY_READ_HOME.map((path) => join(home, path)),
      ...DATA_DIR_DENY_READ.map((path) => join(dataDir, path)),
    ],
    ledger: DATA_DIR_ALWAYS_DENY_WRITE.map((path) => join(dataDir, path)),
    launch: [join(home, "Library", "LaunchAgents"), ...SYSTEM_LAUNCH_DIRS],
    startup: SANDBOX_DENY_WRITE_HOME.map((path) => join(home, path)),
  };
  const result: ScreenResult = { verdict: "allow", rule: null, scripts: [] };
  const hit = input.command.length > HOST_COMMAND_LIMITS.screenedCommand
    ? { rule: "too-long" as const, detail: `${input.command.length}`, line: 1 }
    : input.spendsMoney
      ? { rule: "spends-money" as const, detail: "spends_money", line: 1 }
      : screenSource(input.command, { cwd, vars: initialVars(home, cwd), depth: 0, scripts: result.scripts }, env);
  if (!hit) return result;
  return {
    verdict: SCREEN_RULES[hit.rule], rule: hit.rule, detail: hit.detail, line: hit.line,
    ...(hit.script ? { script: hit.script } : {}), scripts: [],
  };
}

/** 不放行的原因，一句话，给 Fairy 和工具行看。allow 时为 null。 */
export function screenReason(result: ScreenResult, locale: Locale): string | null {
  if (!result.rule) return null;
  const m = screenMessages(locale);
  const detail = result.detail ?? "";
  const reasons: Record<ScreenRule, () => string> = {
    credentials: () => m.credentials(detail),
    "ledger-write": () => m.ledgerWrite(detail),
    "delete-outside-roots": () => m.deleteOutsideRoots(detail),
    launchd: () => m.launchd(detail),
    "spends-money": () => m.spendsMoney(detail),
    "privilege-escalation": () => m.privilegeEscalation(detail),
    "startup-file-write": () => m.startupFileWrite(detail),
    "plc-cli": () => m.plcCli(detail),
    "too-long": () => m.tooLong(HOST_COMMAND_LIMITS.screenedCommand),
    "command-substitution": () => m.commandSubstitution(detail),
    eval: () => m.eval(detail),
    xargs: () => m.xargs(detail),
    "find-exec": () => m.findExec(detail),
    "inline-code": () => m.inlineCode(detail),
    heredoc: () => m.heredoc(detail),
    "dynamic-word": () => m.dynamicWord(detail),
    "shell-construct": () => m.shellConstruct(detail),
    "stdin-shell": () => m.stdinShell(detail),
    "script-outside-scratch": () => m.scriptOutsideScratch(detail),
    "script-not-screened": () => m.scriptNotScreened(detail),
    unterminated: () => m.unterminated(detail),
  };
  const reason = reasons[result.rule]();
  return result.script && result.line ? m.atScriptLine(reason, result.script, result.line) : reason;
}

/**
 * 把筛查过的脚本写成副本，返回改写后的命令：命令里的脚本路径换成副本的路径。执行的是筛查过的那一份，脚本在筛查以后
 * 被改了也不影响。这个函数写文件，不是筛查的一部分，由执行的一方在跑命令前调用。
 */
export function copyScreenedScripts(command: string, scripts: readonly ScreenedScript[], tempDir: string): string {
  let rewritten = command;
  for (const script of [...scripts].sort((a, b) => b.span[0] - a.span[0])) {
    const dir = mkdtempSync(join(tempDir, "plc-screened-"));
    const copy = join(dir, basename(script.path));
    writeFileSync(copy, script.content, { mode: 0o600 });
    rewritten = `${rewritten.slice(0, script.span[0])}${shellQuote(copy)}${rewritten.slice(script.span[1])}`;
  }
  return rewritten;
}

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

// ——— 程序名的清单（4.2）———

const SYSTEM_LAUNCH_DIRS = [
  "/Library/LaunchAgents", "/Library/LaunchDaemons", "/System/Library/LaunchAgents", "/System/Library/LaunchDaemons",
];
const CREDENTIAL_PROGRAMS = new Set(["security", "ssh-add", "ssh-keygen", "gpg", "gpg2"]);
// 不带参数时整份打印登录 shell 的变量。
const ENV_DUMP_PROGRAMS = new Set(["env", "printenv", "export", "set", "declare", "typeset"]);
const LAUNCHD_PROGRAMS = new Set(["launchctl", "defaults"]);
const PRIVILEGE_PROGRAMS = new Set(["sudo", "su", "doas"]);
const EVAL_PROGRAMS = new Set(["eval", "exec", "source", "."]);
const XARGS_PROGRAMS = new Set(["xargs", "parallel"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "csh", "tcsh"]);
const DELETE_PROGRAMS = new Set(["rm", "rmdir", "unlink", "shred", "trash", "srm"]);
// 这些参数会把一个目录整个读走：路径是凭证目录的上级时也算读凭证。
const RECURSIVE_COPIERS = new Set(["cp", "ditto", "rsync", "scp", "tar", "zip", "7z", "rclone"]);
// 只读的程序：路径落在沙箱外会执行的位置（SANDBOX_DENY_WRITE_HOME）时照样放行，例如 cat ~/.zshrc。
const READ_ONLY_PROGRAMS = new Set([
  "cat", "less", "more", "head", "tail", "ls", "stat", "file", "wc", "grep", "egrep", "fgrep", "rg", "ag", "diff", "cmp",
  "md5", "shasum", "sha256sum", "readlink", "realpath", "du", "find", "bat", "tree", "test", "[", "echo", "printf",
  "basename", "dirname", "cd",
]);
// 跑别的命令的外壳：去掉它们再看真正的程序。exec 不在这里：它在 EVAL_PROGRAMS 里（4.1 第 2 条）。
const WRAPPERS = new Set(["env", "command", "builtin", "nohup", "nice", "time", "timeout", "gtimeout", "caffeinate"]);
// 关键字：去掉以后下一个词是命令。
const LEADING_KEYWORDS = new Set(["!", "time", "if", "then", "else", "elif", "do", "while", "until", "{", "}", "fi", "done", "esac"]);
// 筛查器不跟的结构：循环变量、case 的分支、函数关键字。
const UNREADABLE_KEYWORDS = new Set(["for", "case", "select", "function", "coproc"]);
const HTTP_CLIENTS = new Set(["curl", "wget", "http", "https", "xh"]);
// 已知的付费 API：和沙箱的密钥绑定主机同源（SANDBOX_SECRET_HOSTS）。
const PAID_API_SECRETS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"];
const PAID_API_HOSTS = PAID_API_SECRETS.flatMap((name) => SANDBOX_SECRET_HOSTS[name] ?? []);
// 花钱的子命令：程序名加上参数里出现的子命令。清单随时加。
const SPENDING_COMMANDS: ReadonlyArray<{ programs: readonly string[]; spends: (words: readonly string[]) => string | undefined }> = [
  { programs: ["gcloud", "az", "heroku", "doctl"], spends: (words) => words.find((word) => word === "create") },
  { programs: ["aws"], spends: (words) => words.find((word) => word === "run-instances" || word.startsWith("create-")) },
  { programs: ["terraform"], spends: (words) => words.find((word) => word === "apply") },
  { programs: ["pulumi"], spends: (words) => words.find((word) => word === "up") },
  { programs: ["fly", "flyctl", "vercel"], spends: (words) => words.find((word) => word === "deploy") },
];

function interpreterInlineFlag(program: string, args: readonly string[]): string | undefined {
  const flags = /^python[0-9.]*$/.test(program) ? ["-c"]
    : program === "node" || program === "nodejs" ? ["-e", "--eval", "-p", "--print"]
      : program === "ruby" || program === "perl" ? ["-e", "-E"]
        : program === "php" ? ["-r"]
          : program === "deno" || program === "bun" ? ["eval", "-e", "--eval"]
            : null;
  if (!flags) return undefined;
  return args.find((arg) => flags.includes(arg) || flags.some((flag) => flag.length === 2 && arg.startsWith("-") && !arg.startsWith("--") && arg.includes(flag[1]!)))
    ?? (args.length === 0 ? "stdin" : undefined);
}

// ——— 词法 ———

// quoted：在双引号里。不在引号里的变量和命令替换会按空白拆开、按通配展开。
type Segment =
  | { kind: "text"; text: string; quoted: boolean }
  | { kind: "var"; name: string; quoted: boolean }
  // $(…)：里面拆好的命令。
  | { kind: "subst"; tokens: Token[]; quoted: boolean; line: number }
  | { kind: "tilde" };

interface WordToken { type: "word"; segments: Segment[]; start: number; end: number; line: number; raw: string }
interface OpToken { type: "op"; op: string; line: number }
interface RedirectToken { type: "redirect"; op: string; line: number }
// <<、<<- 开的 heredoc：正文在词法里已经读过（只是标准输入），这里只留下「这条命令有 heredoc」。
interface HeredocToken { type: "heredoc"; line: number }
type Token = WordToken | OpToken | RedirectToken | HeredocToken;

interface Hit { rule: ScreenRule; detail: string; line: number; script?: string }

class Unreadable extends Error {
  constructor(readonly hit: Hit) {
    super(hit.rule);
  }
}

const WORD_BREAK = new Set([" ", "\t", "\n", ";", "&", "|", "<", ">", "(", ")"]);
const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;

function lex(source: string): Token[] {
  return lexFrom(source, 0, 1, 0).tokens;
}

// 命令替换最多套几层。再深的 unknown。
const MAX_SUBSTITUTION_DEPTH = 8;

interface PendingHeredoc { delimiter: string; stripTabs: boolean; quoted: boolean; line: number }

/**
 * 从 start 开始拆词。depth 为 0 时拆到结尾；大于 0 时是 $(…) 里面的命令，拆到和它配对的 ) 为止，end 是那个 ) 的位置。
 * 里面的引号、括号和 heredoc 和外面一样拆，所以 heredoc 正文里的 (、) 和撇号不会提前结束 $(…)。
 */
function lexFrom(source: string, start: number, startLine: number, depth: number): { tokens: Token[]; end: number; line: number } {
  const tokens: Token[] = [];
  let i = start;
  let line = startLine;
  let parens = 0;
  let heredocs: PendingHeredoc[] = [];
  const fail = (rule: ScreenRule, detail: string): never => {
    throw new Unreadable({ rule, detail, line });
  };
  const op = (text: string) => {
    tokens.push({ type: "op", op: text, line });
    i += text.length;
  };
  const redirect = (text: string, length = text.length) => {
    tokens.push({ type: "redirect", op: text, line });
    i += length;
  };
  // heredoc 的正文从操作符那一行的下一行开始，到只有结束标记的一行为止。正文是给程序的标准输入，不是命令：
  // 结束标记带引号时原样不展开；不带引号时正文里的 $(…) 和反引号会跑，筛查器不读，unknown。
  const readHeredocBodies = () => {
    for (const doc of heredocs) {
      let closed = false;
      while (i < source.length) {
        const newline = source.indexOf("\n", i);
        const lineEnd = newline < 0 ? source.length : newline;
        const raw = source.slice(i, lineEnd);
        const body = doc.stripTabs ? raw.replace(/^\t+/, "") : raw;
        i = newline < 0 ? source.length : newline + 1;
        if (newline >= 0) line += 1;
        if (body === doc.delimiter) { closed = true; break; }
        if (!doc.quoted && /\$\(|`/.test(body)) fail("heredoc", `<<${doc.delimiter}：正文里有命令替换`);
      }
      if (!closed) throw new Unreadable({ rule: "unterminated", detail: `<<${doc.delimiter}`, line: doc.line });
    }
    heredocs = [];
  };
  const heredoc = () => {
    i += 2;
    const stripTabs = source[i] === "-";
    if (stripTabs) i += 1;
    while (source[i] === " " || source[i] === "\t") i += 1;
    let delimiter = "";
    let quoted = false;
    while (i < source.length && !WORD_BREAK.has(source[i]!)) {
      const c = source[i]!;
      if (c === "'" || c === "\"") {
        const close = source.indexOf(c, i + 1);
        if (close < 0) fail("unterminated", c);
        delimiter += source.slice(i + 1, close);
        quoted = true;
        i = close + 1;
      } else if (c === "\\") {
        delimiter += source[i + 1] ?? "";
        quoted = true;
        i += 2;
      } else if (c === "$" || c === "`") {
        fail("heredoc", `<<${source.slice(i, i + 12)}`);
      } else {
        delimiter += c;
        i += 1;
      }
    }
    if (!delimiter) fail("unterminated", "<<");
    heredocs.push({ delimiter, stripTabs, quoted, line });
    tokens.push({ type: "heredoc", line });
  };
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === " " || ch === "\t") { i += 1; continue; }
    if (ch === "\\" && next === "\n") { i += 2; line += 1; continue; }
    if (ch === "\n") {
      op("\n");
      line += 1;
      if (heredocs.length) readHeredocBodies();
      continue;
    }
    if (ch === "#") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === ";") { op(";"); continue; }
    if (ch === "&") {
      if (source.startsWith("&&", i)) op("&&");
      else if (source.startsWith("&>>", i)) redirect(">>", 3);
      else if (next === ">") redirect(">", 2);
      else op("&");
      continue;
    }
    if (ch === "|") {
      if (next === "|") op("||");
      else if (next === "&") op("|&");
      else op("|");
      continue;
    }
    if (ch === "(") { parens += 1; op(ch); continue; }
    if (ch === ")") {
      if (depth > 0 && parens === 0) {
        if (heredocs.length) fail("unterminated", `<<${heredocs[0]!.delimiter}`);
        return { tokens, end: i, line };
      }
      parens = Math.max(0, parens - 1);
      op(ch);
      continue;
    }
    if (ch === "<") {
      if (source.startsWith("<<<", i)) redirect("<<<");
      else if (next === "<") heredoc();
      else if (next === "(") fail("command-substitution", "<(…)");
      else if (next === "&") redirect("<&");
      else if (next === ">") redirect(">", 2);
      else redirect("<");
      continue;
    }
    if (ch === ">") {
      if (next === "(") fail("command-substitution", ">(…)");
      else if (next === ">") redirect(">>");
      else if (next === "&") redirect(">&");
      else if (next === "|") redirect(">", 2);
      else redirect(">");
      continue;
    }
    const wordStart = i;
    const wordLine = line;
    const segments: Segment[] = [];
    const text = (value: string, quoted: boolean) => {
      const last = segments.at(-1);
      if (last?.kind === "text" && last.quoted === quoted) last.text += value;
      else segments.push({ kind: "text", text: value, quoted });
    };
    const dollar = (quoted: boolean): void => {
      const after = source[i + 1];
      if (after === "(") {
        if (source[i + 2] === "(") fail("shell-construct", "$((…))");
        if (depth + 1 > MAX_SUBSTITUTION_DEPTH) fail("command-substitution", "$(…)");
        // 命令替换（工单 #324）：拆出里面的命令，筛查时逐条按同样的规则筛（screenSubstitutions），值按不知道算。
        const inner = lexFrom(source, i + 2, line, depth + 1);
        segments.push({ kind: "subst", tokens: inner.tokens, quoted, line });
        line = inner.line;
        i = inner.end + 1;
        return;
      }
      if (after === "'") fail("dynamic-word", "$'…'");
      if (after === "{") {
        const close = source.indexOf("}", i + 2);
        if (close < 0) fail("unterminated", "${");
        segments.push({ kind: "var", name: source.slice(i + 2, close), quoted });
        i = close + 1;
        return;
      }
      if (after !== undefined && NAME_START.test(after)) {
        let end = i + 1;
        while (end < source.length && NAME_CHAR.test(source[end]!)) end += 1;
        segments.push({ kind: "var", name: source.slice(i + 1, end), quoted });
        i = end;
        return;
      }
      if (after !== undefined && /[0-9@*#?$!-]/.test(after)) {
        segments.push({ kind: "var", name: after, quoted });
        i += 2;
        return;
      }
      text("$", quoted);
      i += 1;
    };
    while (i < source.length && !WORD_BREAK.has(source[i]!)) {
      const c = source[i]!;
      if (c === "\\") {
        if (source[i + 1] === "\n") { i += 2; line += 1; continue; }
        if (i + 1 < source.length) text(source[i + 1]!, true);
        i += 2;
      } else if (c === "'") {
        const close = source.indexOf("'", i + 1);
        if (close < 0) fail("unterminated", "'");
        const quoted = source.slice(i + 1, close);
        line += quoted.split("\n").length - 1;
        text(quoted, true);
        i = close + 1;
      } else if (c === "\"" || (c === "$" && source[i + 1] === "\"")) {
        i += c === "$" ? 2 : 1;
        for (;;) {
          if (i >= source.length) fail("unterminated", "\"");
          const d = source[i]!;
          if (d === "\"") { i += 1; break; }
          if (d === "`") fail("command-substitution", "`…`");
          if (d === "$") { dollar(true); continue; }
          if (d === "\\" && i + 1 < source.length && "$`\"\\\n".includes(source[i + 1]!)) {
            if (source[i + 1] === "\n") line += 1;
            else text(source[i + 1]!, true);
            i += 2;
            continue;
          }
          if (d === "\n") line += 1;
          text(d, true);
          i += 1;
        }
      } else if (c === "`") {
        fail("command-substitution", "`…`");
      } else if (c === "$") {
        dollar(false);
      } else if (c === "~" && tildeAllowed(segments)) {
        let end = i + 1;
        while (end < source.length && !WORD_BREAK.has(source[end]!) && source[end] !== "/") end += 1;
        if (end > i + 1) segments.push({ kind: "var", name: source.slice(i, end), quoted: false });
        else segments.push({ kind: "tilde" });
        i = end;
      } else {
        text(c, false);
        i += 1;
      }
    }
    // 2>file、2>&1 前面的数字是文件描述符，不是参数。
    const raw = source.slice(wordStart, i);
    if (/^[0-9]+$/.test(raw) && (source[i] === ">" || source[i] === "<")) continue;
    tokens.push({ type: "word", segments, start: wordStart, end: i, line: wordLine, raw });
  }
  if (depth > 0) fail("unterminated", "$(");
  if (heredocs.length) throw new Unreadable({ rule: "unterminated", detail: `<<${heredocs[0]!.delimiter}`, line: heredocs[0]!.line });
  return { tokens, end: i, line };
}

// ~ 只在词的开头、赋值的 = 后面和选项的 = 后面展开（--prefix=~/x 按展开算，多拦不少拦）。
function tildeAllowed(segments: readonly Segment[]): boolean {
  if (segments.length === 0) return true;
  if (segments.length !== 1) return false;
  const only = segments[0]!;
  return only.kind === "text" && !only.quoted && /^([A-Za-z_][A-Za-z0-9_]*|--?[A-Za-z0-9-]+)=$/.test(only.text);
}

// ——— 词的值 ———

interface Word {
  token: WordToken;
  text: string;
  /** 用了筛查器不知道值的变量或者命令替换。 */
  dynamic: string | null;
  /** 不知道的值有一部分不在双引号里：会按空白拆成几个参数、按通配展开。 */
  unquotedDynamic: boolean;
  /** 有不带引号的通配（* ? [ 或者 {a,b}）。 */
  glob: boolean;
  /** NAME=value 形式的赋值。 */
  assignment: { name: string; value: string } | null;
}

type Vars = Map<string, string | null>;

function initialVars(home: string, cwd: string): Vars {
  return new Map([["HOME", home], ["PWD", cwd]]);
}

function wordOf(token: WordToken, vars: Vars, home: string): Word {
  let text = "";
  let dynamic: string | null = null;
  let unquotedDynamic = false;
  let unquoted = "";
  for (const segment of token.segments) {
    if (segment.kind === "tilde") text += home;
    else if (segment.kind === "text") {
      text += segment.text;
      if (!segment.quoted) unquoted += segment.text;
    } else if (segment.kind === "subst") {
      dynamic ??= "$(…)";
      if (!segment.quoted) unquotedDynamic = true;
    } else {
      const value = vars.get(segment.name);
      if (typeof value === "string") text += value;
      else {
        dynamic ??= segment.name.startsWith("~") ? segment.name : `$${segment.name}`;
        if (!segment.quoted) unquotedDynamic = true;
      }
    }
  }
  const glob = /[*?]/.test(unquoted) || /\[[^\]]*\]/.test(unquoted) || /\{[^}]*(,|\.\.)[^}]*\}/.test(unquoted);
  const first = token.segments[0];
  const match = first?.kind === "text" && !first.quoted ? /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(first.text) : null;
  const assignment = match ? { name: match[1]!, value: text.slice(match[0].length) } : null;
  return { token, text, dynamic, unquotedDynamic, glob, assignment };
}

// ——— 简单命令 ———

interface Redirect { op: string; target: WordToken | null; line: number }
interface SimpleCommand { words: WordToken[]; redirects: Redirect[]; line: number; heredoc: boolean }

function commandsOf(tokens: readonly Token[]): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  let current: SimpleCommand | null = null;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.type === "op") {
      if (current) commands.push(current);
      current = null;
      continue;
    }
    current ??= { words: [], redirects: [], line: token.line, heredoc: false };
    if (token.type === "word") {
      current.words.push(token);
      continue;
    }
    if (token.type === "heredoc") {
      current.heredoc = true;
      continue;
    }
    const target = tokens[index + 1];
    if (target?.type !== "word") throw new Unreadable({ rule: "unterminated", detail: token.op, line: token.line });
    index += 1;
    // >&2、<&0、>&- 是复制文件描述符，没有目标文件。
    const duplicate = (token.op === ">&" || token.op === "<&") && /^([0-9]+|-)$/.test(target.raw);
    current.redirects.push({ op: token.op, target: duplicate ? null : target, line: token.line });
  }
  if (current) commands.push(current);
  return commands;
}

// ——— 筛查 ———

interface ScreenEnv {
  fs: ScreenFs;
  home: string;
  dataDir: string;
  scratch: string;
  roots: string[];
  credentialPathReason: ScreenInput["credentialPathReason"];
  protectedRead: string[];
  ledger: string[];
  launch: string[];
  startup: string[];
}

interface ScreenContext {
  cwd: string;
  vars: Vars;
  depth: number;
  script?: string;
  scripts: ScreenedScript[];
}

function screenSource(source: string, context: ScreenContext, env: ScreenEnv): Hit | null {
  try {
    for (const command of commandsOf(lex(source))) {
      const hit = screenCommand(command, context, env);
      if (hit) return hit;
    }
    return null;
  } catch (error) {
    if (error instanceof Unreadable) return error.hit;
    throw error;
  }
}

/** 一个路径参数：展开、解析以后的几种位置。任何一种落在受保护的位置都算。 */
interface PathRef {
  raw: string;
  /** 按 cwd 解析、没解析符号链接的位置。 */
  absolute: string;
  /** 解析了符号链接的位置。 */
  real: string;
  /** 最后一段是符号链接时，链接本身的位置（上级解析，最后一段不解析）。 */
  link: string;
  /** 有通配时，通配以前的目录（已解析）和整个模式（目录已解析）。 */
  glob: { dir: string; pattern: string } | null;
}

function screenCommand(command: SimpleCommand, context: ScreenContext, env: ScreenEnv): Hit | null {
  const at = (rule: ScreenRule, detail: string): Hit => ({ rule, detail, line: command.line, ...(context.script ? { script: context.script } : {}) });
  const substituted = screenSubstitutions(command, context, env);
  if (substituted) return substituted;
  const words = command.words.map((token) => wordOf(token, context.vars, env.home));

  // 开头的赋值。整条都是赋值时记下来，后面的命令能用；只是前缀时只对这一条有效，不记。
  let index = 0;
  while (index < words.length && words[index]!.assignment) index += 1;
  if (index === words.length) {
    for (const word of words) context.vars.set(word.assignment!.name, word.dynamic ? null : word.assignment!.value);
    return screenRedirects(command, null, context, env, at);
  }
  for (; index < words.length; index += 1) {
    const word = words[index]!;
    if (word.token.segments.some((segment) => segment.kind !== "text" || segment.quoted)) break;
    if (UNREADABLE_KEYWORDS.has(word.text)) return at("shell-construct", word.text);
    if (!LEADING_KEYWORDS.has(word.text)) break;
  }
  let rest = words.slice(index);
  if (rest.length === 0) return screenRedirects(command, null, context, env, at);

  // 去掉 env、nohup、timeout 这类外壳。
  for (let guard = 0; guard < 8 && rest.length > 0; guard += 1) {
    const head = rest[0]!;
    if (head.dynamic) return at("dynamic-word", head.dynamic);
    const name = basename(head.text);
    if (!WRAPPERS.has(name)) break;
    const unwrapped = unwrap(name, rest.slice(1));
    if (unwrapped === "dump") return at("credentials", name);
    if (unwrapped === "dynamic") return at("inline-code", `${name} -S`);
    if (unwrapped === "lookup") return screenRedirects(command, null, context, env, at);
    rest = unwrapped;
  }
  if (rest.length === 0) return screenRedirects(command, null, context, env, at);

  const program = rest[0]!;
  if (program.dynamic) return at("dynamic-word", program.dynamic);
  if (program.glob) return at("dynamic-word", program.text);
  const name = basename(program.text);
  const args = rest.slice(1);
  const dynamicArg = unreadableDynamicArg(name, args);
  if (dynamicArg) return at("dynamic-word", dynamicArg.unquotedDynamic ? `${dynamicArg.dynamic!}（没有加双引号）` : dynamicArg.dynamic!);
  if (command.heredoc && !HEREDOC_READERS.has(name)) return at("heredoc", name);
  const argTexts = args.map((arg) => arg.text);

  // 读不懂的写法和保守规则：看程序名就够。
  if (PRIVILEGE_PROGRAMS.has(name)) return at("privilege-escalation", name);
  if (EVAL_PROGRAMS.has(name)) return at("eval", name);
  if (XARGS_PROGRAMS.has(name)) return at("xargs", name);
  if (name === "osascript") return at("inline-code", name);
  if (name === "plc") return at("plc-cli", [name, ...argTexts].join(" ").slice(0, 80));
  if (name === "pushd" || name === "popd") return at("dynamic-word", name);
  const inline = interpreterInlineFlag(name, argTexts);
  if (inline === "stdin") return at("stdin-shell", name);
  if (inline) return at("inline-code", `${name} ${inline}`);
  if (name === "find") {
    const exec = argTexts.find((arg) => ["-exec", "-execdir", "-ok", "-okdir"].includes(arg));
    if (exec) return at("find-exec", exec);
  }
  if (name === "sqlite3") {
    const code = argTexts.find((arg) => /^\s*\.[a-z]/i.test(arg) || /\b(load_extension|writefile|readfile|edit)\s*\(/i.test(arg) || arg === "-cmd" || arg === "-init");
    if (code) return at("inline-code", `sqlite3 ${code.slice(0, 40)}`);
  }

  // 五条底线里只看程序名的部分。
  if (CREDENTIAL_PROGRAMS.has(name)) return at("credentials", name);
  if (ENV_DUMP_PROGRAMS.has(name) && envDump(name, argTexts)) return at("credentials", name);
  if (LAUNCHD_PROGRAMS.has(name)) return at("launchd", name);
  const spending = SPENDING_COMMANDS.find((entry) => entry.programs.includes(name));
  const spendingWord = spending?.spends(argTexts.filter((arg) => !arg.startsWith("-")));
  if (spendingWord) return at("spends-money", `${name} ${spendingWord}`);
  if (HTTP_CLIENTS.has(name)) {
    const paid = argTexts.find((arg) => paidHost(arg));
    if (paid) return at("spends-money", `${name} ${paidHost(paid)}`);
  }

  // git：-C 换目录；git config --global 写 ~/.gitconfig；git clean 是删除。
  let cwd = context.cwd;
  let gitSubcommand: string | null = null;
  let gitArgs: Word[] = [];
  if (name === "git") {
    let position = 0;
    while (position < args.length && args[position]!.text.startsWith("-")) {
      const option = args[position]!.text;
      if ((option === "-C" || option === "-c" || option === "--git-dir" || option === "--work-tree") && position + 1 < args.length) {
        if (option === "-C") cwd = env.fs.realPath(resolve(cwd, args[position + 1]!.text));
        position += 2;
      } else position += 1;
    }
    gitSubcommand = args[position]?.text ?? null;
    gitArgs = args.slice(position + 1);
    if (gitSubcommand === "config" && gitArgs.some((arg) => arg.text === "--global" || arg.text === "--system")
      && !gitArgs.some((arg) => /^(--get|--get-all|--get-regexp|--list|-l|--show-origin)$/.test(arg.text))) {
      return at("startup-file-write", "~/.gitconfig");
    }
  }

  // 脚本：bash <脚本>。
  if (SHELLS.has(name)) {
    const hit = screenShellCall(name, args, { ...context, cwd }, env, at);
    if (hit) return hit;
  } else if (program.text.includes("/")) {
    // 直接执行 lead-scratch 里的文件：内容可能是任何解释器的脚本，筛查器不读。
    const location = pathRef(program.text, cwd, env);
    if (within(location.real, env.scratch) || within(location.link, env.scratch)) return at("script-not-screened", program.text);
  }

  // 每个路径参数。
  const sqliteReadonly = name === "sqlite3" && argTexts.includes("-readonly");
  const paths = pathArguments(name === "git" ? gitArgs : args).map((arg) => pathRef(arg.text, cwd, env, arg.glob));
  for (const path of paths) {
    const credential = credentialHit(path, env, cwd);
    if (credential) return at("credentials", credential);
    if (RECURSIVE_COPIERS.has(name)) {
      const parent = [...env.protectedRead, join(env.home, ".ssh")].find((target) => !target.includes("*") && isAncestor(path.real, target));
      if (parent) return at("credentials", parent);
    }
    const ledger = protectedHit(path, env.ledger);
    if (ledger && !(sqliteReadonly && /plc\.db(-wal|-shm)?$/i.test(ledger))) return at("ledger-write", ledger);
    const launch = protectedHit(path, env.launch);
    if (launch) return at("launchd", launch);
    if (!READ_ONLY_PROGRAMS.has(name)) {
      const startup = protectedHit(path, env.startup);
      if (startup) return at("startup-file-write", startup);
    }
  }

  // 删除。
  const deleted = deletedPaths(name, args, gitSubcommand, gitArgs, cwd);
  for (const arg of deleted) {
    const outside = outsideRoots(pathRef(arg.text, cwd, env, arg.glob), env);
    if (outside) return at("delete-outside-roots", outside);
  }
  if (name === "tee") {
    const append = argTexts.some((arg) => arg === "-a" || arg === "--append");
    for (const arg of pathArguments(args)) {
      const hit = writeTargetHit(pathRef(arg.text, cwd, env, arg.glob), append ? ">>" : ">", env);
      if (hit) return at(hit.rule, hit.detail);
    }
  }

  // cd 改后面命令的 cwd。
  if (name === "cd") {
    const target = pathArguments(args)[0]?.text;
    if (target === "-") return at("dynamic-word", "cd -");
    context.cwd = target === undefined ? env.home : env.fs.realPath(resolve(cwd, target));
    context.vars.set("PWD", context.cwd);
  }

  return screenRedirects(command, { cwd }, context, env, at);
}

/**
 * 一条命令里的 $(…)（词和重定向的目标里的）：里面的每条命令按同样的规则筛查。里面是子 shell：cd 和赋值不带出来。
 * 里面再用 bash <脚本> 的，执行时换不成筛查过的副本，unknown。
 */
function screenSubstitutions(command: SimpleCommand, context: ScreenContext, env: ScreenEnv): Hit | null {
  const tokens = [...command.words, ...command.redirects.flatMap((redirect) => redirect.target ? [redirect.target] : [])];
  for (const token of tokens) {
    for (const segment of token.segments) {
      if (segment.kind !== "subst") continue;
      const inner: ScreenContext = {
        cwd: context.cwd, vars: new Map(context.vars), depth: context.depth, scripts: [],
        ...(context.script ? { script: context.script } : {}),
      };
      for (const nested of commandsOf(segment.tokens)) {
        const hit = screenCommand(nested, inner, env);
        if (hit) return hit;
      }
      if (inner.scripts.length) {
        return { rule: "script-not-screened", detail: "$(bash <脚本>)", line: segment.line, ...(context.script ? { script: context.script } : {}) };
      }
    }
  }
  return null;
}

// 值不知道的参数（来自 $(…) 或者筛查器不知道的变量）在哪些地方可以放行（工单 #324）。不知道的值不能当路径比较，所以只放行
// 当作文字用、不当路径用的位置：echo、printf 只打印；git 的这些子命令的参数是提交、分支、远端和说明文字，删除和写文件的子命令、
// 读写文件的选项不在里面；gh 只放行说明文字类选项的值，和 pr、issue、run 的编号或分支。git 和 gh 的不知道的值要在双引号里：
// 不在引号里的会拆成几个参数，可能变成选项。
const DYNAMIC_PRINTERS = new Set(["echo", "printf"]);
const GIT_DYNAMIC_SUBCOMMANDS = new Set([
  "add", "commit", "push", "fetch", "pull", "log", "show", "diff", "status", "rev-parse", "rev-list", "merge-base", "branch",
  "tag", "switch", "checkout", "merge", "rebase", "cherry-pick", "revert", "reset", "describe", "ls-remote", "ls-files",
  "for-each-ref", "cat-file", "grep", "blame", "shortlog", "notes", "remote", "stash",
]);
// git 读文件或者写文件的选项：值不能是不知道的。
const GIT_PATH_OPTIONS = new Set(["-F", "--file", "-o", "--output", "--output-directory", "-t", "--template", "--pathspec-from-file"]);
// 有它们时 git 读或写仓库以外的文件：这时不放行任何不知道的值。
const GIT_OUTSIDE_FLAGS = /^(--no-index|--output(=.*)?|--output-directory(=.*)?)$/;
const GH_TEXT_OPTIONS = new Set([
  "-t", "--title", "-b", "--body", "-n", "--notes", "-m", "--message", "--subject", "-H", "--head", "-B", "--base",
  "-f", "--raw-field", "-R", "--repo", "-l", "--label", "-q", "--jq", "--search",
]);
const GH_ID_COMMANDS = new Set(["pr", "issue", "run"]);
// 能读 heredoc 的程序：把正文当数据，不当代码。别的程序（shell、解释器、sqlite3）收到的 heredoc 可能是代码，unknown。
const HEREDOC_READERS = new Set(["cat", "tee", "git", "gh", "wc", "head", "tail", "grep", "sort"]);

/** 第一个不能放行的值不知道的参数。都能放行（或者没有）时为 null。 */
function unreadableDynamicArg(name: string, args: readonly Word[]): Word | null {
  const dynamic = args.filter((arg) => arg.dynamic);
  if (!dynamic.length || DYNAMIC_PRINTERS.has(name)) return null;
  const unquoted = dynamic.find((arg) => arg.unquotedDynamic);
  if (unquoted) return unquoted;
  if (name === "git") return gitDynamicArg(args);
  if (name === "gh") return ghDynamicArg(args);
  return dynamic[0]!;
}

/** 词开头的 --选项= 的选项名（--body="$(…)"）。不是这种写法时为 null。 */
function assignedOption(arg: Word): string | null {
  const first = arg.token.segments[0];
  return first?.kind === "text" ? /^(--?[A-Za-z-]+)=/.exec(first.text)?.[1] ?? null : null;
}

function gitDynamicArg(args: readonly Word[]): Word | null {
  let position = 0;
  while (position < args.length && args[position]!.text.startsWith("-") && !args[position]!.dynamic) {
    const option = args[position]!.text;
    if (["-C", "-c", "--git-dir", "--work-tree"].includes(option) && position + 1 < args.length) {
      const value = args[position + 1]!;
      // git -c user.name="$(…)"：只有作者的名字和邮箱可以是不知道的值。别的配置可能跑命令（core.sshCommand、alias.*）。
      const first = value.token.segments[0];
      const userIdentity = option === "-c" && first?.kind === "text" && /^user\.(name|email)=/i.test(first.text);
      if (value.dynamic && !userIdentity) return value;
      position += 2;
    } else position += 1;
  }
  const subcommand = args[position];
  if (!subcommand) return args.find((arg) => arg.dynamic) ?? null;
  if (subcommand.dynamic) return subcommand;
  const rest = args.slice(position + 1);
  const dynamic = rest.find((arg) => arg.dynamic);
  if (!dynamic) return null;
  if (!GIT_DYNAMIC_SUBCOMMANDS.has(subcommand.text) || rest.some((arg) => GIT_OUTSIDE_FLAGS.test(arg.text))) return dynamic;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (!arg.dynamic) continue;
    const assigned = assignedOption(arg);
    if ((assigned && GIT_PATH_OPTIONS.has(assigned)) || GIT_PATH_OPTIONS.has(rest[index - 1]?.text ?? "")) return arg;
  }
  return null;
}

function ghDynamicArg(args: readonly Word[]): Word | null {
  const group = args.find((arg) => !arg.text.startsWith("-") && !arg.dynamic);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.dynamic) continue;
    const previous = args[index - 1]?.text ?? "";
    const assigned = assignedOption(arg);
    if (assigned ? GH_TEXT_OPTIONS.has(assigned) : GH_TEXT_OPTIONS.has(previous)) continue;
    // pr、issue、run 后面的位置参数是编号或者分支：gh pr view "$(git branch --show-current)"。
    const positional = !assigned && !previous.startsWith("-") && group !== undefined && args.indexOf(group) < index;
    if (positional && GH_ID_COMMANDS.has(group.text)) continue;
    return arg;
  }
  return null;
}

// 外壳后面真正的命令。env 不带命令时整份打印变量；command -v 只是查找。
function unwrap(name: string, args: Word[]): Word[] | "dump" | "dynamic" | "lookup" {
  let position = 0;
  const takesValue: Record<string, readonly string[]> = {
    env: ["-u", "-C", "-P"], nice: ["-n"], timeout: ["-s", "-k", "--signal", "--kill-after"], gtimeout: ["-s", "-k"],
    caffeinate: ["-t", "-w"],
  };
  while (position < args.length) {
    const text = args[position]!.text;
    if (name === "env" && (text === "-S" || text.startsWith("--split-string"))) return "dynamic";
    if (name === "command" && (text === "-v" || text === "-V")) return "lookup";
    if (text === "--") { position += 1; break; }
    if (text.startsWith("-") && text.length > 1) {
      position += (takesValue[name] ?? []).includes(text) ? 2 : 1;
      continue;
    }
    if (name === "env" && args[position]!.assignment) { position += 1; continue; }
    break;
  }
  if ((name === "timeout" || name === "gtimeout") && position < args.length) position += 1;
  const rest = args.slice(position);
  if (name === "env" && rest.length === 0) return "dump";
  return rest;
}

function envDump(name: string, args: readonly string[]): boolean {
  if (name === "set") return args.length === 0;
  if (name === "printenv" || name === "env") return args.length === 0;
  // export、declare、typeset 只带选项（或者什么都不带）时打印。
  return args.every((arg) => arg.startsWith("-"));
}

function paidHost(arg: string): string | undefined {
  const value = arg.includes("=") && arg.startsWith("-") ? arg.slice(arg.indexOf("=") + 1) : arg;
  let host: string;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) host = new URL(value).hostname;
    else if (/^[a-z0-9.-]+\.[a-z]{2,}(:[0-9]+)?(\/|$)/i.test(value)) host = new URL(`http://${value}`).hostname;
    else return undefined;
  } catch {
    return undefined;
  }
  host = host.toLowerCase();
  return PAID_API_HOSTS.some((pattern) => {
    const bare = pattern.replace(/^\*\./, "");
    return host === bare || host.endsWith(`.${bare}`);
  }) ? host : undefined;
}

// bash、sh、zsh 的调用：-c 是直接写代码；没有脚本时从标准输入读；脚本在 lead-scratch 下的逐行筛查。
function screenShellCall(
  name: string, args: readonly Word[], context: ScreenContext, env: ScreenEnv, at: (rule: ScreenRule, detail: string) => Hit,
): Hit | null {
  let position = 0;
  while (position < args.length) {
    const text = args[position]!.text;
    if (text === "--") { position += 1; break; }
    if (text === "-o" || text === "+o") { position += 2; continue; }
    if (text === "--norc" || text === "--noprofile" || text === "--login") { position += 1; continue; }
    if (/^[-+][euxvnl]+$/.test(text)) { position += 1; continue; }
    if (text.startsWith("-") || text.startsWith("+")) {
      if (/c/.test(text)) return at("inline-code", `${name} ${text}`);
      if (/[si]/.test(text) || text === "-") return at("stdin-shell", `${name} ${text}`);
      return at("inline-code", `${name} ${text}`);
    }
    break;
  }
  const scriptWord = args[position];
  if (!scriptWord) return at("stdin-shell", name);
  const location = pathRef(scriptWord.text, context.cwd, env);
  if (!within(location.real, env.scratch) || !within(location.link, env.scratch)) {
    return at("script-outside-scratch", scriptWord.text);
  }
  if (context.depth > 0) return at("script-not-screened", `${scriptWord.text}：脚本里再跑脚本`);
  const content = env.fs.readFile(location.real);
  if (content === null) return at("script-not-screened", scriptWord.text);
  // 脚本的位置参数：$0 是脚本，$1… 是后面的参数。
  const scriptArgs = args.slice(position + 1).map((arg) => arg.text);
  const vars: Vars = initialVars(env.home, context.cwd);
  vars.set("0", location.real);
  scriptArgs.forEach((arg, offset) => vars.set(String(offset + 1), arg));
  vars.set("#", String(scriptArgs.length));
  vars.set("@", scriptArgs.join(" "));
  vars.set("*", scriptArgs.join(" "));
  const hit = screenSource(content, { cwd: context.cwd, vars, depth: context.depth + 1, script: location.real, scripts: [] }, env);
  if (hit) return hit;
  context.scripts.push({ path: location.real, content, span: [scriptWord.token.start, scriptWord.token.end] });
  return null;
}

// 参数里哪些可能是路径：选项本身不算，--file=<路径> 取 = 后面；-- 以后都算；URL 不算。宁可多算：多算的只会多比较一次。
interface PathArgument { text: string; glob: boolean }

function pathArguments(args: readonly Word[]): PathArgument[] {
  const paths: PathArgument[] = [];
  let afterDashes = false;
  for (const arg of args) {
    const text = arg.text;
    if (!afterDashes && text === "--") { afterDashes = true; continue; }
    if (!text) continue;
    if (!afterDashes && text.startsWith("-")) {
      const equals = text.indexOf("=");
      if (equals > 0 && equals < text.length - 1) paths.push({ text: text.slice(equals + 1), glob: arg.glob });
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) continue;
    paths.push({ text, glob: arg.glob });
  }
  return paths;
}

const GLOB_CHARS = /[*?[{]/;

function pathRef(raw: string, cwd: string, env: ScreenEnv, glob = false): PathRef {
  const absolute = resolve(cwd, raw);
  if (glob) {
    const parts = absolute.split(sep);
    const first = parts.findIndex((part) => GLOB_CHARS.test(part));
    const dir = env.fs.realPath(parts.slice(0, first).join(sep) || sep);
    const pattern = join(dir, ...parts.slice(first));
    return { raw, absolute, real: dir, link: dir, glob: { dir, pattern } };
  }
  const real = env.fs.realPath(absolute);
  const link = join(env.fs.realPath(dirname(absolute)), basename(absolute));
  return { raw, absolute, real, link, glob: null };
}

function locationsOf(path: PathRef): string[] {
  return [...new Set([path.absolute, path.real, path.link])];
}

function credentialHit(path: PathRef, env: ScreenEnv, cwd: string): string | null {
  const protectedPath = protectedHit(path, env.protectedRead);
  if (protectedPath) return protectedPath;
  const candidates = path.glob ? [path.glob.dir] : locationsOf(path);
  for (const candidate of candidates) {
    const reason = env.credentialPathReason(candidate, { home: env.home, cwd });
    if (reason) return `${path.raw}：${reason}`;
  }
  return null;
}

/** 路径落在哪一个受保护的位置里（位置可以带通配）。都不在时为 null。 */
function protectedHit(path: PathRef, locations: readonly string[]): string | null {
  for (const location of locations) {
    if (path.glob) {
      if (globTouches(segmentsOf(path.glob.pattern), segmentsOf(location))) return location;
      continue;
    }
    if (locationsOf(path).some((candidate) => withinPattern(segmentsOf(candidate), segmentsOf(location)))) return location;
  }
  return null;
}

function outsideRoots(path: PathRef, env: ScreenEnv): string | null {
  const candidates = path.glob ? [path.glob.dir] : [path.real, path.link];
  const outside = candidates.find((candidate) => !env.roots.some((root) => within(candidate, root)));
  return outside ?? null;
}

// 哪些参数是要删的路径。
function deletedPaths(
  name: string, args: readonly Word[], gitSubcommand: string | null, gitArgs: readonly Word[], cwd: string,
): PathArgument[] {
  const texts = args.map((arg) => arg.text);
  if (DELETE_PROGRAMS.has(name)) return pathArguments(args);
  if (name === "git" && gitSubcommand === "clean") {
    const paths = pathArguments(gitArgs);
    return paths.length > 0 ? paths : [{ text: cwd, glob: false }];
  }
  if (name === "find" && texts.includes("-delete")) {
    const starts: PathArgument[] = [];
    for (const arg of args) {
      if (arg.text.startsWith("-") || arg.text === "(" || arg.text === "!") break;
      starts.push({ text: arg.text, glob: arg.glob });
    }
    return starts.length > 0 ? starts : [{ text: cwd, glob: false }];
  }
  if (name === "rsync" && texts.some((text) => text.startsWith("--delete") || text === "--remove-source-files")) {
    const paths = pathArguments(args);
    return paths.length > 0 ? [paths.at(-1)!] : [];
  }
  return [];
}

const DEVICE_FILES = /^\/dev\/(null|stdout|stderr|tty|fd\/[0-9]+)$/;

// 写的目标：账本、凭证、launchd、沙箱外会执行的位置；> 会清空文件，目标在允许的根以外时也算删除。
function writeTargetHit(path: PathRef, op: string, env: ScreenEnv): { rule: ScreenRule; detail: string } | null {
  if (!path.glob && DEVICE_FILES.test(path.absolute)) return null;
  const ledger = protectedHit(path, env.ledger);
  if (ledger) return { rule: "ledger-write", detail: ledger };
  const credential = protectedHit(path, env.protectedRead);
  if (credential) return { rule: "credentials", detail: credential };
  const launch = protectedHit(path, env.launch);
  if (launch) return { rule: "launchd", detail: launch };
  const startup = protectedHit(path, env.startup);
  if (startup) return { rule: "startup-file-write", detail: startup };
  if (op === ">") {
    const outside = outsideRoots(path, env);
    if (outside) return { rule: "delete-outside-roots", detail: `> ${outside}` };
  }
  return null;
}

function screenRedirects(
  command: SimpleCommand, scope: { cwd: string } | null, context: ScreenContext, env: ScreenEnv,
  at: (rule: ScreenRule, detail: string) => Hit,
): Hit | null {
  const cwd = scope?.cwd ?? context.cwd;
  for (const redirect of command.redirects) {
    if (!redirect.target || redirect.op === "<<<") continue;
    const word = wordOf(redirect.target, context.vars, env.home);
    if (word.dynamic) return at("dynamic-word", word.dynamic);
    const path = pathRef(word.text, cwd, env, word.glob);
    if (redirect.op === "<" || redirect.op === "<&") {
      const credential = credentialHit(path, env, cwd);
      if (credential) return at("credentials", credential);
      const launch = protectedHit(path, env.launch);
      if (launch) return at("launchd", launch);
      continue;
    }
    const hit = writeTargetHit(path, redirect.op === ">&" ? ">" : redirect.op, env);
    if (hit) return at(hit.rule, hit.detail);
  }
  return null;
}

// ——— 路径比较 ———

function within(path: string, root: string): boolean {
  const rel = relative(root.toLowerCase(), path.toLowerCase());
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isAncestor(path: string, target: string): boolean {
  return within(target, path);
}

function segmentsOf(path: string): string[] {
  return path.toLowerCase().split(sep).filter((part) => part.length > 0);
}

// 一段路径名和一段模式比较。* 和 ? 不匹配开头的 .，和 shell 一样。
function segmentMatches(pattern: string, segment: string): boolean {
  if (!GLOB_CHARS.test(pattern)) return pattern === segment;
  if (segment.startsWith(".") && !pattern.startsWith(".")) return false;
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const ch = pattern[index]!;
    if (ch === "*") source += ".*";
    else if (ch === "?") source += ".";
    else if (ch === "[") {
      const close = pattern.indexOf("]", index + 1);
      if (close < 0) { source += "\\["; continue; }
      source += `[${pattern.slice(index + 1, close).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
      index = close;
    } else if (ch === "{") {
      const close = pattern.indexOf("}", index + 1);
      if (close < 0) { source += "\\{"; continue; }
      source += `(${pattern.slice(index + 1, close).split(",").map(escapeRegExp).join("|")}|.*)`;
      index = close;
    } else source += escapeRegExp(ch);
  }
  try {
    return new RegExp(`^${source}$`).test(segment);
  } catch {
    return true;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 路径在模式描述的位置里面（或者就是它）。模式里的 ** 匹配任意多段。
function withinPattern(path: readonly string[], pattern: readonly string[], i = 0, j = 0): boolean {
  if (j === pattern.length) return true;
  if (pattern[j] === "**") return withinPattern(path, pattern, i, j + 1) || (i < path.length && withinPattern(path, pattern, i + 1, j));
  if (i === path.length) return false;
  return segmentMatches(pattern[j]!, path[i]!) && withinPattern(path, pattern, i + 1, j + 1);
}

// 一个带通配的路径能不能碰到受保护的位置：逐段比较。模式先用完时它是位置的上级（rm -rf ~/.s*），位置先用完时它在
// 位置里面（cat ~/.ssh/*）。位置里的 ** 匹配任意多段；跨过 ** 以后，模式只是「某个深处位置的上级」不算碰到
// （rm -rf ~/Documents/* 不算写 **/.git/hooks）。两边都带通配的段按能匹配算。
function globTouches(glob: readonly string[], location: readonly string[], i = 0, j = 0, crossed = false): boolean {
  if (j === location.length) return true;
  if (i === glob.length) return !crossed;
  const a = glob[i]!;
  const b = location[j]!;
  if (a === "**") return true;
  if (b === "**") return globTouches(glob, location, i, j + 1, true) || globTouches(glob, location, i + 1, j, true);
  const aGlob = GLOB_CHARS.test(a);
  const bGlob = GLOB_CHARS.test(b);
  const matches = aGlob && bGlob ? true : aGlob ? segmentMatches(a, b) : bGlob ? segmentMatches(b, a) : a === b;
  return matches && globTouches(glob, location, i + 1, j + 1, crossed);
}

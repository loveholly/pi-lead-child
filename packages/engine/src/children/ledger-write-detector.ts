// child 的命令里有没有直接写账本（plc.db）或配置（config.json）的操作（2026-10-19 审查）。
//
// 规则（用户 2026-10-19）：child 可以读数据目录里的日志、runtime-events、sessions，可以用 sqlite3 -readonly 查 plc.db；
// 不能写 plc.db 和 config.json，改设置必须走 daemon 的 API。写库会被账本的写入守卫拦住（store 的 ledger-guard.ts），
// 这里只负责发现「它试过」，让用户知道。
//
// 输入是 shell 命令，不是自然语言：这里按 shell 的结构拆开（引号、管道、分号、重定向、heredoc、cd），再按命令判断：
//   - sqlite3 打开 plc.db 并且不是只读：看每条 SQL 语句的第一个关键词是不是写（INSERT、UPDATE、DROP……）。
//     SELECT 里出现 update、replace()、'CREATE TABLE%' 都不算。
//   - rm、mv、cp、dd、tee、重定向、sed -i、编辑器：只在目标是 plc.db（含 -wal、-shm）或 config.json 时算。
//   - python -c、node -e 这类一行脚本：脚本里提到 plc.db，并且有一段字符串是写语句时算。
// 宁可漏报，不误报：判断不了的（$(...) 里的命令、从文件读的 SQL）不报。
import { homedir } from "node:os";
import { basename, isAbsolute, join, normalize, resolve } from "node:path";

export interface LedgerPaths {
  dbPath: string;
  dataDir: string;
  home?: string;
}

export interface LedgerWriteAttempt {
  target: "plc.db" | "config.json";
}

// ——— shell 的拆分 ———

interface SimpleCommand {
  words: string[];
  // 输出重定向的目标（> 和 >>）。
  outputs: string[];
  // heredoc 的正文（<<EOF … EOF）。
  heredoc: string;
  // 前一条命令经管道（|）接到这一条时为 true。
  piped: boolean;
}

/** 把一条 shell 命令拆成简单命令。只处理常见的写法；$(...) 和反引号当成普通文字。 */
export function splitShell(command: string): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  let current: SimpleCommand = { words: [], outputs: [], heredoc: "", piped: false };
  let word = "";
  let inWord = false;
  let pendingOutput = false;
  const heredocs: Array<{ delimiter: string; strip: boolean; command: SimpleCommand }> = [];
  const endWord = () => {
    if (!inWord) return;
    if (pendingOutput) current.outputs.push(word);
    else current.words.push(word);
    pendingOutput = false;
    word = "";
    inWord = false;
  };
  const endCommand = (piped: boolean) => {
    endWord();
    if (current.words.length || current.outputs.length) commands.push(current);
    current = { words: [], outputs: [], heredoc: "", piped };
  };
  let i = 0;
  while (i < command.length) {
    const char = command[i]!;
    if (char === "\\" && i + 1 < command.length) {
      if (command[i + 1] === "\n") { i += 2; continue; }
      word += command[i + 1];
      inWord = true;
      i += 2;
      continue;
    }
    if (char === "'") {
      const end = command.indexOf("'", i + 1);
      word += command.slice(i + 1, end < 0 ? command.length : end);
      inWord = true;
      i = end < 0 ? command.length : end + 1;
      continue;
    }
    if (char === "\"") {
      i += 1;
      while (i < command.length && command[i] !== "\"") {
        if (command[i] === "\\" && i + 1 < command.length && "\"\\$`".includes(command[i + 1]!)) {
          word += command[i + 1];
          i += 2;
          continue;
        }
        word += command[i];
        i += 1;
      }
      inWord = true;
      i += 1;
      continue;
    }
    if (char === "\n") {
      endCommand(false);
      i += 1;
      // heredoc 的正文从这一行开始，到只有分隔符的那一行为止。
      while (heredocs.length) {
        const doc = heredocs.shift()!;
        const lines: string[] = [];
        while (i < command.length) {
          const next = command.indexOf("\n", i);
          const line = command.slice(i, next < 0 ? command.length : next);
          i = next < 0 ? command.length : next + 1;
          if ((doc.strip ? line.trim() : line) === doc.delimiter) break;
          lines.push(line);
        }
        doc.command.heredoc += `${lines.join("\n")}\n`;
      }
      continue;
    }
    if (char === " " || char === "\t") { endWord(); i += 1; continue; }
    if (char === ";") { endCommand(false); i += 1; continue; }
    if (char === "&" && command[i + 1] === "&") { endCommand(false); i += 2; continue; }
    if (char === "|" && command[i + 1] === "|") { endCommand(false); i += 2; continue; }
    if (char === "|") { endCommand(true); i += 1; continue; }
    if (char === "&" && command[i + 1] === ">") { endWord(); pendingOutput = true; i += command[i + 2] === ">" ? 3 : 2; continue; }
    if (char === "&") { endCommand(false); i += 1; continue; }
    if (char === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      endWord();
      let j = i + 2;
      const strip = command[j] === "-";
      if (strip) j += 1;
      while (command[j] === " ") j += 1;
      let delimiter = "";
      const quote = command[j] === "'" || command[j] === "\"" ? command[j] : null;
      if (quote) {
        const end = command.indexOf(quote, j + 1);
        delimiter = command.slice(j + 1, end < 0 ? command.length : end);
        j = end < 0 ? command.length : end + 1;
      } else {
        while (j < command.length && !" \t\n;&|<>".includes(command[j]!)) delimiter += command[j++];
      }
      if (delimiter) heredocs.push({ delimiter, strip, command: current });
      i = j;
      continue;
    }
    if (char === ">" || char === "<") {
      // 2> 这样的文件描述符前缀不是一个词。
      if (inWord && /^\d+$/.test(word)) { word = ""; inWord = false; }
      endWord();
      // >&2、2>&1：复制文件描述符，不是写文件。
      if (command[i + 1] === "&") {
        i += 2;
        while (i < command.length && /[\d-]/.test(command[i]!)) i += 1;
        continue;
      }
      if (char === ">") pendingOutput = true;
      i += command[i + 1] === ">" || command[i + 1] === "|" ? 2 : 1;
      if (char === "<") {
        // 输入重定向的来源不算目标：读下一个词，丢掉。
        while (command[i] === " ") i += 1;
        while (i < command.length && !" \t\n;&|<>".includes(command[i]!)) i += 1;
      }
      continue;
    }
    word += char;
    inWord = true;
    i += 1;
  }
  endCommand(false);
  return commands;
}

// ——— SQL ———

const SQL_WRITE_KEYWORDS = new Set([
  "insert", "update", "delete", "replace", "drop", "alter", "create", "vacuum", "reindex", "attach", "detach", "upsert",
]);
// sqlite3 的点命令里会写库的。
const DOT_WRITES = new Set([".import", ".restore", ".clone", ".recover"]);

// 去掉字符串常量和注释，按分号切成语句。
function sqlStatements(sql: string): string[] {
  let text = "";
  let i = 0;
  while (i < sql.length) {
    const char = sql[i]!;
    if (char === "'" || char === "\"" || char === "`") {
      const end = sql.indexOf(char, i + 1);
      text += " '' ";
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (char === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end;
      continue;
    }
    if (char === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
      continue;
    }
    text += char;
    i += 1;
  }
  return text.split(/;|\n(?=\s*\.)/).map((statement) => statement.trim()).filter(Boolean);
}

// 去掉括号里的内容（WITH 的子查询），只留最外层。
function topLevel(statement: string): string {
  let depth = 0;
  let out = "";
  for (const char of statement) {
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) out += char;
  }
  return out;
}

/** 一段 SQL 里有没有写语句：每条语句看第一个关键词。WITH 开头的看最外层有没有写的关键词。 */
export function sqlWrites(sql: string): boolean {
  for (const statement of sqlStatements(sql)) {
    const first = /^[.A-Za-z_]+/.exec(statement)?.[0]?.toLowerCase() ?? "";
    if (first.startsWith(".")) {
      if (DOT_WRITES.has(first)) return true;
      continue;
    }
    if (SQL_WRITE_KEYWORDS.has(first)) return true;
    if (first === "pragma" && statement.includes("=")) return true;
    if (first === "with" && /\b(insert|update|delete|replace)\b/i.test(topLevel(statement))) return true;
  }
  return false;
}

// ——— 路径 ———

interface Context {
  paths: Required<LedgerPaths>;
  cwd: string | null;
}

function expand(word: string, context: Context): string {
  const { home, dbPath, dataDir } = context.paths;
  return word
    .replace(/^~(?=\/|$)/, home)
    .replace(/^\$\{?HOME\}?(?=\/|$)/, home)
    .replace(/^\$\{?PLC_DB\}?/, dbPath)
    .replace(/^\$\{?PLC_DATA_DIR\}?(?=\/|$)/, dataDir);
}

// 一个词展开后指向的绝对路径。相对路径只在知道当前目录（cd 过）时才能解析。
function pathOf(word: string, context: Context): string | null {
  const expanded = expand(word, context);
  if (isAbsolute(expanded)) return normalize(expanded);
  return context.cwd ? resolve(context.cwd, expanded) : null;
}

function isDb(word: string, context: Context): boolean {
  const path = pathOf(word.replace(/\*+$/, ""), context);
  if (!path) return false;
  const base = path.replace(/-(wal|shm|journal)$/, "");
  return base === normalize(context.paths.dbPath);
}

function isConfig(word: string, context: Context): boolean {
  return pathOf(word, context) === join(normalize(context.paths.dataDir), "config.json");
}

type Target = "plc.db" | "config.json";

function targetOf(word: string, context: Context): Target | null {
  if (isDb(word, context)) return "plc.db";
  if (isConfig(word, context)) return "config.json";
  return null;
}

// 命令前面的包装：环境变量赋值、sudo、env、command、exec、time、nohup。
function unwrap(words: string[]): string[] {
  let i = 0;
  while (i < words.length) {
    const word = words[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) { i += 1; continue; }
    if (["sudo", "env", "command", "exec", "time", "nohup", "builtin"].includes(word)) { i += 1; continue; }
    break;
  }
  return words.slice(i);
}

// sqlite3 带值的选项。
const SQLITE_VALUE_OPTIONS = new Set(["-cmd", "-separator", "-newline", "-nullvalue", "-init", "-vfs", "-maxsize", "-mmap", "-pagecache", "-lookaside", "-heap"]);
const EDITORS = new Set(["vi", "vim", "nvim", "nano", "emacs", "ed", "ex", "code", "subl"]);
const REMOVERS = new Set(["rm", "unlink", "shred", "truncate"]);
const MOVERS = new Set(["mv", "cp", "install", "ln", "rsync"]);
const SCRIPTS = new Set(["python", "python3", "node", "ruby", "perl", "bun", "deno"]);

function sqliteWrite(words: string[], stdin: string, context: Context): Target | null {
  let db: string | null = null;
  let readOnly = false;
  const sql: string[] = [];
  for (let i = 1; i < words.length; i += 1) {
    const word = words[i]!;
    if (word.startsWith("-") && db === null) {
      if (word === "-readonly" || word === "--readonly") readOnly = true;
      if (word === "-cmd" && words[i + 1]) sql.push(words[i + 1]!);
      if (SQLITE_VALUE_OPTIONS.has(word)) i += 1;
      continue;
    }
    if (db === null) { db = word; continue; }
    sql.push(word);
  }
  if (db === null || !isDb(db.replace(/^file:/, "").replace(/\?.*$/, ""), context)) return null;
  if (readOnly || /[?&](mode=ro|immutable=1)\b/.test(db)) return null;
  return sqlWrites(sql.length ? sql.join(";\n") : stdin) ? "plc.db" : null;
}

function scriptWrite(script: string, context: Context): Target | null {
  const words = script.split(/[\s'"`(),]+/).filter(Boolean);
  if (words.some((word) => isDb(word, context))) {
    const strings = [...script.matchAll(/'([^']*)'|"([^"]*)"/g)].map((match) => match[1] ?? match[2] ?? "");
    if (strings.some((text) => sqlWrites(text))) return "plc.db";
  }
  if (words.some((word) => isConfig(word, context))
    && /open\([^)]*['"][wa]\+?['"]|write_text|writeFileSync|writeFile\(|json\.dump\(/.test(script)) return "config.json";
  return null;
}

function commandWrite(command: SimpleCommand, stdin: string, context: Context): Target | null {
  for (const output of command.outputs) {
    const target = targetOf(output, context);
    if (target) return target;
  }
  const words = unwrap(command.words);
  if (!words.length) return null;
  const name = basename(words[0]!);
  const args = words.slice(1);
  const operands = args.filter((word) => !word.startsWith("-"));
  if (name === "sqlite3") return sqliteWrite(words, command.heredoc || stdin, context);
  if (REMOVERS.has(name)) return operands.map((word) => targetOf(word, context)).find(Boolean) ?? null;
  if (MOVERS.has(name)) {
    if (args.includes("-t") || args.some((word) => word.startsWith("--target-directory"))) return null;
    const last = operands.at(-1);
    return operands.length >= 2 && last ? targetOf(last, context) : null;
  }
  if (name === "dd") {
    const output = args.find((word) => word.startsWith("of="));
    return output ? targetOf(output.slice(3), context) : null;
  }
  if (name === "tee" || EDITORS.has(name)) return operands.map((word) => targetOf(word, context)).find(Boolean) ?? null;
  if ((name === "sed" && args.some((word) => word === "-i" || word.startsWith("-i") || word === "--in-place" || /^-[a-zA-Z]*i/.test(word)))
    || (name === "perl" && args.some((word) => /^-[a-zA-Z]*i/.test(word)))) {
    return operands.map((word) => targetOf(word, context)).find(Boolean) ?? null;
  }
  if (["bash", "sh", "zsh"].includes(name)) {
    const script = args[args.indexOf("-c") + 1];
    return args.includes("-c") && script ? detectIn(script, context) : null;
  }
  if (SCRIPTS.has(name.replace(/[\d.]+$/, ""))) {
    const flag = args.findIndex((word) => word === "-c" || word === "-e" || word === "--eval");
    if (flag >= 0 && args[flag + 1]) return scriptWrite(args[flag + 1]!, context);
    if (command.heredoc) return scriptWrite(command.heredoc, context);
  }
  return null;
}

function detectIn(command: string, context: Context): Target | null {
  const commands = splitShell(command);
  let previousStdout = "";
  for (const simple of commands) {
    const words = unwrap(simple.words);
    if (words[0] === "cd") {
      const path = words[1] ? pathOf(words[1], context) : context.paths.home;
      context.cwd = path;
      previousStdout = "";
      continue;
    }
    const stdin = simple.piped ? previousStdout : "";
    const target = commandWrite(simple, stdin, context);
    if (target) return target;
    // 管道的上一段：echo、printf 的参数和 cat 的 heredoc 就是下一段的输入。
    const name = words[0] ? basename(words[0]) : "";
    previousStdout = name === "echo" || name === "printf" ? words.slice(1).join(" ") : simple.heredoc;
  }
  return null;
}

/** 一条 child 执行的命令像不像在直接写账本或配置。不像时返回 null。 */
export function detectLedgerWrite(command: string, paths: LedgerPaths): LedgerWriteAttempt | null {
  if (!command.trim()) return null;
  const context: Context = { paths: { dbPath: paths.dbPath, dataDir: paths.dataDir, home: paths.home ?? homedir() }, cwd: null };
  const target = detectIn(command, context);
  return target ? { target } : null;
}

/** 一个 tool.started 事件里的命令（bash 一类工具的 command / cmd 参数）。没有时返回 null。 */
export function commandOfToolEvent(event: { type: string; args?: unknown }): string | null {
  if (event.type !== "tool.started" || !event.args || typeof event.args !== "object") return null;
  const args = event.args as Record<string, unknown>;
  const command = args.command ?? args.cmd;
  if (typeof command === "string") return command;
  if (Array.isArray(command) && command.every((part) => typeof part === "string")) return command.join(" ");
  return null;
}

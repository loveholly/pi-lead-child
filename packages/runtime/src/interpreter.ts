// 解释器检查（spec D2，工单 05）。
// 脚本形式的 CLI（例如 pi）由 shebang 决定解释器。`#!/usr/bin/env node` 用的是 child 的 PATH 上第一个 node，
// 不是 daemon 自己的 Node。历史上 pi child 因此跑在 Node 22.14 上，而 pi-coding-agent 1.1.0 要求 22.19 或更高。
// 所以这里按 child 的 PATH 解析解释器，再用 CLI 所属包的 engines 判断它的版本。
// 原生可执行文件（例如 Claude Code 2.1.258、codex-cli 0.153.3）没有 shebang，不需要这一项检查。
// 工单 10 之后，pi 不再经 shebang 运行，而由 daemon 自己的 Node 运行入口文件（daemonNodeLaunch）。
// 它的解释器就是 daemon 的 Node，engines 检查照旧。其他脚本形式的 CLI 仍按 child 的 PATH 解析。
import {
  accessSync, closeSync, constants, existsSync, openSync, readFileSync, readSync, realpathSync,
} from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";

export interface RuntimeInterpreter {
  // shebang 里的命令名，例如 node。
  command: string;
  // child 实际会用的那个解释器的绝对路径。PATH 上找不到时为 null。
  path: string | null;
  // CLI 所属的包对这个解释器的版本要求，例如 ">=22.19.0"。包没有声明时为 null。
  engines: string | null;
}

const SHEBANG_BYTES = 256;
// 向上找 package.json 的层数上限。CLI 的入口文件离它所属包的根目录不远。
const MAX_PACKAGE_DEPTH = 8;

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function firstLine(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(SHEBANG_BYTES);
    const read = readSync(fd, buffer, 0, SHEBANG_BYTES, 0);
    return buffer.subarray(0, read).toString("utf8").split("\n")[0] ?? null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

// `/usr/bin/env` 按 child 的 PATH 找命令。这里用同样的规则：只看 child 的 PATH，按顺序取第一个可执行文件。
export function resolveOnPath(command: string, pathValue: string | undefined): string | null {
  if (command.includes("/")) return isExecutable(command) ? command : null;
  for (const dir of (pathValue ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, command);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

// shebang 的解释器命令。`#!/usr/bin/env [-S] [VAR=value] node [args]` 取 env 之后的第一个命令。
// args 是命令之后交给解释器的参数，例如 `#!/usr/bin/env -S node --no-warnings` 的 --no-warnings。
function shebangCommand(line: string): { command: string; viaEnv: boolean; args: string[] } | null {
  if (!line.startsWith("#!")) return null;
  const tokens = line.slice(2).trim().split(/\s+/).filter(Boolean);
  const head = tokens[0];
  if (!head) return null;
  if (basename(head) !== "env") return { command: head, viaEnv: false, args: tokens.slice(1) };
  const index = tokens.findIndex((token, position) => position > 0 && !token.startsWith("-") && !token.includes("="));
  return index === -1 ? null : { command: tokens[index]!, viaEnv: true, args: tokens.slice(index + 1) };
}

// CLI 所属包声明的 engines。从入口文件的真实路径向上找第一个 package.json。
function packageEngines(entry: string, command: string): string | null {
  let dir = dirname(entry);
  for (let depth = 0; depth < MAX_PACKAGE_DEPTH; depth += 1) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const engines = (JSON.parse(readFileSync(manifest, "utf8")) as { engines?: Record<string, unknown> }).engines;
        const range = engines?.[command];
        return typeof range === "string" && range.trim() ? range.trim() : null;
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// 可执行文件的入口（真实路径）和它的 shebang。原生可执行文件、读不到的文件返回 null。
function readShebang(executable: string): { entry: string; shebang: NonNullable<ReturnType<typeof shebangCommand>> } | null {
  let entry: string;
  try {
    entry = realpathSync(executable);
  } catch {
    return null;
  }
  const line = firstLine(entry);
  const shebang = line ? shebangCommand(line) : null;
  return shebang ? { entry, shebang } : null;
}

// 一个可执行文件的解释器。原生可执行文件、读不到的文件返回 null。
// env 是 child 的环境：解释器按它的 PATH 解析。
export function resolveInterpreter(
  executable: string,
  env: Record<string, string | undefined>,
): RuntimeInterpreter | null {
  const script = readShebang(executable);
  if (!script) return null;
  const { entry, shebang } = script;
  const command = basename(shebang.command);
  const path = shebang.viaEnv
    ? resolveOnPath(shebang.command, env.PATH)
    : isExecutable(shebang.command) ? shebang.command : null;
  return { command, path, engines: packageEngines(entry, command) };
}

// CLI 入口是 node 脚本时，由 daemon 自己的 Node 运行它（spec D6，工单 10）。解释器就是 daemon 的 Node。
// 返回运行方式。命令是 daemon 的 Node，参数是 shebang 里给 node 的参数，再加入口文件的真实路径。
// 入口不是 node 脚本时返回 null，例如原生可执行文件、其他解释器、读不到的文件。调用方照旧直接运行它。
export interface DaemonNodeLaunch {
  command: string;
  args: string[];
  interpreter: RuntimeInterpreter;
}

export function daemonNodeLaunch(executable: string): DaemonNodeLaunch | null {
  const script = readShebang(executable);
  if (!script || basename(script.shebang.command) !== "node") return null;
  const { entry, shebang } = script;
  return {
    command: process.execPath,
    args: [...shebang.args, entry],
    interpreter: { command: "node", path: process.execPath, engines: packageEngines(entry, "node") },
  };
}

// ── 版本要求的判断 ──────────────────────────────────────────────────────────────
// 只实现 engines 里常见的写法：比较符（>= > <= < =）、^、~、空格表示"且"、|| 表示"或"。
// 认不出的写法（例如 x 通配、连字符区间）返回 null，调用方把它当作无法判断，不拦截。
// 宁可放过，也不因为解析不了就挂起派发。
type Version = [number, number, number];

export function parseVersion(text: string): Version | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function compare(left: Version, right: Version): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return 0;
}

function comparatorHolds(version: Version, token: string): boolean | null {
  if (token === "*") return true;
  const match = /^(>=|<=|>|<|=|\^|~)?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(token);
  if (!match) return null;
  const given = [match[2], match[3], match[4]].filter((part) => part !== undefined).length;
  const base: Version = [Number(match[2]), Number(match[3] ?? 0), Number(match[4] ?? 0)];
  const cmp = compare(version, base);
  switch (match[1] ?? "=") {
    case ">=": return cmp >= 0;
    case ">": return cmp > 0;
    case "<=": return cmp <= 0;
    case "<": return cmp < 0;
    // ^ 允许不改变最左边非零位的升级；~ 只允许补丁版本的升级。
    case "^": return cmp >= 0 && (base[0] > 0 ? version[0] === base[0] : version[0] === 0 && version[1] === base[1]);
    case "~": return cmp >= 0 && version[0] === base[0] && (given === 1 || version[1] === base[1]);
    // 只写了一部分的版本（例如 "22"）只比较写出来的部分。
    default: return version.slice(0, given).every((part, index) => part === base[index]);
  }
}

// version 是否满足 range。range 认不出时返回 null。
export function satisfiesRange(version: string, range: string): boolean | null {
  const parsed = parseVersion(version);
  if (!parsed) return null;
  const alternatives = range.split("||").map((part) => part.trim());
  let unknown = false;
  for (const alternative of alternatives) {
    // ">= 22.19" 这种比较符和版本之间有空格的写法，先把空格去掉。
    const tokens = alternative.replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1").split(/\s+/).filter(Boolean);
    if (!tokens.length) return true;
    const results = tokens.map((token) => comparatorHolds(parsed, token));
    if (results.some((result) => result === null)) {
      unknown = true;
      continue;
    }
    if (results.every(Boolean)) return true;
  }
  return unknown ? null : false;
}

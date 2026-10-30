// 测试用：临时目录。tempDir 新建目录并登记，测试文件结束时删除。watchTempDirs 找出测试文件留下的 plc-* 目录。
// 起因：测试用 mkdtemp 在 os.tmpdir() 里新建目录，从来不删。2026-10-13，用户的 TMPDIR 里积累了约 149,000 个
// plc-* 目录，共 167 GiB，磁盘用到 98%。
//
// 删除登记的目录的是根 vitest 配置的 setup 文件（vitest.setup.ts）。它在每个测试文件结束时，先等测试启动的进程退出，
// 再删除目录。所以测试不用自己写清理，进程也不会在还用着目录的时候丢掉目录。
//
// watchTempDirs 按本进程的调用认目录：它包装 node:fs 的 mkdtemp 和 mkdir，记下直接建在 os.tmpdir() 下的 plc-* 目录。
// 同一个 TMPDIR 也给别的 vitest 和源码模式的 daemon 用，所以不比较前后两次列出的目录：那样会把别人的目录算进来。
// 子进程新建的目录因此认不出来：漏报，不会多报。检查只报告，不删除目录。
//
// 状态放在 globalThis 上：vitest 每个测试文件重新加载模块，包装只装一次，包装要找到当前的状态。
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PREFIX = "plc-";
const VALID_PREFIX = /^plc-[\w.-]*$/;
const THIS_FILE = fileURLToPath(import.meta.url);

export interface LeftTempDir {
  path: string;
  // 新建目录的调用位置：调用栈里第一个不在本文件、也不在 node 内部的帧。
  createdAt: string;
}

export interface TempDirWatch {
  // 开始以后本进程新建、现在还在的 plc-* 目录。
  left(): LeftTempDir[];
  stop(): void;
}

interface State {
  registered: Set<string>;
  watches: Set<Map<string, string>>;
  installed: boolean;
}

const KEY = Symbol.for("pi-lead-child.testing.temp-dirs");

function state(): State {
  const holder = globalThis as unknown as Record<symbol, State | undefined>;
  return holder[KEY] ??= { registered: new Set(), watches: new Set(), installed: false };
}

// 新建一个直接在 os.tmpdir() 下的目录，并登记。根 setup 文件在这个测试文件结束时删除它。
// 前缀必须以 plc- 开头，这样漏删的目录也在检查范围里；前缀只能是一个目录名的开头。
export function tempDir(prefix = PREFIX): string {
  if (!VALID_PREFIX.test(prefix) || prefix.includes("..")) {
    throw new Error(`tempDir needs a prefix that starts with ${PREFIX} and names one folder, got ${JSON.stringify(prefix)}`);
  }
  const dir = mkdtempSync(join(tmpdir(), prefix));
  state().registered.add(dir);
  return dir;
}

// 删除登记的目录。删不掉的目录（例如权限被测试改掉）留在磁盘上，由 expectTempDirsRemoved 报告。
export function removeTempDirs(): void {
  const { registered } = state();
  for (const dir of [...registered]) {
    registered.delete(dir);
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // 留给检查报告。
    }
  }
}

// 不再管登记的目录，也不删除。测试启动的进程还在时用：进程可能还在用这些目录，以后的测试文件也不能删除它们。
export function keepTempDirs(): string[] {
  const { registered } = state();
  const kept = [...registered];
  registered.clear();
  return kept;
}

export function watchTempDirs(): TempDirWatch {
  install();
  const created = new Map<string, string>();
  const { watches } = state();
  watches.add(created);
  return {
    left: () => [...created].filter(([path]) => existsSync(path)).map(([path, createdAt]) => ({ path, createdAt })),
    stop: () => {
      watches.delete(created);
    },
  };
}

// 还有留下的目录时抛出错误，列出每个目录和新建它的位置。只报告，不删除。
// kept 是 keepTempDirs 留下的目录：测试启动的进程还在，所以没有删除。报告里注明这一点。
export function expectTempDirsRemoved(
  watch: TempDirWatch,
  options: { owner?: string; kept?: readonly string[] } = {},
): void {
  const left = watch.left();
  if (!left.length) return;
  const kept = new Set((options.kept ?? []).map((dir) => resolve(dir)));
  throw new Error([
    `${options.owner ?? "the test"} left ${left.length} plc-* temp folder(s) under ${tmpdir()}; `
      + "make them with tempDir() from @pi-lead-child/core/testing, or remove them in the test:",
    ...left.map((dir) => [
      `  ${dir.path}${kept.has(dir.path) ? " (kept: a process that the test started is still running)" : ""}`,
      `    created at ${dir.createdAt}`,
    ].join("\n")),
  ].join("\n"));
}

let cachedTmp: { dir: string; spellings: Set<string> } | null = null;

// os.tmpdir() 的两种写法：macOS 的 /var 是 /private/var 的符号链接。
function tmpSpellings(): Set<string> {
  const dir = resolve(tmpdir());
  if (cachedTmp?.dir !== dir) {
    let real = dir;
    try {
      real = realpathSync(dir);
    } catch {
      // 不存在时只认 tmpdir() 的写法。
    }
    cachedTmp = { dir, spellings: new Set([dir, real]) };
  }
  return cachedTmp.spellings;
}

function caller(): string {
  const frames = (new Error().stack ?? "").split("\n").slice(1).map((line) => line.trim().replace(/^at\s+/, ""));
  return frames.find((frame) => !frame.includes(THIS_FILE) && !frame.includes("node:")) ?? "unknown";
}

function note(created: unknown): void {
  const { watches } = state();
  if (!watches.size) return;
  const path = pathOf(created);
  if (!path || !basename(path).startsWith(PREFIX) || !tmpSpellings().has(dirname(path))) return;
  const createdAt = caller();
  for (const watch of watches) watch.set(path, createdAt);
}

function pathOf(value: unknown): string | null {
  if (typeof value === "string") return resolve(value);
  if (value instanceof URL && value.protocol === "file:") return fileURLToPath(value);
  if (Buffer.isBuffer(value)) return resolve(value.toString());
  return null;
}

function recursive(options: unknown): boolean {
  return typeof options === "object" && options !== null && (options as { recursive?: unknown }).recursive === true;
}

// mkdir 新建的最上层目录：recursive 时是返回值（已经存在时是 undefined），否则是参数里的路径。
function mkdirCreated(result: unknown, args: unknown[]): unknown {
  return recursive(args[1]) ? result : args[0];
}

type Callable = (...args: unknown[]) => unknown;

// 包装 node:fs 的 mkdtemp 和 mkdir（同步、回调、promise 三种），再同步 ESM 的具名导出。
// 测试文件用 import { mkdtempSync } from "node:fs" 拿到的也是包装后的函数。包装只记录，不改变行为。
function install(): void {
  const current = state();
  if (current.installed) return;
  current.installed = true;
  const fs = createRequire(import.meta.url)("node:fs") as Record<string, unknown> & { promises: Record<string, unknown> };
  const original = {
    mkdtempSync: fs.mkdtempSync as Callable,
    mkdirSync: fs.mkdirSync as Callable,
    mkdtemp: fs.mkdtemp as Callable,
    mkdir: fs.mkdir as Callable,
    mkdtempPromise: fs.promises.mkdtemp as Callable,
    mkdirPromise: fs.promises.mkdir as Callable,
  };
  // 回调形式：最后一个参数是回调，成功时第二个参数是新建的目录（mkdir recursive 时）。
  const withCallback = (call: Callable, created: (value: unknown, args: unknown[]) => unknown): Callable =>
    function (this: unknown, ...args: unknown[]) {
      const callback = args.at(-1);
      if (typeof callback !== "function") return call.apply(this, args);
      return call.apply(this, [...args.slice(0, -1), (error: unknown, value: unknown) => {
        if (!error) note(created(value, args));
        (callback as Callable)(error, value);
      }]);
    };
  fs.mkdtempSync = function (this: unknown, ...args: unknown[]) {
    const dir = original.mkdtempSync.apply(this, args);
    note(dir);
    return dir;
  };
  fs.mkdirSync = function (this: unknown, ...args: unknown[]) {
    const result = original.mkdirSync.apply(this, args);
    note(mkdirCreated(result, args));
    return result;
  };
  fs.mkdtemp = withCallback(original.mkdtemp, (value) => value);
  fs.mkdir = withCallback(original.mkdir, mkdirCreated);
  fs.promises.mkdtemp = async function (this: unknown, ...args: unknown[]) {
    const dir = await original.mkdtempPromise.apply(this, args);
    note(dir);
    return dir;
  };
  fs.promises.mkdir = async function (this: unknown, ...args: unknown[]) {
    const result = await original.mkdirPromise.apply(this, args);
    note(mkdirCreated(result, args));
    return result;
  };
  syncBuiltinESMExports();
}

// 测试用：找出测试启动、还活着的进程，并在测试结束时检查它们都已经退出。
// 起因：重启接管的测试（工单 15）每次全量运行都留下垫片和 fake CLI，三天里积累了 82 个孤儿进程，测试照样通过。
//
// 有两种认法。
// testProcesses：按测试自己用 mkdtemp 新建的目录认进程。这些进程一定属于这个测试，所以检查失败时可以停止它们。
// - 垫片的 cwd 是数据目录里的启动目录。
// - fake CLI 的命令行里有工作目录（codex 的 --cd）或 session 目录（pi 的 --session-dir）。
// - fake daemon 的命令行里有数据目录（测试启动它时放进去）。
// cwd 或命令行指向这些目录的 node 进程属于这个测试，它们的子孙进程和它们领头的进程组也属于这个测试。
// 只从 node 进程开始认，所以打开测试文件的编辑器或 tail 不会被认进来。
// scriptProcesses：按 node 运行的脚本认进程，给根 vitest 配置的兜底检查用（vitest.setup.ts）。
// 同一个脚本也可能由别人运行（同一个 checkout 里的另一个 vitest、源码模式的 daemon），所以这种认法只用来报告，不停止进程。
// macOS 的 ps 读不到别的进程的环境变量，所以两种认法都不用环境变量做标记。
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export interface TestProcess {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
  cwd: string | null;
}

type ProcessRow = Omit<TestProcess, "cwd">;

function run(file: string, args: string[]): string {
  try {
    return execFileSync(file, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch (error) {
    // lsof 有进程读不到时退出码是 1，但已经读到的部分照样在 stdout 里。
    const stdout = (error as { stdout?: unknown }).stdout;
    return typeof stdout === "string" ? stdout : "";
  }
}

function processRows(): ProcessRow[] {
  return run("ps", ["-axww", "-o", "pid=,ppid=,pgid=,command="]).split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4]! }] : [];
  });
}

// node 进程的 cwd。垫片和 fake CLI 都是 node 进程，别的进程靠父进程和进程组找到。
// 目录已经删除时，macOS 的 lsof 通常还报告原来的路径，但不保证，所以删除目录之前先记下进程（见 tracked）。
function nodeCwds(): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid = 0;
  for (const line of run("lsof", ["-a", "-d", "cwd", "-c", "node", "-Fpn"]).split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

// ps 把 argv 用空格连起来，所以这里按空格切分。路径里有空格的脚本因此认不出来：漏报，不会多报。
function argvOf(command: string): string[] {
  return command.split(" ").filter(Boolean);
}

function isNode(argv: readonly string[]): boolean {
  return /(?:^|\/)node$/.test(argv[0] ?? "");
}

// 带一个单独取值的 node 选项，例如 --import tsx。
const NODE_OPTIONS_WITH_VALUE = new Set([
  "--import", "--require", "-r", "--loader", "--experimental-loader", "--conditions", "-C", "--env-file", "--title", "--input-type",
]);
const TSX_CLI = /\/tsx\/dist\/cli\.mjs$|\/\.bin\/tsx$/;

// node 进程运行的脚本：跳过 node 的选项，取第一个参数。经 tsx 的命令行入口运行时，取 tsx 后面的第一个参数。
// 不是 node 进程，或者 node 运行的是 -e、-p 给出的代码时，返回 null。
export function scriptOf(command: string): string | null {
  const argv = argvOf(command);
  if (!isNode(argv)) return null;
  let viaTsx = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!viaTsx && ["-e", "--eval", "-p", "--print"].includes(arg)) return null;
    if (!viaTsx && NODE_OPTIONS_WITH_VALUE.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    if (!viaTsx && TSX_CLI.test(arg)) {
      viaTsx = true;
      continue;
    }
    return arg;
  }
  return null;
}

// 选中的进程，加上它们的子孙进程和它们领头的进程组里的进程。不含测试进程自己。
function withDescendants(rows: readonly ProcessRow[], cwds: ReadonlyMap<number, string>, seeds: ReadonlySet<number>): TestProcess[] {
  const found = new Map<number, TestProcess>();
  const add = (row: ProcessRow) => found.set(row.pid, { ...row, cwd: cwds.get(row.pid) ?? null });
  for (const row of rows) if (row.pid !== process.pid && seeds.has(row.pid)) add(row);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) {
      if (found.has(row.pid) || row.pid === process.pid) continue;
      if (found.has(row.ppid) || found.get(row.pgid)?.pgid === row.pgid) {
        add(row);
        grew = true;
      }
    }
  }
  return [...found.values()];
}

// macOS 的 /var 和 /tmp 是 /private 下的符号链接。tmpdir() 给出 /var/...，lsof 报告 /private/var/...。
// 目录可能已经删除，所以不用 realpath，直接列出两种写法。
function spellings(root: string): string[] {
  const trimmed = root.replace(/\/+$/, "");
  if (/^\/(?:var|tmp)\//.test(trimmed)) return [trimmed, `/private${trimmed}`];
  if (/^\/private\/(?:var|tmp)\//.test(trimmed)) return [trimmed, trimmed.slice("/private".length)];
  return [trimmed];
}

// path 是 root 本身或者在 root 里面。
function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

// 命令行里出现了 root：后面紧跟的不是文件名里的字符，所以 /x/plc-abc123 不会匹配 /x/plc-abc1234。
function mentions(command: string, root: string): boolean {
  for (let at = command.indexOf(root); at !== -1; at = command.indexOf(root, at + 1)) {
    if (!/[\w.-]/.test(command.charAt(at + root.length))) return true;
  }
  return false;
}

// 属于这些目录的活进程：cwd 或命令行指向这些目录的 node 进程，加上它们的子孙进程和它们领头的进程组。
export function testProcesses(roots: readonly string[]): TestProcess[] {
  const marks = roots.flatMap(spellings);
  const rows = processRows();
  const cwds = nodeCwds();
  const seeds = new Set(rows.filter((row) => {
    if (!isNode(argvOf(row.command))) return false;
    const cwd = cwds.get(row.pid);
    return marks.some((mark) => (cwd !== undefined && within(cwd, mark)) || mentions(row.command, mark));
  }).map((row) => row.pid));
  return withDescendants(rows, cwds, seeds);
}

// node 运行这些脚本之一的活进程，加上它们的子孙进程和它们领头的进程组。脚本按 scriptOf 精确比较。
// 只算本进程名下的进程：从进程往上，越过同样运行这些脚本的祖先（例如 fake CLI 的父进程是垫片），
// 第一个别的祖先是本进程或本进程的子孙，或者已经是 1（父进程已经退出的孤儿）。
// 所以另一个 vitest 或者源码模式的 daemon 正在看管的进程不算。它们留下的孤儿算，因为认不出主人。
export function scriptProcesses(scripts: readonly string[]): TestProcess[] {
  const wanted = new Set(scripts);
  const rows = processRows();
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const matched = new Set(rows.filter((row) => wanted.has(scriptOf(row.command) ?? "")).map((row) => row.pid));
  const descendsFromHere = (pid: number): boolean => {
    for (let current = pid, steps = 0; current > 1 && steps < 1_000; steps += 1) {
      if (current === process.pid) return true;
      current = byPid.get(current)?.ppid ?? 0;
    }
    return false;
  };
  const owned = (pid: number): boolean => {
    let parent = byPid.get(pid)?.ppid ?? 0;
    while (matched.has(parent)) parent = byPid.get(parent)?.ppid ?? 0;
    return parent === 1 || descendsFromHere(parent);
  };
  return withDescendants(rows, new Map(), new Set([...matched].filter(owned)));
}

// 用 SIGKILL 停止这些进程。进程领头一个进程组时，停止整个组。
// 测试进程自己所在的组不动：没有 detached 的子进程和 vitest 本身都在这个组里。
export function killTestProcesses(processes: readonly TestProcess[]): void {
  const ownGroup = processRows().find((row) => row.pid === process.pid)?.pgid;
  for (const target of processes) {
    if (target.pgid === target.pid && target.pgid !== ownGroup) {
      try { process.kill(-target.pid, "SIGKILL"); } catch { /* 已经退出 */ }
    }
    try { process.kill(target.pid, "SIGKILL"); } catch { /* 已经退出 */ }
  }
}

function describeProcess(target: TestProcess): string {
  const command = target.command.length > 240 ? `${target.command.slice(0, 240)}…` : target.command;
  return `  pid=${target.pid} ppid=${target.ppid} pgid=${target.pgid} cwd=${target.cwd ?? "?"}\n    ${command}`;
}

// 进程不多时，前几次检查间隔短；之后放慢，少跑几次 ps 和 lsof。
function pollDelay(attempt: number): number {
  return Math.min(500, 50 * 2 ** attempt);
}

// 等 find 找到的进程都退出。超时后还有活着的进程时抛出错误，测试失败。
// kill 为 true 时，先强制停止这些进程，进程不会留在机器上。只有 find 找到的进程一定属于这个测试时才这样做。
export async function expectProcessesGone(
  find: () => TestProcess[],
  options: { owner?: string; timeoutMs?: number; kill?: boolean } = {},
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  let left = find();
  for (let attempt = 0; left.length && Date.now() < deadline; attempt += 1) {
    await delay(pollDelay(attempt));
    left = find();
  }
  if (!left.length) return;
  const kill = options.kill ?? true;
  if (kill) killTestProcesses(left);
  throw new Error([
    `${options.owner ?? "the test"} left ${left.length} process(es) running; ${kill ? "they are now killed" : "stop them by hand"}:`,
    ...left.map(describeProcess),
  ].join("\n"));
}

// 等这个测试的进程都退出。roots 是测试的目录。tracked 是删除目录之前记下的进程：目录删除以后，
// cwd 可能不再能按路径认出，所以按 pid 和命令行继续跟踪它们。这些进程一定属于这个测试，所以超时后停止它们。
export function expectNoTestProcesses(
  roots: readonly string[],
  options: { tracked?: readonly TestProcess[]; timeoutMs?: number } = {},
): Promise<void> {
  return expectProcessesGone(() => {
    const left = new Map(testProcesses(roots).map((target) => [target.pid, target]));
    const tracked = options.tracked ?? [];
    if (tracked.length) {
      const rows = processRows();
      for (const target of tracked) {
        if (left.has(target.pid)) continue;
        if (rows.some((row) => row.pid === target.pid && row.command === target.command)) left.set(target.pid, target);
      }
    }
    return [...left.values()];
  }, { timeoutMs: options.timeoutMs, kill: true });
}

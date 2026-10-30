// 用户登录 shell 里的 PATH 和工具目录变量（2026-10-28）。用户：「我预期 Fairy 能正常调用我本机的 CLI，各种 bash」。
// daemon 由 launchd 拉起，环境里只有系统的 PATH 加几个目录：/pkg/env/global/bin、~/go/bin、~/.cargo/bin、~/.bun/bin、
// /opt/homebrew/sbin、Python 的 bin 都没有，Lead 和执行者在里面一跑就是 command not found。
// daemon 启动时用用户的 shell 读一次（`$SHELL -ilc`，和用户开一个终端一样），补到 daemon 的环境里，Lead 的 bash 和
// child 都继承（runtime 的 environment.ts：child 继承 daemon 的全部环境）。
//   - PATH：按登录 shell 的顺序（`python3` 这类命令要和用户终端里找到的是同一个；2026-10-28 发现接在后面时 Lead 的
//     python3 是 /usr/bin 下命令行工具自带的 3.9，用户终端里是 python.org 的 3.12）。daemon 自己的 Node 和仓库的
//     node_modules/.bin 仍然排在最前；daemon 原来有、登录 shell 没有的目录接在最后。
//   - 工具目录变量（*_HOME、*_ROOT、GOPATH 这类路径、HOMEBREW_*、NVM_*、LANG）：daemon 里没有的才补。
//   - 别的变量不补，尤其是密钥（OPENAI_API_KEY 这类）和改变 CLI 行为的（ANTHROPIC_BASE_URL 这类）：并进 daemon 的环境，
//     Codex 这类执行者会从订阅登录换成按 API key 计费。
import { spawnSync } from "node:child_process";
import { delimiter, dirname } from "node:path";

const MARKER = "__PLC_LOGIN_ENV__";

// 补的变量：名字是路径或目录的，或者几个工具自己的前缀。
const TOOL_VARIABLE = /^(?:[A-Z][A-Z0-9_]*_(?:HOME|ROOT|INSTALL)|GOPATH|GOBIN|MANPATH|INFOPATH|HOMEBREW_[A-Z_]+|NVM_[A-Z_]+|PNPM_HOME|LANG|LC_[A-Z]+)$/;

/** 解析 `printf MARKER; env -0` 的输出。rc 文件可能往 stdout 打印别的东西，只认标记以后的部分。 */
export function parseLoginShellEnv(output: string): Record<string, string> | null {
  const at = output.lastIndexOf(MARKER);
  if (at < 0) return null;
  const env: Record<string, string> = {};
  for (const entry of output.slice(at + MARKER.length).split("\0")) {
    const eq = entry.indexOf("=");
    const name = entry.slice(0, eq).trim();
    if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) env[name] = entry.slice(eq + 1);
  }
  return env;
}

/**
 * 用户登录 shell 的环境。读不到（没有 shell、超时、rc 文件出错）时为 null。最多等 timeoutMs：rc 文件慢不能卡住 daemon 启动。
 * 值里可能有密钥：只给 mergeLoginShellEnv 挑选，不要整个存下或者打印。
 */
export function loginShellEnv(options: { shell?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Record<string, string> | null {
  const shell = options.shell ?? options.env?.SHELL ?? process.env.SHELL ?? "/bin/zsh";
  try {
    const result = spawnSync(shell, ["-ilc", `printf '%s' ${MARKER}; command env -0`], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: options.timeoutMs ?? 8_000,
      env: options.env ?? process.env, maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) return null;
    return parseLoginShellEnv(result.stdout);
  } catch {
    return null;
  }
}

/**
 * 把登录 shell 的 PATH 和工具目录变量补进 target（就地改），返回补了哪些名字（只有名字）。
 * PATH：daemon 自己的目录（nodeDir 和 node_modules/.bin）在前，然后按登录 shell 的顺序，daemon 原来有、登录 shell 没有的接在最后，去重。
 */
export function mergeLoginShellEnv(
  target: Record<string, string | undefined>, login: Record<string, string>, nodeDir: string = dirname(process.execPath),
): string[] {
  const merged: string[] = [];
  const current = (target.PATH ?? "").split(delimiter).filter(Boolean);
  const loginDirs = (login.PATH ?? "").split(delimiter).filter(Boolean);
  if (loginDirs.length) {
    const own = current.filter((dir) => dir === nodeDir || dir.endsWith("/node_modules/.bin"));
    const next = [...new Set([...own, ...loginDirs, ...current])].join(delimiter);
    if (next !== target.PATH) {
      target.PATH = next;
      merged.push("PATH");
    }
  }
  for (const [name, value] of Object.entries(login)) {
    if (name === "PATH" || target[name] !== undefined || !value || !TOOL_VARIABLE.test(name)) continue;
    target[name] = value;
    merged.push(name);
  }
  return merged;
}

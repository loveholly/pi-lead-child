// 在沙箱里跑 bash（lead-tools-and-routing spec D2）。pi 的 bash 工具换成这里的执行函数：命令经
// @anthropic-ai/sandbox-runtime 包一层（macOS 是 sandbox-exec，Linux 是 bubblewrap，网络走它在本进程里起的代理），
// 写的范围、不能读的路径、先放行的域名和打码的密钥都按 core 的 sandboxPolicy。Lead（daemon 进程里）和 pi 子进程
// （engine 的 extension/sandbox.ts）都用它。
// 网络全开（2026-10-28 用户）：不在先放行清单里的域名，ask 回调一律放行。仍然走沙箱的代理：打码的密钥要在代理里
// 换成真值（sandbox-runtime 的 credentials.envVars），回环和云的元数据地址照旧被代理拦下。
//
// 沙箱起不来时不退回到没有沙箱的 bash：命令直接失败，结果写明原因（spec D11：这是能力缺口，Lead 换一条路）。
// 2026-10-28 在本机核实：按调用传入的 filesystem 覆盖初始化时的写范围；代理的设置写在包装后的命令里，
// 所以环境变量可以自己过滤；子进程必须异步起（同步起会卡住同一个进程里的代理）。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { sandboxEnv, sandboxRuntimeConfig, type SandboxPolicy } from "@pi-lead-child/core";

type SandboxManagerModule = typeof import("@anthropic-ai/sandbox-runtime");

let manager: SandboxManagerModule["SandboxManager"] | null = null;
// 一个进程只初始化一次（SandboxManager 是单例，网络代理也只起一次）。结果是 null（可以用）或者不能用的原因。
let ready: Promise<string | null> | null = null;

// 不在先放行清单里的域名：放行（见文件头）。
const allowEveryHost = async (): Promise<boolean> => true;

/** 初始化沙箱。网络、打码的密钥在这里定，每次调用的写范围另传。返回 null 表示可以用，否则是不能用的原因。 */
export function initSandbox(policy: SandboxPolicy): Promise<string | null> {
  if (ready) return ready;
  ready = (async () => {
    try {
      const module = await import("@anthropic-ai/sandbox-runtime") as SandboxManagerModule;
      const candidate = module.SandboxManager;
      if (!candidate.isSupportedPlatform()) return `这个系统（${process.platform}）不支持沙箱`;
      await candidate.initialize(sandboxRuntimeConfig(policy) as Parameters<typeof candidate.initialize>[0], allowEveryHost);
      manager = candidate;
      return null;
    } catch (error) {
      return `沙箱起不来：${error instanceof Error ? error.message : String(error)}`;
    }
  })();
  return ready;
}

/** 测试用：关掉沙箱（代理、临时 CA），下一条命令按新的 policy 重新初始化。 */
export async function resetSandboxForTests(): Promise<void> {
  const current = manager;
  ready = null;
  manager = null;
  await current?.reset();
}

function kill(pid: number | undefined, child: { kill: (signal: NodeJS.Signals) => boolean }): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/**
 * pi bash 工具的执行函数：每条命令按 policy() 当时给出的范围包进沙箱。policy 每次调用重新取：Lead 能写的 worktree
 * 会变。沙箱不能用时命令失败，错误里写明原因。
 */
export function sandboxedBashOperations(policy: () => SandboxPolicy): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (!existsSync(cwd)) throw new Error(`工作目录不存在：${cwd}`);
      const current = policy();
      const problem = await initSandbox(current);
      if (problem || !manager) {
        throw new Error(`${problem ?? "沙箱不能用"}。命令没有运行（没有沙箱时不跑命令）。换一条路：派子 agent，或者告诉用户。`);
      }
      const config = sandboxRuntimeConfig(current);
      const wrapped = await manager.wrapWithSandboxArgv(
        command, undefined, { filesystem: config.filesystem } as never, signal, cwd,
      );
      return await new Promise((resolve, reject) => {
        const child = spawn(wrapped.argv[0]!, wrapped.argv.slice(1), {
          cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: sandboxEnv({ ...process.env, ...env }),
        });
        let timedOut = false;
        const timer = timeout && timeout > 0
          ? setTimeout(() => {
            timedOut = true;
            kill(child.pid, child);
          }, timeout * 1000)
          : undefined;
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        const onAbort = () => kill(child.pid, child);
        signal?.addEventListener("abort", onAbort, { once: true });
        child.on("error", (error) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        });
        child.on("close", (code, killedBy) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          if (signal?.aborted) reject(new Error("aborted"));
          else if (timedOut) reject(new Error(`timeout:${timeout}`));
          else resolve({ exitCode: code ?? (killedBy ? 128 : null) });
        });
      });
    },
  };
}

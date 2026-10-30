// pi 子进程（执行者、核查员）的沙箱扩展（lead-tools-and-routing spec D2、D15）。runtime 的 pi.ts 给每个 pi child 都加载它。
// 以前 pi 执行者的 bash 没有任何边界（带着用户账号的全部权限），核查员又完全不能跑命令。现在：
//   - bash 换成沙箱里的（engine 的 sandboxedBashOperations）：能写这次运行的工作目录（pi 进程的 cwd，就是 worktree 或检出）
//     和系统临时目录，不能读凭证。网络全开，密钥打码（沙箱里是占位值，发往绑定的主机时换成真值），见 core 的
//     sandbox-policy.ts。执行者还能连 ssh-agent（推送）。沙箱起不来时命令不跑。
//   - edit、write 和 bash 同一套边界（沙箱管不到这两个工具）。核查员本来就没有 edit、write（pi.ts 的 PI_REVIEWER_TOOL_ARGS）。
import { isAbsolute, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sandboxPolicy, sandboxToolNote, sandboxWriteBlocker } from "@pi-lead-child/core";
import { sandboxedBashOperations } from "../sandbox/bash.js";

const WRITE_TOOLS = new Set(["edit", "write"]);

function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

/** 按工作目录建扩展。pi 加载的缺省导出用 pi 进程的 cwd（就是这次运行的 worktree 或检出）。 */
export function createSandboxExtension(cwd: string): (pi: ExtensionAPI) => void {
  return (pi) => installSandbox(pi, cwd);
}

export default function sandboxExtension(pi: ExtensionAPI): void {
  installSandbox(pi, process.cwd());
}

function installSandbox(pi: ExtensionAPI, cwd: string): void {
  // runtime 的 pi.ts 写进 child 的环境。没有时按执行者算（旧的 child）。
  const role = process.env.PLC_SANDBOX_ROLE === "reviewer" ? "reviewer" : "executor";
  const policy = () => sandboxPolicy({ role, writable: [cwd], dataDir: process.env.PLC_DATA_DIR || undefined });
  const bash = createBashToolDefinition(cwd, { operations: sandboxedBashOperations(policy) });
  pi.registerTool({
    ...bash,
    description: `${bash.description}\n${sandboxToolNote(policy(), `整个 home（挡住会在沙箱外执行的地方）、工作目录（${cwd}）`)}`,
  });
  pi.on("tool_call", (event) => {
    if (!WRITE_TOOLS.has(event.toolName)) return undefined;
    const input = event.input as Record<string, unknown>;
    const raw = typeof input.path === "string" ? input.path.trim().replace(/^@/, "") : "";
    if (!raw) return undefined;
    const absolute = resolve(cwd, expandHome(raw));
    // 和 bash 的沙箱同一套边界（core 的 sandboxWriteBlocker）。
    const blocker = sandboxWriteBlocker(policy(), absolute);
    if (!blocker) return undefined;
    return { block: true, reason: `${blocker}。把要改的文件放进工作目录，或者在说明里写清楚交回。` };
  });
}

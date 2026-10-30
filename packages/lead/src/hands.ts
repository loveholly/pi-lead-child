// Lead 的动手工具（lead-tools-and-routing spec D5、D8、D13）。用户 2026-10-27：Lead 的限制太多，一条路被堵住就没有
// 备选；连 pi 的 codemode 都被堵死了，结果事情要么用户手动做，要么请 Claude Code。所以 Lead 有了：
//   - bash：在沙箱里跑（core 的 sandboxPolicy，engine 的 sandboxedBashOperations）。能写的是 Lead 的临时目录和
//     plc 的隔离 worktree，不能读凭证。网络全开，密钥打码：沙箱里是占位值，发往绑定的主机时换成真值（2026-10-28）。
//     沙箱起不来时命令不跑。
//   - edit、write：和 bash 同一套边界（core 的 sandboxWriteBlocker），不能写凭证文件。沙箱管不到这两个工具，这里用
//     tool_call 钩子检查路径。
//   - codemode：在 session.ts 里加载（pi 内置的扩展），脚本里的调用照样经过这里和别的钩子。
// 外部消息叫醒的一轮里（Slack 这类别人写的话），这三个工具不用（D8，用户 2026-10-27 的办法）：要跑命令的活派沙箱里的
// 子 agent，结果交回 Lead 审核。拒绝写明这是能力缺口，并给出下一条路（D11、D13）。
// 只读了连接结果（例如用户自己 PR 的 CI 状态）的一轮、用户本人正在说话的一轮照用（用户 2026-10-29：「起码要让 lead agent
// 有能力处理」）：命令在沙箱里跑，沙箱挡住凭证和逃出去的路，它才是边界。
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createBashToolDefinition, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { sandboxPolicy, sandboxToolNote, sandboxWriteBlocker, type SandboxPolicy } from "@pi-lead-child/core";
import { sandboxedBashOperations } from "@pi-lead-child/engine";
import type { Db } from "@pi-lead-child/store";
import { credentialPathReason, resolveLikePi } from "./credential-guard.js";
import { tildeHome } from "./home-paths.js";
import { isLiveUserTurn } from "@pi-lead-child/engine";
import { authorityTurnId, type LeadTurnOrigin } from "./turn-origin.js";

export const LEAD_HAND_TOOLS = ["bash", "edit", "write"] as const;
export const LEAD_CODEMODE_TOOL = "codemode";

/** Lead 的临时目录：写脚本、放中间结果。bash 的工作目录也在这里。 */
export function leadScratchDir(dataDir: string): string {
  return join(dataDir, "lead-scratch");
}

/** Lead 能写的地方：临时目录，加上 plc 还在用的隔离 worktree（例如给执行者装依赖、在旧代码上跑一次回归测试）。 */
export function leadWritableRoots(db: Db, dataDir: string): string[] {
  let worktrees: string[] = [];
  try {
    worktrees = (db.prepare(
      "SELECT path FROM workspaces WHERE mode = 'isolated' AND cleaned_at IS NULL"
        + " AND state NOT IN ('archived', 'released', 'failed') AND path IS NOT NULL",
    ).all() as Array<{ path: string }>).map((row) => row.path).filter((path) => isAbsolute(path));
  } catch {
    // 读不到工作区表（测试里的空库）：只有临时目录。
  }
  return [leadScratchDir(dataDir), ...worktrees];
}

export function leadSandboxPolicy(db: Db, dataDir: string): SandboxPolicy {
  return sandboxPolicy({ role: "lead", writable: leadWritableRoots(db, dataDir), dataDir });
}

/** 外部消息叫醒的一轮里不用动手工具：给模型的说明（能力缺口，写出下一条路）。 */
export const EXTERNAL_TURN_HANDS_REFUSAL = "这一轮是外部消息（例如 Slack 里别人发的话）叫醒的，你自己不跑命令、不写文件"
  + "（能力缺口，不是底线）。换一条路：要跑命令或改文件的活派轻子 agent（create_task 的 light=true，再 spawn_child），"
  + "它在沙箱里做，结果交回给你审核；"
  + "只要查东西的，用读的工具和连接工具。";

/** 外部消息叫醒的一轮里不设命令检查（watch 的 check='command'）：到点它在同一个沙箱里跑命令，和 bash 是同一件事。 */
export const EXTERNAL_TURN_WATCH_REFUSAL = "这一轮是外部消息（例如 Slack 里别人发的话）叫醒的，命令检查到点会在你的沙箱里跑命令，"
  + "和 bash 一样不设（能力缺口，不是底线）。换一条路：用 check='agent' 的子代理检查（系统会请用户确认），"
  + "或者等用户本人的一轮再设。";

/** 外部消息叫醒的一轮里不设控件的数据源：它到点也在同一个沙箱里跑命令，和命令检查是同一件事。 */
export const EXTERNAL_TURN_WIDGET_SOURCE_REFUSAL = "这一轮是外部消息（例如 Slack 里别人发的话）叫醒的，控件的数据源到点会在你的沙箱里跑命令，"
  + "和 bash 一样不设（能力缺口，不是底线）。换一条路：先建不带 source 的控件（快照），或者等用户本人的一轮再加数据源。";

/**
 * 这一轮里动手工具（bash、edit、write、命令检查、控件的数据源）能不能用。不能用的只有外部消息叫醒的一轮：交来的事件里有外部消息，
 * 或者只知道是外部的一轮、不知道来源（按外部消息算）。只读了连接结果的一轮、用户本人正在说话的一轮都能用。
 */
export function handsBlockedInTurn(origin: LeadTurnOrigin, liveUser: boolean): boolean {
  if (liveUser || !origin.external) return false;
  const sources = origin.externalBy ?? [];
  if ((origin.externalEvents?.length ?? 0) > 0 || sources.some((source) => source.via === "message")) return true;
  return sources.length === 0;
}

/** edit、write 的路径为什么不能写。可以写时返回 null。边界和 bash 的沙箱是同一份（core 的 sandboxWriteBlocker）。 */
export function leadWriteRefusal(path: string, options: { cwd: string; home: string; policy: SandboxPolicy }): string | null {
  const credential = credentialPathReason(path, { cwd: options.cwd, home: options.home });
  if (credential) return `不能写凭证：${credential}（底线）。`;
  const absolute = resolveLikePi(path, { cwd: options.cwd, home: options.home });
  const blocker = sandboxWriteBlocker(options.policy, absolute);
  return blocker ? `${blocker}（底线）。` : null;
}

export interface LeadHandsOptions {
  db: Db;
  dataDir: string;
  turnOrigin?: () => LeadTurnOrigin;
  // 这一轮的编号：用户本人正在说话的一轮不受外部内容的限制（isLiveUserTurn）。
  currentTurnId?: () => string | null;
  home?: string;
  log?: (line: string) => void;
}

/** pi 扩展：沙箱里的 bash（替换 pi 内置的），以及三个动手工具的检查。 */
export function leadHandsExtension(options: LeadHandsOptions): ExtensionFactory {
  const scratch = leadScratchDir(options.dataDir);
  const home = options.home ?? homedir();
  return (pi) => {
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    const bash = createBashToolDefinition(scratch, {
      operations: sandboxedBashOperations(() => leadSandboxPolicy(options.db, options.dataDir)),
    });
    pi.registerTool({
      ...bash,
      // 工具说明每一轮都发给模型服务商：用户目录写成 ~（home-paths.ts，用户 2026-10-30）。
      description: tildeHome(`${bash.description}\n工作目录是 ${scratch}。`
        + sandboxToolNote(leadSandboxPolicy(options.db, options.dataDir), "整个 home（挡住会在沙箱外执行的地方）、plc 的隔离 worktree")
        + "\n发评审、发消息这类写外部账号的事用连接工具：那里有你的账号和护栏。", home),
    });
    pi.on("tool_call", (event) => {
      if (!(LEAD_HAND_TOOLS as readonly string[]).includes(event.toolName)) return undefined;
      const origin = options.turnOrigin?.();
      if (origin && handsBlockedInTurn(origin, origin.external && isLiveUserTurn(
        options.db, authorityTurnId({ ...options, turnOrigin: () => origin }), "tickets:create",
      ))) {
        options.log?.(`[lead] ${event.toolName} refused in an external turn`);
        return { block: true, reason: EXTERNAL_TURN_HANDS_REFUSAL };
      }
      if (event.toolName === "bash") return undefined;
      const input = event.input as Record<string, unknown>;
      const path = typeof input.path === "string" ? input.path : "";
      if (!path.trim()) return undefined;
      const reason = leadWriteRefusal(path, { cwd: options.dataDir, home, policy: leadSandboxPolicy(options.db, options.dataDir) });
      if (!reason) return undefined;
      options.log?.(`[lead] ${event.toolName} refused outside the writable roots`);
      return { block: true, reason };
    });
  };
}

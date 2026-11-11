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
// 免沙箱（docs/ticket-246-user-turn-bypass.md，实施单 C）：开关开着、用户的一轮或系统事件叫醒的一轮（hostBypassActive）、
// 这一轮没读过外部内容、命令过了筛查器时，这一次 bash 在沙箱外跑（engine 的 hostBashOperations），结果开头写「（沙箱外）」。每次调用重新判断
// （hostCommandRoute）。开关开着但这一次退回沙箱时，结果开头写原因；开关关着时什么都不加，和以前一样。
import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createBashToolDefinition, type BashOperations, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { sandboxPolicy, sandboxPolicyAsync, sandboxToolNote, sandboxWriteBlocker, type SandboxPolicy } from "@pi-lead-child/core";
import {
  copyScreenedScripts, hostBashOperations, newHostCommandId, sandboxedBashOperations, screenHostCommand, screenReason,
  type HostCommandRecord,
} from "@pi-lead-child/engine";
import type { HostCommandVia } from "@pi-lead-child/protocol";
import type { Db } from "@pi-lead-child/store";
import { credentialPathReason, resolveLikePi } from "./credential-guard.js";
import { tildeHome } from "./home-paths.js";
import { isLiveUserTurn } from "@pi-lead-child/engine";
import { authorityTurnId, hostBypassActive, type LeadTurnOrigin, type TurnOriginDeps } from "./turn-origin.js";
import {
  bashSoftLimitMs, DEFAULT_BACKGROUND_JOB_MAX_SECONDS, newBackgroundJobId, runWithSoftLimit, type ForegroundWaits, type LeadBackgroundJobs,
} from "./background-jobs.js";

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

/** leadSandboxPolicy 的异步版：要用的 git 目录和根证书先在子进程里查好（core 的 sandboxPolicyAsync）。跑命令、写文件之前用它。 */
export function leadSandboxPolicyAsync(db: Db, dataDir: string): Promise<SandboxPolicy> {
  return sandboxPolicyAsync({ role: "lead", writable: leadWritableRoots(db, dataDir), dataDir });
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

/** 在沙箱外跑的命令，工具结果开头写这一句（设计文档 5.3）。会话里的工具行据此加标记。 */
export const HOST_RUN_MARK = "（沙箱外）";

/** 开关开着、这一次却退回了沙箱时，工具结果开头写的话。 */
export function sandboxFallbackNote(why: string): string {
  return `（沙箱里：免沙箱开着，但这一次没有用——${why}）`;
}

export type HostCommandRoute =
  // 在沙箱外跑。run 是真正跑的命令（脚本换成筛查过的副本），record 写进 host_command.started。
  | { route: "host"; run: string; record: Omit<HostCommandRecord, "cwd" | "timeoutSeconds"> }
  // 照旧：bash 在沙箱里跑，run_on_host 发确认卡。why 是开关开着时这一次没有免沙箱的原因；开关关着时为 null。
  | { route: "sandbox"; why: string | null };

type HostCommandRouteInput = {
  command: string; cwd: string; via: HostCommandVia; spendsMoney: boolean; dataDir: string; home?: string; now?: Date;
};

/**
 * 这一条命令在哪里跑（设计文档 3.1、第 4 节）：hostBypassActive 说能免沙箱，而且筛查器说 allow，才在沙箱外跑。
 * 筛查器的 floor 和 unknown 都退回今天的做法。bash 和 run_on_host 都用它，每次调用都重新算。判断本身出错时也退回。
 */
export function hostCommandRoute(db: Db, deps: TurnOriginDeps, input: HostCommandRouteInput): HostCommandRoute {
  try {
    return routeOf(db, deps, input);
  } catch (error) {
    return { route: "sandbox", why: `判断能不能免沙箱时出错（${error instanceof Error ? error.message : String(error)}）` };
  }
}

function routeOf(db: Db, deps: TurnOriginDeps, input: HostCommandRouteInput): HostCommandRoute {
  const decision = hostBypassActive(db, deps, input.now);
  if (!decision.active) return { route: "sandbox", why: decision.why };
  const home = input.home ?? homedir();
  const screen = screenHostCommand({
    command: input.command, cwd: input.cwd, allowedRoots: leadWritableRoots(db, input.dataDir), dataDir: input.dataDir, home,
    spendsMoney: input.spendsMoney,
    credentialPathReason: (path, context) => credentialPathReason(path, context),
  });
  if (screen.verdict !== "allow") {
    const reason = screenReason(screen, "zh") ?? screen.rule ?? screen.verdict;
    return { route: "sandbox", why: `命令筛查没有放行（${screen.verdict}）：${reason}` };
  }
  return {
    route: "host",
    run: screen.scripts.length ? copyScreenedScripts(input.command, screen.scripts, tmpdir()) : input.command,
    record: {
      id: newHostCommandId(), turnId: decision.turnId, turnOrigin: decision.turnOrigin,
      ...(decision.wokenBy ? { wokenBy: decision.wokenBy } : {}), via: input.via, confirmationId: null,
      command: input.command, screen: { verdict: screen.verdict, rule: screen.rule }, spendsMoney: input.spendsMoney,
    },
  };
}

/**
 * Lead 的 bash 不填 timeout 时的时限（秒）。pi 的 bash 缺省不设时限：2026-11-03 Lead 在仓库根目录跑了一条 grep -r，
 * 扫进了几十个工作树的 node_modules，15 分钟没有结束，这一轮一直停在 Running。要跑更久的命令，模型自己填 timeout。
 */
export const LEAD_BASH_DEFAULT_TIMEOUT_SECONDS = 120;

/** 没填 timeout 的命令按 seconds 秒的时限跑。到时限时 pi 结束命令，告诉模型「Command timed out after N seconds」。 */
export function withDefaultTimeout(operations: BashOperations, seconds: number): BashOperations {
  return {
    exec: (command, cwd, run) => operations.exec(command, cwd, { ...run, timeout: run.timeout ?? seconds }),
  };
}

export interface LeadHandsOptions {
  db: Db;
  dataDir: string;
  turnOrigin?: () => LeadTurnOrigin;
  // 这一轮的编号：用户本人正在说话的一轮不受外部内容的限制（isLiveUserTurn）。
  currentTurnId?: () => string | null;
  home?: string;
  log?: (line: string) => void;
  // bash 不填 timeout 时的时限（秒），缺省 LEAD_BASH_DEFAULT_TIMEOUT_SECONDS。测试用短的。
  bashTimeoutSeconds?: number;
  // 长的只读命令转后台（lead-scheduler spec D6，background-jobs.ts）：daemon 给出口。不给时 read_only 不起作用。
  backgroundJobs?: LeadBackgroundJobs;
  // 软时限（毫秒），缺省 PLC_LEAD_BASH_SOFT_MS 或 20 秒。测试用短的。
  bashSoftLimitMs?: number;
  // 用户插话时，正在等的只读命令马上转后台（background-jobs.ts 的 ForegroundWaits）。
  foregroundWaits?: ForegroundWaits;
}

/** 工具结果的第一段文字前面加一句。 */
function withLeadingNote<T extends { content: Array<{ type: string; text?: string }> }>(result: T, note: string): T {
  const index = result.content.findIndex((part) => part.type === "text");
  if (index < 0) return { ...result, content: [{ type: "text", text: note }, ...result.content] };
  const content = result.content.map((part, at) => (at === index ? { ...part, text: `${note}\n${part.text ?? ""}` } : part));
  return { ...result, content };
}

/** pi 扩展：沙箱里的 bash（替换 pi 内置的），以及三个动手工具的检查。 */
export function leadHandsExtension(options: LeadHandsOptions): ExtensionFactory {
  const scratch = leadScratchDir(options.dataDir);
  const home = options.home ?? homedir();
  const timeoutSeconds = options.bashTimeoutSeconds ?? LEAD_BASH_DEFAULT_TIMEOUT_SECONDS;
  return (pi) => {
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    const sandboxed = sandboxedBashOperations(() => leadSandboxPolicyAsync(options.db, options.dataDir));
    const bash = createBashToolDefinition(scratch, { operations: withDefaultTimeout(sandboxed, timeoutSeconds) });
    pi.registerTool({
      ...bash,
      // pi 的参数说明写着「没有缺省时限」：换成 Lead 的缺省，模型才知道长命令要自己填。
      parameters: Type.Object({
        command: Type.String({ description: "Shell command to execute" }),
        timeout: Type.Optional(Type.Number({
          description: `Timeout in seconds. Without it, the command stops after ${timeoutSeconds} seconds.`,
        })),
        spends_money: Type.Optional(Type.Boolean({
          description: "true when you think the command spends money (cloud resources, paid APIs, deploys).",
        })),
        read_only: Type.Optional(Type.Boolean({
          description: "true when the command only reads or is safe to run again (grep, find, tests, builds, reading a system). "
            + "If it still runs after about 20 seconds, it moves to the background and you get its output in a later event. "
            + "Leave it out for a command that changes anything.",
        })),
      }),
      // 每次调用按这一次的命令和目录选沙箱或主机（hostCommandRoute）。pi 的 bash 工具照旧管输出、截断和错误写法。
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        let note: string | null = null;
        const routed: BashOperations = {
          exec: (command, cwd, run) => {
            const route = hostCommandRoute(options.db, options, {
              command, cwd, via: "bash", spendsMoney: (params as { spends_money?: unknown }).spends_money === true,
              dataDir: options.dataDir, home,
            });
            if (route.route === "sandbox") {
              note = route.why ? sandboxFallbackNote(route.why) : null;
              return sandboxed.exec(command, cwd, run);
            }
            note = HOST_RUN_MARK;
            options.log?.(`[lead] bash runs outside the sandbox (${route.record.id})`);
            return hostBashOperations(options.db, { record: route.record, dataDir: options.dataDir }).exec(route.run, cwd, run);
          },
        };
        // 只读的命令（read_only）：过了软时限还没结束就转后台（lead-scheduler spec D6）。它最多跑 timeout 或 30 分钟。
        const jobs = options.backgroundJobs;
        if (jobs && (params as { read_only?: unknown }).read_only === true) {
          const longCall = createBashToolDefinition(scratch, { operations: withDefaultTimeout(routed, DEFAULT_BACKGROUND_JOB_MAX_SECONDS) });
          const result = await runWithSoftLimit({
            softMs: options.bashSoftLimitMs ?? bashSoftLimitMs(), stepSignal: signal, jobs,
            ...(options.foregroundWaits ? { waits: options.foregroundWaits } : {}),
            job: { id: newBackgroundJobId(), tool: "bash", command: String((params as { command?: unknown }).command ?? "").slice(0, 300), toolCallId },
            run: async (jobSignal) => {
              try {
                return await longCall.execute(toolCallId, params, jobSignal, undefined, ctx);
              } catch (error) {
                return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
              }
            },
          });
          if (result.isError) throw new Error(`${note ? `${note}\n` : ""}${result.content.map((part) => part.text ?? "").join("\n")}`);
          return (note ? withLeadingNote(result, note) : result) as Awaited<ReturnType<typeof longCall.execute>>;
        }
        const call = createBashToolDefinition(scratch, { operations: withDefaultTimeout(routed, timeoutSeconds) });
        try {
          const result = await call.execute(toolCallId, params, signal, onUpdate, ctx);
          return note ? withLeadingNote(result, note) : result;
        } catch (error) {
          if (!note || !(error instanceof Error)) throw error;
          throw new Error(`${note}\n${error.message}`);
        }
      },
      // 工具说明每一轮都发给模型服务商：用户目录写成 ~（home-paths.ts，用户 2026-10-30）。
      description: tildeHome(`${bash.description}\n工作目录是 ${scratch}。`
        + `不填 timeout 时，命令跑到 ${timeoutSeconds} 秒就结束；要跑更久的命令（装依赖、跑测试）自己填 timeout。`
        + (options.backgroundJobs ? "只读或可以重跑的命令（搜索、跑测试、构建、查外部系统）标 read_only=true：跑过 20 秒还没完就转后台，结束时系统把输出交给你，这期间用户的消息能送到你这里。改东西的命令不要标。" : "")
        + "在仓库里找文件、搜代码用 find、grep 工具，读已知的文件用 read：它们按 .gitignore 跳过 node_modules 这类目录。"
        + "bash 里的 grep -r、find 不会跳过它们，在大仓库里会跑很久。"
        + sandboxToolNote(leadSandboxPolicy(options.db, options.dataDir), "整个 home（挡住会在沙箱外执行的地方）、plc 的隔离 worktree")
        + "\n发评审、发消息这类写外部账号的事用连接工具：那里有你的账号和护栏。", home),
    });
    pi.on("tool_call", async (event) => {
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
      const reason = leadWriteRefusal(path, { cwd: options.dataDir, home, policy: await leadSandboxPolicyAsync(options.db, options.dataDir) });
      if (!reason) return undefined;
      options.log?.(`[lead] ${event.toolName} refused outside the writable roots`);
      return { block: true, reason };
    });
  };
}

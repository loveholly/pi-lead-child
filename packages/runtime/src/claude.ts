import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";
import { AsyncEventQueue, RuntimeEventSequencer } from "./event-queue.js";
import type {
  AgentRuntime,
  RuntimeCapabilities,
  RuntimeEventInput,
  RuntimeExit,
  RuntimeHandle,
  RuntimePreflightRequest,
  RuntimeProbeRequest,
  RuntimeProbeResult,
  RuntimeAttachRequest,
  RuntimeStartRequest,
} from "./types.js";
import {
  probeMcpServer, runInstallChecks, statusJson, type McpServerCommand, type ProbeCommand, type ProbeStep, type ProbeStepOutput,
} from "./probe.js";
import type { RuntimeAdapter, RuntimeEnv } from "./types.js";
import { findRuntimeExecutable, resolveRuntimeExecutable } from "./executable.js";
import { claudeModelsFromHelp, cliEffortValue, runDiscoveryCommand, type ModelDiscovery } from "./model-discovery.js";
import {
  matchProviderFailure, residualFailureCode, typedFailure, type FailureEvidence,
} from "./typed-failure.js";
import {
  agentMcpServer, claudeSandboxSettings, dataDir, sandboxCacheEnv, sandboxPolicy, sandboxTrustEnv, type TypedFailure,
  warmGitDirs, warmSandboxTrustBundle,
} from "@pi-lead-child/core";
import { adapterProfile, type RuntimeProfile } from "./profile.js";
import { childEnvironment } from "./environment.js";
import { claudeChildSkillArgs, defaultChildSkillsRoot } from "./child-skills.js";
import { attachProcess, launchProcess, type LaunchedProcess } from "./launcher.js";

const MAX_MALFORMED_LINES = 8;
const MAX_LINE_LENGTH = 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 2_000;
// 核查员的内置工具：读代码，加上沙箱里的 Bash（lead-tools-and-routing spec D15），能装依赖、能跑测试。
// 没有 Edit、Write：它不改交付。Bash 写到工作区里的改动，核查前后的工作区指纹比对会发现。
const REVIEW_TOOLS = "Read,Glob,Grep,Bash";
const MAX_STDERR_TAIL_CHARS = 16_000;
// 内核给 agent 的工具通道在 --mcp-config 里叫这个名字。
const TOOL_CHANNEL_SERVER = "plc";
// MCP 服务器的启动时限（工单 #113）。官方文档（https://code.claude.com/docs/en/env-vars）：
// 「MCP_TIMEOUT: Timeout in milliseconds for MCP server startup (default: 30000, or 30 seconds)」。
// 2026-11-06 机器很忙时，plc 握手用了 31–59 秒，30 秒的默认值不够；空闲时 1–2 秒。所以放到 90 秒。
const DEFAULT_MCP_TIMEOUT_MS = 90_000;

// 带 plc 工具通道启动 CLI 时补上的 MCP_TIMEOUT。用户自己设了的（daemon 的环境、adapter 或请求的 env）不改。
// 用户在 Claude Code 的 settings.json 的 env 里设的值由 CLI 自己读，这里看不到，也不覆盖它。
export function claudeMcpTimeoutEnv(env: Record<string, string | undefined>): Record<string, string> {
  return env.MCP_TIMEOUT?.trim() ? {} : { MCP_TIMEOUT: String(DEFAULT_MCP_TIMEOUT_MS) };
}

// child 实际收到的 MCP 启动时限，毫秒。认不出时按默认值。
export function claudeMcpTimeoutMs(env: Record<string, string | undefined>): number {
  const value = Number(env.MCP_TIMEOUT?.trim());
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MCP_TIMEOUT_MS;
}

// executor 和核查员的命令在 Claude Code 自带的沙箱里跑（lead-tools-and-routing spec D2、D15；buildArgs 的 --settings）：
// 沙箱里的 Bash 不用审批，所以这份清单只在沙箱起不来时有用（Claude Code 回到普通的许可判断）。
// executor 在用户自己的设置之外得到的命令许可（spec D6，工单 11）。
// 用户的设置照常加载。--allowedTools 只追加规则，不替换用户的规则。
// 清单只放项目的校验命令：测试、类型检查、提交前检查和只读的 git。规则写法按 Claude Code 2.1.258 核实：
// - "x *" 按词边界匹配，也匹配不带参数的 x。"x*" 是纯前缀匹配，用来覆盖 test:unit 这类脚本名。
// - 前缀规则不分析参数。所以 git 只给不带参数的写法：git 的一些参数能写文件，例如 git diff --output。
//   带参数的只读 git 命令由 Claude Code 自带的只读校验放行，不需要规则。
// - 不给 npx：本地没有对应的包时，npx 会下载并执行它。
// 用户的 rtk hook（`rtk hook claude`）把命令改写成 `rtk …`，Claude Code 按改写后的命令判权限（2026-10-21，Run #118）。
// 所以每条校验命令也给出 rtk 0.37.1 改写后的形式。npm test 不被改写。
// npm run lint 改写成 rtk lint。rtk lint 把第一个参数当程序运行，只要它不以 - 开头、不含 / 和 .：
// `rtk lint sh -c …` 会执行命令。所以只给不带参数的 rtk lint 和 `rtk lint -- -…`（npm run lint -- --fix 的改写）。
// 只读命令也被改写，改写后 Claude Code 自带的只读放行不认得它们。带参数的只读 git（例如 git status --short）也因此被拒。
// 只给 rtk ls：它只列出名字，不执行参数。前缀规则不看参数，所以它也能列出工作区以外的目录。
// 不给 rtk grep 和 rtk read（2026-10-21 的独立审查）：
// - rtk grep 把多余的参数转给 ripgrep。装了 rg 时，--pre 对每个文件执行程序。
// - rtk read 能一步读工作区以外的文件。读文件用内置的 Read 工具，它有工作区的限制。
// 2026-10-28：沙箱放行的 Bash 里不包括 git commit（Claude Code 2.1.311 在沙箱里仍要审批它，本机用 -p 核实）。执行者要在
// 自己的分支上提交、推送，所以明确放行 git add、git commit、git push 和 rtk 改写后的形式（用户 2026-10-28：「推代码本身
// 也没什么问题」）。它们照样在沙箱里跑：只能写这次运行的 worktree 和它的 git 目录，git 的 hooks 和 config 写不了；
// 推送经用户的 ssh-agent，读不到私钥（core 的 sandboxPolicy）。
const CLAUDE_EXECUTOR_ALLOWED_TOOLS: readonly string[] = [
  "Bash(git add *)",
  "Bash(git commit *)",
  "Bash(git push *)",
  "Bash(rtk git add *)",
  "Bash(rtk git commit *)",
  "Bash(rtk git push *)",
  "Bash(npm test *)",
  "Bash(npm run test*)",
  "Bash(npm run typecheck*)",
  "Bash(npm run lint*)",
  "Bash(npm run verify*)",
  "Bash(git status)",
  "Bash(git diff)",
  "Bash(git diff --check)",
  "Bash(git log)",
  "Bash(rtk npm run test*)",
  "Bash(rtk npm run typecheck*)",
  "Bash(rtk npm run lint*)",
  "Bash(rtk lint)",
  "Bash(rtk lint -- -*)",
  "Bash(rtk npm run verify*)",
  "Bash(rtk git status)",
  "Bash(rtk git diff)",
  "Bash(rtk git diff --check)",
  "Bash(rtk git log)",
  "Bash(rtk ls *)",
];

// 执行者和核查员的许可模式。PLC_CLAUDE_PERMISSION_MODE 用来在 auto 不能用的账号上退回 acceptEdits。
const CLAUDE_PERMISSION_MODES = new Set(["auto", "acceptEdits", "default", "dontAsk", "bypassPermissions"]);

export function claudePermissionMode(env: Record<string, string | undefined> = process.env): string {
  const configured = env.PLC_CLAUDE_PERMISSION_MODE?.trim();
  return configured && CLAUDE_PERMISSION_MODES.has(configured) ? configured : "auto";
}

export interface ClaudeRuntimeOptions {
  bin?: string;
  prefixArgs?: string[];
  env?: Record<string, string>;
  killGraceMs?: number;
  // PLC 内置给 child 的 skill（child-skills.ts）的根目录。不给时用 engine 的 src/child-skills，null 表示不加载。
  childSkillsRoot?: string | null;
  // 探针拉起的 plc MCP 服务器（工单 #113）。不给时用执行时的同一个（core 的 agentMcpServer），null 表示探针不检查它。
  toolChannelServer?: McpServerCommand | null;
}

interface ResultState {
  ok: boolean;
  errorCode: string | null;
  errorMessage: string | null;
}

// 一个进程或一次响应的用量，分成计费不同的四部分（ADR 0001）。cacheWrite1h 是 cacheWrite 里 1 小时的那部分，只用来按价目分成本，不报出去。
interface UsageParts {
  uncached: number;
  cacheWrite: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
}

// 报给 usage.updated 的形状：inputTokens 照旧含缓存读写，另外报其中的缓存读、缓存写。
interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

// 一条 result 里一组按模型给的用量（modelUsage 或 model_usage_since_last_result）的合计。
interface ModelUsageTotal {
  parts: UsageParts;
  costUsd: number | null;
}

// 一个 Claude 进程的用量（工单 #102，2026-10-21）。规则按 Run #118 的原始输出核对（Claude Code 2.1.258）：
// - stream-json 把一次 API 响应按内容块拆成几行 assistant。每行带同一份 usage，output_tokens 只是流开始时的值。
//   所以按 parent_tool_use_id 和 message.id 去重，一次响应只算一次。后台子 agent 的响应也在这些行里。
// - result.usage 只算本回合的主线程，不是进程的累计。一个进程可以有几个回合，例如后台任务的通知开了新回合。
// - result.modelUsage 是整个会话的累计，含子 agent，和 total_cost_usd 对得上。
// - 续接的进程（--resume）：Claude Code 把被续接会话存下的累计恢复进来，modelUsage 和 total_cost_usd 是
//   「以前的进程 + 这个进程」（Claude Code 2.1.318 实测；#180 的 Run #306 只调了 2 次 API，记成了 2 亿）。
// - result.model_usage_since_last_result（2.1.318 有）：上一条 result 以后这个进程的用量，不含恢复进来的那份。
//   有它时，进程的总量是各条 result 的它之和，这是权威的数。
// 运行中报去重后的估计（输出偏少），result 到了用上面的总量替换它。两种都按 cumulative 报。
// 没有 model_usage_since_last_result 的旧版本：没续接时用 modelUsage；续接时第一条 result 定下恢复进来的那份
// （modelUsage 减去这个进程自己的用量），以后每条都减去它。都没有时取估计和各回合 result.usage 之和里较大的那个。
class ClaudeUsageLedger {
  // 最近一条 result 给出的总量，和它已经包含的响应。
  private settled: UsageParts = emptyParts();
  private settledCost: number | null = null;
  private readonly settledResponses = new Set<string>();
  // 最近一条 result 之后的响应。
  private readonly pending = new Map<string, UsageParts>();
  private turns: UsageParts = emptyParts();
  // 各条 result 的 model_usage_since_last_result 之和。
  private sinceTotal: ModelUsageTotal | null = null;
  // 续接时恢复进来的那份（旧版本的兜底）。第一条 result 时定下。
  private restored: ModelUsageTotal | null = null;

  constructor(private readonly resumed: boolean) {}

  // 一行 assistant。总量变了时返回新的总量。
  response(key: string, usage: UsageParts | null): NormalizedUsage | null {
    if (!usage || this.settledResponses.has(key)) return null;
    const previous = this.pending.get(key);
    const merged = previous ? largerParts(previous, usage) : usage;
    if (previous && sameParts(merged, previous)) return null;
    this.pending.set(key, merged);
    return reported(this.running());
  }

  // 一条 result。返回进程到目前的总量和成本。
  result(input: {
    turn: UsageParts | null;
    session: ModelUsageTotal | null;
    sinceLast: ModelUsageTotal | null;
    totalCostUsd: number | null;
  }): NormalizedUsage & { costUsd: number | null } {
    const { turn, session, sinceLast } = input;
    if (turn) this.turns = addParts(this.turns, turn);
    if (sinceLast) {
      this.sinceTotal = addModelUsage(this.sinceTotal, sinceLast);
      this.settled = this.sinceTotal.parts;
      this.settledCost = this.sinceTotal.costUsd;
    } else if (session && this.resumed) {
      // 这个进程自己到这条 result 的用量：本回合主线程的 result.usage，加上子 agent 的响应（键以 parent_tool_use_id 开头）。
      if (!this.restored) {
        let own = turn ?? emptyParts();
        for (const [key, usage] of this.pending) if (!key.startsWith(":")) own = addParts(own, usage);
        this.restored = restoredShare(session, own, input.totalCostUsd);
      }
      this.settled = subtractParts(session.parts, this.restored.parts);
      const cost = input.totalCostUsd ?? session.costUsd;
      this.settledCost = cost === null ? null : Math.max(0, cost - (this.restored.costUsd ?? 0));
    } else if (session) {
      this.settled = session.parts;
      this.settledCost = input.totalCostUsd ?? session.costUsd;
    } else {
      this.settled = largerTotal(this.running(), this.turns);
      this.settledCost = input.totalCostUsd;
    }
    for (const key of this.pending.keys()) this.settledResponses.add(key);
    this.pending.clear();
    return { ...reported(this.settled), costUsd: this.settledCost };
  }

  private running(): UsageParts {
    let total = this.settled;
    for (const usage of this.pending.values()) total = addParts(total, usage);
    return total;
  }
}

// 恢复进来的那份：会话的累计减去这个进程自己的用量。成本按价目的比例分：缓存读是未缓存输入的 0.1 倍，
// 5 分钟缓存写 1.25 倍，1 小时缓存写 2 倍，输出 5 倍（实测的两个进程都精确对得上）。几个模型时按合计分，是近似。
function restoredShare(session: ModelUsageTotal, own: UsageParts, totalCostUsd: number | null): ModelUsageTotal {
  const parts = subtractParts(session.parts, own);
  parts.cacheWrite1h = Math.min(parts.cacheWrite1h, parts.cacheWrite);
  const cost = totalCostUsd ?? session.costUsd;
  const weight = priceWeight(session.parts);
  return { parts, costUsd: cost === null || weight === 0 ? null : cost * (priceWeight(parts) / weight) };
}

function priceWeight(parts: UsageParts): number {
  const write5m = Math.max(0, parts.cacheWrite - parts.cacheWrite1h);
  return parts.uncached + 1.25 * write5m + 2 * parts.cacheWrite1h + 0.1 * parts.cacheRead + 5 * parts.output;
}

function emptyParts(): UsageParts {
  return { uncached: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 };
}

const PART_KEYS = ["uncached", "cacheWrite", "cacheWrite1h", "cacheRead", "output"] as const;

function combineParts(left: UsageParts, right: UsageParts, combine: (a: number, b: number) => number): UsageParts {
  const parts = emptyParts();
  for (const key of PART_KEYS) parts[key] = combine(left[key], right[key]);
  return parts;
}

function addParts(left: UsageParts, right: UsageParts): UsageParts {
  return combineParts(left, right, (a, b) => a + b);
}

function largerParts(left: UsageParts, right: UsageParts): UsageParts {
  return combineParts(left, right, Math.max);
}

function subtractParts(left: UsageParts, right: UsageParts): UsageParts {
  return combineParts(left, right, (a, b) => Math.max(0, a - b));
}

// 估计和各回合之和里较大的那个（旧版本的兜底）：输入的几部分一起取输入较大的那边，输出取较大的。
function largerTotal(left: UsageParts, right: UsageParts): UsageParts {
  const input = (parts: UsageParts) => parts.uncached + parts.cacheWrite + parts.cacheRead;
  return { ...(input(left) >= input(right) ? left : right), output: Math.max(left.output, right.output) };
}

function sameParts(left: UsageParts, right: UsageParts): boolean {
  return PART_KEYS.every((key) => left[key] === right[key]);
}

function addModelUsage(left: ModelUsageTotal | null, right: ModelUsageTotal): ModelUsageTotal {
  if (!left) return right;
  const costUsd = left.costUsd === null && right.costUsd === null ? null : (left.costUsd ?? 0) + (right.costUsd ?? 0);
  return { parts: addParts(left.parts, right.parts), costUsd };
}

function reported(parts: UsageParts): NormalizedUsage {
  const inputTokens = parts.uncached + parts.cacheWrite + parts.cacheRead;
  return {
    inputTokens,
    outputTokens: parts.output,
    totalTokens: inputTokens + parts.output,
    cacheReadTokens: parts.cacheRead,
    cacheWriteTokens: parts.cacheWrite,
  };
}

type JsonRecord = Record<string, unknown>;

// Claude 把失败写在 result 消息里（errors 或 result 文本），那段文本是终止原因。
// 认证、余额这类 API 错误也走这条路：result 的 subtype 仍是 success，只是 is_error 为 true。
export function classifyClaudeFailure(evidence: FailureEvidence): TypedFailure {
  // agent 用完了回合数：它确实在做任务，只是没做完。
  if (evidence.errorCode === "claude_error_max_turns") return typedFailure("task_failed", evidence);
  if (evidence.errorCode === "claude_tool_channel_unavailable" || evidence.errorCode === "claude_tool_channel_timeout") {
    return typedFailure("tool_channel_unavailable", evidence);
  }
  if (SESSION_NOT_FOUND.test(evidence.message ?? "")) return typedFailure("session_not_found", evidence);
  if (MODEL_NOT_AVAILABLE.test(evidence.message ?? "")) return typedFailure("model_unsupported", evidence);
  return typedFailure(matchProviderFailure(evidence.message) ?? residualFailureCode(evidence), evidence);
}

// --resume 的会话已经不存在：Claude Code 按保留期删了它的记录（工单 #66 的 Run #71）。
// 文本取自 Claude Code 2.1.258 二进制里的字符串，和 Run #71 的输出一致。--fork-session 也报这一句。
// 这时 CLI 没有初始化会话：result 的 subtype 是 error_during_execution，errors 里就是这一句。
const SESSION_NOT_FOUND = /No conversation found with session ID/i;

// Claude Code 自己写的模型错误：模型不存在，或者这个账号、这个部署用不了它。
// 文本取自 Claude Code 2.1.258 二进制里的字符串（工单 13）。通用的 provider 诊断认不出这两句。
const MODEL_NOT_AVAILABLE = /issue with the selected model|is not available on your [^\n]{0,40}deployment/i;

// plc 工具通道是否就绪（工单 05）。字段按 Claude Code 2.1.258 核实：init 事件的 mcp_servers 是
// { name, status } 的数组，status 取 connected、failed、needs-auth、pending、disabled；
// 配置校验失败的服务器另列在 mcp_server_errors 里。只有 connected 算就绪。
// plc 设了 alwaysLoad，CLI 在会话开始前就连接它，所以 pending 也说明它没有连上。
export function toolChannelProblem(init: JsonRecord): string | null {
  const server = TOOL_CHANNEL_SERVER;
  const records = (value: unknown) => (Array.isArray(value) ? value.map(jsonRecord) : []);
  if (records(init.mcp_server_errors).some((entry) => entry?.name === server)) {
    return `MCP 服务器 ${server} 的配置无效，plc 工具通道没有就绪`;
  }
  const entry = records(init.mcp_servers).find((candidate) => candidate?.name === server);
  if (!entry) return `初始化事件里没有 MCP 服务器 ${server}，plc 工具通道没有就绪`;
  const status = stringValue(entry.status) ?? "unknown";
  return status === "connected" ? null : `MCP 服务器 ${server} 的状态是 ${status}，plc 工具通道没有就绪`;
}

// plc 工具通道没有就绪，是不是因为启动超时（工单 #113）。
// init 事件只给 status=failed，不给原因。原因只写在 Claude Code 自己的 MCP 日志里（CONNECT_TIMEOUT），
// 那个文件在 CLI 的缓存目录下，路径格式没有文档，所以不读它。这里用一个自己量得到的信号：
// plc 设了 alwaysLoad，CLI 在发 init 之前等它连完。启动超时的话，从拉起 CLI 到收到 init 至少过了 MCP_TIMEOUT。
// 配置坏了（mcp_server_errors）、需要认证这类失败不算超时。服务器一启动就崩溃时 init 来得早，也不算。
// 只有机器忙到 CLI 自己启动加上 hooks 都超过 MCP_TIMEOUT 时，才会把崩溃误判成超时：那只多重试一次。
export function toolChannelTimedOut(init: JsonRecord, elapsedMs: number, timeoutMs: number): boolean {
  if (elapsedMs < timeoutMs) return false;
  const records = (value: unknown) => (Array.isArray(value) ? value.map(jsonRecord) : []);
  if (records(init.mcp_server_errors).some((entry) => entry?.name === TOOL_CHANNEL_SERVER)) return false;
  const entry = records(init.mcp_servers).find((candidate) => candidate?.name === TOOL_CHANNEL_SERVER);
  return entry?.status === "failed";
}

// 探针拉起 plc MCP 服务器时给它的变量（工单 #113）。mcp-server 启动时要求这几个变量。
// 给了工具桥的 socket 和 token，它就只转发工具调用、不打开账本（mcp-server.ts 的 proxyThroughBridge）。
// 探针只发 initialize，不调用工具，所以这个 socket 不存在、PLC_DB 指向不存在的文件都没关系。token 是占位，不是凭据。
const TOOL_CHANNEL_PROBE_ENV: Record<string, string> = {
  PLC_DB: join(tmpdir(), "plc-mcp-probe", "unused.db"),
  PLC_TICKET_ID: "1",
  PLC_ATTEMPT_ID: "1",
  PLC_AGENT_TOOL_SOCKET: join(tmpdir(), "plc-mcp-probe", "unused.sock"),
  PLC_AGENT_TOOL_TOKEN: "probe",
};

// plc 工具通道的 MCP 配置文件（工单 10）。配置的 env 里有工具桥 token，所以配置不进 argv。
// 配置写进一个只有当前用户能读写的文件。目录由 mkdtemp 创建，权限是 0700。文件的权限是 0600。
// alwaysLoad（按 Claude Code 2.1.258 核实）：CLI 在会话开始前连上这个服务器，
// 它的工具也不放进 ToolSearch 的延迟列表。runs 53、54 里，agent 用 ToolSearch 找不到 ticket_update。
// 连接结果因此在初始化事件里就是确定的，adapter 据此检查 plc 工具通道。
// 进程结束后删除整个目录。启动垫片也在 CLI 退出后删除它（工单 14），daemon 来不及删时由垫片删。
function writeMcpConfig(server: NonNullable<RuntimeStartRequest["mcpServer"]>): { path: string; dir: string; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), "plc-mcp-"));
  const path = join(dir, "mcp-config.json");
  writeFileSync(path, JSON.stringify({ mcpServers: { [TOOL_CHANNEL_SERVER]: { ...server, alwaysLoad: true } } }), {
    mode: 0o600, flag: "wx",
  });
  return { path, dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

// `claude auth status --json` 的判断。输出里有账号信息，这里只读 loggedIn 和 apiProvider 两个字段。
// apiProvider 不是 firstParty 时（Bedrock、Vertex 等），CLI 用那家 provider 自己的凭据。
// 这条命令只报告 Anthropic 账号，看不出那些凭据能不能用，所以放行。凭据真的不能用时，下一个 Run 失败，
// 故障重新开启（store 的 runtime-health.ts，2026-10-20 去掉金丝雀以后）。
function claudeAuthStatus(output: ProbeStepOutput): string | null {
  const status = statusJson(output.stdout);
  if (status) {
    if (typeof status.apiProvider === "string" && status.apiProvider !== "firstParty") return null;
    if (status.loggedIn === false) return "未登录";
  }
  return output.exitCode === 0 ? null : `退出码 ${output.exitCode}`;
}

export class ClaudeRuntime implements AgentRuntime {
  readonly id = "claude" as const;
  readonly capabilities: RuntimeCapabilities = {
    streaming: true,
    steering: false,
    resume: true,
    interrupt: true,
    approvals: false,
    mcp: true,
    // 核查员在沙箱里能跑命令（lead-tools-and-routing spec D15）。
    executableReadOnlyReview: true,
  };

  private readonly bin: string;
  private readonly prefixArgs: string[];
  private readonly env: Record<string, string>;
  private readonly killGraceMs: number;
  private readonly childSkillsRoot: string | null;
  private readonly toolChannelServer: McpServerCommand | null | undefined;

  constructor(options: ClaudeRuntimeOptions = {}) {
    this.bin = options.bin ?? "claude";
    this.prefixArgs = [...(options.prefixArgs ?? [])];
    this.env = { ...(options.env ?? {}) };
    this.killGraceMs = Math.max(0, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    this.childSkillsRoot = options.childSkillsRoot === undefined ? defaultChildSkillsRoot() : options.childSkillsRoot;
    this.toolChannelServer = options.toolChannelServer;
  }

  // 模型目录（工单 05）：Claude 不接受带 provider 前缀的模型名，例如 openai/gpt-5.4-mini（run 63）。
  // Bedrock 的 ARN 和 Vertex 的模型名不带这种前缀，不受影响。
  // executor 的命令许可写进 profile（工单 11），所以它也进 profile hash。
  get profile(): RuntimeProfile {
    return adapterProfile("claude", this.bin, this.env, {
      models: { defaultModel: claudeDefaultModel() ?? null, providers: [] },
      allowedTools: CLAUDE_EXECUTOR_ALLOWED_TOOLS,
    });
  }

  // 探针和 child 用同一个环境（工单 10），所以 auth status 看到的认证方式和真实 Run 一样。
  private probeCommand(signal?: AbortSignal): ProbeCommand {
    return {
      bin: this.bin, prefixArgs: this.prefixArgs, env: childEnvironment(this.profile.environment, this.env), signal,
    };
  }

  private readonly versionStep: ProbeStep = {
    label: "claude --version", args: ["--version"], failure: "runtime_start_failed", keepStderr: true,
  };

  // preflight（工单 05）：只检查安装。不跑 auth status：用 API key 等方式认证时，它可能报告未登录。
  preflight(request: RuntimePreflightRequest): Promise<RuntimeProbeResult> {
    return runInstallChecks(this.probeCommand(request.signal), [this.versionStep], this.profile.interpreter);
  }

  // 健康探针（工单 04），按 Claude Code 2.1.258 核实：`auth status --json` 输出 loggedIn 字段，
  // 未登录时退出码 1。两条命令都不发起模型调用。安装检查和 preflight 共用。
  // 工单 #113：最后一步真的拉起 plc 的 MCP 服务器，等它回答 initialize。以前探针只跑这两条命令，
  // plc 握手超时开的故障被探针关掉，下一个执行又超时，故障反复开关（2026-11-06 一天 10 次）。
  async probe(request: RuntimeProbeRequest): Promise<RuntimeProbeResult> {
    const installed = await runInstallChecks(this.probeCommand(request.signal), [
      this.versionStep,
      { label: "claude auth status", args: ["auth", "status", "--json"], failure: "auth_required", judge: claudeAuthStatus },
    ], this.profile.interpreter);
    const server = this.toolChannelServer === undefined ? agentMcpServer() : this.toolChannelServer;
    if (!installed.ok || server === null) return installed;
    return this.toolChannelCheck(server, installed.checks, request.signal);
  }

  // 探针的代价：每次多起一个 node 进程，加载 mcp-server 的模块，空闲时 1–2 秒。探针只在故障开着时按退避间隔跑
  // （engine 的 health-recovery.ts），前两步没过就不跑这一步，所以不会在机器忙的时候成批地起进程。
  // 等待上限用真实执行的 MCP_TIMEOUT：机器忙到真实执行会超时，探针也超时，故障保持打开。
  private async toolChannelCheck(
    server: McpServerCommand, checks: string[], signal?: AbortSignal,
  ): Promise<RuntimeProbeResult> {
    const label = "plc MCP initialize";
    const outcome = await probeMcpServer(server, {
      env: childEnvironment(this.profile.environment, this.env, TOOL_CHANNEL_PROBE_ENV),
      timeoutMs: claudeMcpTimeoutMs({ ...process.env, ...this.env }),
      signal,
    });
    const ran = [...checks, label];
    if (outcome.problem === null) return { ok: true, checks: ran };
    return {
      ok: false, checks: ran,
      failure: typedFailure("tool_channel_unavailable", {
        errorCode: "probe_failed", message: `${label}：${outcome.problem}`, stderr: outcome.stderr,
      }),
      ...(outcome.timedOut ? { timedOut: true } : {}),
    };
  }

  async start(request: RuntimeStartRequest): Promise<RuntimeHandle> {
    const queue = new AsyncEventQueue<ReturnType<RuntimeEventSequencer["event"]>>();
    const sequencer = new RuntimeEventSequencer(request.runId);
    const emit = (event: RuntimeEventInput): void => queue.push(sequencer.event(event));
    const mcpConfig = request.mcpServer ? writeMcpConfig(request.mcpServer) : null;
    // 沙箱策略要的 git 目录和根证书先在子进程里查好：buildArgs 和下面的环境只读缓存（2026-11-03）。
    await Promise.all([warmGitDirs([request.workdir]), warmSandboxTrustBundle()]);
    const args = this.buildArgs(request, mcpConfig?.path ?? null);
    const userEnv = { ...process.env, ...this.env, ...request.env };
    // 包管理器的缓存指到临时目录（沙箱里写不了 home 下面的缓存）。Run 自己给的同名变量优先。
    // 根证书（core 的 sandboxTrustEnv）：Claude Code 沙箱里的 curl、Python 也要能验证证书。用户自己设了的不改。
    // MCP_TIMEOUT（工单 #113）：只在带 plc 工具通道时补，用户自己设了的不改。它对用户自己的 MCP 服务器也生效。
    const env = childEnvironment(this.profile.environment, this.env, {
      ...sandboxCacheEnv(), ...sandboxTrustEnv(userEnv), ...(mcpConfig ? claudeMcpTimeoutEnv(userEnv) : {}), ...request.env,
    });
    const launchedAt = Date.now();

    let proc: LaunchedProcess;
    try {
      // CLI 经启动垫片运行（工单 14）。daemon 进程退出时，Claude 不会因为管道断开而退出。
      proc = await launchProcess({
        runId: request.runId, command: this.bin, args, cwd: request.workdir, env,
        baseDir: request.launchDir, removeOnExit: mcpConfig ? [mcpConfig.dir] : [],
      });
    } catch (error) {
      mcpConfig?.remove();
      const message = errorMessage(error);
      const exit: RuntimeExit = {
        ok: false,
        exitCode: null,
        signal: null,
        externalSessionId: null,
        errorCode: "claude_spawn_error",
        errorMessage: message,
      };
      emit({ type: "run.started", runtime: "claude", model: request.model ?? null });
      emit({
        type: "run.failed",
        exitCode: null,
        errorCode: exit.errorCode!,
        error: message,
        failure: classifyClaudeFailure({ errorCode: exit.errorCode, message }),
      });
      queue.end();
      return {
        pid: null,
        events: queue,
        interrupt: async () => {},
        wait: async () => exit,
      };
    }
    return this.supervise(
      proc,
      {
        runId: request.runId, model: request.model, toolChannel: request.mcpServer !== undefined,
        resumed: Boolean(request.resumeSessionId),
        toolChannelStart: mcpConfig ? { launchedAt, timeoutMs: claudeMcpTimeoutMs(env) } : null,
      },
      mcpConfig,
    );
  }

  // 接管 daemon 重启前启动的 Claude（工单 15）。解析和 start 相同，从输出文件的开头重放，
  // 所以会话、工具名这些在偏移之前积累的状态都会重建，重新产生的事件和原来的 seq 相同。
  // MCP 配置文件由垫片在 CLI 退出时删除。
  async attach(request: RuntimeAttachRequest): Promise<RuntimeHandle> {
    return this.supervise(
      attachProcess(request.launch, { hasStdin: false }),
      {
        runId: request.runId, model: request.model, toolChannel: request.toolChannel,
        resumed: Boolean(request.resumeSessionId), toolChannelStart: null,
      },
      null,
    );
  }

  // toolChannel：启动时有没有给 plc 工具通道。初始化消息里要检查它的状态。resumed：进程是不是 --resume 起的（用量要减去恢复进来的那份）。
  // toolChannelStart：这个进程什么时候拉起、MCP 启动时限多少，用来认出启动超时（toolChannelTimedOut）。
  // 接管的进程不知道拉起的时间，不认超时：内核也不在接管的 Run 里重试。
  private supervise(
    proc: LaunchedProcess,
    request: Pick<RuntimeStartRequest, "runId" | "model"> & {
      toolChannel: boolean;
      resumed: boolean;
      toolChannelStart: { launchedAt: number; timeoutMs: number } | null;
    },
    mcpConfig: { remove(): void } | null,
  ): RuntimeHandle {
    const queue = new AsyncEventQueue<ReturnType<RuntimeEventSequencer["event"]>>();
    const sequencer = new RuntimeEventSequencer(request.runId);
    const emit = (event: RuntimeEventInput): void => queue.push(sequencer.event(event));
    let externalSessionId: string | null = null;
    let sessionEventEmitted = false;
    let resultState: ResultState | null = null;
    let protocolError: string | null = null;
    let spawnError: string | null = null;
    // plc 工具通道没有就绪（工单 05）。这时 Run 在初始化阶段就结束，agent 不在没有交接工具的情况下工作。
    let channelError: string | null = null;
    let channelTimedOut = false;
    let interruptedReason: string | null = null;
    let closed = false;
    let malformedLines = 0;
    let stderrTail = "";
    let generatedMessageId = 0;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const toolNames = new Map<string, string>();
    const usage = new ClaudeUsageLedger(request.resumed);

    let resolveWait!: (exit: RuntimeExit) => void;
    const waitPromise = new Promise<RuntimeExit>((resolve) => {
      resolveWait = resolve;
    });

    const rememberSession = (message: JsonRecord, runtimeVersion?: string): void => {
      const sessionId = stringValue(message.session_id);
      if (!sessionId) return;
      externalSessionId = sessionId;
      if (sessionEventEmitted) return;
      sessionEventEmitted = true;
      emit({
        type: "session.updated",
        externalSessionId: sessionId,
        ...(runtimeVersion ? { runtimeVersion } : {}),
      });
    };

    // SIGTERM，宽限期之后 SIGKILL。CLI 可能忽略 SIGTERM。
    const terminate = (): void => {
      if (closed) return;
      proc.kill("SIGTERM");
      if (killTimer) return;
      killTimer = setTimeout(() => {
        if (!closed) proc.kill("SIGKILL");
      }, this.killGraceMs);
    };

    // 畸形行超过上限时，这个 Run 已经失败。CLI 可能一直不退出，所以停止它（工单 13 的合约用例）。
    const recordMalformedLine = (): void => {
      malformedLines += 1;
      if (malformedLines > MAX_MALFORMED_LINES && protocolError === null) {
        protocolError = `Claude emitted more than ${MAX_MALFORMED_LINES} malformed stream-json lines`;
        terminate();
      }
    };

    const handleLine = (line: string): void => {
      if (!line.trim() || protocolError !== null || channelError !== null) return;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        recordMalformedLine();
        return;
      }
      const record = jsonRecord(message);
      if (!record) {
        recordMalformedLine();
        return;
      }
      this.handleMessage(record, {
        emit,
        rememberSession,
        toolNames,
        usage,
        nextMessageId: () => `claude-message-${++generatedMessageId}`,
        setResult: (state) => {
          if (resultState === null) resultState = state;
        },
        onInit: (init) => {
          if (!request.toolChannel || channelError !== null) return;
          channelError = toolChannelProblem(init);
          if (channelError === null) return;
          const start = request.toolChannelStart;
          const elapsedMs = start ? Date.now() - start.launchedAt : 0;
          if (start && toolChannelTimedOut(init, elapsedMs, start.timeoutMs)) {
            channelTimedOut = true;
            channelError += `：启动超时（从拉起 CLI 到初始化用了 ${Math.round(elapsedMs / 1000)} 秒，`
              + `MCP_TIMEOUT 是 ${Math.round(start.timeoutMs / 1000)} 秒）`;
          }
          terminate();
        },
      });
    };

    const finalize = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (closed) return;
      closed = true;
      if (killTimer) clearTimeout(killTimer);
      mcpConfig?.remove();

      const exit = resolveExit({
        exitCode,
        signal,
        externalSessionId,
        spawnError,
        channelError,
        channelTimedOut,
        interruptedReason,
        protocolError,
        resultState,
      });
      if (exit.ok) {
        emit({ type: "run.completed", exitCode: exit.exitCode! });
      } else {
        emit({
          type: "run.failed",
          exitCode: exit.exitCode,
          errorCode: exit.errorCode!,
          error: exit.errorMessage!,
          failure: classifyClaudeFailure({
            errorCode: exit.errorCode, message: exit.errorMessage, stderr: stderrTail,
          }),
        });
      }
      queue.end();
      resolveWait(exit);
    };

    attachBoundedLineReader(proc.stdout!, handleLine, recordMalformedLine);
    // stderr 不产生事件，只留末尾作失败证据。
    proc.stderr!.setEncoding("utf8");
    proc.stderr!.on("data", (text: string) => {
      stderrTail = `${stderrTail}${text}`.slice(-MAX_STDERR_TAIL_CHARS);
    });
    proc.once("error", (error) => {
      spawnError = errorMessage(error);
    });
    proc.once("close", finalize);

    emit({ type: "run.started", runtime: "claude", model: request.model ?? null });

    return {
      pid: proc.pid ?? null,
      process: proc,
      events: queue,
      interrupt: async (reason: string): Promise<void> => {
        if (!closed && interruptedReason === null) {
          interruptedReason = reason || "interrupted";
          terminate();
        }
        await waitPromise;
      },
      wait: async (): Promise<RuntimeExit> => waitPromise,
    };
  }

  // 用户的配置照常加载（工单 11，2026-10-11 的用户决定）。所以这里不加 --safe-mode、--setting-sources、
  // --bare 这类 flag。按 Claude Code 2.1.258 的代码核实：--safe-mode 会丢掉 --mcp-config 里的 plc。
  // --mcp-config、--allowedTools、--tools 是可变参数的选项，会收取后面所有不以 - 开头的参数。
  // 所以它们后面总是跟另一个选项，提示词跟在只取一个值的选项后面。
  private buildArgs(request: RuntimeStartRequest, mcpConfigPath: string | null): string[] {
    // 沙箱（lead-tools-and-routing spec D2）：能写这次运行的工作目录和临时目录，不能读凭证，网络全开，密钥打码。
    // --settings 只取一个值，和用户自己的设置合并。设置里只有路径、域名和密钥的名字，没有值，可以放在命令行上。
    const sandbox = claudeSandboxSettings(sandboxPolicy({
      role: request.role === "reviewer" ? "reviewer" : "executor", writable: [request.workdir], dataDir: dataDir(),
    }));
    const args = [
      ...this.prefixArgs,
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--settings", JSON.stringify(sandbox),
      // PLC 内置的 skill（child-skills.ts）：这次会话加载的插件，不装进用户的系统。--plugin-dir 只取一个值。
      ...claudeChildSkillArgs(this.childSkillsRoot, request.role === "reviewer" ? "reviewer" : "executor"),
    ];
    // reviewer 只用 plc 一个 MCP 服务器：用户的 MCP 服务器可能带写操作的工具。
    if (request.role === "reviewer") args.push("--strict-mcp-config");
    // --mcp-config 接受 JSON 字符串或 JSON 文件的路径（Claude Code 2.1.258 的 --help）。
    // 这里只放文件路径：配置里有工具桥 token，不能出现在进程命令行里（工单 10）。
    if (mcpConfigPath) args.push("--mcp-config", mcpConfigPath);
    // executor 的命令许可从 profile 读，所以 argv 和 profile hash 用的是同一份清单。
    // MCP 工具默认要许可。-p 模式没有人回答许可请求，所以 plc 的工具要显式放行。
    const allowedTools = [
      ...(request.role === "reviewer" ? [] : this.profile.allowedTools),
      ...(mcpConfigPath ? [`mcp__${TOOL_CHANNEL_SERVER}__*`] : []),
    ];
    if (allowedTools.length) args.push("--allowedTools", allowedTools.join(","));
    // auto 模式（用户 2026-10-28：「不要啥都让我审批」）：-p 模式下没有人回答许可请求，以前不在清单里的就被拒。
    // auto 由 Claude Code 自己的分类模型判断放不放行，例如沙箱里要连的新域名（2026-10-28 在本机用 -p 核实：
    // 第一次被拦，它声明域名后重跑成功）。核查员没有 Edit、Write（--tools），靠沙箱约束。
    const permissionMode = claudePermissionMode();
    if (request.role === "reviewer") args.push("--tools", REVIEW_TOOLS);
    args.push("--permission-mode", permissionMode);
    if (request.model) args.push("--model", request.model);
    // --effort <level>：low, medium, high, xhigh, max（Claude Code 2.1.258 的 --help）。
    const effort = cliEffortValue(request.effort);
    if (effort) args.push("--effort", effort);
    if (request.resumeSessionId) args.push("--resume", request.resumeSessionId);
    // --fork-session：resume 时开一个新的 session id，原 session 不变（Claude Code 2.1.258 的 --help）。
    if (request.resumeSessionId && request.forkSession) args.push("--fork-session");
    args.push(request.prompt);
    return args;
  }

  private handleMessage(
    message: JsonRecord,
    context: {
      emit: (event: RuntimeEventInput) => void;
      rememberSession: (message: JsonRecord, runtimeVersion?: string) => void;
      toolNames: Map<string, string>;
      usage: ClaudeUsageLedger;
      nextMessageId: () => string;
      setResult: (state: ResultState) => void;
      onInit: (init: JsonRecord) => void;
    },
  ): void {
    const type = stringValue(message.type);
    if (type === "rate_limit_event") return;

    if (type === "system") {
      const subtype = stringValue(message.subtype);
      if (subtype !== "init") return;
      context.rememberSession(
        message,
        stringValue(message.claude_code_version) ?? stringValue(message.version) ?? undefined,
      );
      context.onInit(message);
      return;
    }

    if (type === "assistant") {
      context.rememberSession(message);
      const assistant = jsonRecord(message.message);
      if (!assistant) return;
      const content = Array.isArray(assistant.content) ? assistant.content : [];
      const text = content
        .map(jsonRecord)
        .filter((block): block is JsonRecord => block !== null && block.type === "text")
        .map((block) => stringValue(block.text) ?? "")
        .join("");
      const messageId = stringValue(assistant.id) ?? stringValue(message.uuid) ?? context.nextMessageId();
      if (text) {
        const stopReason = stringValue(assistant.stop_reason) ?? stringValue(message.stop_reason);
        context.emit({
          type: "message.completed",
          messageId,
          role: "assistant",
          text,
          ...(stopReason ? { stopReason } : {}),
        });
      }
      for (const value of content) {
        const block = jsonRecord(value);
        if (!block || block.type !== "tool_use") continue;
        const callId = stringValue(block.id);
        const name = stringValue(block.name);
        if (!callId || !name) continue;
        context.toolNames.set(callId, name);
        context.emit({
          type: "tool.started",
          callId,
          name,
          args: block.input ?? null,
        });
      }
      const responseKey = `${stringValue(message.parent_tool_use_id) ?? ""}:${messageId}`;
      const running = context.usage.response(responseKey, normalizeUsage(assistant.usage));
      if (running) {
        context.emit({
          type: "usage.updated",
          mode: "cumulative",
          ...running,
          costUsd: null,
        });
      }
      return;
    }

    if (type === "user") {
      context.rememberSession(message);
      const user = jsonRecord(message.message);
      const content = user && Array.isArray(user.content) ? user.content : [];
      for (const value of content) {
        const block = jsonRecord(value);
        if (!block || block.type !== "tool_result") continue;
        const callId = stringValue(block.tool_use_id);
        if (!callId) continue;
        const name = context.toolNames.get(callId) ?? "unknown";
        if (block.is_error === true) {
          context.emit({
            type: "tool.failed",
            callId,
            name,
            error: contentText(block.content),
          });
        } else {
          context.emit({
            type: "tool.completed",
            callId,
            name,
            result: block.content ?? null,
          });
        }
      }
      return;
    }

    if (type !== "result") return;
    context.rememberSession(message);
    const turn = normalizeUsage(message.usage);
    const session = normalizeModelUsage(message.modelUsage);
    const sinceLast = normalizeModelUsage(message.model_usage_since_last_result);
    const totalCostUsd = numberValue(message.total_cost_usd);
    if (turn || session || sinceLast || totalCostUsd !== null) {
      context.emit({
        type: "usage.updated",
        mode: "cumulative",
        ...context.usage.result({ turn, session, sinceLast, totalCostUsd }),
      });
    }

    const subtype = stringValue(message.subtype) ?? "result_error";
    const isError = message.is_error === true || subtype !== "success";
    if (!isError) {
      context.setResult({ ok: true, errorCode: null, errorMessage: null });
      return;
    }
    // API 错误（认证、余额、满载）的 subtype 是 success。按 subtype 拼码会得到 claude_success，
    // 一个失败带着"成功"的码，所以这种情况单独命名。
    context.setResult({
      ok: false,
      errorCode: subtype === "success"
        ? "claude_result_error"
        : `claude_${subtype.replace(/[^a-zA-Z0-9_]+/g, "_").toLowerCase()}`,
      errorMessage: resultError(message, subtype),
    });
  }
}

function attachBoundedLineReader(
  stream: Readable,
  onLine: (line: string) => void,
  onOversizedLine: () => void,
): void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let discardingOversizedLine = false;

  const consume = (text: string): void => {
    if (discardingOversizedLine) {
      const newlineIndex = text.indexOf("\n");
      if (newlineIndex === -1) return;
      discardingOversizedLine = false;
      text = text.slice(newlineIndex + 1);
    }
    buffer += text;
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;
      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > MAX_LINE_LENGTH) {
        onOversizedLine();
        continue;
      }
      if (line.endsWith("\r")) line = line.slice(0, -1);
      onLine(line);
    }
    if (buffer.length > MAX_LINE_LENGTH) {
      buffer = "";
      discardingOversizedLine = true;
      onOversizedLine();
    }
  };

  stream.on("data", (chunk) => {
    consume(typeof chunk === "string" ? chunk : decoder.write(chunk));
  });
  stream.on("end", () => {
    consume(decoder.end());
    if (!discardingOversizedLine && buffer) onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
  });
}

function normalizeUsage(value: unknown): UsageParts | null {
  const usage = jsonRecord(value);
  if (!usage) return null;
  const fields = [
    numberValue(usage.input_tokens),
    numberValue(usage.cache_creation_input_tokens),
    numberValue(usage.cache_read_input_tokens),
    numberValue(usage.output_tokens),
  ];
  if (fields.every((field) => field === null)) return null;
  const creation = jsonRecord(usage.cache_creation);
  return {
    uncached: fields[0] ?? 0,
    cacheWrite: fields[1] ?? 0,
    cacheWrite1h: numberValue(creation?.ephemeral_1h_input_tokens) ?? 0,
    cacheRead: fields[2] ?? 0,
    output: fields[3] ?? 0,
  };
}

// result.modelUsage 或 model_usage_since_last_result：每个模型一项。各模型相加。没有任何一项时返回 null。
function normalizeModelUsage(value: unknown): ModelUsageTotal | null {
  const models = jsonRecord(value);
  if (!models) return null;
  let total: ModelUsageTotal | null = null;
  for (const entry of Object.values(models)) {
    const model = jsonRecord(entry);
    if (!model) continue;
    total = addModelUsage(total, {
      parts: {
        uncached: numberValue(model.inputTokens) ?? 0,
        cacheWrite: numberValue(model.cacheCreationInputTokens) ?? 0,
        cacheWrite1h: numberValue(model.cacheCreationEphemeral1hInputTokens) ?? 0,
        cacheRead: numberValue(model.cacheReadInputTokens) ?? 0,
        output: numberValue(model.outputTokens) ?? 0,
      },
      costUsd: numberValue(model.costUSD),
    });
  }
  return total;
}

function resolveExit(input: {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  externalSessionId: string | null;
  spawnError: string | null;
  channelError: string | null;
  channelTimedOut: boolean;
  interruptedReason: string | null;
  protocolError: string | null;
  resultState: ResultState | null;
}): RuntimeExit {
  let errorCode: string | null = null;
  let errorMessageValue: string | null = null;

  if (input.spawnError) {
    errorCode = "claude_spawn_error";
    errorMessageValue = input.spawnError;
  } else if (input.channelError) {
    // 启动超时的码在 typed-failure.ts 的 TOOL_CHANNEL_START_TIMEOUT_CODES 里，内核据此重试一次。
    errorCode = input.channelTimedOut ? "claude_tool_channel_timeout" : "claude_tool_channel_unavailable";
    errorMessageValue = input.channelError;
  } else if (input.interruptedReason) {
    errorCode = "claude_interrupted";
    errorMessageValue = input.interruptedReason;
  } else if (input.protocolError) {
    errorCode = "claude_protocol_error";
    errorMessageValue = input.protocolError;
  } else if (input.resultState && !input.resultState.ok) {
    errorCode = input.resultState.errorCode;
    errorMessageValue = input.resultState.errorMessage;
  } else if (input.signal) {
    errorCode = "claude_signal";
    errorMessageValue = `Claude exited from signal ${input.signal}`;
  } else if (input.exitCode !== 0) {
    errorCode = "claude_exit";
    errorMessageValue = `Claude exited with code ${input.exitCode}`;
  } else if (!input.resultState) {
    errorCode = "claude_missing_result";
    errorMessageValue = "Claude exited without a result message";
  }

  return {
    ok: errorCode === null,
    exitCode: input.exitCode,
    signal: input.signal,
    externalSessionId: input.externalSessionId,
    errorCode,
    errorMessage: errorMessageValue,
  };
}

function jsonRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .map(jsonRecord)
      .filter((block): block is JsonRecord => block !== null)
      .map((block) => stringValue(block.text) ?? "")
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function resultError(message: JsonRecord, subtype: string): string {
  if (Array.isArray(message.errors)) {
    const errors = message.errors.filter((value): value is string => typeof value === "string");
    if (errors.length) return errors.join("\n");
  }
  return stringValue(message.error)
    ?? stringValue(message.result)
    ?? `Claude result failed: ${subtype}`;
}

// ── registry 的登记项（spec D8，工单 12）──────────────────────────────────────

// 没有配置时不传 --model，由 Claude Code 用自己的默认模型。
export function claudeDefaultModel(env: RuntimeEnv = process.env): string | undefined {
  return env.PLC_CLAUDE_MODEL?.trim() || undefined;
}

// Claude Code 没有列模型的命令。--help 的 --model 说明列出别名（指向该系列最新的模型），
// --effort 说明列出档位。别名就是目录：用 opus 永远是最新的 Opus，不用知道版本号。
async function discoverClaudeModels(context: { env?: RuntimeEnv; timeoutMs?: number }): Promise<ModelDiscovery> {
  const source = "claude --help";
  const bin = findRuntimeExecutable(claudeBin());
  if (!bin) return { ok: false, error: "claude executable not found", source };
  try {
    const { models, efforts } = claudeModelsFromHelp(await runDiscoveryCommand({ bin, env: context.env, timeoutMs: context.timeoutMs }, ["--help"]));
    if (models.length === 0) return { ok: false, error: "claude --help lists no model aliases", source };
    return {
      ok: true, models, efforts, cliDefaultModel: null, source,
      account: "Claude Code 内置的订阅账号",
      // --help：也可以给完整模型名（e.g. 'claude-fable-5'）。
      freeformModelPattern: "^claude-[a-z0-9][a-z0-9.-]*$",
    };
  } catch (error) {
    return { ok: false, error: String((error as Error).message ?? error).slice(0, 300), source };
  }
}

// 没有指定可执行文件时，用 PLC_CLAUDE_BIN，再找 PATH 上的 claude。目录和实例用同一条规则。
function claudeBin(): string {
  return process.env.PLC_CLAUDE_BIN ?? "claude";
}

// Claude Code 命令里的 $TMPDIR 是 /private/tmp/claude-<uid>。后台命令的输出在
// <那里>/<工作目录，非字母数字换成 -><会话号>/tasks/（2026-10-29）。
function claudeTempFiles(context: { workdir: string | null; sessionId: string | null }): { tmpdir: string; tasks: string | null } | null {
  if (typeof process.getuid !== "function") return null;
  const tmpdir = `/private/tmp/claude-${process.getuid()}`;
  const tasks = context.workdir && context.sessionId
    ? `${tmpdir}/${context.workdir.replace(/[^A-Za-z0-9]/g, "-")}/${context.sessionId}/tasks/`
    : null;
  return { tmpdir, tasks };
}

export const claudeAdapter: RuntimeAdapter<ClaudeRuntimeOptions> = {
  id: "claude",
  displayName: "Claude Code",
  // 能力只在 ClaudeRuntime 里声明一次。
  capabilities: new ClaudeRuntime().capabilities,
  // 模型名原样交给 CLI。带 provider 前缀的模型名由 preflight 的模型检查拒绝（profile 的模型目录）。
  models: { defaultModel: claudeDefaultModel, resolve: (model) => model },
  reportsCost: true,
  classifyFailure: classifyClaudeFailure,
  locateExecutable: () => findRuntimeExecutable(claudeBin()),
  discoverModels: (context) => discoverClaudeModels(context),
  tempFiles: claudeTempFiles,
  create: (options) => new ClaudeRuntime({
    ...options,
    bin: resolveRuntimeExecutable(options?.bin ?? claudeBin()),
  }),
};

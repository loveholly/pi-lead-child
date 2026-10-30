// Lead 的运行环境说明（Lead 事件主干 spec D17，工单 13）。
//
// 2026-10-17 用户问 Lead「jev 在你的会话里面激活了多少次」，Lead 回答「查不到 jev 指什么」。Lead 的提示词里
// 没有 Jev、决策模型，也没有说调用记在哪里。所以系统提示里加一节「你运行的环境」：系统有哪些组件、它们在做什么、
// 记在哪里、Lead 用什么读、Lead 看不到什么。
//
// 2026-10-30 用户看了这一节：「不该全部 hardcode 这么多内容，而且尤其存在泄漏我个人隐私的嫌疑……比如 am api key
// 这个就不要暴露了，比如 vibe proxy 这个也是 hardcode 了」。系统提示词每一轮都发给模型服务商，Lead 也可能照着复述。
// 所以分成两半：
//   - renderLeadEnvironment：系统提示里的这一节。只写组件、能力、用什么查和名词，不含现在的值。
//     它不随配置和状态变，也就不再让提示缓存失效。
//   - renderEnvironmentDetails：get_environment 的结果。现在的值：你的模型和备选、决策模型的配置和 SmartModel 的后端、
//     记忆服务的状态、runtime 的健康、连接、沙箱里的密钥名和主机。Lead 调用时才生成。
//   - collectLeadEnvironment 读各数据源，拼出快照。每个数据源读不到时只影响它自己那一行。
// 短暂的状态不列：runtime 的 degraded（自动重试到了上限，派发照常进行，过一会儿自己消失）不列；
// 连接的 degraded（暂时连不上，daemon 在重试）按「已连接」列。这两样用 get_runtime_health、list_connections 现查。
import type { ConnectionHub } from "@pi-lead-child/connections";
import { projectRoot, SANDBOX_SECRET_HOSTS_ENV, sandboxSecrets } from "@pi-lead-child/core";
import { currentModelCatalog } from "@pi-lead-child/engine";
import { redactAndCap, type DecisionModelDto, type MemorySettingsDto } from "@pi-lead-child/protocol";
import { incidentModel, listUnhealthyRuntimeTargets, type Db } from "@pi-lead-child/store";
import { disabledRuntimes } from "@pi-lead-child/runtime";
import { loadLeadModelConfig } from "./model-config.js";

/**
 * 沙箱里的密钥（core 的 sandboxSecrets）：只写名字和主机，不写值。用户问「能不能用 X 的 key」时 Lead 照这一行回答。
 */
export function sandboxSecretsLine(env: Record<string, string | undefined>): string {
  const { masked, withheld } = sandboxSecrets(env);
  const parts = [
    masked.length
      ? "沙箱里能用的密钥（命令里是占位值，发往绑定的主机时沙箱的代理换成真值，直接用 $名字 就行）："
        + masked.map((secret) => `${secret.name} → ${secret.injectHosts.join("、")}`).join("；")
      : "沙箱里没有绑定了主机的密钥",
    ...(withheld.length
      ? [`没绑定主机、沙箱里拿不到的：${withheld.join("、")}。要用时请用户在 config.json 的 env 段里写 `
        + `${SANDBOX_SECRET_HOSTS_ENV}（名字=主机，例如 EXAMPLE_API_KEY=api.example.com）。这是用户的设置，你改不了`]
      : []),
  ];
  return `- ${parts.join("。")}。`;
}


/** 系统提示里这一节的名字（pi 的系统提示分节）。 */
export const ENVIRONMENT_SECTION = "environment";
/** 这一节的长度上限，按估算的 token 算（core 的 estimateTokens：中日韩文字每个 1 个，其他每 4 个字符 1 个）。测试守着它。 */
export const ENVIRONMENT_TOKEN_BUDGET = 2_000;

// 健康账本里一个不可用的目标（有故障，派发会挂起）。degraded 不在这里，见文件开头。
export interface RuntimeProblem {
  // 不可用的模型。整个 runtime 不可用时为 null。
  model: string | null;
  code: string | null;
  // 要用户做什么（健康账本的 needs），例如 login。
  needs: string | null;
  incidentId: number | null;
}

export interface RuntimeEnvironment {
  runtime: string;
  // known：CLI 给出了模型目录；unknown：还不知道。
  catalog: "known" | "unknown";
  models: number;
  problems: RuntimeProblem[];
  // 用户在设置里停用了它（设置 → 执行器，PLC_DISABLED_RUNTIMES）。不给时当作没有停用。
  disabled?: boolean;
}

export interface LeadEnvironmentSnapshot {
  lead: {
    // 你正在用的模型（provider/model）。不知道时为 null。
    model: string | null;
    // config.json 的 lead.models，按顺序。
    models: readonly string[];
    // 读不到 config.json 时的原因。
    configProblem: string | null;
  };
  // SmartModel 现在的后端：例如 jev→llm、llm；没有后端时是 none。llm 是兜底的 LLM 用的模型。
  // 会话没有建出 SmartModel 时为 null。
  smartModel: { backend: string; llm: string | null } | null;
  // 决策模型的设置（daemon 的 MemoryController）。daemon 没有提供（没有托管，或者读失败）时为 null。
  decisionModel: { model: string; host: string | null; keySet: boolean; problem: string | null } | null;
  // 记忆服务（daemon 的 MemoryController）。daemon 没有提供（没有托管，或者读失败）时为 null。
  memory: {
    state: "off" | "starting" | "healthy" | "down";
    backend: "hindsight" | "sqlite";
    reranker: "decision" | "local" | "none";
    // 索引进度（设置 → 记忆 的「已索引 N/M」，lead-tools-and-routing spec D5：界面上看得到的状态，Lead 也要读得到）。
    index?: { notes: number; indexed: number } | null;
  } | null;
  // 各 runtime 的模型目录和健康账本。读不到时为 null。
  runtimes: RuntimeEnvironment[] | null;
  // 第三方账号的连接。daemon 没有提供时为 null。
  connections: Array<{ label: string; state: string }> | null;
}

// ── 纯函数：快照 → 文字 ─────────────────────────────────────────────────────────────────

// get_environment 的结果里每个 runtime 最多列几个问题、最多列几个连接。
const DETAIL_CAPS = { problems: 5, connections: 20 } as const;

const CONNECTED_STATES: Readonly<Record<string, string>> = {
  connected: "已连接", degraded: "暂时连不上，daemon 在重试", needs_reauth: "要用户重新授权",
};

// 设置里的说明文字可能很长，也可能抄了地址：截短并脱敏。
function short(text: string, limit = 120): string {
  const capped = redactAndCap(text.replace(/\s+/g, " ").trim(), limit);
  return capped.truncated ? `${capped.text}…` : capped.text;
}

function list(items: readonly string[]): string {
  return items.join("、");
}

function more(total: number, shown: number): string {
  return total > shown ? `，另有 ${total - shown} 条` : "";
}

function runtimeLines(runtimes: LeadEnvironmentSnapshot["runtimes"]): string[] {
  if (runtimes === null) return ["- runtime（执行 child 的 CLI）：这次读不到模型目录和健康账本。用 get_runtime_health 查。"];
  if (runtimes.length === 0) return ["- runtime（执行 child 的 CLI）：没有登记任何 runtime。"];
  return [
    "- runtime（执行 child 的 CLI）。健康账本里不可用的目标会挂起派发：",
    ...runtimes.map((entry) => {
      const catalog = entry.catalog === "known" ? `模型目录有 ${entry.models} 个模型` : "模型目录还不知道";
      const shown = entry.problems.slice(0, DETAIL_CAPS.problems).map((problem) => {
        const target = problem.model ? `模型 ${problem.model}` : "整个 runtime";
        const facts = [
          problem.incidentId !== null ? `故障 #${problem.incidentId}` : null,
          problem.code ? `code=${problem.code}` : null,
          problem.needs && problem.needs !== "none" ? `要用户做：${problem.needs}` : null,
        ].filter(Boolean).join("，");
        return `${target} 不可用${facts ? `（${facts}）` : ""}`;
      });
      const health = entry.problems.length === 0 ? "健康" : `${list(shown)}${more(entry.problems.length, shown.length)}`;
      const disabled = entry.disabled ? "已被用户停用（设置 → 执行器），派发、核查和选型都跳过它，点名它会报错；" : "";
      return `  - ${entry.runtime}：${disabled}${catalog}；${health}。`;
    }),
  ];
}

function decisionModelLine(snapshot: LeadEnvironmentSnapshot): string {
  const smart = snapshot.smartModel;
  const settings = snapshot.decisionModel;
  const jevInChain = smart?.backend.split("→").includes("jev") ?? false;
  let state: string;
  if (settings?.problem) state = `设置有问题：${short(settings.problem)}`;
  else if (settings && !settings.keySet) state = "没有配置 key，不调用 Jev";
  else if (settings) state = `已配置（模型 ${settings.model}${settings.host ? `，主机 ${settings.host}` : ""}）`;
  else state = jevInChain ? "已配置" : "daemon 没有提供决策模型的设置，SmartModel 不调用 Jev";
  const chain = smart === null ? "这个会话没有 SmartModel，suggest_route 只按硬规则建议"
    : smart.backend === "none" ? "SmartModel 现在没有可用的后端，suggest_route 只按硬规则建议"
    : `SmartModel 现在的后端：${smart.backend}${smart.llm ? `；兜底的 LLM 是 ${smart.llm}` : ""}`;
  return `- 决策模型 Jev：${state}。${chain}。`;
}

function memoryLine(memory: LeadEnvironmentSnapshot["memory"]): string {
  if (memory === null) return "- 记忆服务：daemon 没有提供记忆服务的状态。daemon 不托管记忆服务时，search_notes 只用笔记的全文检索。";
  const state = memory.state === "healthy" ? "运行中"
    : memory.state === "starting" ? "正在启动"
    : memory.state === "down" ? "没有运行（服务出了问题）"
    : memory.backend === "sqlite" ? "关闭（这台电脑设置了只用全文检索）"
    : "关闭（还没有可用的 embedding）";
  const reranker = memory.reranker === "decision" ? "重排序用决策模型"
    : memory.reranker === "local" ? "重排序用本地模型" : "不重排序";
  const fallback = memory.state === "healthy" ? "" : "search_notes 现在只用笔记的全文检索。";
  // 写入进度：Hindsight 处理完的笔记条数（memory_sync 里 completed 的）。N 等于 M 时，笔记都已经写进 Hindsight。
  const index = memory.index && memory.backend === "hindsight"
    ? `已写入 ${memory.index.indexed}/${memory.index.notes} 条笔记${memory.index.indexed >= memory.index.notes ? "（都写完了）" : "（没写完的召回不到，见设置 → 记忆）"}。`
    : "";
  return `- 记忆服务 Hindsight：${state}，${reranker}。${index}${fallback}`;
}

function connectionLine(connections: LeadEnvironmentSnapshot["connections"]): string {
  if (connections === null) return "- 连接（第三方账号）：读不到连接列表。";
  const used = connections.filter((item) => item.state in CONNECTED_STATES);
  const unused = connections.filter((item) => !(item.state in CONNECTED_STATES)).map((item) => item.label);
  const shown = used.slice(0, DETAIL_CAPS.connections).map((item) => `${item.label}（${CONNECTED_STATES[item.state]}）`);
  const usedText = used.length === 0 ? "还没有连接任何账号" : `${list(shown)}${more(used.length, shown.length)}`;
  const unusedText = unused.length === 0 ? ""
    : `。没有连接：${list(unused.slice(0, DETAIL_CAPS.connections))}${more(unused.length, Math.min(unused.length, DETAIL_CAPS.connections))}`;
  return `- 连接（第三方账号）：${usedText}${unusedText}。`;
}

function leadModelLine(lead: LeadEnvironmentSnapshot["lead"]): string {
  const models = lead.configProblem ? `读不到 config.json 的 lead.models（${short(lead.configProblem)}）`
    : lead.models.length ? `config.json 的 lead.models：${list(lead.models)}（第一个是缺省模型；限流时按这个顺序换）`
    : "config.json 没有配置 lead.models，用缺省模型";
  return `- 你的模型：现在用 ${lead.model ?? "（不知道）"}。${models}。`;
}

function codeRoot(): string {
  try {
    return projectRoot();
  } catch {
    return "（找不到仓库的根目录）";
  }
}

const FIXED_COMPONENTS = [
  "- daemon：常驻的后台进程。它管工单、派发、事件日志和你的会话。你是 daemon 里的一个 pi 会话。",
  "- supervisor：守护 daemon 的进程。它做安全重启、升级、备份和诊断（get_runtime_health、request_runtime_maintenance）。",
  "- 网关：App 和 plc 命令行连到 daemon 的入口。Slack 的消息经 aish 适配器进来。",
  "- runtime（执行 child 的 CLI）：健康账本里不可用的目标会挂起派发；用户停用的 runtime，派发、核查和选型都跳过它。"
    + "哪个现在能用：get_environment 或 get_runtime_health。",
  "- 决策模型 Jev：TypeSafe 托管的类型化判断模型。SmartModel 先问它；它失败时，由兜底的 LLM 回答。现在的配置和 SmartModel 的后端：get_environment。",
  "  - Jev 不在你的会话里运行。你的回答由你自己的模型生成，不经过 Jev。",
  "  - 用它的功能：suggest_route（你调用这个工具时）；记忆召回的重排序（reranker 选了「决策模型」时，Hindsight 在自己的进程里调用它）；"
    + "影子分诊（daemon 在后台问 Jev 规则定不了级别的事件，只记录、不改级别，用途是 triage_shadow；只用 Jev，没有 key 时不运行；"
    + "对照结果用 get_triage_shadow_report 读）；"
    + "通道里别人发来的消息紧不紧急（daemon 用你这个会话的 SmartModel 问，用途是 channel_urgency，结果写进事件的 urgent 和 urgency；"
    + "问不成时按不紧急处理：照常开会话卡，不推送）；"
    + "工单 agent 的回复下面显示哪些动作按钮（daemon 在 agent 答完一轮后用你这个会话的 SmartModel 问，用途是 ticket_reply_actions；"
    + "问不成时不显示按钮，决策卡上照样有）。",
  "  - 每次 SmartModel 调用写一条 decision_model.called 事件，另写一行决策日志（数据目录下的 smart-model/decisions.jsonl）。Hindsight 里的重排序调用不在事件日志里。",
  "- 记忆服务 Hindsight：只问它，挂了用全文检索。每次召回写一条 memory.recalled 事件。现在的状态和写入进度：get_environment。",
  "- 连接（第三方账号）：有哪些、连没连上：list_connections。",
];

function selfLines(): string[] {
  return [
    "- 你用的模型和备选的顺序：get_environment。",
    "- 你有只读工具（read、grep、find、ls）、沙箱里的 bash（像用户的终端：能写整个 home 和 plc 的隔离 worktree，各个 CLI 的"
      + "登录和配置能读能写；挡住会在沙箱外执行的地方、私钥和 plc 自己的账本密钥；网络全开；连不了本机端口）、同样边界的 edit 和 write、"
      // 和 hands.ts 一致：只拦外部消息叫醒的一轮。以前写成「读过外部内容的一轮」，Lead 在用户本人的一轮里读完 Slack 就不跑命令了
      // （用户 2026-10-30）。完整的说法在 prompt.ts。
      + "codemode，以及系统给你的工具。外部消息叫醒的一轮里你不跑命令、不写文件。",
    "- 沙箱里的密钥：命令里直接用 $名字。命令里看到的是占位值，发往绑定的主机时沙箱的代理换成真值。有哪些、各绑定哪个主机：get_environment。",
    "- bash 的 PATH 和用户的登录 shell 一样（daemon 启动时读的），用户本机装的 CLI 直接调，也能替用户登录（设备码登录时"
      + "盯着进程的输出，用户授权完就继续）。把令牌存在钥匙串里的 CLI 在沙箱里读不到登录：换成文件存的登录、连接工具，或者派执行者。",
    "- 系统提示词里只列你自带的 skill。用户给 agent 装的 skill（~/.agents/skills 这类）不列出来，用 find_skill 找；"
      + "找到以后用 read 读 SKILL.md，里面写的 Claude Code 专用工具（Skill、Agent、mcp__ 开头的）换成你有的工具：bash、codemode、连接工具、派子 agent。",
    "- 你看不到 child 会话的内部。你能读 child 的 Run 事件（read_run_events）、checkpoint 和交付。",
    "- 你看不到 Jev、Hindsight 和兜底 LLM 的内部日志。你能读到的是事件日志里的调用记录。",
    `- pi-lead-child 自己的代码在 ${codeRoot()}。回答「系统为什么这样做」时，用 read、grep 在这里查。`,
  ];
}

const WHERE = [
  "### 记在哪里、用什么读",
  "- 现在的配置和状态（你的模型、决策模型、记忆服务、runtime、连接、沙箱里的密钥）：get_environment。",
  "- 工单、Run 和失败的根因：query_tickets、get_ticket_status、read_run_events。",
  "- 你自己的回合和健康状态：read_lead_turns。",
  "- 组件被调用了几次、失败几次、平均耗时（决策模型、记忆召回）：get_system_usage。数字来自事件日志，不来自你的记忆。",
  "- 系统里发生过的每一件事（事件日志，按序号、对象、类型、级别查）：query_events。",
  "- runtime 的健康：get_runtime_health。连接：list_connections。笔记：search_notes。",
];

const GLOSSARY = [
  "### 名词（用户可能用其中任何一个称呼同一个东西）",
  "- Jev：TypeSafe 的决策模型，见上。用户说「jev」「决策模型」「判断模型」时，指的是它或者 SmartModel。",
  "- SmartModel：系统里快速的类型化判断层。它按顺序问 Jev 和兜底的 LLM，每次调用写一条 decision_model.called 事件。",
  "- 决策模型：设置页「Lead → 模型」里配置的 Jev 或兼容的端点。SmartModel 和记忆的重排序共用它。",
  "- runtime：执行 child 的 CLI，例如 codex、claude、pi。",
  "- child：执行工单的 agent。executor 执行工作，reviewer 做独立核查。",
  "- reviewer：只读的独立核查员。它重跑验证，把核查报告写回工单。",
  "- Run：child 对一张工单的一次执行。一张工单可以有多个 Run。",
  "- Hindsight：记忆服务，见上。",
];

/**
 * 生成「你运行的环境」一节：组件、你自己能做什么、用什么查、名词。
 * 不含现在的值（模型、密钥、服务地址、状态、连接），所以配置和状态变了它也不变，不让提示缓存失效。
 */
export function renderLeadEnvironment(): string {
  return [
    "## 你运行的环境",
    "这一节写系统有哪些组件、你能做什么、用什么查。现在的值不在这里：你用的模型、决策模型和记忆服务的状态、runtime 的健康、"
      + "连接、沙箱里的密钥，用 get_environment 现查；调用次数用 get_system_usage 查。",
    "",
    "### 组件",
    ...FIXED_COMPONENTS,
    "",
    "### 你自己",
    ...selfLines(),
    "",
    ...WHERE,
    "",
    ...GLOSSARY,
  ].join("\n");
}

/**
 * get_environment 的结果：现在的配置和状态。纯函数：同样的快照和环境变量得到同样的文字。
 * 只在 Lead 调用时生成，不进系统提示词。
 */
export function renderEnvironmentDetails(snapshot: LeadEnvironmentSnapshot, env: Record<string, string | undefined> = process.env): string {
  return [
    "## 现在的配置和状态",
    leadModelLine(snapshot.lead),
    decisionModelLine(snapshot),
    memoryLine(snapshot.memory),
    ...runtimeLines(snapshot.runtimes),
    connectionLine(snapshot.connections),
    sandboxSecretsLine(env),
  ].join("\n");
}

// ── 读数据源 ─────────────────────────────────────────────────────────────────────────

/** daemon 提供的那部分：决策模型的设置和记忆服务的状态（MemoryController）。 */
export interface LeadDaemonEnvironment {
  decisionModel: DecisionModelDto | null;
  memory: MemorySettingsDto | null;
}

export interface LeadEnvironmentSources {
  db: Db;
  dataDir: string;
  // 你正在用的模型（provider/model）。
  leadModel: () => string | null;
  // SmartModel 的后端每次现读：决策模型的 key 可能在会话中途加上或者删掉。
  smartModel: () => { backend: string; llm: string | null } | null;
  connections?: Pick<ConnectionHub, "list"> | null;
  daemon?: (() => LeadDaemonEnvironment) | null;
  env?: Record<string, string | undefined>;
}

function attempt<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runtimes(db: Db, env: Record<string, string | undefined>): RuntimeEnvironment[] {
  const byRuntime = new Map<string, RuntimeEnvironment>();
  for (const entry of currentModelCatalog(db).runtimes) {
    byRuntime.set(entry.runtime, { runtime: entry.runtime, catalog: entry.state, models: entry.models.length, problems: [] });
  }
  for (const runtime of disabledRuntimes(env)) {
    const target = byRuntime.get(runtime) ?? { runtime, catalog: "unknown" as const, models: 0, problems: [] };
    byRuntime.set(runtime, { ...target, disabled: true });
  }
  for (const entry of listUnhealthyRuntimeTargets(db)) {
    // degraded 是短暂的状态，不进这一节（见文件开头）。
    if (entry.status !== "unavailable") continue;
    const target = byRuntime.get(entry.runtime)
      ?? { runtime: entry.runtime, catalog: "unknown" as const, models: 0, problems: [] };
    byRuntime.set(entry.runtime, target);
    target.problems.push({
      model: incidentModel(entry),
      code: entry.incident?.code ?? null,
      needs: entry.incident?.needs ?? null,
      incidentId: entry.incident_id,
    });
  }
  return [...byRuntime.values()].sort((a, b) => a.runtime.localeCompare(b.runtime));
}

/** 读各数据源，拼出快照。每个数据源读不到时只影响它自己那一部分。 */
export function collectLeadEnvironment(sources: LeadEnvironmentSources): LeadEnvironmentSnapshot {
  let lead: LeadEnvironmentSnapshot["lead"];
  try {
    lead = { model: sources.leadModel(), models: loadLeadModelConfig(sources.dataDir, sources.env).models, configProblem: null };
  } catch (error) {
    lead = { model: attempt(sources.leadModel, null), models: [], configProblem: errorMessage(error) };
  }
  const daemon = attempt(() => sources.daemon?.() ?? null, null);
  const decision = daemon?.decisionModel ?? null;
  const memory = daemon?.memory ?? null;
  return {
    lead,
    smartModel: attempt(sources.smartModel, null),
    decisionModel: decision ? {
      model: decision.model, host: decision.apiKeyHost, keySet: decision.apiKeySet, problem: decision.problem,
    } : null,
    memory: memory ? {
      state: memory.service.state, backend: memory.service.backend, reranker: memory.reranker.effective,
      index: memory.service.index ?? null,
    } : null,
    runtimes: attempt(() => runtimes(sources.db, sources.env ?? process.env), null),
    connections: sources.connections
      ? attempt(() => sources.connections!.list().map((item) => ({
        label: item.label,
        // 暂时连不上是短暂的状态，按已连接列（见文件开头）。
        state: item.state === "degraded" ? "connected" : item.state,
      })), null)
      : null,
  };
}

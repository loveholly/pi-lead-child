import { join, sep } from "node:path";
import type { LeadEngine } from "./engine.js";
import {
  SOL_PI_ENTRY_ENV, solPiPinnedCommit, solPiSettings, solPiSource, type SolPiSettings,
} from "@pi-lead-child/engine";
import { envConfigPath, packageSource } from "@pi-lead-child/core";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { createLeadToolset, GRANT_GATED_LEAD_TOOLS, type LeadDeps } from "./tools.js";
import { LEAD_CODEMODE_INLINE_BUDGET, LEAD_CODEMODE_TOOLS } from "./tool-exposure.js";
import { CONNECTION_QUIET_TOOLS } from "./connection-tools.js";
import { renderLeadSystemPrompt } from "./prompt.js";
import { IDENTITY_SECTION, renderLeadIdentity } from "./identity.js";
import { designPreferencesFields } from "@pi-lead-child/protocol";
import { APPEARANCE_SECTION, renderAppearance } from "./appearance.js";
import { REPLY_STYLE_SECTION, renderReplyStyle } from "./reply-style.js";
import { credentialGuardExtension, knownSecretValues } from "./credential-guard.js";
import { applyLeadCompactionReserve } from "./compaction-settings.js";
import { costSignalsExtension } from "./cost-signals.js";
import {
  getDesignPreferences, getLeadProfile, getReplyStyle, leadProfileFields, recordDecisionModelCall, renderCoreMemory, renderStandingOrdersForLead,
} from "@pi-lead-child/store";
import { leadHasCapability } from "@pi-lead-child/store";
import {
  collectLeadEnvironment, ENVIRONMENT_SECTION, renderEnvironmentDetails, renderLeadEnvironment, type LeadDaemonEnvironment,
} from "./environment.js";
import { hideHomeInPrompt } from "./home-paths.js";
import {
  loadLeadModelConfig,
  parseModelName,
  registerLeadProviders,
  resolveLeadModel,
  selectedLeadModelSpec,
} from "./model-config.js";
import { createLeadSmartModel } from "./smart-model.js";
import { createCredibilityExtension } from "./credibility/extension.js";
import { LEAD_CODEMODE_TOOL, LEAD_HAND_TOOLS, leadHandsExtension } from "./hands.js";
import { handbookGuardExtension } from "./handbook-guard.js";
import { TurnEvidence } from "./credibility/evidence.js";
import type { CreateSmartModelOptions, SmartTextComplete } from "@pi-lead-child/engine";

export { parseModelName } from "./model-config.js";

// lead 可用的内置只读工具（read/grep/find/ls）。动手的 bash、edit、write 和 codemode 另列（hands.ts，
// lead-tools-and-routing spec D5）：bash 在沙箱里跑，edit、write 只能写 Lead 的临时目录和 plc 的隔离 worktree。
export const LEAD_BUILTIN_TOOLS = ["read", "grep", "find", "ls"] as const;
// Lead 的全部内置工具：只读的四个、动手的三个和 codemode。
export const LEAD_ALL_BUILTIN_TOOLS: readonly string[] = [...LEAD_BUILTIN_TOOLS, ...LEAD_HAND_TOOLS, LEAD_CODEMODE_TOOL];

// Lead 自带的 skill 目录：每个子目录一个 SKILL.md。daemon 打包以后也从仓库里的源码目录读（packageSource）。
export const LEAD_SKILLS_DIR = packageSource("lead", "skills");

/** 这个 skill 是不是 Lead 自带的（在 LEAD_SKILLS_DIR 下）。 */
export function isLeadOwnSkill(filePath: string): boolean {
  return filePath.startsWith(LEAD_SKILLS_DIR + sep);
}

/**
 * pi 加载完 skill 以后的一道过滤（2026-10-28，文档「按需加载方案」，用户定的）：用户装的 skill 标成不让模型自己调用，
 * pi 就不把它们列进系统提示词的 skills 一节（每一轮约 3 万字符）。它们照样加载，Lead 用 find_skill 找（skill-tools.ts）。
 * Lead 自带的照常列出。不改用户的 skill 文件，用户在 Claude Code、Codex 里用它们不受影响。
 */
export function hideUserSkillsFromPrompt<T extends { skills: Skill[] }>(base: T): T {
  return { ...base, skills: base.skills.map((skill) => (isLeadOwnSkill(skill.filePath) ? skill : { ...skill, disableModelInvocation: true })) };
}

/** 用户给 agent 装的 skill 所在的目录（存在的）。 */
export function userSkillDirs(home: string = homedir()): string[] {
  return [join(home, ".agents", "skills"), join(home, ".claude", "skills"), join(home, ".pi", "agent", "skills")]
    .filter((dir) => existsSync(dir));
}

// 不改变任何外部状态的工具：只读的查询，以及 Lead 自己的笔记。Lead 自己发起的一轮（心跳巡检等）里只调了
// 这些、最后又没有要告诉用户的话时，会话里不留这一轮。调了别的工具（建工单、派发、改状态）的一轮要留着：
// 它的任务卡和记录要有一个轮次（发布评审 2340cac）。新加的工具缺省不在这里，宁可多留一轮。
export const LEAD_QUIET_TOOLS: ReadonlySet<string> = new Set([
  ...LEAD_BUILTIN_TOOLS,
  "resolve_workspace", "query_tickets", "get_ticket", "get_ticket_relations", "get_session_entries",
  "get_project", "get_ticket_tree", "list_learning_candidates", "get_capability", "get_runtime_health",
  "list_lead_models", "read_inbox", "read_notifications", "list_needs_user", "list_items", "list_triggers",
  "agenda", "list_approvals", "get_delegation_policy", "suggest_route",
  "get_ticket_status", "read_lead_turns", "list_standing_orders", "get_standing_order", "get_system_usage", "get_environment", "query_events",
  "get_triage_shadow_report",
  "save_note", "search_notes", "update_note", "invalidate_memory", "record_handback",
  ...CONNECTION_QUIET_TOOLS,
  // SoL-Pi 的 ObservationPack：按页读回被占位符替换掉的大工具结果。
  "obs_recall",
]);

// Lead 自己的笔记：不算验收的证据（credibility/evidence.ts）。
const NOTE_TOOLS: ReadonlySet<string> = new Set(["save_note", "search_notes", "update_note", "invalidate_memory"]);
// 不在 LEAD_QUIET_TOOLS 里、但读的是证据的工具。read_run_events 读一个 Run 实际做了什么；拒绝记录时的提示就让 Lead 用它
// （2026-10-19 发布评审：它不算证据，Lead 照提示读了仍被拒）。call_connection_tool 可能会写，但读到的结果也是证据。
// bash 跑出来的结果（例如 Lead 自己跑了测试）也是证据（lead-tools-and-routing spec D5）。
const EXTRA_EVIDENCE_TOOLS: ReadonlySet<string> = new Set(["read_run_events", "call_connection_tool", "bash"]);

/** 这个工具的结果算不算验收的证据：只读的查询和外部账号的结果算，笔记不算。 */
export function isLeadEvidenceTool(name: string): boolean {
  return EXTRA_EVIDENCE_TOOLS.has(name) || (LEAD_QUIET_TOOLS.has(name) && !NOTE_TOOLS.has(name));
}

// 这一刻该激活哪些工具。受授权的工具**注册**在 session 里（否则 setActiveToolsByName
// 无从启用它们——SDK 只认注册表里的名字），但只有拿到未撤销授权时才进入激活名单。
// 没进激活名单的工具不会出现在发给模型的工具表里，模型看不到它，也就不会去撞。
// extensionTools 是扩展注册的工具（SoL-Pi 的 obs_recall）。它们不受授权控制，总是激活。
export function leadActiveToolNames(
  db: LeadDeps["db"],
  customTools: { name: string }[],
  extensionTools: readonly string[] = [],
): string[] {
  return [
    ...customTools
      .filter((tool) => {
        // 放进 codemode 的工具不激活：激活就会被声明给模型（tool-exposure.ts）。它们照样能在 codemode 脚本里调。
        if (LEAD_CODEMODE_TOOLS.has(tool.name)) return false;
        const capability = GRANT_GATED_LEAD_TOOLS[tool.name];
        return capability === undefined || leadHasCapability(db, capability);
      })
      .map((tool) => tool.name),
    ...LEAD_ALL_BUILTIN_TOOLS,
    ...extensionTools,
  ];
}

// Lead 的 SoL-Pi 配置（PLC_LEAD_SOL_PI）。配置写错时关闭 SoL-Pi 并记一行日志：
// 省 token 不值得让 Lead 起不来。这时入口文件不加载，所以日志只能在这里记。
export function leadSolPiSettings(env: Record<string, string | undefined> = process.env): SolPiSettings {
  try {
    return solPiSettings("lead", env);
  } catch (error) {
    console.error(`[lead] sol-pi: ${error instanceof Error ? error.message : String(error)}; SoL-Pi is off`);
    return { role: "lead", features: [], reducer: null, tools: [] };
  }
}

// Lead 绑上 SoL-Pi 之后记一行成功日志：部署时据此确认 Lead 真的加载了它（2026-10-16 部署时没法确认）。
// 判据是 SoL-Pi 的工具都注册上了。行里只有机制名和固定 commit 的前 7 位，没有路径和密钥。
// 装了入口、工具却没注册上时也记一行，原因见入口文件（engine 的 registerSolPi）的日志。
export function logLeadSolPi(
  registeredTools: readonly string[], solPi: SolPiSettings, env: Record<string, string | undefined> = process.env,
): void {
  if (solPi.tools.length === 0 || !env[SOL_PI_ENTRY_ENV]?.trim()) return;
  let commit = "unpinned";
  try {
    commit = solPiPinnedCommit(solPiSource(env)).slice(0, 7);
  } catch { /* PLC_SOL_PI_SOURCE 写错时入口不会被设置，这里只是保险 */ }
  const missing = solPi.tools.filter((tool) => !registeredTools.includes(tool));
  console.error(missing.length === 0
    ? `[lead] sol-pi loaded: ${solPi.features.join(", ")} (${commit})`
    : `[lead] sol-pi not loaded: ${missing.join(", ")} not registered (${commit})`);
}

export async function createLeadSession(opts: {
  dataDir: string;
  dbPath: string;
  db: LeadDeps["db"];
  onChildDone?: LeadDeps["onChildDone"];
  onChildEvent?: LeadDeps["onChildEvent"];
  childPi?: LeadDeps["childPi"];
  runtimeRegistry?: LeadDeps["runtimeRegistry"];
  currentTurnId?: LeadDeps["currentTurnId"];
  turnOrigin?: LeadDeps["turnOrigin"];
  cancelBudgetTurnId?: LeadDeps["cancelBudgetTurnId"];
  announceLeadStatus?: LeadDeps["announceLeadStatus"];
  scheduleLeadModelRestart?: LeadDeps["scheduleLeadModelRestart"];
  ticketActionHost?: LeadDeps["ticketActionHost"];
  uiActionServices?: LeadDeps["uiActionServices"];
  pullRequestRunner?: LeadDeps["pullRequestRunner"];
  ticketSummaries?: LeadDeps["ticketSummaries"];
  ticketSummary?: LeadDeps["ticketSummary"];
  leadHealth?: LeadDeps["leadHealth"];
  memory?: LeadDeps["memory"];
  connections?: LeadDeps["connections"];
  channelCards?: LeadDeps["channelCards"];
  turnUserActions?: LeadDeps["turnUserActions"];
  leadModelQuota?: LeadDeps["leadModelQuota"];
  configSlackEmoji?: LeadDeps["configSlackEmoji"];
  decisionModel?: CreateSmartModelOptions["decisionModel"];
  // 设置页选的「直觉都用不了时问大脑的哪个模型」（config.json 的 decision.llmFallback）。每次判断时读。
  llmFallback?: () => string | null;
  // 「你运行的环境」一节里 daemon 提供的部分：决策模型的设置和记忆服务的状态（工单 13）。不给时那两行写「没有提供」。
  environment?: () => LeadDaemonEnvironment;
  // 用户给 agent 装的 skill 的目录（userSkillDirs）。daemon 的入口传；不传时只有 Lead 自带的。
  skillDirs?: string[];
}): Promise<{
  session: LeadEngine; modelName: string; syncToolAccess: () => void; reloadExtensions: () => Promise<void>;
  models: string[]; switchModel: (spec: string) => Promise<void>; reportsInputDelivery: boolean;
  // 这个会话的 SmartModel（带决策日志和 decision_model.called 事件）。建不出来时为 null。
  smartModel: LeadDeps["smartModel"];
  // 同一个便宜模型的自由文本补全（每次调用记一条 decision_model.called，带调用方的 purpose）。没有 LLM 后端时为 null。
  complete: SmartTextComplete | null;
  // SmartModel 的 LLM 后端缺省用的模型（设置页没选、或者选的注册不到时用它）。没有 LLM 后端时为 null。
  smartModelLlm: string | null;
  // 按 config.json 现在的 lead.providers 重新注册（设置 → 模型改了服务商）。
  refreshProviders: () => Promise<void>;
  // 大脑现在能不能用（首次启动引导，.scratch/onboarding）：正在用的模型有认证。
  brainReady: () => Promise<boolean>;
}> {
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const leadModels = loadLeadModelConfig(opts.dataDir);
  for (const note of await registerLeadProviders(modelRuntime, leadModels)) {
    console.error(`[lead] ${note}`);
  }
  const spec = selectedLeadModelSpec(leadModels);
  parseModelName(spec);
  const { model } = await resolveLeadModel(modelRuntime, spec);
  // SmartModel 每个会话建一次。建不出来不影响 Lead：用它的工具会退回硬规则。
  let smartModel: LeadDeps["smartModel"] = null;
  let smartModelLlm: string | null = null;
  let complete: SmartTextComplete | null = null;
  try {
    // 说明出现时就打：读 backend 时才知道决策模型能不能用，原因要排在下面那一行之前。
    const built = createLeadSmartModel({
      modelRuntime, config: leadModels, leadSpec: spec, dataDir: opts.dataDir,
      ...(opts.decisionModel ? { decisionModel: opts.decisionModel } : {}),
      ...(opts.llmFallback ? { llmFallback: opts.llmFallback } : {}),
      // 每次调用写一条 decision_model.called 事件（工单 13）：get_system_usage 的数字从事件日志来。
      // 写不进去只记一行日志，判断照常返回。
      onCall: (call) => {
        try {
          recordDecisionModelCall(opts.db, call);
        } catch (error) {
          console.error(`[lead] decision_model.called not recorded: ${(error as Error).message}`);
        }
      },
      onNote: (note) => console.error(`[lead] ${note}`),
    });
    smartModel = built.smartModel;
    smartModelLlm = built.llmSpec;
    complete = built.complete;
    const backend = smartModel?.backend ?? "none";
    console.error(`[lead] smart model: ${backend}${built.llmSpec ? ` (llm ${built.llmSpec})` : ""}`);
  } catch (error) {
    console.error(`[lead] smart model unavailable: ${(error as Error).message}`);
  }

  // 资源隔离：agentDir 指向 dataDir 下的空目录，避免加载用户全局 extensions/AGENTS.md
  const isolatedAgentDir = join(opts.dataDir, "agent");
  mkdirSync(isolatedAgentDir, { recursive: true });
  // 常驻核心记忆（spec §A2）：session 创建时取一次、冻结进系统提示词。
  // 压缩会丢失系统提示词后的历史，故 compaction 后由 daemon 下一轮前缀重注入（server.ts）。
  // 常设指令清单（工单 05）：标题和版本，完整内容用 get_standing_order 查。第 1 期 Lead 只读，指令只在 daemon 启动时由系统同步，
  // 所以会话建立时取一次就是现在的清单。
  const systemPrompt = renderLeadSystemPrompt(renderCoreMemory(opts.db), renderStandingOrdersForLead(opts.db));
  // 内置的 SoL-Pi（engine 的 extension/sol-pi.ts）。Lead 只开 ObservationPack：
  // 大的工具结果发两次之后换成占位符，Lead 需要时用 obs_recall 按页读回。
  // 入口文件经 pi 的扩展加载器加载，它再 import pi 包管理器装好的 SoL-Pi（PLC_SOL_PI_ENTRY）。
  // 没装时入口文件什么也不做。
  const solPi = leadSolPiSettings();
  // 「你运行的环境」一节（工单 13，spec D17）：放进系统提示的 environment 节。2026-10-30 起它只写组件、能力和用什么查，
  // 不含现在的值，不随配置和状态变；现在的值由 get_environment 现查（environmentDetails，environment.ts 开头）。
  // 生成出错时沿用上一次的文字：这一节缺席时，pi 会当作删掉它。
  let environmentText: string | null = null;
  // 你正在用的模型：每一轮开头从 pi 的 ctx 取，get_environment 用它。
  let currentLeadModel: string | null = `${model.provider}/${model.id}`;
  const environmentDetails = () => renderEnvironmentDetails(collectLeadEnvironment({
    db: opts.db,
    dataDir: opts.dataDir,
    leadModel: () => currentLeadModel,
    smartModel: () => (smartModel ? { backend: smartModel.backend, llm: smartModelLlm } : null),
    connections: opts.connections ?? null,
    daemon: opts.environment ?? null,
  }));
  // identity 一节（identity.ts）：名字、人格和互动风格，设置页改了以后下一轮生效。读不到时沿用上一次的文字。
  let identityText: string | null = null;
  // appearance 一节（appearance.ts）：界面的外观偏好和用户的设计说明。
  let appearanceText: string | null = null;
  // reply-style 一节（reply-style.ts）：用户的代回复风格。框是空的时候没有这一节（renderReplyStyle 返回 null）。
  // 读不到时沿用上一次的文字。
  let replyStyleText: string | null = null;
  const environmentExtension: ExtensionFactory = (pi) => {
    pi.on("before_agent_start", (event, ctx) => {
      try {
        identityText = renderLeadIdentity(leadProfileFields(getLeadProfile(opts.db)));
      } catch (error) {
        console.error(`[lead] identity section not refreshed: ${(error as Error).message}`);
      }
      if (identityText) event.systemPromptOptions.sections[IDENTITY_SECTION] = identityText;
      try {
        appearanceText = renderAppearance(designPreferencesFields(getDesignPreferences(opts.db)));
      } catch (error) {
        console.error(`[lead] appearance section not refreshed: ${(error as Error).message}`);
      }
      if (appearanceText) event.systemPromptOptions.sections[APPEARANCE_SECTION] = appearanceText;
      try {
        replyStyleText = renderReplyStyle(getReplyStyle(opts.db).text);
      } catch (error) {
        console.error(`[lead] reply-style section not refreshed: ${(error as Error).message}`);
      }
      if (replyStyleText) event.systemPromptOptions.sections[REPLY_STYLE_SECTION] = replyStyleText;
      if (ctx.model) currentLeadModel = `${ctx.model.provider}/${ctx.model.id}`;
      try {
        environmentText = renderLeadEnvironment();
      } catch (error) {
        console.error(`[lead] environment section not refreshed: ${(error as Error).message}`);
      }
      if (environmentText) event.systemPromptOptions.sections[ENVIRONMENT_SECTION] = environmentText;
    });
  };
  // 凭证防护（credential-guard.ts，2026-10-19 审查）：read、grep、find、ls 读不到凭证文件，结果里的密钥被盖掉。
  // 已知密钥的值（环境变量和 config.json 的 env 段）缓存一分钟：每个工具结果都要用，config.json 可能被设置页改了。
  let secretCache: { values: readonly string[]; at: number } | null = null;
  const secretValues = () => {
    if (!secretCache || Date.now() - secretCache.at > 60_000) {
      secretCache = { values: knownSecretValues(process.env, envConfigPath(opts.dataDir)), at: Date.now() };
    }
    return secretCache.values;
  };
  const credentialGuard = credentialGuardExtension({
    cwd: opts.dataDir, secretValues, log: (line) => console.error(line),
  });
  // 可信度检查（2026-10-19，credibility/extension.ts）：发出去的文字里的代码引用先核对；这一轮读过什么记下来，
  // record_decision 和 ticket_action 的验收（complete）把它附进记录。笔记是 Lead 自己写的，不算证据。
  const evidence = new TurnEvidence();
  const credibilityExtension = createCredibilityExtension({
    db: opts.db,
    evidence,
    isEvidenceTool: isLeadEvidenceTool,
    connectionToolReadOnly: (connection, tool) => {
      try {
        return opts.connections?.toolDtos(connection).find((entry) => entry.name === tool)?.readOnly ?? null;
      } catch {
        return null;
      }
    },
    log: (line) => console.error(`[lead] ${line}`),
  });
  // 和 createAgentSession 缺省建的一样（同一个 cwd、agentDir），只是先调好 Lead 的压缩参数（compaction-settings.ts）。
  const settingsManager = SettingsManager.create(opts.dataDir, isolatedAgentDir);
  applyLeadCompactionReserve(settingsManager);
  const loader = new DefaultResourceLoader({
    cwd: opts.dataDir,
    agentDir: isolatedAgentDir,
    systemPromptOverride: () => systemPrompt,
    extensionFactories: [
      { name: "plc-environment", factory: environmentExtension, hidden: true },
      { name: "plc-credential-guard", factory: credentialGuard, hidden: true },
      { name: "plc-credibility", factory: credibilityExtension, hidden: true },
      // codemode（pi 内置的扩展，SDK 里要自己加；lead-tools-and-routing spec D5）：脚本里调别的工具，嵌套的调用照样
      // 经过上面这些钩子。它注册时不激活，leadActiveToolNames 把它放进激活名单。
      // 代价信号（cost-signals.ts，lead-self-routing spec C）：大的工具结果加一句尾注，写它有多大、上下文到哪了。
      {
        name: "plc-cost-signals", hidden: true,
        factory: costSignalsExtension({ compactAt: (window) => window - settingsManager.getCompactionSettings().reserveTokens }),
      },
      // inlineBudget 0：codemode 的说明不列不常用工具的签名，系统提示词列它们的名字（tool-exposure.ts）。
      { name: "codemode", factory: createCodemodeExtension({ inlineBudget: LEAD_CODEMODE_INLINE_BUDGET }), hidden: true },
      {
        name: "plc-hands", hidden: true,
        factory: leadHandsExtension({
          db: opts.db, dataDir: opts.dataDir,
          ...(opts.turnOrigin ? { turnOrigin: opts.turnOrigin } : {}),
          ...(opts.currentTurnId ? { currentTurnId: opts.currentTurnId } : {}),
          log: (line) => console.error(line),
        }),
      },
      // 交接说明管建编码工单（自动代你处理方案 B，issue 04，handbook-guard.ts）：外部消息叫醒的一轮里看这一句有没有改代码的能力。
      {
        name: "plc-handbook-guard", hidden: true,
        factory: handbookGuardExtension({
          db: opts.db,
          ...(opts.turnOrigin ? { turnOrigin: opts.turnOrigin } : {}),
          ...(opts.currentTurnId ? { currentTurnId: opts.currentTurnId } : {}),
          log: (line) => console.error(line),
        }),
      },
      // 系统提示词里不写用户目录的完整路径（home-paths.ts，用户 2026-10-30）。排在最后：别的扩展改完提示词以后再换。
      {
        name: "plc-home-paths", hidden: true,
        factory: (pi) => {
          pi.on("before_agent_start", (event) => hideHomeInPrompt(event.systemPromptOptions, homedir()));
        },
      },
    ],
    // Lead 自带的 skill（2026-10-19）：pi 把名字和说明列进系统提示词，Lead 要用时用 read 读全文。
    // genui-cards 讲怎样组合 render_ui 的组件（设计规范见 docs/genui-design.md）。
    // 用户给 agent 装的 skill（2026-10-28，用户：「我预期 Fairy 能正常调用……各种给它安装的 skills」）：在
    // ~/.agents/skills、~/.claude/skills、~/.pi/agent/skills。Lead 的 agentDir 是隔离的，pi 不会自己去找。
    // 自带的排在前面：重名时 pi 用先加载的那个，同一个文件的链接只算一次。
    additionalSkillPaths: [LEAD_SKILLS_DIR, ...(opts.skillDirs ?? [])],
    // 用户装的 skill 不列进系统提示词，用 find_skill 找（hideUserSkillsFromPrompt）。
    skillsOverride: hideUserSkillsFromPrompt,
    ...(solPi.features.length > 0
      ? { additionalExtensionPaths: [packageSource("engine", "extension", "sol-pi-lead.ts")] }
      : {}),
  });
  await loader.reload();
  for (const error of loader.getExtensions().errors) {
    console.error(`[lead] extension ${error.path}: ${error.error}`);
  }

  const toolDeps: LeadDeps = {
    db: opts.db, dbPath: opts.dbPath, dataDir: opts.dataDir,
    userSkills: () => loader.getSkills().skills
      .filter((skill) => !isLeadOwnSkill(skill.filePath))
      .map((skill) => ({ name: skill.name, description: skill.description, filePath: skill.filePath })),
    ...(opts.onChildDone ? { onChildDone: opts.onChildDone } : {}),
    ...(opts.onChildEvent ? { onChildEvent: opts.onChildEvent } : {}),
    ...(opts.childPi ? { childPi: opts.childPi } : {}),
    ...(opts.runtimeRegistry ? { runtimeRegistry: opts.runtimeRegistry } : {}),
    ...(opts.currentTurnId ? { currentTurnId: opts.currentTurnId } : {}),
    ...(opts.turnOrigin ? { turnOrigin: opts.turnOrigin } : {}),
    ...(opts.cancelBudgetTurnId ? { cancelBudgetTurnId: opts.cancelBudgetTurnId } : {}),
    ...(opts.announceLeadStatus ? { announceLeadStatus: opts.announceLeadStatus } : {}),
    ...(opts.scheduleLeadModelRestart ? { scheduleLeadModelRestart: opts.scheduleLeadModelRestart } : {}),
    ...(opts.ticketActionHost ? { ticketActionHost: opts.ticketActionHost } : {}),
    ...(opts.uiActionServices ? { uiActionServices: opts.uiActionServices } : {}),
    ...(opts.pullRequestRunner ? { pullRequestRunner: opts.pullRequestRunner } : {}),
    ...(opts.ticketSummaries ? { ticketSummaries: opts.ticketSummaries } : {}),
    ...(opts.ticketSummary ? { ticketSummary: opts.ticketSummary } : {}),
    ...(opts.leadHealth ? { leadHealth: opts.leadHealth } : {}),
    ...(smartModel ? { smartModel } : {}),
    ...(opts.memory ? { memory: opts.memory } : {}),
    ...(opts.connections ? { connections: opts.connections } : {}),
    ...(opts.channelCards ? { channelCards: opts.channelCards } : {}),
    turnEvidence: () => evidence.list(),
    environmentDetails,
    ...(opts.turnUserActions ? { turnUserActions: opts.turnUserActions } : {}),
    ...(opts.leadModelQuota ? { leadModelQuota: opts.leadModelQuota } : {}),
    ...(opts.configSlackEmoji ? { configSlackEmoji: opts.configSlackEmoji } : {}),
  };
  // 受授权的工具一并注册（否则授权到来时无从启用），但激活与否由账本里的授权决定。
  // 包一层自动登记等待（wait-tools.ts）：工具返回「需要用户做什么」时系统登记，用户做了就叫醒 Lead。
  const customTools = createLeadToolset(toolDeps);

  const { session } = await createAgentSession({
    cwd: opts.dataDir,
    agentDir: isolatedAgentDir,
    settingsManager,
    model,
    modelRuntime,
    resourceLoader: loader,
    // tools 是名字 allowlist（string[]）。
    // 必须把自定义工具名一并列入，否则连 customTools 都会被禁用。
    // 只读四件套用来取证和核对；bash、edit、write 和 codemode 让 Lead 自己动手（hands.ts）。
    //
    // 受授权的工具也必须出现在这里。实测（session.getAllTools()）：**注册表就是这份
    // allowlist**——不在 tools 里的 customTool 根本没被注册，后续 setActiveToolsByName
    // 也启用不了它（"Only tools in the registry can be enabled"，未注册的名字被静默忽略）。
    // 所以这里注册全集，紧接着由 syncToolAccess 把没授权的那些**取消激活**。
    tools: [...customTools.map((t) => t.name), ...LEAD_ALL_BUILTIN_TOOLS, ...solPi.tools],
    customTools,
    // lead 长期会话：续接最近一次，持久化在 dataDir/lead-sessions
    sessionManager: SessionManager.continueRecent(opts.dataDir, join(opts.dataDir, "lead-sessions")),
  });
  // 用户排队的消息（工单 04，spec D6）：Lead 答完这一轮后，连着排队的几条一起放进同一轮。
  session.setFollowUpMode("all");
  // SoL-Pi 在 session_start 里注册它的工具和钩子。SDK 会话只在 bindExtensions 时发 session_start。
  await session.bindExtensions({
    onError: (error) => console.error(`[lead] extension ${error.extensionPath} ${error.event}: ${error.error}`),
  });

  const syncToolAccess = () =>
    session.setActiveToolsByName(leadActiveToolNames(opts.db, customTools, solPi.tools));
  // 注册完立刻收一次：没有授权时 confirm_item 虽然在注册表里，但不能出现在发给模型的
  // 工具表里——"看得到却用不了"会让模型反复去撞一扇锁着的门。
  syncToolAccess();
  logLeadSolPi(session.getAllTools().map((tool) => tool.name), solPi);

  return {
    session,
    modelName: `${model.provider}/${model.id}`,
    // 授权变动后由 daemon 调一次：撤销要让工具当场从工具表里消失，而不是等下次重启。
    // setActiveToolsByName 会顺带重建系统提示词里的工具清单（SDK 文档），
    // 所以模型下一轮看到的就是新的权限面。
    syncToolAccess,
    // 在正在运行的会话里重新加载扩展，不重建会话（2026-10-16 用户要求：SoL-Pi 装好后不用重启 daemon）。
    // pi 的 reload 重新运行扩展入口（sol-pi-lead.ts 这时读得到 PLC_SOL_PI_ENTRY），保留会话、上下文和工具表，
    // 再发一次 session_start，SoL-Pi 在那里注册 obs_recall。reload 会把扩展的工具全部激活，所以再按授权收一次。
    // 只能在 Lead 空闲时调：daemon 在两轮之间调它。
    reloadExtensions: async () => {
      await session.reload();
      // reload 重读了设置文件，Lead 的压缩参数要再调一次。
      applyLeadCompactionReserve(settingsManager);
      syncToolAccess();
      logLeadSolPi(session.getAllTools().map((tool) => tool.name), solPi);
    },
    // 模型切换（spec D9，model-failover.ts）：限流或者连续溢出时，daemon 按这个顺序换模型。第一个是正在用的。
    models: [...new Set([spec, ...leadModels.models])],
    // 在会话里换模型，不改 config.json（setModel 不带 persist），也不重启：限流过去以后 daemon 再换回第一个。
    // 输入框里选的新模型（例如带推理强度的 as4/claude-sonnet-5(high)）启动时没有注册：照 config.json 现在的样子重新注册一次。
    switchModel: async (next: string) => {
      const { provider, id } = parseModelName(next);
      if (!modelRuntime.getModel(provider, id)) {
        for (const note of await registerLeadProviders(modelRuntime, loadLeadModelConfig(opts.dataDir))) {
          console.error(`[lead] ${note}`);
        }
      }
      const { model: resolved } = await resolveLeadModel(modelRuntime, next);
      await session.setModel(resolved);
    },
    // pi 的会话在把插话和排队消息送进模型的上下文时发 message_start（agent-session.js 的 _handleAgentEvent）。
    reportsInputDelivery: true,
    smartModel,
    complete,
    smartModelLlm,
    // 设置 → 模型改了服务商（2026-10-29）：照 config.json 现在的样子重新注册。正在用的模型由 daemon 再挂一次（switchModel）。
    refreshProviders: async () => {
      for (const note of await registerLeadProviders(modelRuntime, loadLeadModelConfig(opts.dataDir))) {
        console.error(`[lead] ${note}`);
      }
    },
    // 和 pi 发 prompt 前的检查一样（agent-session 的 hasConfiguredAuth / checkAuth）：环境变量里的 key 也算。
    brainReady: async () => {
      const current = session.model;
      if (!current) return false;
      return modelRuntime.hasConfiguredAuth(current.provider) || (await modelRuntime.checkAuth(current.provider)) !== undefined;
    },
  };
}

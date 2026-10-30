import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chmodSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Item } from "./types.js";

// 向上找 monorepo 的根：第一个声明了 workspaces 的 package.json 所在的目录（可测纯函数）。
// 各包自己的 package.json 没有 workspaces，所以会被跳过。找不到抛错。
export function findWorkspaceRoot(startDir: string): string {
  let dir = startDir;
  while (!declaresWorkspaces(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("projectRoot: no package.json with workspaces found upward");
    dir = parent;
  }
  return dir;
}

function declaresWorkspaces(manifest: string): boolean {
  if (!existsSync(manifest)) return false;
  try {
    return Array.isArray((JSON.parse(readFileSync(manifest, "utf8")) as { workspaces?: unknown }).workspaces);
  } catch {
    return false;
  }
}

// 仓库根定位：向上找 monorepo 根。不能用固定 "../.."——源码在 packages/core/src，打包后在
// apps/daemon/dist，深度不同（实坑预防）。
// 注意：dist/ 产物不可脱离仓库单独部署——externals（better-sqlite3/pi SDK）运行时依赖仓库 node_modules。
let cachedRoot: string | undefined;
export function projectRoot(): string {
  if (cachedRoot) return cachedRoot;
  return (cachedRoot = findWorkspaceRoot(dirname(fileURLToPath(import.meta.url))));
}

// 某个工作区包的目录。可运行的程序在 apps/，库在 packages/。先找 apps/，找不到再用 packages/。
// 判断依据是 package.json，不是目录：包搬走后，旧目录里可能还留着被 git 忽略的 dist/。
export function workspaceDir(name: string): string {
  const app = join(projectRoot(), "apps", name);
  return existsSync(join(app, "package.json")) ? app : join(projectRoot(), "packages", name);
}

// daemon 包的构建产物目录。launchd、launcher 垫片、mcp-server 和 web UI 都从这里加载。
export function distDir(): string {
  return join(workspaceDir("daemon"), "dist");
}

// 某个包的源码文件。dist 不存在或 PLC_DEV=1 时，进程入口用 tsx 直接跑源码。
export function packageSource(pkg: string, ...segments: string[]): string {
  return join(workspaceDir(pkg), "src", ...segments);
}

export function dataDir(): string {
  const dir = process.env.PLC_DATA_DIR ?? join(homedir(), ".pi-lead-child");
  // 账本、config.json 和本机 socket 都在这里：没有时以 0700 创建，只给本机这个用户。
  // 已有目录由 daemon 和 supervisor 在 listen 本机 socket 之前收紧（listenOwnerOnly）。
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
export function dbPath(): string {
  return join(dataDir(), "plc.db");
}
export function sessionDir(itemId: number): string {
  return join(dataDir(), "sessions", `item-${itemId}`);
}

export function agentMcpServer(): { command: string; args: string[] } {
  const built = join(distDir(), "mcp-server.mjs");
  if (!process.env.PLC_DEV && existsSync(built)) {
    return { command: process.execPath, args: [built] };
  }
  return {
    command: join(projectRoot(), "node_modules", ".bin", "tsx"),
    args: [packageSource("engine", "agent-tools", "mcp-server.ts")],
  };
}

export interface CheckpointPolicyConfig {
  dedupeWindowMs: number;
  progressMinIntervalMs: number;
  silenceMs: number;
  silenceToolEvents: number;
  silenceDomainEvents: number;
  reminderCooldownMs: number;
}

export const CHECKPOINT_POLICY_DEFAULTS: CheckpointPolicyConfig = {
  dedupeWindowMs: 60_000,
  progressMinIntervalMs: 120_000,
  silenceMs: 900_000,
  silenceToolEvents: 8,
  silenceDomainEvents: 3,
  reminderCooldownMs: 900_000,
};

export const ARTIFACT_ORPHAN_GRACE_MS_DEFAULT = 86_400_000;

export interface ArtifactStorageConfig {
  orphanGraceMs: number;
}

function positiveIntegerEnv(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function loadCheckpointPolicyConfig(
  env: Record<string, string | undefined> = process.env,
): CheckpointPolicyConfig {
  return {
    dedupeWindowMs: positiveIntegerEnv(
      env, "PLC_CHECKPOINT_DEDUPE_WINDOW_MS", CHECKPOINT_POLICY_DEFAULTS.dedupeWindowMs,
    ),
    progressMinIntervalMs: positiveIntegerEnv(
      env,
      "PLC_CHECKPOINT_PROGRESS_MIN_INTERVAL_MS",
      CHECKPOINT_POLICY_DEFAULTS.progressMinIntervalMs,
    ),
    silenceMs: positiveIntegerEnv(
      env, "PLC_CHECKPOINT_SILENCE_MS", CHECKPOINT_POLICY_DEFAULTS.silenceMs,
    ),
    silenceToolEvents: positiveIntegerEnv(
      env,
      "PLC_CHECKPOINT_SILENCE_TOOL_EVENTS",
      CHECKPOINT_POLICY_DEFAULTS.silenceToolEvents,
    ),
    silenceDomainEvents: positiveIntegerEnv(
      env,
      "PLC_CHECKPOINT_SILENCE_DOMAIN_EVENTS",
      CHECKPOINT_POLICY_DEFAULTS.silenceDomainEvents,
    ),
    reminderCooldownMs: positiveIntegerEnv(
      env,
      "PLC_CHECKPOINT_REMINDER_COOLDOWN_MS",
      CHECKPOINT_POLICY_DEFAULTS.reminderCooldownMs,
    ),
  };
}

// Trigger / Notification 层的两个阈值（spec §4、§10）。
export const TRIGGER_MAX_FAILURES_DEFAULT = 5;
export const NOTIFY_FALLBACK_MS_DEFAULT = 120_000;

export function triggerMaxFailures(
  env: Record<string, string | undefined> = process.env,
): number {
  return positiveIntegerEnv(env, "PLC_TRIGGER_MAX_FAILURES", TRIGGER_MAX_FAILURES_DEFAULT);
}

// urgency='immediate' 的通知 pending 超过这个窗口仍未 delivered，系统直接兜底推送
// 并记 delivered_via='fallback'——lead 挂了、卡住了、判断失误，用户照样收得到。
export function notifyFallbackMs(
  env: Record<string, string | undefined> = process.env,
): number {
  return positiveIntegerEnv(env, "PLC_NOTIFY_FALLBACK_MS", NOTIFY_FALLBACK_MS_DEFAULT);
}

export function loadArtifactStorageConfig(
  env: Record<string, string | undefined> = process.env,
): ArtifactStorageConfig {
  return {
    orphanGraceMs: positiveIntegerEnv(
      env,
      "PLC_ARTIFACT_ORPHAN_GRACE_MS",
      ARTIFACT_ORPHAN_GRACE_MS_DEFAULT,
    ),
  };
}

// 凭证与环境配置（spec §B2）：config.json 的 env 段。value 直接给值，fromEnv 间接引用环境变量名。
// 优先级：config.json > 进程环境变量；config 未覆盖的 key 保持 env 原值。密钥不进 plc.db / plist。
export interface EnvSpec { value?: string; fromEnv?: string }

export function envConfigPath(dir: string = dataDir()): string {
  return join(dir, "config.json");
}

export interface PlcConfigFile {
  env?: Record<string, EnvSpec>;
  lead?: {
    providers?: Record<string, unknown>;
    models?: string[];
    // Lead 的当前局面（2026-10-19）。idleTicketHours：多久没有动静的工单折叠成一行，缺省 72。
    situation?: { idleTicketHours?: number };
    // 额度按周重置的一类模型（2026-10-19，lead 的 model-failover.ts）：额度用尽后，下一次重置以前跳过模型名里含 match 的模型。
    // 例如 [{ "match": "claude-", "weekday": 1, "time": "16:00" }]：每周一 16:00（本机时区）重置。不写时用这一条。
    quotaResets?: Array<{ match: string; weekday: number; time: string }>;
  };
  // Lead 的记忆（设置页「Lead → 记忆」，daemon 的 memory-controller.ts）。不含密钥：密钥加密存在保险库里。
  memory?: PlcMemoryConfig;
  // 决策模型（设置页「Lead → 模型」的「直觉」）：TypeSafe 的 Jev，或者用户自建的兼容端点。SmartModel 和记忆的 reranker 共用。
  // 旧的写法只有 baseUrl、model（一条）。2026-10-29 起可以配多条（models），chain 是分工（第一个主用，后面最多 3 个备用），
  // llmFallback 是都用不了时问 Lead 的哪个模型（provider/model，可以带推理强度）。没有 models 时把 baseUrl、model 读成 id 为 jev 的一条
  // （apps/daemon 的 decision-models.ts）。
  decision?: {
    baseUrl?: string;
    model?: string;
    models?: Array<{ id: string; name: string; baseUrl: string; model: string }>;
    chain?: string[];
    llmFallback?: string | null;
  };
  // 执行器（设置页「执行器」，2026-10-19）：disabled 是停用的 runtime id。daemon 启动时和设置改了以后
  // 把它写进 PLC_DISABLED_RUNTIMES（apps/daemon 的 runtime-settings.ts），内核从环境变量读。手改这里要重启 daemon。
  // disabledBy（2026-10-22，Lead 也能停用）：谁停用的、为什么、什么时候。没有这一项的停用当作用户停用的。
  runtimes?: { disabled?: string[]; disabledBy?: Record<string, RuntimeDisabledBy> };
  // 外部通道。daemon 启动时读一次，改了要重启 daemon。
  channels?: PlcChannelsConfig;
}

// 一个执行器是谁停用的（config.json 的 runtimes.disabledBy）。Lead 只能重新启用自己停用的（runtime-settings.ts）。
export interface RuntimeDisabledBy {
  by: "user" | "lead";
  reason: string | null;
  at: string;
}

// 谁拨的执行器开关。设置页总是用户；Lead 经过操作层（engine 的 ui-actions/，runtime 的 disable、enable）拨，写原因。
// onBehalfOf：Lead 在用户本人这一轮里代他做（操作层核对过那一轮），启用用户停用的执行器要它。
export type RuntimeSwitchBy =
  | { actor: "user" }
  | { actor: "lead"; reason: string; onBehalfOf?: { actor: "user"; sourceTurnId: string } };

export interface PlcChannelsConfig {
  // 披露署名里的主人名：来源里取不到名字时用（slack-takeover spec D8）。
  ownerName?: string;
  // 披露署名里的助手名，也是建 Slack 应用的清单里的应用名（Slack 在代发的消息下面写「Sent using @<应用名>」）。
  // 不写时用 Lead 的名字（设置 → 身份与风格，2026-10-22；以前缺省是 Fairy）。
  assistantName?: string;
  // 代查扫描本地仓库的根目录（缺省 ~/Workspace，两层以内的 git 仓库；spec D5）。
  lookup?: { localRoots?: string[] };
  slack?: {
    // 记忆沉淀（slack-takeover 工单 07，spec D12）。exclude：不订阅、不沉淀的频道，写频道编号或者频道名（带不带 # 都行）。
    memory?: { exclude?: string[] };
    // 署名里助手名前面的 emoji，写 Slack 的短代码（自定义 emoji 要在工作区里有，否则 Slack 原样显示短代码）。缺省 ":robot_face:"；写 "" 不加。
    assistantEmoji?: string;
  };
}

export interface PlcMemoryConfig {
  embedding?: {
    // unset：还没选。这时有远程配置就用远程，否则只用 SQLite 全文检索。
    mode?: "unset" | "local" | "remote";
    local?: { model?: string };
    remote?: { baseUrl: string; model: string; dimensions?: number | null };
  };
  reranker?: {
    mode?: "decision" | "local" | "none";
    local?: { model?: string };
    // 用决策模型做 reranker 时，每次召回最多发给它多少条候选记忆（1–300，缺省 50）。
    maxCandidates?: number;
  };
  // Hindsight 的摘要模型（设置 → 记忆，2026-10-29）：每个槽存一个 Lead 的 provider/id。没有时缺省槽自动选
  // （最新的 haiku），整理观察槽跟缺省一样。key 不在这里：daemon 按服务商解析。
  llm?: { default?: string | null; consolidation?: string | null };
}

export function loadPlcConfig(dir: string = dataDir()): PlcConfigFile {
  const path = envConfigPath(dir);
  if (!existsSync(path)) return {};
  let conf: unknown;
  try {
    conf = JSON.parse(readFileSync(path, "utf8"));
  } catch (e: any) {
    throw new Error(`config.json 解析失败（${path}）: ${e.message}`);
  }
  // JSON.parse("null")/"[]"/'"str"' 都是合法 JSON 但顶层不是对象，conf.env 访问会静默拿到 undefined
  // 或在下游（如 doctor 的 broken 探测）抛出裸 TypeError——顶层结构错误必须在这里就报友好错误。
  if (conf === null || typeof conf !== "object" || Array.isArray(conf)) {
    throw new Error(`config.json 格式错误（${path}）: 顶层必须是对象`);
  }
  return conf as PlcConfigFile;
}

export function writePlcConfig(conf: PlcConfigFile, dir: string = dataDir()): string {
  const path = envConfigPath(dir);
  mkdirSync(dir, { recursive: true });
  const content = `${JSON.stringify(conf, null, 2)}\n`;
  writeFileSync(path, content, { encoding: "utf8" });
  chmodSync(path, 0o600);
  writtenConfigHashes.set(path, plcConfigHash(content));
  return path;
}

// 这个进程最后一次经 writePlcConfig 写下的 config.json 内容的哈希（按路径）。daemon 的 config 核对用它区分
// 「daemon 自己改的」（设置页、Lead 换模型）和「别的进程直接改的」（2026-10-19 审查：child 不能改配置）。
const writtenConfigHashes = new Map<string, string>();

export function plcConfigHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function lastWrittenPlcConfigHash(path: string): string | null {
  return writtenConfigHashes.get(path) ?? null;
}

// 单个 env 条目的取值逻辑抽成独立函数：loadEnvConfig 和 doctor 的 resolveKeyReal 都要做同一件事
// （value 优先，其次 fromEnv 间接引用），曾经两处各写一份判定逻辑，容易在改动时悄悄分叉走样。
export function resolveEnvSpec(spec: EnvSpec, env: Record<string, string | undefined>): string | undefined {
  return spec.value ?? (spec.fromEnv ? env[spec.fromEnv] : undefined);
}

export function loadEnvConfig(
  dir: string = dataDir(),
  env: Record<string, string | undefined> = process.env,
): string[] {
  const conf = loadPlcConfig(dir);
  const applied: string[] = [];
  for (const [key, spec] of Object.entries(conf.env ?? {})) {
    const val = resolveEnvSpec(spec, env);
    if (val !== undefined) { env[key] = val; applied.push(key); }
  }
  return applied;
}

// reviewer child 的初始 prompt（M5：验收去自述化——独立核查，禁改产物）
// canRunCommands=false：这个核查员只有读文件的工具（Claude Code 和 pi 当核查员时，2026-10-20）。
// 以前只有能跑命令的 Codex 能当核查员，Codex 停用以后核查一直挂着。现在换成不能跑命令的核查员，
// 提示里写明这一点：结论只基于阅读，证据里要说没有实际运行，用户才知道这次核查的分量。
// 核查的材料是系统拼好的核查包（工单 10，engine 的 review-packet.ts），由 children/manager.ts 接在这段后面：
// 编号的验收标准、brief 原文、交付快照、执行 agent 的自述，复核时加上次的逐条结论。这里只写身份、纪律和怎么交结论。
// 以前这里放 brief 和工单正文：#102 的正文是空的，核查员只能从零开始找改了什么。
export function buildReviewerPrompt(
  t: Pick<Item, "id" | "title">,
  options: { canRunCommands?: boolean } = {},
): string {
  const readOnly = options.canRunCommands === false
    ? [
        "## 这次核查不能运行命令",
        "- 你只有读文件的工具，不能运行测试、构建或任何命令。不要尝试运行，也不要声称运行过。",
        "- 结论只基于阅读代码、产物和核查包。要运行才能确认的标准，结论写 unverifiable（无法核实），证据里说明要运行什么。",
        "- 核查报告和 review_verdict 的 evidence 里写明：这次核查没有实际运行测试或命令，结论来自阅读。",
      ].join("\n")
    : "";
  return [
    `你是工单 #${t.id}（${t.title}）的独立审查 agent。执行 child 声称任务已完成，你的职责是独立核查，不轻信任何自述。`
      + "核查的材料在下面的「核查包」一节，由系统拼好。",
    [
      "## 核查纪律",
      "- 独立核查一切可验证的声称：产物文件真实存在且内容符合标准。核查包里执行 agent 的成果说明是待核实的自述，不能直接当证据。",
      "- 跑什么、跑多少按改动判断，不要动不动就跑全量（用户 2026-10-29：「负责 review 的应该要灵活变通」）：",
      "  - 只改了文档、PR 描述、注释、文案这类不影响运行的内容：不跑测试，核对内容就行。",
      "  - 改了代码：跑和改动有关的测试（改到的模块、直接调用它的地方），能说明标准是否达到就够。",
      "  - 改了依赖、构建配置或公共的底层代码：这时才跑全量。",
      "  - 执行 agent 在同一个提交上已经跑过、核查包里有命令和结果的：挑和验收标准最相关的一两条复现，不整套重跑。",
      "  - 不要另起一份 master 副本跑全量基线。要证明某个失败原来就有时，只在基线上跑那几条失败的。",
      "  - 没跑的写明为什么不跑；结论要靠运行才能确认、你又判断不值得跑时，写 unverifiable，不写通过。",
      "- **禁止修改任何产物文件**。你只读取、运行、验证，不修复不优化。发现问题如实记录，修复是执行 child 的事。",
      "- 核查完成后调用 ticket_update，body_append 以'【独立核查报告】'开头：逐条列出验收标准的核查结果",
      "  （通过/不通过/无法核实 + 实证依据），最后给出总结论。**不要带 status 参数**——验收决定权在 lead。",
      "- 核查报告和 review_verdict 的 evidence 是给用户看的，用中文写。命令、文件路径、代码标识符和报错原文保持原样，不要翻译。",
      "- 发现严重问题（产物缺失、测试失败、与自述严重不符）→ 额外 notify_lead(severity='blocker')。",
    ].join("\n"),
    [
      "## 怎么交结论（review_verdict）",
      "同时调用 review_verdict 提交结构化结论。手动验收的工单由用户决定，托管的工单由系统据此推进。",
      "- criteria：核查包里的每一条验收标准一项 {id, result, evidence}。result 是 pass（通过）、fail（不通过）或"
        + " unverifiable（无法核实）。每一条都要写证据。没有结构化的验收标准时传空数组。",
      "- verdict：总结论 pass 或 fail。有一条不通过时总结论只能是 fail。",
      "- evidence：总结论的证据。",
      "- escalate（可选）：只在需要用户决定、不能让托管自动验收或自动返工时给。reason 选一个：evidence_conflict（证据互相矛盾）、"
        + "requirement_change（做的事和任务说明不一样，像是需求变了）、irreversible_action（交付里有不可逆的操作）、"
        + "external_approval（要外部的批准才能继续）；note 写一句说明。系统只看这个字段，不看证据里的字眼。",
    ].join("\n"),
    readOnly,
  ].filter(Boolean).join("\n\n");
}

// child 初始 prompt（DESIGN §6.1/§6.3：brief + 正文 + 纪律；不塞历史 session）
// leadName：用户给 Lead 起的名字（设置 → 身份与风格）。给了时告诉 child：写给用户看的文字里用这个名字称呼 Lead。
export function buildChildPrompt(t: Pick<Item, "id" | "title" | "brief" | "body">, options: { leadName?: string } = {}): string {
  const parts = [
    `你是工单 #${t.id}（${t.title}）的执行 agent。`
      + (options.leadName ? `用户把 Lead 叫做 ${options.leadName}：写给用户看的文字里提到 Lead 时用这个名字。` : ""),
    `## 任务说明\n${t.brief}`,
  ];
  if (t.body) parts.push(`## 当前工单正文（此前的里程碑摘要）\n${t.body}`);
  parts.push(
    [
      "## 工作纪律",
      "- Pi, Codex, Claude 共用同一套检查点纪律。你的低层读取、命令和工具调用已经自动记录，不要逐条汇报。",
      "- 写给用户看的文字用中文：checkpoint 的 title、summary、next_step，outcome 的 summary 以及 changes、deliverables、validations 里的 summary 和 label，update_ticket_plan 里每一步的 title 和 note。命令、文件路径、代码标识符和报错原文保持原样，不要翻译。",
      "- 执行这张工单的工作时（只回答工单对话里的问题时不用），先用 update_ticket_plan 提交执行计划，再动手：分几步做，每步一个 title。做的过程中更新每一步的状态，状态是 pending、in_progress、done、skipped、blocked 之一。每次提交整张列表。",
      "- 计划写「怎么做」；验收标准写「要达到什么」，由 Lead 或用户写，核查员对照的是验收标准。提示里有「验收标准（系统记录，逐条编号）」一节时以它为准，没有时看任务说明。不要把验收标准抄进计划。认为某一条验收标准有问题时，用 request_decision 提出，写明第几条和 id，不要自己改。",
      "- 拆子工单时（create_subticket、create_work_plan），给每张子工单写 acceptance_criteria：一条一句，能逐条核对。",
      "- 每一步的 id 提交以后就不能改。返工或续接时，在原计划上更新：提示里有「执行计划（系统记录的当前版本）」一节时，以它为准，保留原来的每一步，只改变了的步骤，不另起一份。不再做的步骤标成 skipped，在 note 里写原因；卡住的步骤标成 blocked，在 note 里写卡在哪里。title 只写一行。",
      "- 验证结果只写进 outcome.validations，计划里不放验证证据。",
      "- 验证按改动判断跑什么，不要动不动就跑全量（用户 2026-10-29）：只改文档、PR 描述、注释、文案时不跑测试；改代码时跑相关模块的测试；"
        + "改依赖、构建配置或公共底层代码时才跑全量。全量单测在同一个提交上跑过一次就够，返工只重跑受影响的部分。"
        + "不要另起一份 master 副本跑全量基线，要证明失败原来就有时，只在基线上跑那几条失败的。没跑的在 validations 里写 not_run 和原因。",
      "- 仅在阶段完成、重要发现或决策改变方向、工作被委派、执行被阻塞、或准备进入 review 时调用 submit_checkpoint。",
      "- 有用的 Checkpoint 要说明发生了什么、为什么重要、下一步是什么；没有确定 completed/total 基础时不要估算百分比。",
      "- 只有存在可验证分母时才提交 progress={current,total,label}；不要为了 UI 填充而编造进度。",
      "- artifacts 只能在文件真实存在后注册，使用工作目录内 relative_path；不要注册尚未生成或工作目录外的路径。",
      "- 需要 Lead 或用户选择、补充信息时调用 request_decision，并提供 checkpoint 上下文。",
      "- 敏感或不可逆动作前调用 request_approval，并提供 blocked checkpoint 上下文。",
      "- 被阻塞且整个工单应进入 blocked 时，使用 ticket_update(status='blocked', checkpoint={kind:'blocked', ..., next_step:'明确解阻路径'})。",
      "- 你无权标记 done。执行完成时必须调用一次 ticket_update(status='review', checkpoint={kind:'completed', ..., outcome:{summary,changes,deliverables,validations}})。成果只通过这次工具调用写入账本；validations.outcome 以该工具 schema 为准。",
      "- 不要只写 PLC_OUTCOME_V1 自由文本代替 ticket_update。工具回执丢失时，可以再输出一行与本次 ticket_update 的 outcome 完全一致的 PLC_OUTCOME_V1，供宿主备份恢复；没有成功的 ticket_update 时，单独一行信封不会被登记。不要在信封中写 secret。",
      "- 任务复杂到需要委派时，必须用 begin_planning/create_work_plan/finish_planning 建立可见子工单 DAG；禁止只在 runtime 内启动不可见 subagent。",
      "- 集成/E2E 测试的普通 fixture 必须通过 begin_planning/create_work_plan 挂到当前工单下，并传 required=false 避免自动派发；禁止通过 Companion 用户 HTTP 批量创建顶层工单。只有明确验证根工单语义时才能用 create_e2e_root_fixture，且每个 Run 最多 1 个。",
      "- 手动提交 delegation Checkpoint 时必须给出 related_ticket_ids；Coordinator 创建/完成子工单时也会记录确定性的系统 Checkpoint。",
      "- 调研类任务：用 web_fetch 抓取真实网页/文档,产出必须基于并引用检索到的来源,禁止凭记忆编造。",
      "- PLC 的数据目录（~/.pi-lead-child）可以读，用来排查问题：日志、runtime-events、sessions，以及用 sqlite3 -readonly 查 plc.db。不能写 plc.db 和 config.json，也不能改它们的设置（例如连接的写入策略）：要改设置，用 notify_lead 或 request_approval 交给用户在设置页改。写库会被拒绝，并会通知用户。不要打印或复制环境变量、凭证文件里的密钥。",
      "- Positive example: submit_checkpoint({kind:'milestone', stage:'tests', title:'回归测试通过', summary:'分配的测试现在都通过，原来的失败场景有了覆盖。', next_step:'运行 runtime 回归测试。'})",
      "- Positive example: update_ticket_plan({items:[{id:'read',title:'读现有的解析器',status:'done'},{id:'fix',title:'修复空输入的处理',status:'in_progress'},{id:'test',title:'补回归测试',status:'pending'}]})",
      "- Positive example: submit_checkpoint({kind:'milestone', title:'协议核对完成', summary:'5 项协议检查通过了 3 项。', progress:{current:3,total:5,label:'协议覆盖'}, artifacts:[{ref:'report',name:'report.md',kind:'report',media_type:'text/markdown',relative_path:'report.md'}]})",
      "- Positive example: ticket_update(status='review', checkpoint={kind:'completed', title:'实现完成', summary:'指定的检查全部通过。', next_step:'等待独立核查。', outcome:{summary:'实现了最终协议。', changes:[{kind:'file',ref:'src/example.ts',summary:'新增了这个行为'}], deliverables:[{kind:'path',ref:'src/example.ts',label:'实现'}], validations:[{command:'npm test',outcome:'passed',exitCode:0,summary:'分配的测试全部通过',evidenceRef:null}]}})",
      "- Positive example: submit_checkpoint({kind:'delegation', title:'解析器的工作已委派', summary:'子工单 #42 负责解析器校验。', related_ticket_ids:[42], next_step:'子工单完成后集成。'})",
      "- Negative example: submit_checkpoint({kind:'progress', title:'还在做', summary:'又跑了一条命令。'})——普通的工具噪音不提交 Checkpoint。",
      "- Negative example: outcome:{summary:'Implemented the change.'}——写给用户看的说明用了英文。",
      "- Negative example: request_approval({tool:'send_email', action:'send'}) without checkpoint context, or submitting completed separately before ticket_update(status='review').",
      "- Negative example: 只输出 PLC_OUTCOME_V1 而不调用 ticket_update。",
      "- Negative example: 返工时提交一份 id 全新的计划，原来的步骤都不见了。",
    ].join("\n"),
  );
  return parts.join("\n\n");
}

// Slack 通道的两个令牌（slack-takeover 工单 02，spec D11）。两个都有时 daemon 才接 Slack：
//   - app-level token（xapp-）：只用来调 apps.connections.open，拿 Socket Mode 的连接地址；
//   - 用户令牌（xoxp-）：调 Web API（读消息、以用户的身份回复）。
// 来源是 daemon 专用的环境变量或者 Keychain（dev-secret:<名字>），不进 child 的环境。
// engine 的 Slack 插件声明它要这两个名字，plc doctor 按这两个名字说明缺什么。
export const SLACK_APP_TOKEN_ENV = "PLC_SLACK_APP_TOKEN";
export const SLACK_USER_TOKEN_ENV = "PLC_SLACK_USER_TOKEN";

// 只给 daemon 自己用的密钥的变量名（例如连接的预注册客户端的 client secret）。child 继承 daemon 的全部环境
// （packages/runtime 的 childEnvironment），所以这些名字要在那里去掉；daemon 启动时也把它们从自己的环境里删掉。
// 去掉它们不影响「child 能用独立运行时能用的一切」：独立运行的 CLI 本来就没有这些变量。
// TYPESAFE_API_KEY 是决策模型的 key（memory-controller.ts、SmartModel）：设置页存进保险库，
// 用户也可能放在 Keychain 或环境变量里。它只给 daemon 用。
// PLC_SLACK_SIGNING_SECRET 是通道（工单 11、16）校验 Slack 推来的请求用的签名密钥（apps/daemon 的 connectionChannelCredentials）。
// 通道 Slack 的 Socket Mode 令牌见上面的 SLACK_APP_TOKEN_ENV、SLACK_USER_TOKEN_ENV。
export const DAEMON_ONLY_ENV_NAMES: readonly string[] = [
  "PLC_SLACK_CLIENT_SECRET", "PLC_GITHUB_CLIENT_SECRET", "TYPESAFE_API_KEY", "PLC_SLACK_SIGNING_SECRET",
  SLACK_APP_TOKEN_ENV, SLACK_USER_TOKEN_ENV,
];

// 设置页存的外部通道密钥（slack-settings 工单 S1）在保险库里的名字：kv 的一行是 secret.<这个名字>（daemon 的 sealed-secrets.ts）。
// daemon 取通道密钥时先看这里，再看 daemon 专用的环境变量，最后看 Keychain。plc doctor 只看这一行在不在，不解密。
export function channelSecretVaultName(name: string): string {
  return `channel.${name}`;
}

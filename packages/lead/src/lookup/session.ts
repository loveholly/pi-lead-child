// 代查的 pi 会话（slack-takeover spec D5）：进程内、受限、隔离。
//   - SessionManager.inMemory：会话不落盘，不续接。
//   - 隔离的 resource loader：agentDir 和 cwd 都是数据目录下的空目录，不加载扩展、技能、提示模板、AGENTS.md，
//     设置在内存里（不读用户的 ~/.pi 和项目的 .pi）。pi 内置的扩展（codemode、mcp、tool-search）一个也不加载。
//   - noTools: "all" 加只有我们自己的工具的名单：没有 read、bash、edit、write，没有 MCP 工具。
//     建好以后核对一次：会话里的工具和我们给的名单不一样，就不用这个会话。
//   - 便宜的模型：独立的 ModelRuntime + Lead 的 provider 配置，模型按 SmartModel 的选法（selectSmartModelSpec）。
// 测试接缝：LookupSessionFactory 可以注入。测试用 createIsolatedLookupSession 加 pi-ai 的假模型（faux），
// 走的是同一份隔离代码。
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type ExtensionFactory, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { loadLeadModelConfig, registerLeadProviders, resolveLeadModel, selectedLeadModelSpec } from "../model-config.js";
import { configuredLeadModelSpecs, selectSmartModelSpec } from "../smart-model.js";

/** runtime 用到的会话接口。AgentSession 满足它；测试也可以给一个更简单的替身。 */
export interface LookupSession {
  subscribe(listener: (event: any) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}

export interface LookupSessionRequest {
  runId: number;
  systemPrompt: string;
  tools: ToolDefinition[];
}

/** 建一个代查会话。model 是 provider/model，记在 Run 上。 */
export type LookupSessionFactory = (request: LookupSessionRequest) => Promise<{ session: LookupSession; model: string | null }>;

// pi 1.1.0 的内置扩展（dist/extensions/index.js）。不传给 resource loader 就不会加载；这里再显式关掉一次。
const BUILTIN_EXTENSIONS = ["codemode", "tool-search", "mcp", "llama.cpp"];

/**
 * 按隔离的设置建一个 pi 会话。workDir 下建 agent/ 和 cwd/ 两个空目录。
 * extensionFactories 只给测试注册假模型的 provider 用；正式的会话不传。
 */
export async function createIsolatedLookupSession(input: {
  workDir: string;
  systemPrompt: string;
  tools: ToolDefinition[];
  model: NonNullable<ReturnType<ModelRuntime["getModel"]>>;
  modelRuntime?: ModelRuntime;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
  retry?: boolean;
  extensionFactories?: Array<{ name: string; factory: ExtensionFactory }>;
}): Promise<LookupSession> {
  const cwd = join(input.workDir, "cwd");
  const agentDir = join(input.workDir, "agent");
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: input.retry ?? true },
  });
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    disabledBuiltinExtensions: BUILTIN_EXTENSIONS,
    systemPromptOverride: () => input.systemPrompt,
    appendSystemPromptOverride: () => [],
    ...(input.extensionFactories ? { extensionFactories: input.extensionFactories } : {}),
  });
  await loader.reload();
  const names = input.tools.map((tool) => tool.name);
  const { session } = await createAgentSession({
    cwd, agentDir,
    model: input.model,
    ...(input.modelRuntime ? { modelRuntime: input.modelRuntime } : {}),
    thinkingLevel: input.thinkingLevel ?? "low",
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    noTools: "all",
    tools: names,
    customTools: input.tools,
  });
  try {
    await session.bindExtensions({});
    const registered = session.getAllTools().map((tool) => tool.name).sort();
    const active = session.getActiveToolNames().slice().sort();
    const expected = [...names].sort();
    if (JSON.stringify(registered) !== JSON.stringify(expected) || JSON.stringify(active) !== JSON.stringify(expected)) {
      throw new Error(`lookup session exposes unexpected tools: registered=${registered.join(",")} active=${active.join(",")}`);
    }
  } catch (error) {
    session.dispose();
    throw error;
  }
  return {
    subscribe: (listener) => session.subscribe(listener),
    prompt: (text) => session.prompt(text, { expandPromptTemplates: false }),
    abort: () => session.abort(),
    dispose: () => session.dispose(),
  };
}

/**
 * daemon 用的会话工厂：ModelRuntime 建一次，代查之间复用（工单 04：每次新建要跑一次模型发现）。登记 Lead 的 provider
 * （config.json），模型按 SmartModel 的选法：PLC_SMART_MODEL，否则配置里最新的 haiku，否则 Lead 自己的模型。
 * 模型的配置（config.json 的 lead 段和相关的环境变量）变了时重建。同时到的几次代查共用一次建立。
 */
export function createLookupSessionFactory(input: {
  dataDir: string;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  // pi 的凭据文件。缺省和 Lead 一样用 pi 自己的（~/.pi/agent/auth.json）；测试给一个临时文件。
  authPath?: string;
}): LookupSessionFactory {
  const env = input.env ?? process.env;
  type Prepared = { key: string; modelRuntime: ModelRuntime; model: NonNullable<ReturnType<ModelRuntime["getModel"]>>; spec: string };
  let prepared: Promise<Prepared> | null = null;
  let preparedKey: string | null = null;
  const prepare = async (key: string, config: ReturnType<typeof loadLeadModelConfig>): Promise<Prepared> => {
    const modelRuntime = await ModelRuntime.create({
      allowModelNetwork: false, refreshOnCreate: false, ...(input.authPath ? { authPath: input.authPath } : {}),
    });
    for (const note of await registerLeadProviders(modelRuntime, config, env)) input.log?.(`[lookup] ${note}`);
    const choice = selectSmartModelSpec({
      env,
      configuredSpecs: configuredLeadModelSpecs(config, (provider) => modelRuntime.getModels(provider).map((model) => model.id)),
      leadSpec: selectedLeadModelSpec(config, env),
    });
    if (choice.note) input.log?.(`[lookup] ${choice.note}`);
    const { model } = await resolveLeadModel(modelRuntime, choice.spec);
    return { key, modelRuntime, model, spec: choice.spec };
  };
  return async (request) => {
    const config = loadLeadModelConfig(input.dataDir, env);
    // 配置的指纹：只在内存里比较，不记下来（配置里可能有密钥的引用）。
    const key = createHash("sha256").update(JSON.stringify({
      config, smart: env.PLC_SMART_MODEL ?? null, lead: env.PLC_LEAD_MODEL ?? null,
    })).digest("hex");
    if (!prepared || preparedKey !== key) {
      preparedKey = key;
      prepared = prepare(key, config);
      // 建不成时下一次再试，不把失败缓存下来。
      prepared.catch(() => { if (preparedKey === key) { prepared = null; preparedKey = null; } });
    }
    const { modelRuntime, model, spec } = await prepared;
    const session = await createIsolatedLookupSession({
      // 所有代查共用这两个空目录：会话在内存里，设置也在内存里，pi 不往里面写东西。
      workDir: join(input.dataDir, "lookup"),
      systemPrompt: request.systemPrompt,
      tools: request.tools,
      model,
      modelRuntime,
    });
    return { session, model: spec };
  };
}

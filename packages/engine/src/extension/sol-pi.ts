// 内置的 SoL-Pi：NVIDIA 给 pi 做的省 token 扩展（github.com/NVlabs/SoL-Pi）。
// pi 的包管理器安装它（sol-pi-package.ts），这里按角色给配置，再交给 SoL-Pi 注册。
// Lead（进程内的 SDK 会话）加载 sol-pi-lead.ts，pi 执行器（pi CLI 子进程）用 -e 加载 sol-pi-executor.ts。
// 两个入口都经 pi 的扩展加载器加载：SoL-Pi 没有自己的 node_modules，它引用的 pi 包由加载器提供。
// 只对 pi 生效：Claude Code 和 Codex 执行器不受影响。
import { dirname, join } from "node:path";
import type { ExtensionAPI, ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";

export const SOL_PI_FEATURES = [
  "actionFusion", "observationPack", "evidencePreservingReducer", "onlineContextCompact",
] as const;
export type SolPiFeature = (typeof SOL_PI_FEATURES)[number];
export type SolPiRole = "lead" | "executor";

// 装好的 SoL-Pi 入口文件（pi 的包管理器按包的 manifest 解析出来的扩展）。daemon 装好后设置它，执行器继承它。
// 也可以手动指向一个本地 checkout，这时 daemon 不再安装。
export const SOL_PI_ENTRY_ENV = "PLC_SOL_PI_ENTRY";

interface RolePolicy {
  // 这个角色允许开的机制。
  allowed: readonly SolPiFeature[];
  // 没有配置时开的机制。
  defaults: readonly SolPiFeature[];
  // 覆盖缺省的环境变量。
  env: string;
}

const ROLES: Record<SolPiRole, RolePolicy> = {
  // Lead 只开 ObservationPack。其余三个不适合 Lead：
  // - Action Fusion 注册 edit/write。Lead 刻意没有写能力。
  // - Evidence-Preserving Reducer 只处理 bash 的输出，Lead 没有 bash。
  // - Online Context Compact 在回合中途 abort，压缩后再补一个隐藏回合。daemon 按回合管理 Lead，
  //   Lead 也有自己的压缩和沉淀笔记（precipitate）。
  lead: { allowed: ["observationPack"], defaults: ["observationPack"], env: "PLC_LEAD_SOL_PI" },
  // 上游 README 的保守配置：这两个机制不额外调用模型，也不打断正在跑的 Run。
  executor: { allowed: SOL_PI_FEATURES, defaults: ["actionFusion", "observationPack"], env: "PLC_SOL_PI" },
};

// 每个机制注册的工具。Lead 的工具是 allowlist，不在名单里的工具注册了也用不了。
const FEATURE_TOOLS: Record<SolPiFeature, readonly string[]> = {
  actionFusion: ["edit", "write"],
  observationPack: ["obs_recall"],
  evidencePreservingReducer: [],
  onlineContextCompact: ["update_plan"],
};

export interface SolPiSettings {
  role: SolPiRole;
  features: SolPiFeature[];
  // 不用上游缺省时，Reducer 用的模型。
  reducer: { provider: string; model: string } | null;
  // 开启的机制注册的工具名。
  tools: string[];
}

// 按角色和环境变量算出要开的机制：
// - 角色的环境变量（执行器 PLC_SOL_PI，Lead PLC_LEAD_SOL_PI）不设或为 default：用角色的缺省机制。
// - off：关闭。
// - 逗号分隔的机制名（例如 actionFusion,observationPack）：只开这些。
// - PLC_SOL_PI_REDUCER_MODEL=provider/model：Reducer 用的模型。上游缺省是 openai-codex/gpt-5.6-luna，
//   找不到这个模型时 Reducer 什么也不做。
// 不认识的值抛错，错误信息列出可用的值。
export function solPiSettings(role: SolPiRole, env: Record<string, string | undefined> = process.env): SolPiSettings {
  const policy = ROLES[role];
  const raw = env[policy.env]?.trim() ?? "";
  const features: SolPiFeature[] = [];
  if (raw === "" || raw === "default") {
    features.push(...policy.defaults);
  } else if (raw !== "off") {
    for (const name of raw.split(",").map((part) => part.trim()).filter(Boolean)) {
      if (!(policy.allowed as readonly string[]).includes(name)) {
        throw new Error(`${policy.env}=${raw}: unknown or not allowed for ${role}: ${name}. `
          + `Use default, off, or a comma-separated list of: ${policy.allowed.join(", ")}`);
      }
      if (!features.includes(name as SolPiFeature)) features.push(name as SolPiFeature);
    }
  }
  return {
    role, features,
    reducer: features.includes("evidencePreservingReducer") ? reducerRoute(env.PLC_SOL_PI_REDUCER_MODEL) : null,
    tools: features.flatMap((feature) => FEATURE_TOOLS[feature]),
  };
}

function reducerRoute(value: string | undefined): { provider: string; model: string } | null {
  const spec = value?.trim();
  if (!spec) return null;
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) {
    throw new Error(`PLC_SOL_PI_REDUCER_MODEL=${spec}: expected provider/model`);
  }
  return { provider: spec.slice(0, slash), model: spec.slice(slash + 1) };
}

// SoL-Pi 的配置对象（上游 config.ts 的 SolPiConfig）：上游缺省加上要开的机制。
// 四个机制都显式写出开或关（安全评审 L5）：以后升级 commit 时，上游的缺省值变了，也不会悄悄打开没选的机制。
export function solPiConfig(defaults: Record<string, unknown>, settings: SolPiSettings): Record<string, unknown> {
  return Object.freeze({
    ...defaults,
    ...Object.fromEntries(SOL_PI_FEATURES.map((feature) => [feature, settings.features.includes(feature)])),
    ...(settings.reducer ? {
      evidencePreservingReducerProvider: settings.reducer.provider,
      evidencePreservingReducerModel: settings.reducer.model,
    } : {}),
  });
}

// pi 1.x 的兼容修正（上游 issue #94）。pi 1.x 的 bash 工具把非零退出码报成 isError 的结果，不再抛错：
// 结果的最后一行是 "Command exited with code N"（pi-coding-agent 1.1.0 的 dist/core/tools/bash.js）。
// 上游 SoL-Pi 的 then_run 只认抛错，于是把失败的命令报成 [then_run:succeeded]，模型以为测试通过了。
// 这里把这种结果改回失败。上游合并修复（PR #99/#105/#107）后，修复版抛错，结果里不再有成功标记，
// 这个修正就不再生效。那时升级 SOL_PI_SOURCE 并删掉它。
const THEN_RUN_SUCCEEDED = "[then_run:succeeded]";
const THEN_RUN_FAILED = "[then_run:failed]";
const NON_ZERO_EXIT = /\nCommand exited with code [1-9]\d*\s*$/;

export function correctThenRunFailure(event: Pick<ToolResultEvent, "toolName" | "content" | "isError">): ToolResultEventResult | undefined {
  if ((event.toolName !== "edit" && event.toolName !== "write") || event.isError) return undefined;
  const index = event.content.findIndex((block) =>
    block.type === "text" && block.text.startsWith(THEN_RUN_SUCCEEDED) && NON_ZERO_EXIT.test(block.text));
  if (index === -1) return undefined;
  const content = event.content.map((block, i) => (i === index && block.type === "text"
    ? { ...block, text: THEN_RUN_FAILED + block.text.slice(THEN_RUN_SUCCEEDED.length) }
    : block));
  return { content, isError: true };
}

// 加载装好的 SoL-Pi，按角色注册。没装、配置写错或加载失败时 SoL-Pi 关闭，Lead 和 Run 照常工作：
// 省 token 不值得让它们起不来。出错时在 stderr 留一行说明；只是没装时不说话（测试和首次安装前都是这样）。
export async function registerSolPi(
  pi: ExtensionAPI, role: SolPiRole, env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const entry = env[SOL_PI_ENTRY_ENV]?.trim();
  if (!entry) return;
  try {
    const settings = solPiSettings(role, env);
    if (settings.features.length === 0) return;
    // 经 pi 的加载器 import：SoL-Pi 引用的 pi 包由加载器提供。
    const solPi = await import(entry) as { createSolPiExtension?: unknown };
    const config = await import(join(dirname(entry), "config.ts")) as { DEFAULT_CONFIG?: unknown };
    if (typeof solPi.createSolPiExtension !== "function" || typeof config.DEFAULT_CONFIG !== "object" || !config.DEFAULT_CONFIG) {
      throw new Error(`${entry} does not export createSolPiExtension and config.ts DEFAULT_CONFIG`);
    }
    if (settings.features.includes("actionFusion")) {
      pi.on("tool_result", (event) => correctThenRunFailure(event));
    }
    const resolved = solPiConfig(config.DEFAULT_CONFIG as Record<string, unknown>, settings);
    (solPi.createSolPiExtension as (load: () => unknown) => (pi: ExtensionAPI) => void)(() => resolved)(pi);
  } catch (error) {
    console.error(`[sol-pi] ${error instanceof Error ? error.message : String(error)}; SoL-Pi is off`);
  }
}

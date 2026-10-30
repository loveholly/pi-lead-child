// RuntimeProfile（spec D2）。
// 工单 03 定下 profile 的身份：runtime、解析出的可执行文件、配置目录。账号和凭据都放在配置目录里，
// 所以同一个配置目录就是同一个账号。健康账本按身份记录状态（runtimeProfileKey）。
// 工单 05 补上 profile 的内容：解释器、需要的扩展文件、模型目录。内容生成 profile hash（runtimeProfileHash）。
// 每个 Run 记录它的 profile hash，preflight 按它缓存结果。
// 两个值分开，是因为账本跟的是"哪个安装、哪个账号"，内容变化不应该清掉一次没修好的故障。
// 例如，改了默认模型，OAuth 过期的故障仍然在。
// 工单 10 补上 child 的环境（environment.ts）。工单 11 按用户的决定改成继承 daemon 的全部环境，
// PATH 仍由 profile 构造。工单 11 还补上 adapter 在用户设置之外加的许可（allowedTools）。
// 它们都是内容，改变 hash，不改变身份。
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RuntimeId } from "@pi-lead-child/core";
import { childEnvironment, runtimeEnvironment, type RuntimeEnvironment } from "./environment.js";
import { findRuntimeExecutable } from "./executable.js";
import { resolveInterpreter, type RuntimeInterpreter } from "./interpreter.js";

export interface RuntimeProfileIdentity {
  runtime: RuntimeId;
  // 解析后的绝对路径。解析不到时保留原样，例如 "codex"。
  executable: string;
  configDir: string | null;
}

// 模型目录：这个 runtime 接受哪些模型（spec D2：模型属于这个 runtime）。
export interface RuntimeModelCatalog {
  // CLI 的默认模型。没有配置时为 null，由 CLI 自己决定。
  defaultModel: string | null;
  // 带 provider 前缀的模型名（provider/model）接受哪些 provider。null 表示任意 provider（pi 按 provider 路由）。
  // 空数组表示不接受带前缀的模型名。不带前缀的模型名总是交给 CLI 自己判断。
  providers: readonly string[] | null;
}

export interface RuntimeProfile extends RuntimeProfileIdentity {
  // 实际运行 CLI 的解释器。原生可执行文件为 null。
  interpreter: RuntimeInterpreter | null;
  // CLI 启动时要加载的扩展文件（绝对路径）。
  extensions: string[];
  models: RuntimeModelCatalog;
  // child 的 PATH 和继承方式（工单 10、11）。
  environment: RuntimeEnvironment;
  // adapter 在用户自己的设置之外加的许可（工单 11）。用户的设置照常加载，这份清单只追加，不替换。
  // 空数组表示 adapter 不加许可。
  allowedTools: string[];
}

// 每个 CLI 用自己的环境变量指定配置目录。没有设置时，用 CLI 自己的默认目录。
// 配置目录是 profile 身份的一部分。child 继承 daemon 的环境，所以它用的就是这个目录。
const CONFIG_DIR_ENV: Record<RuntimeId, { name: string; fallback: () => string }> = {
  codex: { name: "CODEX_HOME", fallback: () => join(homedir(), ".codex") },
  claude: { name: "CLAUDE_CONFIG_DIR", fallback: () => join(homedir(), ".claude") },
  pi: { name: "PI_CODING_AGENT_DIR", fallback: () => join(homedir(), ".pi", "agent") },
};

export function runtimeConfigDir(runtime: RuntimeId, env: Record<string, string | undefined>): string {
  const { name, fallback } = CONFIG_DIR_ENV[runtime];
  return env[name]?.trim() || fallback();
}

// adapter 的 profile：解析它的可执行文件，读它的配置目录，按 child 的环境解析解释器。
// child 的环境由 environment.ts 构造。adapter 启动 child 时用的是同一个函数。
// interpreter 由 adapter 给出时，不按 shebang 解析（pi，工单 10）。
export function adapterProfile(
  runtime: RuntimeId,
  bin: string,
  env: Record<string, string | undefined> = {},
  content: {
    extensions?: string[]; models: RuntimeModelCatalog; allowedTools?: readonly string[];
    interpreter?: RuntimeInterpreter | null;
  },
): RuntimeProfile {
  const configVariable = CONFIG_DIR_ENV[runtime].name;
  const configDir = runtimeConfigDir(runtime, { [configVariable]: env[configVariable] ?? process.env[configVariable] });
  const environment = runtimeEnvironment(env);
  const childEnv = childEnvironment(environment, env);
  // 可执行文件按 child 的 PATH 的同一组目录查找（runtimeBinDirectories）。
  const executable = findRuntimeExecutable(bin, env.PATH ?? process.env.PATH ?? "") ?? bin;
  return {
    runtime,
    executable,
    configDir,
    interpreter: content.interpreter !== undefined ? content.interpreter : resolveInterpreter(executable, childEnv),
    extensions: [...(content.extensions ?? [])],
    models: { defaultModel: content.models.defaultModel, providers: content.models.providers },
    environment,
    allowedTools: [...(content.allowedTools ?? [])],
  };
}

// 账本和派发请求都用这个 key 引用 profile。前缀可读，后半段是身份的 hash。
// 改了可执行文件或配置目录，就是另一个 profile，它的健康状态从 healthy 开始。
export function runtimeProfileKey(profile: RuntimeProfileIdentity): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([profile.runtime, profile.executable, profile.configDir]))
    .digest("hex");
  return `${profile.runtime}:${digest.slice(0, 16)}`;
}

// profile 的内容 hash。每个 Run 记录它，出问题时能追查当时的环境（spec 用户故事 21）。
// 字段按固定顺序序列化，同样的内容总是得到同样的 hash。
export function runtimeProfileHash(profile: RuntimeProfile): string {
  return createHash("sha256").update(JSON.stringify([
    profile.runtime, profile.executable, profile.configDir,
    profile.interpreter ? [profile.interpreter.command, profile.interpreter.path, profile.interpreter.engines] : null,
    profile.extensions,
    [profile.models.defaultModel, profile.models.providers],
    [profile.environment.path, profile.environment.inherit, profile.environment.adapterVariables],
    profile.allowedTools,
  ])).digest("hex").slice(0, 16);
}

// 模型名的 provider 前缀，例如 openai/gpt-5.4-mini 的 openai。
// 第一段不能带冒号：Bedrock 的 ARN（arn:aws:bedrock:…/…）不是 provider 前缀。
const PROVIDER_PREFIX = /^([A-Za-z0-9][\w.-]*)\/./;

// 模型是否属于这个 runtime（spec D2）。属于时返回 null，不属于时返回原因。
// 例如 Claude 不接受 openai/…（run 63）。Codex 的规则在派发请求时就已经执行（model.ts 的 resolveRuntimeModel）。
export function modelOwnershipProblem(profile: Pick<RuntimeProfile, "models">, model: string | null | undefined): string | null {
  const providers = profile.models.providers;
  if (!model || providers === null) return null;
  const prefix = PROVIDER_PREFIX.exec(model)?.[1]?.toLowerCase();
  if (!prefix || providers.includes(prefix)) return null;
  return providers.length
    ? `模型 ${model} 属于 provider ${prefix}。这个 runtime 只接受 ${providers.join("、")} 的模型。`
    : `模型 ${model} 属于 provider ${prefix}。这个 runtime 不接受带 provider 前缀的模型名。`;
}

// 内核选模型用的两个函数。规则由各个 adapter 声明，这里按 runtime id 从 registry 读（工单 12）。
import type { RuntimeId } from "@pi-lead-child/core";
import { runtimeAdapter } from "./registry.js";

// 没有指定模型时，派发和执行用的模型。返回 undefined 时，由 CLI 自己决定。
export function defaultRuntimeModel(runtime: RuntimeId): string | undefined {
  return runtimeAdapter(runtime).models.defaultModel(process.env);
}

// 工具输入用 provider/model。每个 adapter 把它换成自己 CLI 接受的模型名。
// 在创建 Run 之前转换。模型不属于这个 runtime 时，adapter 在这里抛错，不让进程之后才崩溃。
export function resolveRuntimeModel(
  runtime: RuntimeId,
  model: string | null | undefined,
): string | undefined {
  const value = model?.trim();
  if (!value) return undefined;
  return runtimeAdapter(runtime).models.resolve(value);
}

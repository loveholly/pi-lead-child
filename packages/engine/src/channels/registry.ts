// 通道的 registry（Lead 事件主干 spec D14，工单 11）。先例是 runtime 的 registry（packages/runtime/src/registry.ts）。
//
// 登记一个适配器时，把来源插件提供的东西接进内核：
//   - 来源名登记成外部来源（protocol 的 registerExternalEventSource）：分诊的硬性规则和 Lead 输入的放置都按
//     「不是内部来源」判断，所以它的事件最高 tell，永远不插进 Lead 正在进行的回合；
//   - 它的事件类型注册进事件日志（registerEventKind）；
//   - 它的默认常设指令登记成系统种子（store 的 registerSystemStandingOrderSeeds），openDb 和 hub 启动时同步进库。
// 这三样都是进程里的全局登记，同一个适配器登记两次不报错。registry 的实例只决定这个 hub 接哪些来源。
import {
  ENTITY_KEY_PATTERN, eventKindDefinition, isExternalEventSource, registerEventKind,
  registerExternalEventSource, validateStandingOrderDefinition, EXTERNAL_EVENT_SOURCE_PATTERN,
} from "@pi-lead-child/protocol";
import { registerSystemStandingOrderSeeds } from "@pi-lead-child/store";
import type { ChannelAdapter } from "./types.js";

/** 检查一个适配器的声明。返回所有问题；空数组表示可以登记。 */
export function validateChannelAdapter(adapter: ChannelAdapter): string[] {
  const errors: string[] = [];
  if (!EXTERNAL_EVENT_SOURCE_PATTERN.test(adapter.id)) errors.push(`来源名 ${adapter.id} 要是小写字母开头的单词`);
  if (!adapter.auth?.connectionProvider) errors.push(`${adapter.id} 要说明用哪个连接（auth.connectionProvider）`);
  for (const definition of adapter.eventKinds) {
    if (!definition.kind.startsWith(`${adapter.id}.`)) errors.push(`事件类型 ${definition.kind} 要以 ${adapter.id}. 开头`);
    if (definition.sources.length !== 1 || definition.sources[0] !== adapter.id) {
      errors.push(`事件类型 ${definition.kind} 的来源只能是 ${adapter.id}`);
    }
  }
  if (!ENTITY_KEY_PATTERN.test(`${adapter.id}:x`)) errors.push(`来源名 ${adapter.id} 不能做对象键的前缀`);
  for (const seed of adapter.standingOrders) {
    const problems = validateStandingOrderDefinition(seed);
    if (problems.length) errors.push(`常设指令 ${seed.id}：${problems.join("；")}`);
  }
  if (adapter.settings) {
    // 设置页的密钥就是 daemon 取的那几个：名字要和 auth.secrets 一一对应。
    const declared = adapter.auth?.secrets ?? [];
    const named = adapter.settings.secrets.map((secret) => secret.name);
    if (named.length !== declared.length || named.some((name) => !declared.includes(name)) || new Set(named).size !== named.length) {
      errors.push(`${adapter.id} 的设置页密钥（settings.secrets）要和 auth.secrets 一一对应`);
    }
  }
  for (const kind of Object.keys(adapter.memory?.kinds ?? {})) {
    if (!adapter.eventKinds.some((definition) => definition.kind === kind)) errors.push(`记忆沉淀的事件类型 ${kind} 不是 ${adapter.id} 登记的`);
  }
  return errors;
}

/** 把来源插件提供的东西登记进进程（外部来源、事件类型、种子）。同一个适配器登记两次不报错。 */
export function installChannelAdapter(adapter: ChannelAdapter): void {
  const errors = validateChannelAdapter(adapter);
  if (errors.length) throw new Error(`通道 ${adapter.id} 不能登记：${errors.join("；")}`);
  if (!isExternalEventSource(adapter.id)) registerExternalEventSource(adapter.id);
  for (const definition of adapter.eventKinds) {
    const existing = eventKindDefinition(definition.kind);
    if (!existing) registerEventKind(definition);
    else if (existing.description !== definition.description || existing.sources.join() !== definition.sources.join()) {
      throw new Error(`事件类型 ${definition.kind} 已经由别的适配器注册了`);
    }
  }
  registerSystemStandingOrderSeeds(adapter.standingOrders);
}

export class ChannelRegistry {
  private readonly adapters = new Map<string, ChannelAdapter>();

  constructor(adapters: readonly ChannelAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: ChannelAdapter): void {
    if (this.adapters.has(adapter.id)) throw new Error(`通道 ${adapter.id} 已经登记了`);
    installChannelAdapter(adapter);
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): ChannelAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): ChannelAdapter[] {
    return [...this.adapters.values()];
  }
}

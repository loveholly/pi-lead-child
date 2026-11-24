// Lead 的模型选择（2026-10-26）：会话输入框的模型浮层按分组列出目录里的模型。
// 分组规则和设置页、首次启动共用一个函数（protocol 的 model-groups.ts，用户 2026-11-05 定的方案）：
// provider → 「group · channel」分段。账号（group）只在服务商的 accountPrefix 生效时才有，目录 DTO 里写在 prefix 字段。
// 浮层（PR #11，2026-11-06）：上面一个搜索框，左栏是 provider（外层），右边是选中 provider 的分段（里层）；
// 左栏选「全部模型」时右边是全部分段。搜索只决定画哪些模型（groupModelsByProvider 的 keep），分段标题不跟着变。
import {
  flatModelSections, groupModelsByProvider, modelSectionTitle, parseLeadModelSpec, subscriptionAccountOf, subscriptionSlotSpec,
  type LeadModelChoice, type LeadModelOption, type ModelSettingsDto, type SubscriptionAccount, type SubscriptionsDto,
} from '@pi-lead-child/protocol';

export interface LeadModelGroup {
  key: string;
  // 分段标题：group · channel，右边画着多个 provider 时前面加 provider。都没有时是空字符串。
  title: string;
  // 这一段一共几个模型（不看搜索）。
  count: number;
  models: LeadModelOption[];
}

export interface LeadModelProvider {
  provider: string;
  // 这个 provider 一共几个模型（不看搜索）。
  count: number;
}

function grouped(models: readonly LeadModelOption[], keep?: (model: LeadModelOption) => boolean) {
  return groupModelsByProvider(models.map((model) => ({ ...model, group: model.prefix })), keep ? { keep } : {});
}

// 搜索和设置页的模型库一样：按完整的 provider/id 和显示名，不分大小写。magpie 的通道（route，例如 Claude Code）也算。
export function matchesLeadModel(model: LeadModelOption, query: string): boolean {
  const term = query.trim().toLowerCase();
  if (!term) return true;
  return model.model.toLowerCase().includes(term) || (model.name?.toLowerCase().includes(term) ?? false)
    || (model.route?.toLowerCase().includes(term) ?? false);
}

/** 左栏：每个 provider 一格，按模型第一次出现的先后。不看搜索，搜索时左栏不变。 */
export function leadModelProviders(models: readonly LeadModelOption[]): LeadModelProvider[] {
  return grouped(models).map((provider) => ({ provider: provider.provider, count: provider.count }));
}

/** 右边的分段。provider 为 null 时是全部 provider 的分段；query 为空时不过滤。一个模型也不剩的分段不画。 */
export function groupLeadModels(
  models: readonly LeadModelOption[], options: { query?: string; provider?: string | null } = {},
): LeadModelGroup[] {
  const query = options.query?.trim() ?? '';
  const providers = grouped(models, query ? (model) => matchesLeadModel(model, query) : undefined);
  const provider = options.provider ?? null;
  // 只画一个 provider 时标题不写它（左栏已经写了）；画全部时有多个 provider 才写。
  const withProvider = provider === null && new Set(models.map((model) => model.provider)).size > 1;
  return flatModelSections(providers.filter((entry) => provider === null || entry.provider === provider)).map((section) => ({
    key: section.key,
    title: modelSectionTitle(section, withProvider),
    count: section.total,
    models: section.models,
  }));
}

// 输入框右下角写的：模型 id（不带 provider）和推理强度。不知道账号时写完整的 id（auto/deepseek-flash 和
// deepseek/deepseek-flash 不能显示成同一个名字）；知道账号时去掉它。
export function leadModelLabel(spec: string, group: string | null = null): { id: string; effort: string | null } {
  const parsed = parseLeadModelSpec(spec, group);
  return { id: parsed.bareId, effort: parsed.effort };
}

// 换到另一个模型时用的推理强度：这个模型也支持现在的强度就留着，不支持时用模型自己的缺省（不加后缀）。
export function effortForModel(model: LeadModelOption, current: string | null): string | null {
  return current && model.efforts.includes(current) ? current : null;
}

// ── 会话里换模型的浮层（模型配置方案 C 的 S4，画板 C-Picker-Desktop / C-Picker-Mobile）──────────────────────
// 左栏按接入方式列「接入」：订阅（Codex、GitHub Copilot，带 5 小时额度的小条）在前，API key 的服务商在后。
// 订阅的模型在目录里写 <base>/<id>；第 n 个账号写 <base>-<n>/<id>，和 <base>/<id> 是分工里的同一格（protocol 的 subscriptionSlotSpec）。

export interface PickerAccount {
  // provider 名：<base> 或 <base>-<n>。
  provider: string;
  index: number;
  // 账号的名字（工作、个人）。没起名时为 null，界面写「账号 n」。
  label: string | null;
  // 5 小时额度用了百分之几（0–100）。查不到时为 null。
  quotaUsed: number | null;
  quotaLabel: string | null;
}

export interface PickerConnection {
  // 订阅是 base（openai-codex），API key 是服务商名。
  key: string;
  kind: 'subscription' | 'key';
  models: LeadModelOption[];
  // 订阅登录了的账号，按序号。API key 的是空的。
  accounts: PickerAccount[];
  // 换号方式（订阅有两个以上账号时有意义）。
  strategy: string | null;
  quotaSupported: boolean;
}

/** 左栏的接入：订阅在前，API key 在后，各自按模型在目录里第一次出现的先后。 */
export function leadModelConnections(
  models: readonly LeadModelOption[], subscriptions: SubscriptionsDto | null | undefined,
): PickerConnection[] {
  const byKey = new Map<string, PickerConnection>();
  for (const model of models) {
    const account = subscriptionAccountOf(model.provider);
    const key = account ? account.base : model.provider;
    let entry = byKey.get(key);
    if (!entry) {
      const subscription = account ? subscriptions?.subscriptions.find((candidate) => candidate.base === account.base) : undefined;
      entry = {
        key,
        kind: account ? 'subscription' : 'key',
        models: [],
        accounts: (subscription?.accounts ?? []).filter((item) => item.loggedIn).map(pickerAccount).sort((a, b) => a.index - b.index),
        strategy: subscription?.strategy ?? null,
        quotaSupported: subscription?.quotaSupported ?? false,
      };
      byKey.set(key, entry);
    }
    entry.models.push(model);
  }
  const all = [...byKey.values()];
  return [...all.filter((entry) => entry.kind === 'subscription'), ...all.filter((entry) => entry.kind === 'key')];
}

function pickerAccount(account: SubscriptionAccount): PickerAccount {
  const window = account.quota?.windows[0] ?? null;
  const remaining = window?.remainingPercent ?? null;
  return {
    provider: account.provider,
    index: account.index,
    label: account.label,
    quotaUsed: remaining === null ? null : Math.round(100 - remaining),
    quotaLabel: window?.label ?? null,
  };
}

/** 一个模型属于哪个接入：订阅的账号算进它的订阅。 */
export function connectionKeyOf(model: string): string {
  const provider = parseLeadModelSpec(model).provider;
  return subscriptionAccountOf(provider)?.base ?? provider;
}

/** 订阅的哪个账号：<base>-<n>/<id> 是第 n 个，<base>/<id> 是 null（自动，或者只有一个账号）。不是订阅时为 null。 */
export function pinnedAccountOf(model: string): string | null {
  const provider = parseLeadModelSpec(model).provider;
  const account = subscriptionAccountOf(provider);
  return account && account.index > 1 ? provider : null;
}

/** 同一个格子里的模型换成另一个账号：account 为 null 时换回 <base>/<id>（自动）。 */
export function withAccount(model: string, account: string | null): string {
  const slot = subscriptionSlotSpec(model);
  if (!account) return slot;
  return `${account}${slot.slice(slot.indexOf('/'))}`;
}

/** 两个模型是不是分工里的同一格（不看账号）。 */
export function sameSlot(left: string, right: string): boolean {
  return subscriptionSlotSpec(parseLeadModelSpec(left).model) === subscriptionSlotSpec(parseLeadModelSpec(right).model);
}

/** 模型在分工里的角色：第一个是主用，后面是备用，不在分工里是 null。 */
export function chainRole(model: string, chain: readonly LeadModelChoice[]): 'primary' | 'backup' | null {
  const index = chain.findIndex((choice) => sameSlot(choice.model, model));
  return index < 0 ? null : index === 0 ? 'primary' : 'backup';
}

/** 会话此刻用的是这个订阅的哪个账号（inSession 是 provider/id）。不是这个订阅时为 null。 */
export function accountInSession(base: string, inSession: string | null | undefined): number | null {
  if (!inSession) return null;
  const account = subscriptionAccountOf(parseLeadModelSpec(inSession).provider);
  return account && account.base === base ? account.index : null;
}

/** 上下文窗口写成 400K、1M。 */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  return `${Math.round(tokens / 1000)}K`;
}

/** 模型的上下文窗口：设置页的目录（服务商和订阅的模型）里有就用。 */
export function contextWindows(settings: ModelSettingsDto | null | undefined): Map<string, number> {
  const windows = new Map<string, number>();
  for (const provider of settings?.brain.providers ?? []) {
    for (const model of provider.models) if (model.contextWindow) windows.set(model.model, model.contextWindow);
  }
  for (const subscription of settings?.subscriptions?.subscriptions ?? []) {
    for (const model of subscription.models) if (model.contextWindow) windows.set(model.model, model.contextWindow);
  }
  return windows;
}

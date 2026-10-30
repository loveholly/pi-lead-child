// 通道在 daemon 里的装配（Lead 事件主干 spec D14，工单 11；slack-takeover 工单 02 接上真实的来源）。
// hub、闸门、投递都在 engine 的 channels/；这里只接线：
//   - 哪些来源接进来：engine 的内置来源（builtinChannelAdapters），按配置建。生产入口（main.ts）给 live：
//     engine 的 liveBuiltinChannels 把内置来源都接上（它们都声明了凭据设置），日志里写缺哪些密钥的名字（不写值）。
//     测试注入假服务（engine/testing 里的假来源）。没有配置的来源不接。
//   - 鉴权：适配器声明了密钥名（auth.secrets）的来源，按名字取密钥（server.ts 给的 secret：设置页存进保险库的，
//     daemon 专用的环境变量，Keychain，按这个顺序；不进 process.env，child 拿不到），交给适配器的 resolveCredential 换成凭据。
//     没有声明的来源，凭据来自 connections 表（ConnectionHub 的 accessToken，令牌在保险库里）和签名密钥
//     PLC_<PROVIDER>_SIGNING_SECRET。凭据只交给适配器。
//   - 传输：适配器自己的进程内传输（transport，例如 Socket 连接）在这里启动，投递交给 hub 的进程内入口；停机时先停传输。
//     声明了密钥的来源，密钥齐了才启动传输（没有密钥时不连，也不刷日志）。
//   - 热重连（slack-settings 工单 S1）：设置页存了、删了凭据，或者用户点了「不是我」以后，reloadChannelSource 清掉凭据缓存、
//     停传输，密钥齐了就重新开。不用重启 daemon。
//   - 连接的状态（没配置、正在连、连上了、出错）报给 onSourceStatus（channel-settings.ts 记下来给设置页看）。
//   - 推送、卡变了以后的网关事件、Lead 的当前局面、影子分诊加问的问题，由 server.ts 接上。
//   - 别人发来的消息紧不紧急、请求 A、请求 B、用户自己的话：hub 问 server.ts 给的 SmartModel（Lead 会话的那一个），这里不自己建。
//   - 代查（slack-takeover 工单 04）：server.ts 把代查的启动器（lookup.ts）、候选仓库和配置里的主人名交给 hub。
//   - PR review 剧本（工单 06）：server.ts 把认 PR 的函数（lead 的 findPullRequestRef）和发帖器（review-post.ts）交给 hub。
//   - 来源的配置：config.json 的 channels 段（loadChannelsConfig），由 engine 的 builtinChannelAdapters 交给对应的来源
//     （例如记忆沉淀的排除名单）。启动时读一次。
//   - 记忆沉淀（slack-takeover 工单 07）：startChannelMemory 在 hub 之后建，server.ts 的轮询每一拍调它的 tick。
//     模型是 Lead 会话的便宜模型的自由文本补全（server.ts 给），笔记写进 Lead 的 NotesMemory。
//   - 上下文包（统一消息事件 spec D5，工单 04）：server.ts 给对话摘要的便宜模型（和记忆沉淀同一个）、对象的状态
//     （context-objects.ts）、笔记的召回（NotesMemory 的 search）。
// 这个文件不写任何具体来源的名字（apps/daemon/test/channel-architecture.test.ts 检查）。
import { createHash } from "node:crypto";
import { loadPlcConfig, type PlcChannelsConfig } from "@pi-lead-child/core";
import {
  builtinChannelAdapters, ChannelHub, ChannelRegistry, createChannelMemory, liveBuiltinChannels,
  type BuiltinChannelOptions, type ChannelAdapter, type ChannelCredential, type ChannelCredentialSource,
  type ChannelHubOptions, type ChannelMemory, type ChannelMemoryOptions, type ChannelTransportContext, type LiveChannelOptions,
} from "@pi-lead-child/engine";
import { redactSecretText, type ChannelSourceAccount } from "@pi-lead-child/protocol";
import { listConnections, type Db } from "@pi-lead-child/store";

/** startDaemon 的 channels 选项。false 关掉通道。 */
export type ChannelDaemonOptions = false | {
  // 内置来源的配置。测试注入假服务（engine/testing 里的假来源）。和 live 接上的同名来源以这里的为准。
  sources?: BuiltinChannelOptions;
  // 生产入口（main.ts）给 true：密钥都有的内置来源用真实的传输接上。测试给假的 fetch 和假的 Socket 客户端。
  live?: true | LiveChannelOptions;
  // 测试注入的凭据。缺省按适配器声明的密钥取（channelCredentials）。注入了凭据时，传输不等密钥，直接启动。
  credentials?: ChannelCredentialSource;
  // 测试注入的 Keychain（按名字取）。测试 daemon 缺省不读 Keychain。
  keychain?: (name: string) => string | null;
  // 记忆沉淀的节奏和上限（engine 的 channels/memory.ts）。false 关掉。测试给短的时间和注入的时钟。
  memory?: false | Pick<ChannelMemoryOptions, "now" | "quietMs" | "maxWaitMs" | "dailyMax" | "perTick" | "timeoutMs" | "intervalMs">;
  // 上下文包（统一消息事件 spec D5，工单 04）：测试注入的状态查询、召回、时间上限，和 server.ts 给的合在一起（这里的优先）。
  contextPack?: ChannelHubOptions["contextPack"];
} & Pick<
  ChannelHubOptions,
  | "classifyTimeoutMs" | "snoozeMs" | "outboundRetryBaseMs" | "outboundMaxAttempts" | "urgencyTimeoutMs" | "intakeTimeoutMs"
  | "replyCheckTimeoutMs" | "selfReplyTimeoutMs" | "pullRequestOf" | "audit" | "labelSettleMs"
>;

/** config.json 的 channels 段。没有、读不了（日志里说一句）时是 undefined：来源按缺省接上。 */
export function loadChannelsConfig(dataDir: string, log: (line: string) => void): PlcChannelsConfig | undefined {
  try {
    const channels = loadPlcConfig(dataDir).channels;
    return channels && typeof channels === "object" && !Array.isArray(channels) ? channels : undefined;
  } catch (error) {
    log(`[channels] config.json is not readable; using the defaults: ${redactSecretText(error instanceof Error ? error.message : String(error)).slice(0, 200)}`);
    return undefined;
  }
}

/**
 * 按连接取凭据：connections 表里 provider 对得上、状态是 connected 的那一行，令牌由 ConnectionHub 取（快到期时先续）；
 * 签名密钥是 daemon 专用的密钥 PLC_<PROVIDER>_SIGNING_SECRET；用户本人在来源里的编号是连接的账号（account_label）。
 * 缺一样就是 null：hub 拒收这个来源的投递，也不往外发。
 */
export function connectionChannelCredentials(input: {
  db: Db;
  accessToken: (connectionId: number) => Promise<string | null>;
  secret: (name: string) => string | null;
}): ChannelCredentialSource {
  return {
    async credential(provider) {
      const row = listConnections(input.db).find((candidate) => candidate.provider === provider && candidate.status === "connected");
      if (!row?.account_label) return null;
      const token = await input.accessToken(row.id);
      const signingSecret = input.secret(`PLC_${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_SIGNING_SECRET`);
      if (!token || !signingSecret) return null;
      return { token, signingSecret, account: row.account_label };
    },
  };
}

// 换好的凭据多久以后重新换一次（例如用户改了名字）。换不成时多久以后再试。
const CREDENTIAL_REFRESH_MS = 30 * 60_000;
const CREDENTIAL_RETRY_MS = 60_000;

/** 带缓存的凭据。forget：清掉一个来源换好的凭据（热重连时），下一次重新换。 */
export interface ChannelCredentialCache extends ChannelCredentialSource {
  forget(provider: string): void;
}

/**
 * 通道的凭据。适配器声明了密钥名（auth.secrets）的来源：按名字取 daemon 专用的密钥，都有时交给适配器的 resolveCredential；
 * 换好的凭据缓存起来，密钥变了就重新换。重新换不成、密钥又没变时，接着用上一次换好的（例如网络一时不通）：
 * 已经收下的投递不能因为这个被拒。缺密钥时是 null。没有声明密钥的来源按 connections 表取（connectionChannelCredentials）。
 * 日志里不写密钥。
 */
export function channelCredentials(input: {
  db: Db;
  adapters: readonly ChannelAdapter[];
  accessToken: (connectionId: number) => Promise<string | null>;
  secret: (name: string) => string | null;
  log: (line: string) => void;
  now?: () => number;
}): ChannelCredentialCache {
  const now = input.now ?? (() => Date.now());
  const fromConnections = connectionChannelCredentials(input);
  const cache = new Map<string, { key: string; at: number; value: ChannelCredential | null; pending: Promise<ChannelCredential | null> | null }>();
  return {
    forget(provider) {
      cache.delete(provider);
    },
    async credential(provider) {
      const adapter = input.adapters.find((candidate) => candidate.auth.connectionProvider === provider);
      const names = adapter?.auth.secrets ?? [];
      if (!adapter || !names.length || !adapter.resolveCredential) return fromConnections.credential(provider);
      const values = names.map((name) => input.secret(name));
      if (values.some((value) => !value)) {
        cache.delete(provider);
        return null;
      }
      const secrets = Object.fromEntries(names.map((name, index) => [name, values[index]!]));
      const key = createHash("sha256").update(values.join("\u0000")).digest("hex");
      const hit = cache.get(provider);
      const same = hit?.key === key;
      if (same && hit.pending) return hit.pending;
      if (same && now() - hit.at < (hit.value ? CREDENTIAL_REFRESH_MS : CREDENTIAL_RETRY_MS)) return hit.value;
      const scrub = (line: string) => {
        let text = line;
        for (const value of values) if (value && value.length >= 4) text = text.split(value).join("[凭据]");
        return redactSecretText(text);
      };
      const previous = same ? hit.value : null;
      const pending = adapter.resolveCredential(secrets, (line) => input.log(`[channels] ${adapter.id}: ${scrub(line)}`))
        .catch((error: unknown) => {
          input.log(`[channels] ${adapter.id}: could not resolve the credential: ${scrub(error instanceof Error ? error.message : String(error))}`);
          return null;
        })
        .then((value) => {
          const kept = value ?? previous;
          cache.set(provider, { key, at: now(), value: kept, pending: null });
          return kept;
        });
      cache.set(provider, { key, at: hit?.at ?? 0, value: previous, pending });
      return pending;
    },
  };
}

/** 一个来源的连接状态（设置页）。account：连上的是谁（凭据里的用户本人和工作区）。error 不含凭据。 */
export type ChannelSourceStatusUpdate =
  | { state: "not_configured" }
  | { state: "connecting" }
  | { state: "connected"; account: ChannelSourceAccount | null }
  | { state: "error"; error: string };

/** startChannels 接好的通道：hub、热重连、停机。 */
export interface StartedChannels {
  readonly hub: ChannelHub;
  /**
   * 设置页存了、删了凭据，或者「不是我」以后调：清掉凭据缓存，停传输；这个来源的密钥齐了就重新开。不用重启 daemon。
   * 同一个来源的重连一个接一个。不认识的来源抛错。
   */
  reloadChannelSource(source: string): Promise<void>;
  /** 停机：等正在进行的重连，停各来源的传输（关连接，交完已经收下的投递），再等 hub 手上的事做完。 */
  stop(): Promise<void>;
}

// 凭据里的用户本人和工作区（设置页显示连上的是谁）。字段按线上契约的长度截断。
function accountOf(credential: ChannelCredential): ChannelSourceAccount {
  return {
    userId: credential.account.slice(0, 100),
    userName: (credential.accountName?.trim() || credential.account).slice(0, 200),
    teamId: (credential.team?.id ?? "").slice(0, 100),
    teamName: (credential.team?.name ?? "").slice(0, 200),
  };
}

class ChannelSources implements StartedChannels {
  private readonly reloading = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(readonly hub: ChannelHub, private readonly input: {
    secret: (name: string) => string | null;
    credentials: ChannelCredentialSource & { forget?(provider: string): void };
    // true：凭据由 daemon 按适配器声明的密钥名取。声明了密钥的来源，密钥齐了才启动传输。
    gated: boolean;
    onStatus?: (source: string, update: ChannelSourceStatusUpdate) => void;
    log: (line: string) => void;
  }) {}

  start(): void {
    for (const adapter of this.hub.registry.list()) this.open(adapter);
  }

  private report(adapter: ChannelAdapter, update: ChannelSourceStatusUpdate): void {
    if (!adapter.settings || !this.input.onStatus) return;
    try {
      this.input.onStatus(adapter.id, update);
    } catch (error) {
      this.input.log(`[channels] ${adapter.id}: the status listener failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private hasSecrets(adapter: ChannelAdapter): boolean {
    return (adapter.auth.secrets ?? []).every((name) => Boolean(this.input.secret(name)));
  }

  // 密钥齐了（或者凭据是注入的）就启动传输；没有传输的来源，凭据换得到就算连上。
  private open(adapter: ChannelAdapter): void {
    if (this.stopped) return;
    if (this.input.gated && adapter.auth.secrets?.length && !this.hasSecrets(adapter)) {
      this.report(adapter, { state: "not_configured" });
      return;
    }
    if (adapter.transport) {
      adapter.transport.start(this.transportContext(adapter), (delivery) => this.hub.receiveFromTransport(adapter.id, delivery));
      return;
    }
    if (!adapter.settings || !this.input.onStatus) return;
    void this.input.credentials.credential(adapter.auth.connectionProvider).then(
      (credential) => this.report(adapter, credential
        ? { state: "connected", account: accountOf(credential) }
        : { state: "error", error: "凭据不可用（原因见 daemon 的日志）" }),
      () => this.report(adapter, { state: "error", error: "凭据不可用（原因见 daemon 的日志）" }),
    );
  }

  // hub 给传输的东西，加上状态：连上时带上最近一次取到的凭据里的账号。
  private transportContext(adapter: ChannelAdapter): ChannelTransportContext {
    const base = this.hub.transportContext(adapter.id);
    let latest: ChannelCredential | null = null;
    return {
      ...base,
      context: async () => {
        const context = await base.context();
        latest = context?.credential ?? null;
        return context;
      },
      status: (update) => this.report(adapter, update.state === "connected"
        ? { state: "connected", account: latest ? accountOf(latest) : null }
        : update),
    };
  }

  reloadChannelSource(source: string): Promise<void> {
    const adapter = this.hub.registry.get(source);
    if (!adapter) return Promise.reject(new Error(`通道 ${source} 没有登记`));
    const next = (this.reloading.get(source) ?? Promise.resolve()).then(() => this.reloadNow(adapter));
    const settled = next.then(() => {}, () => {});
    this.reloading.set(source, settled);
    void settled.then(() => {
      if (this.reloading.get(source) === settled) this.reloading.delete(source);
    });
    return next;
  }

  private async reloadNow(adapter: ChannelAdapter): Promise<void> {
    if (this.stopped) return;
    this.input.credentials.forget?.(adapter.auth.connectionProvider);
    await adapter.transport?.stop();
    if (this.stopped) return;
    this.input.log(`[channels] ${adapter.id}: reconnecting with the current credential`);
    this.open(adapter);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.reloading.values()]);
    await Promise.allSettled(this.hub.registry.list().map(async (adapter) => adapter.transport?.stop()));
    await this.hub.idle();
  }
}

export function startChannels(input: {
  db: Db;
  log: (line: string) => void;
  options?: ChannelDaemonOptions;
  // 来源要的密钥，按名字取（设置页存进保险库的，daemon 专用的环境变量，Keychain）。只交给适配器。
  secret: (name: string) => string | null;
  // 没有声明密钥的来源：connections 表里连接的令牌（ConnectionHub.accessToken）。
  accessToken: (connectionId: number) => Promise<string | null>;
  push: ChannelHubOptions["push"];
  onCardsChanged: ChannelHubOptions["onCardsChanged"];
  smartModel?: ChannelHubOptions["smartModel"];
  textModel?: ChannelHubOptions["textModel"];
  // config.json 的 channels 段（loadChannelsConfig）。
  config?: PlcChannelsConfig;
  // 请求 A 的候选仓库、配置里的主人名和助手名。
  lookupCandidates?: ChannelHubOptions["lookupCandidates"];
  ownerName?: ChannelHubOptions["ownerName"];
  assistantName?: ChannelHubOptions["assistantName"];
  // 署名里助手名前面的 emoji 的生效值（设置 → 身份与风格 → 形象的值 > 配置 > 缺省，2026-10-28）。交给内置来源，每发一条消息问一次。
  assistantEmoji?: () => string | null | undefined;
  // 认原文里的 PR（交给 Lead 的请求里「代码认出的对象」）。options 里的 pullRequestOf（测试注入）优先。
  pullRequestOf?: ChannelHubOptions["pullRequestOf"];
  // 交给 Lead（落地计划 B）：C 的派单器和「Lead 现在能不能工作」。
  lead?: ChannelHubOptions["lead"];
  // 用户本人在通道里写给 Lead 的话（ChannelHubOptions.owner）：server.ts 按用户本人的一轮交给 Lead。
  owner?: ChannelHubOptions["owner"];
  // 上下文包（统一消息事件 spec D5，工单 04）：对话摘要的便宜模型、对象的状态、笔记的召回。
  contextPack?: ChannelHubOptions["contextPack"];
  // 来源的连接状态变了（channel-settings.ts 记下来给设置页看）。只报声明了凭据设置的来源。
  onSourceStatus?: (source: string, update: ChannelSourceStatusUpdate) => void;
}): StartedChannels | null {
  if (input.options === false) return null;
  const { sources, live, credentials, keychain: _keychain, memory: _memory, contextPack, ...tuning } = input.options ?? {};
  const found = live
    ? liveBuiltinChannels(input.secret, { log: (line) => input.log(`[channels] ${line}`), ...(live === true ? {} : live) })
    : null;
  for (const gap of found?.missing ?? []) {
    input.log(`[channels] ${gap.source} is not configured: missing ${gap.names.join(", ")} `
      + "(save them in Settings → Channels, or see plc doctor); it connects once they are saved");
  }
  // 建应用的清单里的应用名和署名一样：配置的 channels.assistantName，没有时是 Lead 的名字（assistantName）。
  const adapters = builtinChannelAdapters({ ...found?.sources, ...sources }, input.config, {
    ...(input.assistantName ? { assistantName: input.assistantName } : {}),
    ...(input.assistantEmoji ? { assistantEmoji: input.assistantEmoji } : {}),
  });
  if (!adapters.length) return null;
  const credentialSource = credentials ?? channelCredentials({
    db: input.db, adapters, accessToken: input.accessToken, secret: input.secret, log: input.log,
  });
  const hub = new ChannelHub({
    db: input.db,
    registry: new ChannelRegistry(adapters),
    credentials: credentialSource,
    log: input.log,
    push: input.push,
    onCardsChanged: input.onCardsChanged,
    ...(input.smartModel ? { smartModel: input.smartModel } : {}),
    ...(input.textModel ? { textModel: input.textModel } : {}),
    ...(input.lookupCandidates ? { lookupCandidates: input.lookupCandidates } : {}),
    ...(input.ownerName ? { ownerName: input.ownerName } : {}),
    ...(input.assistantName ? { assistantName: input.assistantName } : {}),
    ...(input.pullRequestOf ? { pullRequestOf: input.pullRequestOf } : {}),
    ...(input.lead ? { lead: input.lead } : {}),
    ...(input.owner ? { owner: input.owner } : {}),
    ...(input.contextPack || contextPack ? { contextPack: { ...input.contextPack, ...contextPack } } : {}),
    ...tuning,
  });
  input.log(`[channels] connected sources: ${adapters.map((adapter) => adapter.id).join(", ")}`);
  // 适配器自己的传输：投递交给 hub 的进程内入口（不校验签名，只有这里能调）。
  const started = new ChannelSources(hub, {
    secret: input.secret, credentials: credentialSource, gated: !credentials, log: input.log,
    ...(input.onSourceStatus ? { onStatus: input.onSourceStatus } : {}),
  });
  started.start();
  return started;
}

/**
 * 记忆沉淀（slack-takeover 工单 07，spec D12）：把订阅频道里的对话整理成事实笔记。没有 hub（通道关着、没有来源）或者
 * options.memory 是 false 时是 null。模型取不到（complete 返回 null）时它不整理，等有模型再整理。
 */
export function startChannelMemory(input: {
  hub: ChannelHub | null;
  db: Db;
  notes: ChannelMemoryOptions["notes"];
  complete: ChannelMemoryOptions["complete"];
  log: (line: string) => void;
  options?: ChannelDaemonOptions;
}): ChannelMemory | null {
  if (!input.hub || input.options === false || input.options?.memory === false) return null;
  return createChannelMemory({
    db: input.db, registry: input.hub.registry, notes: input.notes, complete: input.complete, log: input.log,
    ...(input.options?.memory ?? {}),
  });
}

/** 停机：先停各来源的传输（关连接，交完已经收下的投递），再等 hub 手上的投递和这一拍做完。 */
export async function stopChannels(channels: StartedChannels | null): Promise<void> {
  await channels?.stop();
}

// 外部通道的凭据设置（设置页「消息通道」，slack-settings 工单 S1；契约在 protocol 的 channel-settings.ts）。
// 这个文件不写任何具体来源的名字（apps/daemon/test/channel-architecture.test.ts 检查）：来源插件声明要哪些密钥、
// 怎么检查（ChannelAdapter.settings），这里按声明做四件事：
//   1. 取密钥：设置页存的（保险库，kv 的 secret.channel.<名字>，sealed-secrets.ts）→ daemon 专用的环境变量 → Keychain。
//      startChannels 的 secret 就是这里的 secret()。保险库里的解不开时当作没有，日志里说一次（不写值）。
//   2. 检查、保存、删除：PUT 先检查（请求里没有的密钥用现在的），全过才存进保险库，再热重连（channels.ts 的
//      reloadChannelSource）。DELETE 只删保险库里的。同一时间只有一次保存或删除。
//   3. 状态：每个来源在内存里记 status、lastError、lastConnectedAt、account、missingScopes。channels.ts 在传输连上、断开、
//      连不上时报来（onSourceStatus）。变了就推 snapshot.required（resource channel-settings）。
//   4. 「不是我」（网关的 owner-actions.ts）：保险库里这个来源的密钥还是那次保存的版本时，删掉并热重连。
//   5. 收不到事件（2026-11-02）：设置页存了令牌以后有没有收到过事件，记在 kv 的 channel.<来源>.events。从存了令牌以后
//      第一次连上算起满 noEventsWarnMs（缺省 30 分钟）还一个都没收到，并且现在连着、这次连接至少连了 2 分钟，
//      状态里带上来源插件给的提醒（noEventsWarning）。断线、出错不从头算；重新保存、删除、没有配置、换回不用登录的方式才从头算。
//      没有这一行（令牌来自环境变量或 Keychain，或者是这以前存的）时不提醒：只是一段时间没人发消息的用户不会看到它。
//      用要登录的连接方式（第 6 条）时也不提醒：那种方式不报收到的事件。
//   6. 连接方式（2026-11-02，有几种方式的来源，ChannelAdapter.connection）：操作层的 channel_connection 经过这里。
//      - 登录：打开来源的登录窗口（不等它），用户登录以后按那种方式的检查试一次，全过才存进保险库、记下换到这种方式、热重连。
//        同一时间一个来源只有一个登录窗口；取消、超时、窗口关掉都记成登录的结果，设置页和 Lead 都看得到。
//      - 换回不用登录的方式：记下来，热重连。
//      - 「代你往来源里写」开关：只记下来，马上生效（来源每次写之前读它）。
//      选的方式和开关存在 store 的 channel-connections.ts。
// 密钥的值不进日志、事件、错误和响应：检查结果、状态里的错误都先把这次涉及的密钥原样换掉，再按通用规则脱敏。
import { createHash } from "node:crypto";
import { channelSecretVaultName } from "@pi-lead-child/core";
import type { SecretVault } from "@pi-lead-child/connections";
import {
  CHANNEL_TOKEN_MAX_LENGTH, ChannelSignInError, UiActionError,
  type ChannelAdapter, type ChannelConnectionControl, type ChannelConnectionService, type ChannelConnectionState, type ChannelSettingsSpec,
  type ChannelSignInFailure,
} from "@pi-lead-child/engine";
import { ChannelSettingsError, type ChannelSettingsService, type ChannelSourceSettingsView } from "@pi-lead-child/gateway";
import {
  CHANNEL_SETUP_URL_MAX,
  redactSecretText,
  type ChannelConnectionDto,
  type ChannelSecretCheck,
  type ChannelSecretOrigin,
  type ChannelSecretsTestResult,
  type ChannelSourceAccount,
  type ChannelSourceStatus,
} from "@pi-lead-child/protocol";
import { getChannelConnection, getLocale, setChannelConnectionMode, setChannelWrites, type Db } from "@pi-lead-child/store";
import { channelSettingsMessages } from "./channel-settings.messages.js";
import type { ChannelSourceStatusUpdate } from "./channels.js";
import { SealedSecrets } from "./sealed-secrets.js";

export interface ChannelSettingsOptions {
  db: Db;
  vault: SecretVault;
  // daemon 专用的环境变量（启动时从 process.env 取走的）。
  env: (name: string) => string | null;
  // Keychain（dev-secret:<名字>）。测试 daemon 不读真的 Keychain。
  keychain: (name: string) => string | null;
  // 重连之前清掉 Keychain 的缓存（server.ts 缓存一分钟），马上读到用户刚改的值。
  forgetKeychain?: (names: readonly string[]) => void;
  // 状态或者密钥变了：网关推 snapshot.required（resource channel-settings），客户端重新 GET。
  publish?: () => void;
  log: (line: string) => void;
  now?: () => Date;
  // 一次检查最多等多久。缺省 30 秒（Web API 自己有超时和重试，这里再兜一层）。
  testTimeoutMs?: number;
  // 连上多久还没收到事件就提醒。缺省 30 分钟。
  noEventsWarnMs?: number;
  // 登录窗口最多开多久（设置页显示的剩余时间；来源自己也按这个时长关窗口）。缺省 5 分钟。
  signInWindowMs?: number;
}

type SignInState = NonNullable<ChannelConnectionState["signIn"]>;

interface SourceState {
  status: ChannelSourceStatus;
  lastError: string | null;
  lastConnectedAt: string | null;
  // 这次连上以后收到第一个事件的时间（只在内存里，不给客户端）。每次连上重新算。
  firstEventAt: string | null;
  // 存了令牌以后第一次连上的时间（毫秒），等第一个事件。重新保存、删除、没有配置、换方式时清掉；断线、出错不清。
  quietSince: number | null;
  // 最近知道的账号（检查的结果，或者连上时凭据里的）。DTO 里只有连上时才给。
  account: ChannelSourceAccount | null;
  missingScopes: string[];
}

const DEFAULT_TEST_TIMEOUT_MS = 30_000;
const DEFAULT_SIGN_IN_WINDOW_MS = 5 * 60_000;
const DEFAULT_NO_EVENTS_WARN_MS = 30 * 60_000;
// 这次连接至少连了多久才提醒：断线很久以后刚连上时，先给实时事件一点时间进来，不一连上就弹提醒。
// 2 分钟：有人说话的工作区几分钟内就有事件，远小于 30 分钟的门槛，不明显推迟提醒。
// 已知的误报（PR #2 审阅，2026-11-03）：Mac 睡了一夜，醒来连上后 2 分钟里没人说话，也会提醒，哪怕订阅是好的。
// 睡眠时状态还是 connected（醒来以后 SDK 的心跳才发现断了），Node 的计时在 macOS 上也算睡眠的时间（libuv 用
// mach_continuous_time），所以「只算连着的时间」挡不住它；把这个值调长会让短于它的抖动连接永远等不到提醒。
// 改成在提醒文字里先说「这段时间没人发消息（例如 Mac 在睡眠）可以忽略」。
const MIN_CONNECTED_MS = 2 * 60_000;

// 存了令牌以后有没有收到过事件。savedAt、firstEventAt 是 ISO 时间。
interface EventsRecord {
  savedAt: string;
  firstEventAt: string | null;
}

const eventsKey = (source: string) => `channel.${source}.events`;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const SIGN_IN_FAILURES = new Set<string>(["cancelled", "window_closed", "timed_out", "no_browser", "checks_failed", "failed"]);

// 登录没有成功的原因：来源抛的 ChannelSignInError 带着它（按名字认：engine 在测试里可能加载两份）。别的错误都是 failed。
function signInFailureOf(error: unknown): ChannelSignInFailure {
  const code = error instanceof Error && error.name === "ChannelSignInError" ? (error as { code?: unknown }).code : null;
  return typeof code === "string" && SIGN_IN_FAILURES.has(code) ? code as ChannelSignInFailure : "failed";
}

/** 去掉文字里的这些值（4 个字符以上的），再按通用的规则脱敏。 */
export function scrubSecretValues(text: string, values: ReadonlyArray<string | null | undefined>): string {
  let result = text;
  for (const value of values) if (value && value.length >= 4) result = result.split(value).join("[凭据]");
  return redactSecretText(result);
}

class TestTimeout extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new TestTimeout()), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

export class ChannelSettings implements ChannelSettingsService, ChannelConnectionService {
  private readonly sealed: SealedSecrets;
  private readonly states = new Map<string, SourceState>();
  // 每个来源最近一次登录，和还在等时取消它用的 AbortController。
  private readonly signIns = new Map<string, { state: SignInState; controller: AbortController | null }>();
  private readonly unreadable = new Set<string>();
  private sources: { adapters: () => readonly ChannelAdapter[]; reload: (source: string) => Promise<void> } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;
  // 到了该提醒的时候通知客户端重新读（每个来源一个）。
  private readonly warnTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;

  constructor(private readonly options: ChannelSettingsOptions) {
    this.sealed = new SealedSecrets(options.db, options.vault);
    this.now = options.now ?? (() => new Date());
  }

  // 给用户看的文字按用户现在选的语言（channel-settings.messages.ts）。
  private m() {
    return channelSettingsMessages(getLocale(this.options.db));
  }

  /** 通道接好以后（startChannels）交过来：有哪些来源，怎样热重连。 */
  attach(sources: { adapters: () => readonly ChannelAdapter[]; reload: (source: string) => Promise<void> }): void {
    this.sources = sources;
  }

  // ── 取密钥 ────────────────────────────────────────────────────────────────────────

  /** 一个密钥现在的值和来源：保险库 → daemon 专用的环境变量 → Keychain。都没有时是 null。 */
  resolve(name: string): { value: string; origin: ChannelSecretOrigin } | null {
    const stored = this.fromVault(name);
    if (stored) return { value: stored, origin: "vault" };
    const env = this.options.env(name);
    if (env) return { value: env, origin: "env" };
    const keychain = this.options.keychain(name);
    if (keychain) return { value: keychain, origin: "keychain" };
    return null;
  }

  /** startChannels 的 secret：按名字取密钥的值。 */
  secret(name: string): string | null {
    return this.resolve(name)?.value ?? null;
  }

  private fromVault(name: string): string | null {
    try {
      const value = this.sealed.get(channelSecretVaultName(name))?.value;
      this.unreadable.delete(name);
      return value || null;
    } catch (error) {
      if (!this.unreadable.has(name)) {
        this.unreadable.add(name);
        this.options.log(`[channel-settings] ${name} in the vault cannot be opened; ignoring it: ${redactSecretText(errorText(error)).slice(0, 200)}`);
      }
      return null;
    }
  }

  // ── 状态 ──────────────────────────────────────────────────────────────────────────

  private sourceState(source: string): SourceState {
    let state = this.states.get(source);
    if (!state) {
      state = {
        status: "not_configured", lastError: null, lastConnectedAt: null, firstEventAt: null, quietSince: null, account: null, missingScopes: [],
      };
      this.states.set(source, state);
    }
    return state;
  }

  // 改状态；变了就通知客户端。
  private change(source: string, mutate: (state: SourceState) => void): void {
    const state = this.sourceState(source);
    const before = JSON.stringify(state);
    mutate(state);
    if (JSON.stringify(state) !== before) this.options.publish?.();
    this.armWarning(source);
  }

  // ── 收不到事件 ────────────────────────────────────────────────────────────────────

  private readEvents(source: string): EventsRecord | null {
    const row = this.options.db.prepare("SELECT value FROM kv WHERE key = ?").get(eventsKey(source)) as { value: string } | undefined;
    if (!row) return null;
    try {
      const value = JSON.parse(row.value) as Partial<EventsRecord> | null;
      if (typeof value?.savedAt !== "string") return null;
      return { savedAt: value.savedAt, firstEventAt: typeof value.firstEventAt === "string" ? value.firstEventAt : null };
    } catch {
      return null;
    }
  }

  private writeEvents(source: string, record: EventsRecord | null): void {
    if (record === null) {
      this.options.db.prepare("DELETE FROM kv WHERE key = ?").run(eventsKey(source));
      return;
    }
    this.options.db.prepare(
      `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    ).run(eventsKey(source), JSON.stringify(record));
  }

  private warnMs(): number {
    return this.options.noEventsWarnMs ?? DEFAULT_NO_EVENTS_WARN_MS;
  }

  // 还在等存了令牌以后的第一个事件：连着，并且 kv 里记着「还没收到」。
  private waitingForEvents(source: string, state: SourceState): boolean {
    return state.status === "connected" && state.quietSince !== null && this.readEvents(source)?.firstEventAt === null;
  }

  // 什么时候该提醒（毫秒）：满 noEventsWarnMs，并且这次连接连满 MIN_CONNECTED_MS。
  private warnAt(state: SourceState): number {
    const connectedAt = state.lastConnectedAt ? Date.parse(state.lastConnectedAt) : this.now().getTime();
    return Math.max(state.quietSince! + this.warnMs(), connectedAt + MIN_CONNECTED_MS);
  }

  // 还没到提醒的时候：到点通知客户端重新读，状态里就有了提醒。
  private armWarning(source: string): void {
    const timer = this.warnTimers.get(source);
    if (timer) clearTimeout(timer);
    this.warnTimers.delete(source);
    const state = this.sourceState(source);
    if (this.stopped || !this.waitingForEvents(source, state)) return;
    const left = this.warnAt(state) - this.now().getTime();
    if (left <= 0) return;
    const next = setTimeout(() => {
      this.warnTimers.delete(source);
      this.options.publish?.();
    }, left);
    next.unref?.();
    this.warnTimers.set(source, next);
  }

  private noEventsWarning(adapter: ChannelAdapter, state: SourceState): string | null {
    const warning = adapter.settings!.noEventsWarning;
    if (!warning || !this.waitingForEvents(adapter.id, state)) return null;
    // 要登录的连接方式（例如 Slack 的浏览器会话）不报 received，按它算会误报。
    const control = adapter.connection;
    if (control?.needsSignIn(control.mode())) return null;
    if (this.now().getTime() < this.warnAt(state)) return null;
    return warning(getLocale(this.options.db)).slice(0, 1_000) || null;
  }

  /** channels.ts 报的来源状态（onSourceStatus）。 */
  sourceStatus(source: string, update: ChannelSourceStatusUpdate): void {
    this.change(source, (state) => {
      switch (update.state) {
        case "not_configured":
          state.status = "not_configured";
          state.quietSince = null;
          state.lastError = null;
          state.account = null;
          state.missingScopes = [];
          return;
        case "connecting":
          // 正在重连：上一次的错误留着，直到连上。
          state.status = "connecting";
          return;
        case "connected":
          state.status = "connected";
          state.lastError = null;
          state.lastConnectedAt = this.now().toISOString();
          state.firstEventAt = null;
          state.quietSince ??= this.now().getTime();
          // 检查时认出的账号更全（显示名）：还是同一个人时留着它。
          if (update.account && state.account?.userId !== update.account.userId) state.account = update.account;
          return;
        case "error":
          state.status = "error";
          // 登录失效有固定的说法，按用户现在的语言写；别的错误照来源的原话。
          state.lastError = update.reason === "signed_out"
            ? this.m().signedOut
            : this.scrubFor(source, update.error).slice(0, 500) || this.m().cannotConnect;
          return;
        case "received": {
          if (state.firstEventAt) return;
          const at = this.now().toISOString();
          state.firstEventAt = at;
          const record = this.readEvents(source);
          if (record && !record.firstEventAt) this.writeEvents(source, { ...record, firstEventAt: at });
          return;
        }
      }
    });
  }

  // 去掉这个来源现在的密钥。
  private scrubFor(source: string, text: string): string {
    const adapter = this.sources?.adapters().find((candidate) => candidate.id === source);
    const values = (adapter?.settings?.secrets ?? []).map((spec) => this.secret(spec.name));
    return scrubSecretValues(text, values);
  }

  // ── 读 ────────────────────────────────────────────────────────────────────────────

  private settingsAdapters(): ChannelAdapter[] {
    return (this.sources?.adapters() ?? []).filter((adapter) => adapter.settings).slice(0, 16);
  }

  private adapter(source: string): ChannelAdapter {
    const adapter = this.settingsAdapters().find((candidate) => candidate.id === source);
    if (!adapter) throw new ChannelSettingsError("not_found", this.m().noChannel);
    return adapter;
  }

  list(): ChannelSourceSettingsView[] {
    return this.settingsAdapters().map((adapter) => this.view(adapter));
  }

  private view(adapter: ChannelAdapter): ChannelSourceSettingsView {
    const settings = adapter.settings!;
    const state = this.sourceState(adapter.id);
    const locale = getLocale(this.options.db);
    return {
      source: adapter.id,
      label: adapter.label.slice(0, 60),
      status: state.status,
      account: state.status === "connected" ? state.account : null,
      missingScopes: state.missingScopes.slice(0, 50),
      lastError: state.lastError,
      lastConnectedAt: state.lastConnectedAt,
      noEventsWarning: this.noEventsWarning(adapter, state),
      secrets: settings.secrets.slice(0, 8).map((spec) => {
        const found = this.resolve(spec.name);
        return {
          name: spec.name, label: spec.label, prefix: spec.prefix, hint: spec.hint(locale).slice(0, 300),
          present: found !== null, origin: found?.origin ?? null,
        };
      }),
      manifest: settings.manifest,
      // 超过契约的长度时不给：一个来源的长链接不能让整个列表过不了客户端的校验。
      setupUrl: settings.setupUrl && settings.setupUrl.length <= CHANNEL_SETUP_URL_MAX ? settings.setupUrl : null,
      setupNote: settings.setupNote?.(locale).slice(0, 1_000) || null,
    };
  }

  /** 停机（关库之前）：清掉提醒的定时器，之后不再设。 */
  stop(): void {
    this.stopped = true;
    for (const timer of this.warnTimers.values()) clearTimeout(timer);
    this.warnTimers.clear();
  }

  // ── 检查 ──────────────────────────────────────────────────────────────────────────

  // 请求里的密钥名都要是这个来源声明过的（网关也查）。
  private checkNames(adapter: ChannelAdapter, secrets: Readonly<Record<string, string>>): void {
    const declared = new Set(adapter.settings!.secrets.map((spec) => spec.name));
    if (Object.keys(secrets).some((name) => !declared.has(name))) {
      throw new ChannelSettingsError("invalid_request", this.m().undeclaredSecret);
    }
  }

  // 要检查的一组密钥：请求里给了的（去掉首尾空白）用请求的，没给的用现在的。current：这一组就是现在用的那一组。
  private merge(adapter: ChannelAdapter, secrets: Readonly<Record<string, string>>): { merged: Record<string, string>; current: boolean } {
    const merged: Record<string, string> = {};
    let current = true;
    for (const spec of adapter.settings!.secrets) {
      const given = secrets[spec.name]?.trim();
      const existing = this.secret(spec.name);
      if (given) {
        merged[spec.name] = given;
        if (given !== existing) current = false;
      } else if (existing) {
        merged[spec.name] = existing;
      }
    }
    return { merged, current };
  }

  private async runTest(
    adapter: ChannelAdapter, secrets: Readonly<Record<string, string>>, spec: ChannelSettingsSpec = adapter.settings!,
  ): Promise<ChannelSecretsTestResult> {
    const values = Object.values(secrets);
    const scrub = (text: string) => scrubSecretValues(text, values);
    const log = (line: string) => this.options.log(`[channel-settings] ${adapter.id}: ${scrub(line)}`);
    const timeoutMs = this.options.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
    const m = this.m();
    // 每个密钥按来源声明的上限查长度（应用令牌缺省 1000 个字符，浏览器会话的 cookie 更长）。超了就不交给来源检查。
    const tooLong = spec.secrets.filter((item) => (secrets[item.name]?.length ?? 0) > (item.maxLength ?? CHANNEL_TOKEN_MAX_LENGTH));
    if (tooLong.length) {
      log(`settings test refused: ${tooLong.map((item) => item.name).join(", ")} too long`);
      const checks = tooLong.map((item) => ({
        id: `length_${item.name}`.slice(0, 60), label: item.label, pass: false,
        detail: m.secretTooLong(item.label, item.maxLength ?? CHANNEL_TOKEN_MAX_LENGTH),
      }));
      return sanitizeResult({ ok: false, checks, account: null, missingScopes: [] }, scrub, m.checkLabel);
    }
    let result: ChannelSecretsTestResult;
    try {
      result = await withTimeout(spec.test(secrets, { log }), timeoutMs);
    } catch (error) {
      const detail = error instanceof TestTimeout
        ? m.timedOut(adapter.label, Math.round(timeoutMs / 1000))
        : m.checkFailed(errorText(error));
      log(`settings test failed: ${error instanceof TestTimeout ? "timed out" : errorText(error)}`);
      result = { ok: false, checks: [{ id: "test", label: m.checkLabel, pass: false, detail }], account: null, missingScopes: [] };
    }
    return sanitizeResult(result, scrub, m.checkLabel);
  }

  /** 用请求里的密钥试一次（没给的用现在的）。不保存。 */
  async test(source: string, secrets: Readonly<Record<string, string>>): Promise<ChannelSecretsTestResult> {
    const adapter = this.adapter(source);
    this.checkNames(adapter, secrets);
    const { merged, current } = this.merge(adapter, secrets);
    const result = await this.runTest(adapter, merged);
    // 检查的就是现在用的那一组：缺的权限记下来（「最近一次校验的结果」）。
    if (current) this.change(source, (state) => { state.missingScopes = [...result.missingScopes]; });
    return result;
  }

  // ── 改 ────────────────────────────────────────────────────────────────────────────

  // 同一时间只有一次保存、删除或者「不是我」。
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  // 保存以后保险库里这个来源的版本：各密钥那一行密文的摘要（密文每次加密都不同；不是密钥，也推不出密钥）。
  private revision(adapter: ChannelAdapter): string {
    const rows = adapter.settings!.secrets.map((spec) => this.sealed.sealed(channelSecretVaultName(spec.name)) ?? "");
    return createHash("sha256").update(rows.join("\n")).digest("hex").slice(0, 32);
  }

  private async reload(adapter: ChannelAdapter): Promise<void> {
    this.options.forgetKeychain?.(adapter.settings!.secrets.map((spec) => spec.name));
    if (!this.sources) throw new ChannelSettingsError("unavailable", this.m().notStarted);
    await this.sources.reload(adapter.id);
  }

  save(source: string, secrets: Readonly<Record<string, string>>): ReturnType<ChannelSettingsService["save"]> {
    return this.serial(async () => {
      const adapter = this.adapter(source);
      this.checkNames(adapter, secrets);
      const { merged } = this.merge(adapter, secrets);
      const result = await this.runTest(adapter, merged);
      if (!result.ok) {
        this.options.log(`[channel-settings] ${source}: not saved, the checks failed (${result.checks.filter((item) => !item.pass).map((item) => item.id).join(", ")})`);
        return { ok: false as const, result };
      }
      const names = adapter.settings!.secrets.map((spec) => spec.name).filter((name) => secrets[name]?.trim());
      for (const name of names) this.sealed.set(channelSecretVaultName(name), { value: secrets[name]!.trim(), host: null });
      // 存了新的令牌：从头等第一个事件。
      if (names.length) this.writeEvents(source, { savedAt: this.now().toISOString(), firstEventAt: null });
      this.change(source, (state) => {
        state.account = result.account;
        state.missingScopes = [...result.missingScopes];
        if (names.length) state.quietSince = null;
      });
      this.options.log(`[channel-settings] ${source}: ${names.length ? `saved ${names.join(", ")} to the vault` : "nothing new to save"}; reconnecting`);
      await this.reload(adapter);
      this.options.publish?.();
      return { ok: true as const, saved: { source: this.view(adapter), names, revision: this.revision(adapter) } };
    });
  }

  // 删掉保险库里这个来源的密钥。返回删掉的名字。
  private dropVault(adapter: ChannelAdapter): string[] {
    const names = adapter.settings!.secrets.map((spec) => spec.name)
      .filter((name) => this.sealed.sealed(channelSecretVaultName(name)) !== null);
    for (const name of names) this.sealed.set(channelSecretVaultName(name), null);
    this.writeEvents(adapter.id, null);
    this.change(adapter.id, (state) => {
      state.missingScopes = [];
      state.quietSince = null;
    });
    return names;
  }

  remove(source: string): ReturnType<ChannelSettingsService["remove"]> {
    return this.serial(async () => {
      const adapter = this.adapter(source);
      const removed = this.dropVault(adapter);
      this.options.log(`[channel-settings] ${source}: ${removed.length ? `removed ${removed.join(", ")} from the vault` : "nothing in the vault"}; reconnecting`);
      await this.reload(adapter);
      this.options.publish?.();
      return { source: this.view(adapter), removed };
    });
  }

  revertSave(source: string, revision: string): ReturnType<ChannelSettingsService["revertSave"]> {
    return this.serial(async () => {
      const adapter = this.settingsAdapters().find((candidate) => candidate.id === source);
      if (!adapter) return { status: "unknown" as const, source: null };
      if (this.revision(adapter) !== revision) return { status: "changed" as const, source: this.view(adapter) };
      const removed = this.dropVault(adapter);
      this.options.log(`[channel-settings] ${source}: the owner disowned a save; removed ${removed.join(", ") || "nothing"} from the vault; reconnecting`);
      await this.reload(adapter);
      this.options.publish?.();
      return { status: "reverted" as const, source: this.view(adapter) };
    });
  }

  // ── 连接方式 ──────────────────────────────────────────────────────────────────────

  private connectionOf(source: string): { adapter: ChannelAdapter; control: ChannelConnectionControl } {
    const adapter = this.adapter(source);
    if (!adapter.connection) throw new UiActionError("not_found", this.m().noConnectionModes(adapter.label));
    return { adapter, control: adapter.connection };
  }

  state(source: string): ChannelConnectionState | null {
    const adapter = this.settingsAdapters().find((candidate) => candidate.id === source);
    const control = adapter?.connection;
    if (!adapter || !control) return null;
    const mode = control.mode();
    return {
      source, label: adapter.label.slice(0, 60), mode,
      modes: control.modes.map((name) => ({ mode: name, needsSignIn: control.needsSignIn(name), writesSwitch: control.writesSwitch(name) })),
      writes: control.writesSwitch(mode) ? getChannelConnection(this.options.db, source).writes : null,
      writesBlocked: adapter.writesBlocked?.() ?? null,
      signIn: this.signIns.get(source)?.state ?? null,
    };
  }

  /** 设置页读的连接方式（GET /v1/channels/settings/:source/connection）：没有给 Lead 的原因和日志里的错误。 */
  connection(source: string): ChannelConnectionDto | null {
    const state = this.state(source);
    if (!state) return null;
    const signIn = state.signIn;
    return {
      source: state.source, mode: state.mode, modes: state.modes, writes: state.writes,
      signIn: signIn
        ? { mode: signIn.mode, state: signIn.state, startedAt: signIn.startedAt, expiresAt: signIn.expiresAt, code: signIn.code }
        : null,
    };
  }

  private settle(source: string, update: Pick<SignInState, "state" | "code" | "error">): void {
    const known = this.signIns.get(source);
    if (!known) return;
    this.signIns.set(source, { state: { ...known.state, ...update, expiresAt: null }, controller: null });
    this.options.publish?.();
  }

  signIn(source: string, mode: string): ChannelConnectionState {
    const { adapter, control } = this.connectionOf(source);
    const m = this.m();
    if (!control.modes.includes(mode)) throw new UiActionError("invalid_input", m.unknownMode(adapter.label, mode));
    if (!control.needsSignIn(mode)) throw new UiActionError("invalid_input", m.modeNoSignIn(mode));
    if (this.signIns.get(source)?.state.state === "waiting") throw new UiActionError("unavailable", m.signInWaiting);
    const controller = new AbortController();
    const started = this.now();
    const windowMs = this.options.signInWindowMs ?? DEFAULT_SIGN_IN_WINDOW_MS;
    this.signIns.set(source, {
      state: {
        mode, state: "waiting", startedAt: started.toISOString(), expiresAt: new Date(started.getTime() + windowMs).toISOString(),
        code: null, error: null,
      },
      controller,
    });
    this.options.publish?.();
    const log = (line: string) => this.options.log(`[channel-settings] ${source}: ${redactSecretText(line)}`);
    log(`opening the sign-in window for the ${mode} connection`);
    void (async () => {
      let secrets: Readonly<Record<string, string>>;
      try {
        secrets = await control.signIn(mode, { log, signal: controller.signal });
      } catch (error) {
        const cancelled = controller.signal.aborted;
        log(`sign-in ${cancelled ? "cancelled" : "failed"}: ${errorText(error)}`);
        this.settle(source, {
          state: cancelled ? "cancelled" : "failed", code: cancelled ? "cancelled" : signInFailureOf(error),
          error: redactSecretText(errorText(error)).slice(0, 300),
        });
        return;
      }
      const values = Object.values(secrets);
      try {
        await this.serial(async () => {
          const spec = control.settingsFor(mode);
          const declared = spec.secrets.map((item) => item.name);
          const merged = Object.fromEntries(declared.flatMap((name) => (secrets[name]?.trim() ? [[name, secrets[name]!.trim()]] : [])));
          const result = await this.runTest(adapter, merged, spec);
          if (!result.ok) {
            throw new ChannelSignInError("checks_failed",
              m.signInChecksFailed(result.checks.filter((item) => !item.pass).map((item) => `${item.label}（${item.detail}）`).join("；")));
          }
          for (const [name, value] of Object.entries(merged)) this.sealed.set(channelSecretVaultName(name), { value, host: null });
          setChannelConnectionMode(this.options.db, source, mode);
          this.change(source, (state) => {
            state.account = result.account;
            state.missingScopes = [...result.missingScopes];
          });
          log(`signed in; saved ${Object.keys(merged).join(", ")} to the vault, switched to the ${mode} connection; reconnecting`);
          await this.reload(adapter);
        });
        this.settle(source, { state: "done", code: null, error: null });
      } catch (error) {
        const text = scrubSecretValues(errorText(error), values).slice(0, 500);
        log(`sign-in not saved: ${text}`);
        this.settle(source, { state: "failed", code: signInFailureOf(error), error: text });
      }
    })();
    return this.state(source)!;
  }

  cancelSignIn(source: string): ChannelConnectionState {
    this.connectionOf(source);
    const known = this.signIns.get(source);
    if (known?.state.state !== "waiting" || !known.controller) throw new UiActionError("unavailable", this.m().noSignInWaiting);
    known.controller.abort();
    return this.state(source)!;
  }

  async useMode(source: string, mode: string): Promise<ChannelConnectionState> {
    const { adapter, control } = this.connectionOf(source);
    const m = this.m();
    if (!control.modes.includes(mode)) throw new UiActionError("invalid_input", m.unknownMode(adapter.label, mode));
    if (control.needsSignIn(mode)) throw new UiActionError("invalid_input", m.modeNeedsSignIn(mode));
    await this.serial(async () => {
      if (control.mode() === mode) return;
      setChannelConnectionMode(this.options.db, source, mode);
      // 换了方式：等事件从这种方式第一次连上从头算（要登录的方式连着的时间不算，第 5 条）。
      this.change(source, (state) => { state.quietSince = null; });
      this.options.log(`[channel-settings] ${source}: switched to the ${mode} connection; reconnecting`);
      await this.reload(adapter);
    });
    this.options.publish?.();
    return this.state(source)!;
  }

  setWrites(source: string, allowed: boolean): ChannelConnectionState {
    const { control } = this.connectionOf(source);
    if (!control.writesSwitch(control.mode())) throw new UiActionError("unavailable", this.m().noWritesSwitch);
    setChannelWrites(this.options.db, source, allowed);
    this.options.log(`[channel-settings] ${source}: sending on the user's behalf is ${allowed ? "allowed" : "off"}`);
    this.options.publish?.();
    return this.state(source)!;
  }
}

// 来源插件给的检查结果：去掉密钥，按线上契约的长度和个数截断；ok 要所有检查都通过。
function sanitizeResult(result: ChannelSecretsTestResult, scrub: (text: string) => string, checkLabel: string): ChannelSecretsTestResult {
  const clip = (text: unknown, max: number) => scrub(typeof text === "string" ? text : "").slice(0, max);
  const checks: ChannelSecretCheck[] = (Array.isArray(result?.checks) ? result.checks : []).slice(0, 20).map((item) => ({
    id: clip(item?.id, 60) || "check", label: clip(item?.label, 100) || checkLabel, pass: item?.pass === true, detail: clip(item?.detail, 500),
  }));
  const account = result?.account
    ? {
      userId: clip(result.account.userId, 100), userName: clip(result.account.userName, 200),
      teamId: clip(result.account.teamId, 100), teamName: clip(result.account.teamName, 200),
    }
    : null;
  const missingScopes = (Array.isArray(result?.missingScopes) ? result.missingScopes : []).slice(0, 50).map((scope) => clip(scope, 100));
  return { ok: result?.ok === true && checks.length > 0 && checks.every((item) => item.pass), checks, account, missingScopes };
}

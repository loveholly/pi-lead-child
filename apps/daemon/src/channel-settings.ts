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
// 密钥的值不进日志、事件、错误和响应：检查结果、状态里的错误都先把这次涉及的密钥原样换掉，再按通用规则脱敏。
import { createHash } from "node:crypto";
import { channelSecretVaultName } from "@pi-lead-child/core";
import type { SecretVault } from "@pi-lead-child/connections";
import type { ChannelAdapter } from "@pi-lead-child/engine";
import { ChannelSettingsError, type ChannelSettingsService, type ChannelSourceSettingsView } from "@pi-lead-child/gateway";
import {
  redactSecretText,
  type ChannelSecretCheck,
  type ChannelSecretOrigin,
  type ChannelSecretsTestResult,
  type ChannelSourceAccount,
  type ChannelSourceStatus,
} from "@pi-lead-child/protocol";
import type { Db } from "@pi-lead-child/store";
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
}

interface SourceState {
  status: ChannelSourceStatus;
  lastError: string | null;
  lastConnectedAt: string | null;
  // 最近知道的账号（检查的结果，或者连上时凭据里的）。DTO 里只有连上时才给。
  account: ChannelSourceAccount | null;
  missingScopes: string[];
}

const DEFAULT_TEST_TIMEOUT_MS = 30_000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

export class ChannelSettings implements ChannelSettingsService {
  private readonly sealed: SealedSecrets;
  private readonly states = new Map<string, SourceState>();
  private readonly unreadable = new Set<string>();
  private sources: { adapters: () => readonly ChannelAdapter[]; reload: (source: string) => Promise<void> } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;

  constructor(private readonly options: ChannelSettingsOptions) {
    this.sealed = new SealedSecrets(options.db, options.vault);
    this.now = options.now ?? (() => new Date());
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

  private state(source: string): SourceState {
    let state = this.states.get(source);
    if (!state) {
      state = { status: "not_configured", lastError: null, lastConnectedAt: null, account: null, missingScopes: [] };
      this.states.set(source, state);
    }
    return state;
  }

  // 改状态；变了就通知客户端。
  private change(source: string, mutate: (state: SourceState) => void): void {
    const state = this.state(source);
    const before = JSON.stringify(state);
    mutate(state);
    if (JSON.stringify(state) !== before) this.options.publish?.();
  }

  /** channels.ts 报的来源状态（onSourceStatus）。 */
  sourceStatus(source: string, update: ChannelSourceStatusUpdate): void {
    this.change(source, (state) => {
      switch (update.state) {
        case "not_configured":
          state.status = "not_configured";
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
          // 检查时认出的账号更全（显示名）：还是同一个人时留着它。
          if (update.account && state.account?.userId !== update.account.userId) state.account = update.account;
          return;
        case "error":
          state.status = "error";
          state.lastError = this.scrubFor(source, update.error).slice(0, 500) || "连不上";
          return;
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
    if (!adapter) throw new ChannelSettingsError("not_found", "没有这个通道");
    return adapter;
  }

  list(): ChannelSourceSettingsView[] {
    return this.settingsAdapters().map((adapter) => this.view(adapter));
  }

  private view(adapter: ChannelAdapter): ChannelSourceSettingsView {
    const settings = adapter.settings!;
    const state = this.state(adapter.id);
    return {
      source: adapter.id,
      label: adapter.label.slice(0, 60),
      status: state.status,
      account: state.status === "connected" ? state.account : null,
      missingScopes: state.missingScopes.slice(0, 50),
      lastError: state.lastError,
      lastConnectedAt: state.lastConnectedAt,
      secrets: settings.secrets.slice(0, 8).map((spec) => {
        const found = this.resolve(spec.name);
        return {
          name: spec.name, label: spec.label, prefix: spec.prefix, hint: spec.hint,
          present: found !== null, origin: found?.origin ?? null,
        };
      }),
      manifest: settings.manifest,
      setupUrl: settings.setupUrl,
    };
  }

  // ── 检查 ──────────────────────────────────────────────────────────────────────────

  // 请求里的密钥名都要是这个来源声明过的（网关也查）。
  private checkNames(adapter: ChannelAdapter, secrets: Readonly<Record<string, string>>): void {
    const declared = new Set(adapter.settings!.secrets.map((spec) => spec.name));
    if (Object.keys(secrets).some((name) => !declared.has(name))) {
      throw new ChannelSettingsError("invalid_request", "请求里有这个通道没有声明的密钥名");
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

  private async runTest(adapter: ChannelAdapter, secrets: Readonly<Record<string, string>>): Promise<ChannelSecretsTestResult> {
    const values = Object.values(secrets);
    const scrub = (text: string) => scrubSecretValues(text, values);
    const log = (line: string) => this.options.log(`[channel-settings] ${adapter.id}: ${scrub(line)}`);
    const timeoutMs = this.options.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
    let result: ChannelSecretsTestResult;
    try {
      result = await withTimeout(adapter.settings!.test(secrets, { log }), timeoutMs);
    } catch (error) {
      const detail = error instanceof TestTimeout
        ? `${adapter.label} 没有在 ${Math.round(timeoutMs / 1000)} 秒内回答，没有检查完。`
        : `检查出错：${errorText(error)}`;
      log(`settings test failed: ${error instanceof TestTimeout ? "timed out" : errorText(error)}`);
      result = { ok: false, checks: [{ id: "test", label: "检查", pass: false, detail }], account: null, missingScopes: [] };
    }
    return sanitizeResult(result, scrub);
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
    if (!this.sources) throw new ChannelSettingsError("unavailable", "消息通道还没有启动");
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
      this.change(source, (state) => {
        state.account = result.account;
        state.missingScopes = [...result.missingScopes];
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
    this.change(adapter.id, (state) => { state.missingScopes = []; });
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
}

// 来源插件给的检查结果：去掉密钥，按线上契约的长度和个数截断；ok 要所有检查都通过。
function sanitizeResult(result: ChannelSecretsTestResult, scrub: (text: string) => string): ChannelSecretsTestResult {
  const clip = (text: unknown, max: number) => scrub(typeof text === "string" ? text : "").slice(0, max);
  const checks: ChannelSecretCheck[] = (Array.isArray(result?.checks) ? result.checks : []).slice(0, 20).map((item) => ({
    id: clip(item?.id, 60) || "check", label: clip(item?.label, 100) || "检查", pass: item?.pass === true, detail: clip(item?.detail, 500),
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

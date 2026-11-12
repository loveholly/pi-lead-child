// 信号源（protocol 的 signal-sources.ts）存在 kv 里：一个信号源一行，key 是 signal-source:<名字>，value 是一份 JSON。
// 不开新表（用户 2026-11-12 问过对外提问「这是要单独开一个数据库表吗」，同一个取向）：信号源只有几个，
// 运行状态（下次什么时候跑、上次的结果、连续出错几次）也放在同一份 JSON 里。
// 这里只读写库：权限在 engine 的 ui-actions/signal-sources.ts，定时跑在 engine 的 pipeline/signal-source-runner.ts。
// 读到坏了的行（手改、截断）时跳过它，不抛错。
import {
  SIGNAL_RULE_LEVELS, SIGNAL_SOURCE_LIMITS, SIGNAL_SOURCE_NAME_PATTERN,
  type SignalFetch, type SignalRule, type SignalSourceDto, type SignalSourceInput,
} from "@pi-lead-child/protocol";
import type { Db } from "./db.js";

const PREFIX = "signal-source:";
const NAME = new RegExp(SIGNAL_SOURCE_NAME_PATTERN);

const text = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const isoOrNull = (value: unknown): string | null =>
  (typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null);

function parse(name: string, raw: string): SignalSourceDto | null {
  let stored: Record<string, unknown>;
  try {
    const value = JSON.parse(raw) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    stored = value as Record<string, unknown>;
  } catch {
    return null;
  }
  const fetch = Array.isArray(stored.fetch) ? stored.fetch.filter((entry): entry is SignalFetch =>
    Boolean(entry) && typeof entry === "object" && typeof (entry as SignalFetch).connection === "string" && typeof (entry as SignalFetch).tool === "string") : [];
  const command = text(stored.command);
  if (!NAME.test(name) || !fetch.length || !command) return null;
  const rules = Array.isArray(stored.rules) ? stored.rules.filter((entry): entry is SignalRule =>
    Boolean(entry) && typeof entry === "object" && typeof (entry as SignalRule).text === "string"
      && (SIGNAL_RULE_LEVELS as readonly string[]).includes((entry as SignalRule).level)) : [];
  const every = typeof stored.everySeconds === "number" && Number.isFinite(stored.everySeconds)
    ? Math.min(Math.max(Math.trunc(stored.everySeconds), SIGNAL_SOURCE_LIMITS.minEverySeconds), SIGNAL_SOURCE_LIMITS.maxEverySeconds)
    : SIGNAL_SOURCE_LIMITS.defaultEverySeconds;
  return {
    name, label: text(stored.label, name), fetch, command, everySeconds: every, rules,
    policy: text(stored.policy), actForUser: stored.actForUser === true, enabled: stored.enabled !== false,
    createdBy: stored.createdBy === "user" ? "user" : "lead", createdAt: isoOrNull(stored.createdAt) ?? new Date(0).toISOString(),
    nextRunAt: isoOrNull(stored.nextRunAt), lastRunAt: isoOrNull(stored.lastRunAt), baselinedAt: isoOrNull(stored.baselinedAt),
    lastStatus: stored.lastStatus === "ok" || stored.lastStatus === "error" ? stored.lastStatus : null,
    lastError: typeof stored.lastError === "string" ? stored.lastError : null,
    consecutiveErrors: typeof stored.consecutiveErrors === "number" && stored.consecutiveErrors > 0 ? Math.trunc(stored.consecutiveErrors) : 0,
    emitted: typeof stored.emitted === "number" && stored.emitted > 0 ? Math.trunc(stored.emitted) : 0,
    agendaFeed: typeof stored.agendaFeed === "string" && NAME.test(stored.agendaFeed) ? stored.agendaFeed : null,
  };
}

function write(db: Db, source: SignalSourceDto): void {
  const { name, ...value } = source;
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(`${PREFIX}${name}`, JSON.stringify(value));
}

export function getSignalSource(db: Db, name: string): SignalSourceDto | null {
  if (!NAME.test(name)) return null;
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(`${PREFIX}${name}`) as { value: string } | undefined;
  return row ? parse(name, row.value) : null;
}

/** 全部信号源，按名字。 */
export function listSignalSources(db: Db): SignalSourceDto[] {
  const rows = db.prepare("SELECT key, value FROM kv WHERE key >= ? AND key < ? ORDER BY key")
    .all(PREFIX, `${PREFIX}￿`) as Array<{ key: string; value: string }>;
  return rows.map((row) => parse(row.key.slice(PREFIX.length), row.value)).filter((source): source is SignalSourceDto => source !== null);
}

/** 建一个信号源。同名的已经有了时返回 null。建好马上到点：第一次不等一个间隔。 */
export function createSignalSource(db: Db, input: SignalSourceInput, args: { by: "user" | "lead"; now: Date }): SignalSourceDto | null {
  return db.transaction((): SignalSourceDto | null => {
    if (getSignalSource(db, input.name)) return null;
    const source: SignalSourceDto = {
      name: input.name, label: input.label, fetch: input.fetch, command: input.command,
      everySeconds: input.everySeconds ?? SIGNAL_SOURCE_LIMITS.defaultEverySeconds, rules: input.rules ?? [],
      policy: input.policy ?? "", actForUser: input.actForUser === true, enabled: true,
      createdBy: args.by, createdAt: args.now.toISOString(), nextRunAt: args.now.toISOString(), lastRunAt: null, baselinedAt: null,
      lastStatus: null, lastError: null, consecutiveErrors: 0, emitted: 0, agendaFeed: input.agendaFeed ?? null,
    };
    write(db, source);
    return source;
  }).immediate();
}

/** 改一个信号源的几项（暂停、恢复、规则、策略、命令）。只写给了的项。不在时返回 null。 */
export function updateSignalSource(
  db: Db, name: string,
  patch: Partial<Pick<SignalSourceDto,
    "enabled" | "rules" | "policy" | "actForUser" | "everySeconds" | "label" | "nextRunAt" | "fetch" | "command" | "baselinedAt"
    | "agendaFeed">>,
): SignalSourceDto | null {
  return db.transaction((): SignalSourceDto | null => {
    const current = getSignalSource(db, name);
    if (!current) return null;
    // 恢复时清掉连续出错的次数：暂停多半是因为它。
    const given = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as typeof patch;
    const next: SignalSourceDto = {
      ...current, ...given,
      ...(patch.enabled === true && !current.enabled ? { consecutiveErrors: 0 } : {}),
    };
    write(db, next);
    return next;
  }).immediate();
}

export function deleteSignalSource(db: Db, name: string): boolean {
  if (!NAME.test(name)) return false;
  return db.prepare("DELETE FROM kv WHERE key = ?").run(`${PREFIX}${name}`).changes > 0;
}

/** 到点的信号源：开着，到了 nextRunAt（没有的算到了）。 */
export function dueSignalSources(db: Db, now: Date): SignalSourceDto[] {
  return listSignalSources(db).filter((source) => source.enabled && (source.nextRunAt === null || Date.parse(source.nextRunAt) <= now.getTime()));
}

/** 记下一次运行的结果，排好下一次。连续出错到了上限就暂停。返回记完以后的样子和这一次有没有因此暂停。 */
export function recordSignalSourceRun(
  db: Db, name: string, result: { ok: true; emitted: number } | { ok: false; error: string }, now: Date,
): { source: SignalSourceDto; paused: boolean } | null {
  return db.transaction((): { source: SignalSourceDto; paused: boolean } | null => {
    const current = getSignalSource(db, name);
    if (!current) return null;
    const consecutiveErrors = result.ok ? 0 : current.consecutiveErrors + 1;
    const paused = !result.ok && current.enabled && consecutiveErrors >= SIGNAL_SOURCE_LIMITS.maxConsecutiveErrors;
    const next: SignalSourceDto = {
      ...current,
      lastRunAt: now.toISOString(),
      baselinedAt: current.baselinedAt ?? (result.ok ? now.toISOString() : null),
      nextRunAt: new Date(now.getTime() + current.everySeconds * 1000).toISOString(),
      lastStatus: result.ok ? "ok" : "error",
      lastError: result.ok ? null : result.error.slice(0, 500),
      consecutiveErrors,
      emitted: current.emitted + (result.ok ? result.emitted : 0),
      enabled: paused ? false : current.enabled,
    };
    write(db, next);
    return { source: next, paused };
  }).immediate();
}

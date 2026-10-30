// src/deploy/doctor.ts — 只读诊断（spec §B4）。probes 可注入以便单测；真实 probes 由 CLI 组装。
import Database from "better-sqlite3";
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  channelSecretVaultName, envConfigPath, loadEnvConfig, resolveEnvSpec, SLACK_APP_TOKEN_ENV, SLACK_USER_TOKEN_ENV, type EnvSpec,
} from "@pi-lead-child/core";
import { LATEST_SCHEMA_VERSION, SCHEMA_MIGRATION_VERSIONS, type Db } from "@pi-lead-child/store";
import { loadAishConn } from "@pi-lead-child/store";

import type { GatewayExposureStatus } from "@pi-lead-child/protocol";

export interface DoctorCheck { name: string; ok: boolean | null; detail: string; fix?: string }
// 账本 schema 的只读读数。current 是 schema_migrations 的 MAX(version)，与 supervisor 的读法一致；
// pending 是代码认识、账本还没记的迁移个数（版本号有跳号，不能用 expected - current 算）。
export type DbSchemaStatus =
  | { state: "missing" }
  | { state: "unreadable"; error: string }
  | { state: "readable"; current: number; expected: number; pending: number };
// 事件表（v43 的 events，只追加）的读数。还没有保留期清理，这张表会一直变大；超过下面的阈值时 doctor 提醒。
// estimated：dbstat 虚拟表不可用，大小是按行数乘平均行长估算的。
export type EventLogStatus =
  | { state: "absent" }                          // 账本还没有创建，或者 v43 之前的账本还没有这张表
  | { state: "unreadable"; error: string }
  | { state: "readable"; rows: number; bytes: number; estimated: boolean; oldestAt: string | null };
export const EVENT_LOG_WARN_ROWS = 500_000;
export const EVENT_LOG_WARN_BYTES = 300 * 1024 * 1024;
export interface DoctorProbes {
  daemonAlive(): Promise<boolean>;
  dbSchema(): DbSchemaStatus;
  // 缺席时不列这一项（例如只注入了部分 probes 的测试）。真实的 probe 由 dbProbesReal 给出。
  eventLog?(): EventLogStatus;
  // config.json 整体能否解析（顶层 JSON 语法 + 顶层必须是对象）。true 也代表"config.json 不存在"——
  // "没有"不是"坏"，存在性由 configPerms 检查展示，这里只关心"存在但解析/结构有问题"。
  configParses(): true | string;
  // 凭证来源探测——只报来源不报值。"broken" = config.json 有该 key 的条目但形状无法解析
  // （既没有可用 value 也没有可解析的 fromEnv，比如裸字符串或 fromEnv 拼错变量名）。
  // 只给 daemon 用的 key（TYPESAFE_API_KEY）还有 settings（设置页存进保险库）和 shell（只在当前 shell 的环境变量里，
  // launchd 起的 daemon 读不到）。见 resolveDaemonOnlyKey。
  resolveKey(key: string): "config" | "env" | "keychain" | "settings" | "shell" | "broken" | null;
  configPerms(): string | null;                     // "600" 等八进制串；null=无 config.json
  aishConfigured(): boolean;
  // 第三方账号的连接（v42 的 connections 表）：只报名字和状态，不碰密文。缺席或老库时为空。
  connections?(): Array<{ label: string; status: string }>;
  launchdLoaded(): Promise<boolean>;
  distFresh(): boolean | null;                      // null=未构建
  webFresh(): boolean | null;                       // dist/web 对比 companion 源码；null=未构建
  fts5Available(): boolean;
  nodeVersion(): string;
  // 网关在回环之外的那个地址的状态（daemon 的 status 里有）。只监听回环或 daemon 没在运行时为 null。
  gatewayExposure?(): Promise<GatewayExposureStatus | null>;
}

export async function runDoctor(p: DoctorProbes): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const alive = await p.daemonAlive();
  checks.push({
    name: "daemon 活性", ok: alive, detail: alive ? "sock 可达" : "无响应",
    fix: alive ? undefined : "plc daemon start（或 plc daemon install 走 launchd）",
  });
  checks.push(dbSchemaCheck(p.dbSchema()));
  if (p.eventLog) checks.push(eventLogCheck(p.eventLog()));
  const parses = p.configParses();
  checks.push({
    name: "config.json 可解析", ok: parses === true, detail: parses === true ? "可解析或不存在" : parses,
    fix: parses === true ? undefined : "修正 JSON 语法或删除后重建",
  });
  const am = p.resolveKey("AM_API_KEY");
  checks.push({
    name: "凭证 AM_API_KEY", ok: am !== null && am !== "broken",
    detail: am === "broken" ? "config.json 有条目但无法解析（检查 value/fromEnv 拼写）" : am ? `来源: ${am}` : "未配置",
    fix: am !== null && am !== "broken" ? undefined : "写入 ~/.pi-lead-child/config.json 的 env 段（launchd 环境不含 shell 变量）",
  });
  const tv = p.resolveKey("TAVILY_API_KEY");
  checks.push({
    name: "凭证 TAVILY_API_KEY（可选）", ok: tv !== null && tv !== "broken" ? true : tv === "broken" ? false : null,
    detail: tv === "broken" ? "config.json 有条目但无法解析（检查 value/fromEnv 拼写）" : tv ? `来源: ${tv}` : "未配置，web_search 不可用",
    fix: tv === "broken" ? "检查 config.json 里 TAVILY_API_KEY 条目的 value/fromEnv 拼写" : undefined,
  });
  // 可选：没有它时 SmartModel 退回 Lead 的 LLM（Haiku），只算 –。
  const ts = p.resolveKey("TYPESAFE_API_KEY");
  checks.push({
    name: "凭证 TYPESAFE_API_KEY（可选）",
    ok: ts === "broken" ? false : ts === null || ts === "shell" ? null : true,
    detail: ts === "broken" ? "config.json 有条目但无法解析（检查 value/fromEnv 拼写）"
      : ts === "settings" ? "来源: 设置页（保险库）"
      : ts === "shell" ? "只在当前 shell 的环境变量里（例如 ~/.zshrc）。launchd 起的 daemon 读不到它，SmartModel 用 Lead 的 LLM 兜底"
      : ts ? `来源: ${ts}` : "设置页、config.json 和 Keychain 里都没有。没有 key 时 SmartModel 用 Lead 的 LLM 兜底",
    fix: ts === "broken" ? "检查 config.json 里 TYPESAFE_API_KEY 条目的 value/fromEnv 拼写"
      : ts === null || ts === "shell" ? "bash ~/.agents/skills/keychain-secrets/keychain-secrets.sh set TYPESAFE_API_KEY" : undefined,
  });
  const perms = p.configPerms();
  checks.push({
    name: "config.json 权限", ok: perms === null ? null : perms === "600",
    detail: perms === null ? "无 config.json" : `mode ${perms}`,
    fix: perms !== null && perms !== "600" ? "chmod 600 ~/.pi-lead-child/config.json" : undefined,
  });
  const aish = p.aishConfigured();
  checks.push({ name: "aish 网关", ok: aish ? true : null, detail: aish ? "凭证已持久化" : "未接 Slack（可选）" });
  checks.push(slackChannelCheck(p.resolveKey(SLACK_APP_TOKEN_ENV), p.resolveKey(SLACK_USER_TOKEN_ENV)));
  const connections = (p.connections?.() ?? []).filter((connection) => connection.status !== "disconnected");
  const broken = connections.filter((connection) => connection.status === "needs_reauth");
  const degraded = connections.filter((connection) => connection.status === "degraded");
  checks.push(connections.length === 0
    ? { name: "连接", ok: null, detail: "没有连接第三方账号（可选）" }
    : broken.length
    ? {
      name: "连接", ok: false, detail: `${broken.map((connection) => connection.label).join("、")} 需要重新授权`,
      fix: "在 companion 的 设置 → 连接 里重新授权",
    }
    : { name: "连接", ok: true, detail: `${connections.length} 个已连接${degraded.length ? `，${degraded.map((connection) => connection.label).join("、")} 暂时连不上（会自动重试）` : ""}` });
  const ld = await p.launchdLoaded();
  checks.push({ name: "launchd job", ok: ld ? true : null, detail: ld ? "loaded" : "未安装（手动模式）", fix: ld ? undefined : "plc daemon install" });
  const fresh = p.distFresh();
  checks.push({
    name: "构建产物", ok: fresh, detail: fresh === null ? "未构建" : fresh ? "dist 新于 src" : "dist 旧于 src",
    fix: fresh !== true ? "npm run build（launchd 跑的是 dist）" : undefined,
  });
  const web = p.webFresh();
  checks.push({
    name: "web UI 构建产物", ok: web,
    detail: web === null ? "dist/web 未构建" : web ? "dist/web 新于 companion 源码" : "dist/web 旧于 companion 源码",
    fix: web !== true ? "npm run build:web（daemon 在网关地址的 / 下提供它，无需重启）" : undefined,
  });
  const exposure = p.gatewayExposure ? await p.gatewayExposure() : null;
  checks.push(!exposure
    ? { name: "网关对外地址", ok: null, detail: "只监听回环（没有配置 PLC_GATEWAY_HOST，或 daemon 没在运行）" }
    : exposure.state === "listening"
      ? { name: "网关对外地址", ok: true, detail: `${exposure.host}:${exposure.port} 已在监听` }
      : {
          name: "网关对外地址", ok: false,
          detail: `${exposure.host}:${exposure.port} 还绑不上（${exposure.lastError ?? exposure.state}），已尝试 ${exposure.attempts} 次，`
            + `下次重试 ${exposure.nextRetryAt ?? "-"}；回环地址照常可用`,
          fix: "确认 PLC_GATEWAY_HOST 是本机网卡上的地址（例如 Tailscale 已登录、Wi-Fi 已连上）",
        });
  const fts5 = p.fts5Available();
  checks.push({ name: "FTS5 检索", ok: fts5, detail: fts5 ? "可用" : "不可用，notes 检索降级 LIKE" });
  checks.push({ name: "node", ok: true, detail: p.nodeVersion() });
  return checks;
}

// fix 只在需要行动时才设置——formatChecks 见 fix 就渲染，✓ 态带 fix 会冒出一条虚假提示。
function dbSchemaCheck(s: DbSchemaStatus): DoctorCheck {
  const name = "账本 db";
  if (s.state === "missing") {
    return { name, ok: null, detail: "plc.db 尚未创建（daemon 首次启动时创建）" };
  }
  if (s.state === "unreadable") {
    return { name, ok: false, detail: `只读打开失败: ${s.error}`, fix: "检查 ~/.pi-lead-child/plc.db 是否损坏" };
  }
  if (s.current > s.expected) {
    return {
      name, ok: false, detail: `schema v${s.current}，比代码期望的 v${s.expected} 新`,
      fix: "代码旧于账本：更新代码后 npm run build",
    };
  }
  if (s.pending > 0) {
    // 落后不算故障：daemon 下次启动时 openDb 会执行这些迁移。doctor 自己只报告，不执行。
    return {
      name, ok: null, detail: `schema v${s.current}，代码期望 v${s.expected}，${s.pending} 个迁移待执行`,
      fix: "daemon 下次启动时自动迁移（plc daemon restart --reason <原因>）",
    };
  }
  return { name, ok: true, detail: `schema v${s.current}，与代码一致` };
}

const megabytes = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

// 表不存在不算错误：老库在 daemon 下次启动时迁移。超过阈值只提醒（–），不让 doctor 失败。
function eventLogCheck(s: EventLogStatus): DoctorCheck {
  const name = "事件表";
  if (s.state === "absent") {
    return { name, ok: null, detail: "还没有事件表（账本是 v43 之前的，或者还没有创建）" };
  }
  if (s.state === "unreadable") {
    return { name, ok: null, detail: `读不到事件表: ${s.error}` };
  }
  const size = s.estimated
    ? `约 ${megabytes(s.bytes)}（估算：dbstat 不可用，按行数乘平均行长）`
    : `约 ${megabytes(s.bytes)}（含索引）`;
  const detail = `${s.rows} 行，${size}，最早一条 ${s.oldestAt ?? "-"}`;
  const over = [
    ...(s.rows > EVENT_LOG_WARN_ROWS ? [`行数超过 ${EVENT_LOG_WARN_ROWS}`] : []),
    ...(s.bytes > EVENT_LOG_WARN_BYTES ? [`大小超过 ${megabytes(EVENT_LOG_WARN_BYTES)}`] : []),
  ];
  if (!over.length) return { name, ok: true, detail };
  return {
    name, ok: null, detail: `${detail}。${over.join("，")}`,
    fix: "以后可以开启事件的保留期清理。现在还没有这个功能，这里只是提醒",
  };
}

type KeySource = ReturnType<DoctorProbes["resolveKey"]>;
const KEYCHAIN_SET = "bash ~/.agents/skills/keychain-secrets/keychain-secrets.sh set";

// 令牌从哪里来（给人看，不显示值）。daemon 的取法：设置页存进保险库的 → daemon 专用的环境变量（launchd 起的 daemon
// 从 config.json 的 env 段拿到）→ Keychain。
const SOURCE_LABELS: Record<string, string> = {
  settings: "设置页", keychain: "Keychain", config: "环境变量（config.json 的 env）", env: "环境变量",
};
const sourceLabel = (source: KeySource) => (source ? SOURCE_LABELS[source] ?? source : "");

// Slack 通道（slack-takeover 工单 02；slack-settings 工单 S1 加了设置页）：两个令牌都有时 daemon 用 Socket Mode 接 Slack。
// 只说名字和来源，不显示值。只在当前 shell 的环境变量里不算有：launchd 起的 daemon 读不到。两个都没有时只是 –（可选）；
// 配了一半是 ✗。设置页里保存的马上生效；Keychain、config.json 里改的要重启 daemon。
function slackChannelCheck(app: KeySource, user: KeySource): DoctorCheck {
  const name = "Slack 通道";
  const keys: Array<[string, KeySource]> = [[SLACK_APP_TOKEN_ENV, app], [SLACK_USER_TOKEN_ENV, user]];
  const usable = (source: KeySource) => source !== null && source !== "broken" && source !== "shell";
  if (keys.every(([, source]) => usable(source))) {
    return { name, ok: true, detail: `两个令牌都有（来源: ${sourceLabel(app)}、${sourceLabel(user)}），daemon 用 Socket Mode 接上 Slack` };
  }
  if (keys.every(([, source]) => source === null)) {
    return {
      name, ok: null,
      detail: `没有配置（可选）：缺 ${SLACK_APP_TOKEN_ENV}、${SLACK_USER_TOKEN_ENV}，Slack 通道不启用。在设置 → 消息通道里填上两个令牌就能启用`,
    };
  }
  const problems = keys.flatMap(([key, source]) => source === null ? [`缺 ${key}`]
    : source === "shell" ? [`${key} 只在当前 shell 的环境变量里（launchd 起的 daemon 读不到）`]
    : source === "broken" ? [`${key} 在 config.json 里的条目无法解析（检查 value/fromEnv 拼写）`]
    : []);
  const missing = keys.filter(([, source]) => !usable(source)).map(([key]) => key);
  return {
    name, ok: false,
    detail: `${problems.join("；")}。两个令牌都有时才启用 Slack 通道。在设置页保存的马上生效；放进 Keychain 的要重启 daemon`,
    fix: `在设置 → 消息通道里填上 ${missing.join("、")}；或者 ${missing.map((key) => `${KEYCHAIN_SET} ${key}`).join("；")}，再重启 daemon`,
  };
}

export function formatChecks(checks: DoctorCheck[]): string {
  return checks.map((c) => {
    const mark = c.ok === true ? "✓" : c.ok === false ? "✗" : "–";
    // fix 只在需要用户行动时才被设置（✓ 态本来就是 undefined）；数据模型里 fix 存在即代表"需要展示"，
    // 直接判断 c.fix 即可，和 ok 的取值无关（ok=null 的项——如 launchd 未装——一样要能带出 fix）。
    return `${mark} ${c.name}: ${c.detail}${c.fix ? `\n  ↳ 修复: ${c.fix}` : ""}`;
  }).join("\n");
}

// ---- 真实 probes（可测，从 CLI 抽出）----

// 凭证来源解析的真实实现：先走 loadEnvConfig 的正常路径（value/fromEnv 都走 resolveEnvSpec，
// 与 loadEnvConfig 内部同一份判定，不会分叉），落空后再翻 config.json 原始结构区分"未配置"(null)
// 与"配置了但形状解析不出来"(broken)——后者是静默陷阱，loadEnvConfig 对无法解析的条目直接跳过不报错。
export function resolveKeyReal(
  dir: string,
  baseEnv: Record<string, string | undefined>,
  key: string,
): "config" | "env" | "broken" | null {
  const envCopy: Record<string, string | undefined> = { ...baseEnv };
  let applied: string[] = [];
  try {
    applied = loadEnvConfig(dir, envCopy);
  } catch {
    // config.json 整体解析失败由 configParses 检查覆盖，这里退化为看传入环境原值
  }
  if (applied.includes(key)) return "config";
  if (envCopy[key]) return "env";
  try {
    const path = envConfigPath(dir);
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const spec = raw.env?.[key];
    if (spec === undefined) return null;
    if (spec === null || typeof spec !== "object") return "broken"; // 裸字符串/数字/数组等形状错误
    return resolveEnvSpec(spec as EnvSpec, envCopy) !== undefined ? "config" : "broken";
  } catch {
    return null; // 顶层解析失败等异常情况交由 config.json 可解析检查处理，这里不误报 broken
  }
}

// 账本相关的真实 probes（从 CLI 抽出，便于用临时库测试）。doctor 是只读诊断，所以这里一律只读打开，
// 不走 openDb：openDb 会顺手执行全部待执行迁移，2026-10-12 就这样把真实账本从 v25 迁到了 v34。
// 只给 daemon 用的 key（DAEMON_ONLY_ENV_NAMES）按 daemon 自己的来源判断（2026-10-16 发布评审）：
// 设置页存的（保险库里有这一行；不解密）、config.json 的 env、Keychain。当前 shell 的环境变量不算：
// launchd 起的 daemon 读不到 ~/.zshrc，在这里报 ✓ 就是误报。
// 设置页的行：决策模型的 key 是 secret.decision.apiKey；外部通道的令牌是 secret.<channelSecretVaultName(名字)>（slack-settings 工单 S1）。
export function resolveDaemonOnlyKey(
  dir: string,
  ledgerPath: string,
  shellEnv: Record<string, string | undefined>,
  key: string,
  keychainHas: (key: string) => boolean,
): "settings" | "config" | "keychain" | "shell" | "broken" | null {
  const vaultRow = key === "TYPESAFE_API_KEY" ? "secret.decision.apiKey" : `secret.${channelSecretVaultName(key)}`;
  try {
    if (withReadonlyDb(ledgerPath, (db) => db.prepare("SELECT 1 FROM kv WHERE key = ?").get(vaultRow))) return "settings";
  } catch {
    // 账本不存在，或者老库还没有 kv 表。
  }
  const real = resolveKeyReal(dir, shellEnv, key);
  if (real === "config" || real === "broken") return real;
  if (keychainHas(key)) return "keychain";
  return real === "env" ? "shell" : null;
}

function withReadonlyDb<T>(path: string, read: (db: Db) => T): T {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

export function dbSchemaReal(path: string): DbSchemaStatus {
  if (!existsSync(path)) return { state: "missing" };
  try {
    const applied = withReadonlyDb(path, (db) => {
      const ledger = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
      ).get();
      if (!ledger) return new Set<number>(); // v10 之前的库还没有迁移账本
      return new Set((db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>)
        .map((row) => row.version));
    });
    return {
      state: "readable",
      current: Math.max(0, ...applied),
      expected: LATEST_SCHEMA_VERSION,
      pending: SCHEMA_MIGRATION_VERSIONS.filter((v) => !applied.has(v)).length,
    };
  } catch (e: any) {
    return { state: "unreadable", error: e.message };
  }
}

// 事件表的读数。只读：只执行 SELECT，dbstat 也是只读的虚拟表。
// 大小优先用 dbstat（SQLite 编译时要带 SQLITE_ENABLE_DBSTAT_VTAB）：events 表和它的索引实际占的页面。
// measure 返回 null（dbstat 不可用）时，按行数乘最近 1000 行的平均行长估算。估算只算行里的数据，不算索引和页面的空余。
export function readEventLog(db: Db, measure: (db: Db) => number | null = dbstatBytes): EventLogStatus {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events'").get()) return { state: "absent" };
  const rows = (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
  const oldest = db.prepare("SELECT received_at FROM events ORDER BY seq LIMIT 1").get() as { received_at: string } | undefined;
  const measured = measure(db);
  return {
    state: "readable", rows, bytes: measured ?? estimatedEventBytes(db, rows), estimated: measured === null,
    oldestAt: oldest?.received_at ?? null,
  };
}

function dbstatBytes(db: Db): number | null {
  try {
    const btrees = db.prepare(
      "SELECT name FROM sqlite_master WHERE tbl_name = 'events' AND type IN ('table', 'index')",
    ).all() as Array<{ name: string }>;
    const size = db.prepare("SELECT pgsize FROM dbstat WHERE name = ? AND aggregate = TRUE");
    return btrees.reduce((sum, { name }) => sum + ((size.get(name) as { pgsize: number } | undefined)?.pgsize ?? 0), 0);
  } catch {
    return null; // 这一版 SQLite 没有 dbstat
  }
}

const EVENT_SIZE_SAMPLE = 1_000;
function estimatedEventBytes(db: Db, rows: number): number {
  if (rows === 0) return 0;
  const sample = db.prepare("SELECT * FROM events ORDER BY seq DESC LIMIT ?").all(EVENT_SIZE_SAMPLE) as Array<Record<string, unknown>>;
  const length = (value: unknown): number => typeof value === "string" ? Buffer.byteLength(value)
    : Buffer.isBuffer(value) ? value.length
    : value === null ? 0 : 8;
  const total = sample.reduce((sum, row) => sum + Object.values(row).reduce<number>((rowSum, value) => rowSum + length(value), 0), 0);
  return Math.round((total / sample.length) * rows);
}

export function eventLogReal(path: string): EventLogStatus {
  if (!existsSync(path)) return { state: "absent" };
  try {
    return withReadonlyDb(path, (db) => readEventLog(db));
  } catch (e: any) {
    return { state: "unreadable", error: e.message };
  }
}

export function dbProbesReal(
  path: string,
): Pick<DoctorProbes, "dbSchema" | "aishConfigured" | "fts5Available" | "connections" | "eventLog"> {
  return {
    dbSchema: () => dbSchemaReal(path),
    eventLog: () => eventLogReal(path),
    connections: () => {
      try {
        return withReadonlyDb(path, (db) => db.prepare("SELECT label, status FROM connections ORDER BY id").all() as Array<{ label: string; status: string }>);
      } catch {
        return []; // 库不存在，或者老库还没有这张表
      }
    },
    aishConfigured: () => {
      try {
        return withReadonlyDb(path, (db) => loadAishConn(db) !== null);
      } catch {
        return false; // 库不存在、或老库还缺这些列，都按"未接"报告
      }
    },
    fts5Available: () => {
      // 与 setupFts 同一个前提：当前 SQLite 能建 fts5 trigram 虚表。在内存库里试建，不碰账本。
      try {
        const db = new Database(":memory:");
        try {
          db.exec("CREATE VIRTUAL TABLE fts_probe USING fts5(x, tokenize='trigram')");
          return true;
        } finally {
          db.close();
        }
      } catch {
        return false;
      }
    },
  };
}

// 构建产物新鲜度：dist 不存在 → null（未构建）；否则比较 mtime 与给定源码目录下最新的源码文件。
// srcDirs 传 src/ 和 scripts/（build 脚本本身变了也该算 stale）。web UI 的源码还有 .tsx，由调用方传 extensions。
export function distFreshReal(distFile: string, srcDirs: string[], extensions: string[] = [".ts"]): boolean | null {
  if (!existsSync(distFile)) return null;
  try {
    const distMtime = statSync(distFile).mtimeMs;
    let latest = 0;
    for (const dir of srcDirs) {
      if (!existsSync(dir)) continue;
      const entries = readdirSync(dir, { recursive: true }) as string[];
      for (const rel of entries) {
        if (!extensions.some((extension) => rel.endsWith(extension))) continue;
        const m = statSync(join(dir, rel)).mtimeMs;
        if (m > latest) latest = m;
      }
    }
    return distMtime >= latest;
  } catch {
    return null;
  }
}

export interface BuildOutput { distFile: string; srcDirs: string[]; extensions?: string[] }

// 几份构建产物合起来的新鲜度。daemon 和 plc 各有一份产物，doctor 把它们当作一项检查。
// 有一份未构建 → null；有一份旧于源码 → false；每一份都新于源码 → true。
export function buildsFreshReal(outputs: BuildOutput[]): boolean | null {
  const results = outputs.map((output) => distFreshReal(output.distFile, output.srcDirs, output.extensions));
  if (results.includes(null)) return null;
  return results.every((fresh) => fresh === true);
}

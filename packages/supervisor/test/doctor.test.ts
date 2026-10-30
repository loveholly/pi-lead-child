// test/doctor.test.ts — probes 全部注入，纯逻辑测试；末尾另有真实 probe（resolveKeyReal/distFreshReal）测试
import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  runDoctor, formatChecks, resolveKeyReal, resolveDaemonOnlyKey, distFreshReal, buildsFreshReal, dbProbesReal, dbSchemaReal,
  eventLogReal, readEventLog, EVENT_LOG_WARN_BYTES, EVENT_LOG_WARN_ROWS,
  type DoctorProbes, type DoctorCheck, type EventLogStatus,
} from "../src/deploy/doctor.js";
import { LATEST_SCHEMA_VERSION, SCHEMA_MIGRATION_VERSIONS, createItem, openDb, openExistingDb, transition } from "@pi-lead-child/store";
import { V15_SCHEMA_FIXTURE } from "@pi-lead-child/store/testing";

const okProbes: DoctorProbes = {
  daemonAlive: async () => true,
  dbSchema: () => ({ state: "readable", current: 34, expected: 34, pending: 0 }),
  configParses: () => true,
  resolveKey: (k) => (k === "AM_API_KEY" ? "config" : k === "TAVILY_API_KEY" ? "env" : null),
  configPerms: () => "600",
  aishConfigured: () => true,
  launchdLoaded: async () => true,
  distFresh: () => true,
  webFresh: () => true,
  fts5Available: () => true,
  nodeVersion: () => "v22.1.0",
};

describe("runDoctor: the gateway's exposed address", () => {
  const exposure = (state: "listening" | "retrying", lastError: string | null = null) => ({
    host: "100.64.0.7", port: 5100, state, attempts: 3, lastError, nextRetryAt: state === "retrying" ? "2026-10-13T04:00:00.000Z" : null,
  });

  it("is not listed when the gateway only listens on loopback", async () => {
    const checks = await runDoctor({ ...okProbes, gatewayExposure: async () => null });
    expect(checks.find((check) => check.name === "网关对外地址")).toMatchObject({ ok: null });
  });

  it("reports a host that is listening, and one that is still retrying", async () => {
    const listening = await runDoctor({ ...okProbes, gatewayExposure: async () => exposure("listening") });
    expect(listening.find((check) => check.name === "网关对外地址")).toMatchObject({ ok: true, detail: "100.64.0.7:5100 已在监听" });
    const retrying = await runDoctor({ ...okProbes, gatewayExposure: async () => exposure("retrying", "listen EADDRNOTAVAIL") });
    const check = retrying.find((item) => item.name === "网关对外地址")!;
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("EADDRNOTAVAIL");
    expect(check.fix).toContain("PLC_GATEWAY_HOST");
  });
});

describe("runDoctor", () => {
  it("全部健康时无 fail 项", async () => {
    const checks = await runDoctor(okProbes);
    expect(checks.every((c) => c.ok !== false)).toBe(true);
    expect(checks.length).toBeGreaterThanOrEqual(8);
  });
  it("AM_API_KEY 缺失是 fail 并给修复提示；TAVILY 缺失只是 warn(–)", async () => {
    const checks = await runDoctor({ ...okProbes, resolveKey: () => null });
    const am = checks.find((c) => c.name.includes("AM_API_KEY"))!;
    expect(am.ok).toBe(false);
    expect(am.fix).toMatch(/config\.json/);
    const tavily = checks.find((c) => c.name.includes("TAVILY"))!;
    expect(tavily.ok).toBeNull(); // 可选项缺失 = "–" 不是 "✗"
  });
  it("TYPESAFE_API_KEY 是可选项：缺失只是 –，并提示用 keychain 脚本写入；有来源时 ✓", async () => {
    const missing = (await runDoctor({ ...okProbes, resolveKey: () => null })).find((c) => c.name.includes("TYPESAFE"))!;
    expect(missing.ok).toBeNull();
    expect(missing.detail).toMatch(/兜底/);
    expect(missing.fix).toBe("bash ~/.agents/skills/keychain-secrets/keychain-secrets.sh set TYPESAFE_API_KEY");
    const present = (await runDoctor({ ...okProbes, resolveKey: () => "keychain" })).find((c) => c.name.includes("TYPESAFE"))!;
    expect(present).toMatchObject({ ok: true, detail: "来源: keychain" });
    expect(present.fix).toBeUndefined();
    const broken = (await runDoctor({ ...okProbes, resolveKey: () => "broken" })).find((c) => c.name.includes("TYPESAFE"))!;
    expect(broken.ok).toBe(false);
    expect(broken.fix).toMatch(/value\/fromEnv/);
  });
  // 2026-10-16 发布评审：key 只写在 ~/.zshrc 里时，doctor 报了 ✓，可 launchd 起的 daemon 读不到 shell 的环境变量。
  it("TYPESAFE_API_KEY 只在 shell 的环境变量里时不算有：daemon 读不到", async () => {
    const shell = (await runDoctor({ ...okProbes, resolveKey: () => "shell" })).find((c) => c.name.includes("TYPESAFE"))!;
    expect(shell.ok).toBeNull();
    expect(shell.detail).toMatch(/只在当前 shell 的环境变量里/);
    expect(shell.fix).toBe("bash ~/.agents/skills/keychain-secrets/keychain-secrets.sh set TYPESAFE_API_KEY");
    const settings = (await runDoctor({ ...okProbes, resolveKey: () => "settings" })).find((c) => c.name.includes("TYPESAFE"))!;
    expect(settings).toMatchObject({ ok: true, detail: "来源: 设置页（保险库）" });
  });
  it("resolveDaemonOnlyKey 按 daemon 的来源判断：设置页、config.json、Keychain；shell 的环境变量不算", () => {
    const dir = tempDir("plc-doctor-key-");
    const ledger = join(dir, "plc.db");
    openDb(ledger).close();
    const keychain = (has: boolean) => () => has;
    expect(resolveDaemonOnlyKey(dir, ledger, { TYPESAFE_API_KEY: "from-zshrc" }, "TYPESAFE_API_KEY", keychain(false))).toBe("shell");
    expect(resolveDaemonOnlyKey(dir, ledger, {}, "TYPESAFE_API_KEY", keychain(false))).toBeNull();
    expect(resolveDaemonOnlyKey(dir, ledger, { TYPESAFE_API_KEY: "from-zshrc" }, "TYPESAFE_API_KEY", keychain(true))).toBe("keychain");
    writeFileSync(join(dir, "config.json"), JSON.stringify({ env: { TYPESAFE_API_KEY: { value: "v" } } }));
    expect(resolveDaemonOnlyKey(dir, ledger, {}, "TYPESAFE_API_KEY", keychain(false))).toBe("config");
    // 设置页经 daemon 写库；账本的写入守卫只放行 store 打开的连接（ledger-guard.ts）。
    const db = openExistingDb(ledger);
    db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('secret.decision.apiKey', 'sealed', datetime('now'))").run();
    db.close();
    expect(resolveDaemonOnlyKey(dir, ledger, {}, "TYPESAFE_API_KEY", keychain(false))).toBe("settings");
  });
  // slack-settings 工单 S1：设置页存进保险库的通道令牌（kv 的 secret.channel.<名字>，不解密）算「设置页」，排在 Keychain 前面。
  it("resolveDaemonOnlyKey 认得设置页存的通道令牌", () => {
    const dir = tempDir("plc-doctor-channel-key-");
    const ledger = join(dir, "plc.db");
    openDb(ledger).close();
    expect(resolveDaemonOnlyKey(dir, ledger, {}, "PLC_SLACK_USER_TOKEN", () => true)).toBe("keychain");
    const db = openExistingDb(ledger);
    db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('secret.channel.PLC_SLACK_USER_TOKEN', 'sealed', datetime('now'))").run();
    db.close();
    expect(resolveDaemonOnlyKey(dir, ledger, {}, "PLC_SLACK_USER_TOKEN", () => true)).toBe("settings");
    expect(resolveDaemonOnlyKey(dir, ledger, {}, "PLC_SLACK_APP_TOKEN", () => false)).toBeNull();
  });
  // slack-takeover 工单 02：Slack 通道要两个令牌。只说名字和来源，不显示值；两个都没有只是 –，配了一半是 ✗。
  it("Slack 通道：两个令牌都有时 ✓，都没有时 –，缺一个或者只在 shell 里时 ✗ 并说出名字", async () => {
    const slackCheck = async (sources: Record<string, ReturnType<DoctorProbes["resolveKey"]>>) =>
      (await runDoctor({ ...okProbes, resolveKey: (key) => sources[key] ?? null })).find((check) => check.name === "Slack 通道")!;
    expect(await slackCheck({ PLC_SLACK_APP_TOKEN: "keychain", PLC_SLACK_USER_TOKEN: "config" }))
      .toMatchObject({ ok: true, detail: expect.stringContaining("来源: Keychain、环境变量（config.json 的 env）") });
    expect(await slackCheck({ PLC_SLACK_APP_TOKEN: "settings", PLC_SLACK_USER_TOKEN: "settings" }))
      .toMatchObject({ ok: true, detail: expect.stringContaining("来源: 设置页、设置页") });
    const none = await slackCheck({});
    expect(none.ok).toBeNull();
    expect(none.detail).toContain("PLC_SLACK_APP_TOKEN、PLC_SLACK_USER_TOKEN");
    const half = await slackCheck({ PLC_SLACK_APP_TOKEN: "keychain" });
    expect(half).toMatchObject({ ok: false, detail: expect.stringContaining("缺 PLC_SLACK_USER_TOKEN") });
    expect(half.fix).toBe(
      "在设置 → 消息通道里填上 PLC_SLACK_USER_TOKEN；或者 bash ~/.agents/skills/keychain-secrets/keychain-secrets.sh set PLC_SLACK_USER_TOKEN，再重启 daemon",
    );
    const shell = await slackCheck({ PLC_SLACK_APP_TOKEN: "keychain", PLC_SLACK_USER_TOKEN: "shell" });
    expect(shell).toMatchObject({ ok: false, detail: expect.stringContaining("PLC_SLACK_USER_TOKEN 只在当前 shell 的环境变量里") });
  });
  it("config 权限过宽是 fail", async () => {
    const checks = await runDoctor({ ...okProbes, configPerms: () => "644" });
    expect(checks.find((c) => c.name.includes("权限"))!.ok).toBe(false);
  });
  it("daemon 不在线时 daemon 活性为 ✗", async () => {
    const checks = await runDoctor({ ...okProbes, daemonAlive: async () => false });
    expect(checks.find((c) => c.name.includes("daemon"))!.ok).toBe(false);
  });
  it("config.json 条目形状错误（broken）时 AM_API_KEY 报 fail 且 detail 提示检查 value/fromEnv", async () => {
    const checks = await runDoctor({ ...okProbes, resolveKey: () => "broken" });
    const am = checks.find((c) => c.name.includes("AM_API_KEY"))!;
    expect(am.ok).toBe(false);
    expect(am.detail).toMatch(/value\/fromEnv/);
  });
  it("TAVILY broken 态也要有 fix 提示（此前漏了）", async () => {
    const checks = await runDoctor({ ...okProbes, resolveKey: () => "broken" });
    const tavily = checks.find((c) => c.name.includes("TAVILY"))!;
    expect(tavily.ok).toBe(false);
    expect(tavily.fix).toBeTruthy();
  });
  it("账本 schema 与代码一致时 ✓，且不带修复提示", async () => {
    const db = (await runDoctor(okProbes)).find((c) => c.name === "账本 db")!;
    expect(db.ok).toBe(true);
    expect(db.detail).toBe("schema v34，与代码一致");
    expect(db.fix).toBeUndefined();
  });
  it("账本落后代码只是 –：报告待执行的迁移个数，提示 daemon 启动时会迁移", async () => {
    const checks = await runDoctor({
      ...okProbes, dbSchema: () => ({ state: "readable", current: 25, expected: 34, pending: 6 }),
    });
    const db = checks.find((c) => c.name === "账本 db")!;
    expect(db.ok).toBeNull();
    expect(db.detail).toBe("schema v25，代码期望 v34，6 个迁移待执行");
    expect(db.fix).toMatch(/plc daemon restart/);
  });
  it("账本比代码新是 ✗（跑的是旧代码）", async () => {
    const checks = await runDoctor({
      ...okProbes, dbSchema: () => ({ state: "readable", current: 35, expected: 34, pending: 0 }),
    });
    const db = checks.find((c) => c.name === "账本 db")!;
    expect(db.ok).toBe(false);
    expect(db.detail).toMatch(/v35.*v34/);
    expect(db.fix).toMatch(/npm run build/);
  });
  it("账本打不开是 ✗，detail 带错误信息；账本不存在只是 –", async () => {
    const broken = (await runDoctor({
      ...okProbes, dbSchema: () => ({ state: "unreadable", error: "file is not a database" }),
    })).find((c) => c.name === "账本 db")!;
    expect(broken.ok).toBe(false);
    expect(broken.detail).toMatch(/file is not a database/);
    expect(broken.fix).toBeTruthy();
    const missing = (await runDoctor({ ...okProbes, dbSchema: () => ({ state: "missing" }) }))
      .find((c) => c.name === "账本 db")!;
    expect(missing.ok).toBeNull();
    expect(missing.detail).toMatch(/尚未创建/);
  });
  it("web UI 构建产物：未构建是 –，旧于源码是 ✗，两者都提示 npm run build:web", async () => {
    const fresh = (await runDoctor(okProbes)).find((c) => c.name === "web UI 构建产物")!;
    expect(fresh.ok).toBe(true);
    expect(fresh.detail).toBe("dist/web 新于 companion 源码");
    expect(fresh.fix).toBeUndefined();
    const missing = (await runDoctor({ ...okProbes, webFresh: () => null }))
      .find((c) => c.name === "web UI 构建产物")!;
    expect(missing.ok).toBeNull();
    expect(missing.detail).toMatch(/未构建/);
    expect(missing.fix).toMatch(/npm run build:web/);
    const stale = (await runDoctor({ ...okProbes, webFresh: () => false }))
      .find((c) => c.name === "web UI 构建产物")!;
    expect(stale.ok).toBe(false);
    expect(stale.detail).toMatch(/旧于/);
    expect(stale.fix).toMatch(/npm run build:web/);
  });
  it("config.json 解析失败时该检查 ✗，detail 是错误信息", async () => {
    const checks = await runDoctor({ ...okProbes, configParses: () => "config.json 解析失败（/x/config.json）: Unexpected token" });
    const c = checks.find((c) => c.name.includes("可解析"))!;
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/解析失败/);
    expect(c.fix).toBeTruthy();
  });
});

describe("formatChecks", () => {
  it("ok=null 但带 fix 的项（如 launchd 未装）也要渲染修复提示（此前是死代码）；✓ 态（无 fix）不出修复行", () => {
    const checks: DoctorCheck[] = [
      { name: "launchd job", ok: null, detail: "未安装（手动模式）", fix: "plc daemon install" },
      { name: "node", ok: true, detail: "v22.1.0" },
    ];
    const out = formatChecks(checks);
    expect(out).toContain("– ");
    expect(out).toContain("↳ 修复: plc daemon install");
    expect(out.split("\n").filter((l) => l.includes("↳ 修复")).length).toBe(1); // 只有 launchd 那一行有修复提示
  });
});

describe("resolveKeyReal（真实 probe）", () => {
  let dir: string;
  beforeEach(() => { dir = tempDir("plc-doctor-"); });

  it("正常：config.json 里有可解析的 value 条目 → config", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ env: { AM_API_KEY: { value: "x" } } }));
    expect(resolveKeyReal(dir, {}, "AM_API_KEY")).toBe("config");
  });
  it("broken：条目是裸字符串（没有 value/fromEnv 形状）→ broken", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ env: { AM_API_KEY: "oops" } }));
    expect(resolveKeyReal(dir, {}, "AM_API_KEY")).toBe("broken");
  });
  it("缺失：无 config.json 且进程环境也没有该 key → null", () => {
    expect(resolveKeyReal(dir, {}, "AM_API_KEY")).toBeNull();
  });
});

describe("distFreshReal（真实 probe）", () => {
  let dir: string;
  beforeEach(() => { dir = tempDir("plc-doctor-dist-"); });

  it("dist 不存在 → null（未构建）", () => {
    expect(distFreshReal(join(dir, "dist.mjs"), [join(dir, "src")])).toBeNull();
  });
  it("dist 比 src 新 → true", () => {
    const srcDir = join(dir, "src");
    mkdirSync(srcDir);
    const srcFile = join(srcDir, "a.ts");
    const distFile = join(dir, "dist.mjs");
    writeFileSync(srcFile, "x");
    writeFileSync(distFile, "y");
    const old = new Date(Date.now() - 60_000);
    const now = new Date();
    utimesSync(srcFile, old, old);
    utimesSync(distFile, now, now);
    expect(distFreshReal(distFile, [srcDir])).toBe(true);
  });
  it("dist 比 src 旧 → false", () => {
    const srcDir = join(dir, "src");
    mkdirSync(srcDir);
    const srcFile = join(srcDir, "a.ts");
    const distFile = join(dir, "dist.mjs");
    writeFileSync(srcFile, "x");
    writeFileSync(distFile, "y");
    const old = new Date(Date.now() - 60_000);
    const now = new Date();
    utimesSync(distFile, old, old);
    utimesSync(srcFile, now, now);
    expect(distFreshReal(distFile, [srcDir])).toBe(false);
  });
});

describe("distFreshReal 按扩展名比较（web UI 的 .tsx 源码）", () => {
  let dir: string;
  beforeEach(() => { dir = tempDir("plc-doctor-web-"); });

  it("一个比产物新的 .tsx 让产物算作旧", () => {
    const srcDir = join(dir, "src");
    mkdirSync(join(srcDir, "app"), { recursive: true });
    const tsFile = join(srcDir, "data.ts");
    const tsxFile = join(srcDir, "app", "pair.tsx");
    const built = join(dir, "index.html");
    writeFileSync(tsFile, "x");
    writeFileSync(tsxFile, "x");
    writeFileSync(built, "y");
    const old = new Date(Date.now() - 120_000);
    const mid = new Date(Date.now() - 60_000);
    const now = new Date();
    utimesSync(tsFile, old, old);
    utimesSync(built, mid, mid);
    utimesSync(tsxFile, now, now);
    expect(distFreshReal(built, [srcDir], [".ts", ".tsx"])).toBe(false);
    utimesSync(built, now, now);
    utimesSync(tsxFile, mid, mid);
    expect(distFreshReal(built, [srcDir], [".ts", ".tsx"])).toBe(true);
  });
});

// daemon 和 plc 各有一份构建产物。只看 daemon 的那份，改了 CLI 的源码 doctor 也会说"新"。
describe("buildsFreshReal（daemon 和 CLI 两份构建产物）", () => {
  let dir: string;
  beforeEach(() => { dir = tempDir("plc-doctor-builds-"); });

  const old = new Date(Date.now() - 60_000);
  const now = new Date();
  // 建一份构建产物和它的源码目录。state 决定产物和源码谁更新；unbuilt 时不写产物。
  function build(name: string, state: "fresh" | "stale" | "unbuilt") {
    const srcDir = join(dir, name, "src");
    mkdirSync(srcDir, { recursive: true });
    const srcFile = join(srcDir, "a.ts");
    const distFile = join(dir, name, "dist.mjs");
    writeFileSync(srcFile, "x");
    if (state !== "unbuilt") {
      writeFileSync(distFile, "y");
      utimesSync(distFile, state === "fresh" ? now : old, state === "fresh" ? now : old);
    }
    utimesSync(srcFile, state === "fresh" ? old : now, state === "fresh" ? old : now);
    return { distFile, srcDirs: [srcDir] };
  }

  it("CLI 的产物旧于源码时算旧，即使 daemon 的产物是新的", () => {
    expect(buildsFreshReal([build("daemon", "fresh"), build("cli", "stale")])).toBe(false);
  });
  it("有一份没有构建时算未构建", () => {
    expect(buildsFreshReal([build("daemon", "fresh"), build("cli", "unbuilt")])).toBeNull();
  });
  it("每一份都新于源码时才算新", () => {
    expect(buildsFreshReal([build("daemon", "fresh"), build("cli", "fresh")])).toBe(true);
  });
});

// 老库输入沿用 item-rename-migration 测试的 v15 快照：它是改名前 openDb 产出的物理形状，
// 不随 schema.ts 漂移。
const V15_FIXTURE = readFileSync(V15_SCHEMA_FIXTURE, "utf8");

function seedV15Db(dir: string): string {
  const path = join(dir, "plc.db");
  const db = new Database(path);
  db.pragma("journal_mode = WAL"); // 与真实账本一致
  db.pragma("foreign_keys = OFF"); // 建表顺序按字母序，FK 目标未必先建
  db.exec(V15_FIXTURE);
  db.exec(`
    INSERT INTO schema_migrations (version, name) VALUES
      (10, 'kernel-orchestration-v1'), (11, 'checkpoint-control-plane-v1'),
      (12, 'plan-item-idempotency-v1'), (13, 'checkpoint-fidelity-storage-v1'),
      (14, 'item-model-v1'), (15, 'trigger-notification-v1');
    INSERT INTO tickets (id, kind, title, body, status, brief, created_by, root_ticket_id,
                         orchestration_state, status_changed_at)
      VALUES (1, 'task', 'root task', '', 'active', 'b1', 'user', 1, 'none',
              '2026-01-01T00:00:00Z');
  `);
  db.close();
  return path;
}

function dbSnapshot(path: string) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return {
      userVersion: db.pragma("user_version", { simple: true }),
      objects: db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all(),
      ledger: db.prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version").all(),
    };
  } finally {
    db.close();
  }
}

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("dbProbesReal（真实 probe）不改账本", () => {
  let dir: string;
  beforeEach(() => { dir = tempDir("plc-doctor-db-"); });

  // 回归：2026-10-12 doctor 用 openDb 打开真实账本，把它从 v25 静默迁到了 v34。
  it("老库上跑完整个 doctor 后，user_version、表结构、迁移账本和文件内容都不变", async () => {
    const path = seedV15Db(dir);
    const before = dbSnapshot(path);
    const hashBefore = fileHash(path);

    await runDoctor({ ...okProbes, ...dbProbesReal(path) });

    expect(dbSnapshot(path)).toEqual(before);
    expect(fileHash(path)).toBe(hashBefore);
  });

  it("账本文件不存在时不凭空建库", async () => {
    const path = join(dir, "plc.db");
    await runDoctor({ ...okProbes, ...dbProbesReal(path) });
    expect(existsSync(path)).toBe(false);
  });

  it("老库报告当前版本、代码期望的版本和待执行的迁移个数", async () => {
    const path = seedV15Db(dir);
    const checks = await runDoctor({ ...okProbes, ...dbProbesReal(path) });
    const pending = SCHEMA_MIGRATION_VERSIONS.filter((v) => v > 15).length;
    const db = checks.find((c) => c.name === "账本 db")!;
    expect(db.ok).toBeNull();
    expect(db.detail).toBe(`schema v15，代码期望 v${LATEST_SCHEMA_VERSION}，${pending} 个迁移待执行`);
  });

  it("不是 SQLite 文件时报 unreadable", () => {
    const path = join(dir, "plc.db");
    writeFileSync(path, "not a database, just text that is long enough to fill a header".repeat(4));
    expect(dbSchemaReal(path).state).toBe("unreadable");
  });

  // SCHEMA_MIGRATION_VERSIONS 是手写列表：新增迁移忘了追加，新建库的账本就会多出一个它不认识的版本。
  it("新建库的账本正好是 SCHEMA_MIGRATION_VERSIONS，读数为最新且无待执行迁移", () => {
    const path = join(dir, "plc.db");
    const fresh = openDb(path);
    const ledger = (fresh.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as
      Array<{ version: number }>).map((row) => row.version);
    fresh.close();
    expect(ledger).toEqual([...SCHEMA_MIGRATION_VERSIONS]);
    expect(dbSchemaReal(path)).toEqual({
      state: "readable", current: LATEST_SCHEMA_VERSION, expected: LATEST_SCHEMA_VERSION, pending: 0,
    });
  });
});

describe("runDoctor: connections", () => {
  const check = async (connections: Array<{ label: string; status: string }>) =>
    (await runDoctor({ ...okProbes, connections: () => connections })).find((entry) => entry.name === "连接");

  it("is optional when nothing is connected, and ignores disconnected rows", async () => {
    expect(await check([])).toMatchObject({ ok: null });
    expect(await check([{ label: "Notion", status: "disconnected" }])).toMatchObject({ ok: null });
  });

  it("fails and names the account that needs re-authorization", async () => {
    expect(await check([{ label: "Notion", status: "needs_reauth" }, { label: "GitHub", status: "connected" }]))
      .toMatchObject({ ok: false, detail: "Notion 需要重新授权", fix: expect.stringContaining("设置 → 连接") });
  });

  it("passes while an account is only temporarily unreachable", async () => {
    expect(await check([{ label: "Jira & Confluence", status: "degraded" }]))
      .toMatchObject({ ok: true, detail: "1 个已连接，Jira & Confluence 暂时连不上（会自动重试）" });
  });

  it("reads names and states from a real ledger without the secrets", () => {
    const path = join(tempDir("plc-doctor-connections-"), "plc.db");
    const db = openDb(path);
    db.prepare("INSERT INTO connections (provider, label, server_url, token_source, status, created_at, updated_at) VALUES ('notion', 'Notion', 'https://mcp.notion.com/mcp', 'oauth', 'connected', 'x', 'x')").run();
    db.close();
    expect(dbProbesReal(path).connections!()).toEqual([{ label: "Notion", status: "connected" }]);
  });
});

// 事件表（v43 的 events）只追加，还没有保留期清理。doctor 显示它的行数、大小和最早一条的时间，超过阈值时提醒。
describe("runDoctor: the event table", () => {
  const check = async (eventLog: EventLogStatus) =>
    (await runDoctor({ ...okProbes, eventLog: () => eventLog })).find((entry) => entry.name === "事件表")!;
  const readable = (rows: number, bytes: number, estimated = false): EventLogStatus =>
    ({ state: "readable", rows, bytes, estimated, oldestAt: "2026-10-16T08:00:00.000Z" });

  it("shows the rows, the size and the oldest event, with no reminder under the thresholds", async () => {
    const entry = await check(readable(12_345, 4 * 1024 * 1024));
    expect(entry).toMatchObject({ ok: true, detail: "12345 行，约 4.0 MB（含索引），最早一条 2026-10-16T08:00:00.000Z" });
    expect(entry.fix).toBeUndefined();
    // 正好等于阈值不算超过。
    expect(await check(readable(EVENT_LOG_WARN_ROWS, EVENT_LOG_WARN_BYTES))).toMatchObject({ ok: true });
  });

  it("says when the size is an estimate", async () => {
    expect((await check(readable(10, 2_048, true))).detail).toContain("估算：dbstat 不可用，按行数乘平均行长");
  });

  it("reminds about retention when the rows or the size go over the threshold, without failing doctor", async () => {
    const rows = await check(readable(EVENT_LOG_WARN_ROWS + 1, 1024));
    expect(rows.ok).toBeNull();
    expect(rows.detail).toContain("行数超过 500000");
    expect(rows.fix).toContain("保留期清理");
    expect(rows.fix).toContain("还没有这个功能");
    const bytes = await check(readable(10, EVENT_LOG_WARN_BYTES + 1));
    expect(bytes.ok).toBeNull();
    expect(bytes.detail).toContain("大小超过 300.0 MB");
    expect(bytes.fix).toContain("保留期清理");
    expect(formatChecks([bytes])).toContain("↳ 修复: 以后可以开启事件的保留期清理");
  });

  it("says there is no event table yet for an older ledger, and does not count it as a failure", async () => {
    const entry = await check({ state: "absent" });
    expect(entry.ok).toBeNull();
    expect(entry.detail).toContain("还没有事件表");
    expect(entry.fix).toBeUndefined();
  });

  it("is not listed when the probe is not given", async () => {
    expect((await runDoctor(okProbes)).some((entry) => entry.name === "事件表")).toBe(false);
  });
});

describe("eventLogReal（真实 probe）", () => {
  it("reads the rows, the size and the oldest event from a ledger without changing the file", async () => {
    const path = join(tempDir("plc-doctor-events-"), "plc.db");
    const db = openDb(path);
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "user" });
    transition(db, { itemId, to: "active", actor: "system", reason: "spawn" });
    transition(db, { itemId, to: "review", actor: "system", reason: "delivered" });
    transition(db, { itemId, to: "done", actor: "user", reason: "accepted" });
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
    const { received_at: oldestAt } = db.prepare("SELECT received_at FROM events ORDER BY seq LIMIT 1").get() as { received_at: string };
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    expect(n).toBeGreaterThanOrEqual(3);
    const hashBefore = fileHash(path);

    const status = eventLogReal(path);
    expect(status).toMatchObject({ state: "readable", rows: n, estimated: false, oldestAt });
    // dbstat 按页面计：表和它的索引至少各占一页。
    expect(status.state === "readable" && status.bytes).toBeGreaterThanOrEqual(4_096);
    const checks = await runDoctor({ ...okProbes, ...dbProbesReal(path) });
    expect(checks.find((entry) => entry.name === "事件表")).toMatchObject({ ok: true, detail: expect.stringContaining(`${n} 行`) });
    expect(fileHash(path)).toBe(hashBefore);
  });

  it("estimates the size from the average row length when dbstat is not available", () => {
    const db = openDb(join(tempDir("plc-doctor-events-estimate-"), "plc.db"));
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "user" });
    transition(db, { itemId, to: "active", actor: "system", reason: "spawn" });
    transition(db, { itemId, to: "review", actor: "system", reason: "delivered" });
    const status = readEventLog(db, () => null);
    const rows = db.prepare("SELECT * FROM events").all() as Array<Record<string, unknown>>;
    db.close();
    expect(status).toMatchObject({ state: "readable", rows: rows.length, estimated: true });
    // 估算值在行里数据的字节数附近：每行至少有 event_id、kind、entity_key 和两个时间。
    expect(status.state === "readable" && status.bytes).toBeGreaterThan(rows.length * 50);
  });

  it("reports an empty table as zero rows with no oldest event", () => {
    const db = openDb(join(tempDir("plc-doctor-events-empty-"), "plc.db"));
    expect(readEventLog(db)).toMatchObject({ state: "readable", rows: 0, oldestAt: null });
    expect(readEventLog(db, () => null)).toMatchObject({ state: "readable", rows: 0, bytes: 0, estimated: true });
    db.close();
  });

  it("says absent for a ledger from before v43 and for a ledger that does not exist", async () => {
    const dir = tempDir("plc-doctor-events-legacy-");
    const path = seedV15Db(dir);
    expect(eventLogReal(path)).toEqual({ state: "absent" });
    const checks = await runDoctor({ ...okProbes, ...dbProbesReal(path) });
    expect(checks.find((entry) => entry.name === "事件表")).toMatchObject({ ok: null, detail: expect.stringContaining("还没有事件表") });
    expect(eventLogReal(join(dir, "missing.db"))).toEqual({ state: "absent" });
    expect(existsSync(join(dir, "missing.db"))).toBe(false);
  });
});

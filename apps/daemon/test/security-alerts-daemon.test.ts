// 安全报警走完 daemon 这一跳（2026-10-19 审查的修改意见）：
//   - 写入守卫的触发器被删掉：daemon 补装，记一条 ledger.guard_removed，直接推送。
//   - config.json 被手改：记一条 tell 级的 config.changed_outside_api，交给 Lead，不直接推送。
//   - plc lead use 经 plc.sock 让 daemon 写 config.json：不报警。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb, ledgerGuardTriggers, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

beforeEach(() => {
  dir = tempDir("plc-security-alerts-");
  dbPath = join(dir, "plc.db");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(dbPath);
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
});

function sessionFactory() {
  return async () => ({
    modelName: "stub/model",
    session: {
      sessionId: "stub-session",
      subscribe() { return () => {}; },
      async prompt() {}, async steer() {}, async followUp() {}, dispose() {},
    },
  });
}

async function boot() {
  daemon = await startDaemon({
    dataDir: dir, dbPath, sessionFactory: sessionFactory() as any, gatewayPort: 0, log: () => {},
    ledgerGuardCheckMs: 50, configWatchMs: 50,
  });
}

function sockCommand(command: Record<string, unknown>): Promise<{ success: boolean; data?: any; error?: string }> {
  return new Promise((resolve, reject) => {
    const sock = connect(join(dir, "plc.sock"));
    let buffer = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      sock.end();
      resolve(JSON.parse(buffer.slice(0, newline)));
    });
    sock.once("error", reject);
    sock.once("connect", () => sock.write(`${JSON.stringify(command)}\n`));
  });
}

const eventsOf = (kind: string) =>
  db.prepare("SELECT level, payload, correlation_id FROM events WHERE kind = ? ORDER BY seq").all(kind) as
    Array<{ level: string; payload: string; correlation_id: string | null }>;

describe("security alerts through the daemon", () => {
  it("reinstalls a dropped guard trigger and pushes one alert", async () => {
    await boot();
    const before = ledgerGuardTriggers(db).length;
    const foreign = new Database(dbPath);
    foreign.exec('DROP TRIGGER "plc_ledger_guard_connections_update"');
    foreign.close();
    await vi.waitFor(() => expect(ledgerGuardTriggers(db)).toHaveLength(before), { timeout: 15_000, interval: 50 });
    const alerts = eventsOf("ledger.guard_removed");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ level: "interrupt" });
    expect(JSON.parse(alerts[0]!.payload)).toMatchObject({ missing: ["plc_ledger_guard_connections_update"], count: 1 });
    const notificationId = Number(alerts[0]!.correlation_id!.replace("notification:", ""));
    await vi.waitFor(() => {
      expect((db.prepare("SELECT state FROM notifications WHERE id = ?").get(notificationId) as { state: string }).state).toBe("delivered");
    }, { timeout: 15_000, interval: 50 });
  }, 30_000);

  it("replaces a same-name empty trigger with the real guard and alerts", async () => {
    await boot();
    const foreign = new Database(dbPath);
    foreign.exec(`DROP TRIGGER "plc_ledger_guard_kv_insert";
      CREATE TRIGGER "plc_ledger_guard_kv_insert" BEFORE INSERT ON "kv" BEGIN SELECT 1; END;`);
    foreign.close();
    await vi.waitFor(() => expect(eventsOf("ledger.guard_removed")).toHaveLength(1), { timeout: 15_000, interval: 50 });
    expect(JSON.parse(eventsOf("ledger.guard_removed")[0]!.payload)).toMatchObject({ missing: ["plc_ledger_guard_kv_insert"] });
    const again = new Database(dbPath);
    expect(() => again.prepare("INSERT INTO kv (key, value) VALUES ('x', 'y')").run()).toThrow(/plc_db_is_read_only/);
    again.close();
  }, 30_000);

  it("hands a hand edit of config.json to Lead at tell level, and stays quiet for plc lead use", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ lead: { models: ["a/b"] } }));
    await boot();
    const viaDaemon = await sockCommand({ type: "set_lead_model", spec: "local/qwen" });
    expect(viaDaemon).toMatchObject({ success: true, data: { models: ["local/qwen", "a/b"] } });
    // 等两轮核对：daemon 自己写的不报。
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(eventsOf("config.changed_outside_api")).toEqual([]);

    writeFileSync(join(dir, "config.json"), JSON.stringify({ lead: { models: ["local/qwen"] }, env: { X_TOKEN: { value: "v" } } }));
    await vi.waitFor(() => expect(eventsOf("config.changed_outside_api")).toHaveLength(1), { timeout: 15_000, interval: 50 });
    const [event] = eventsOf("config.changed_outside_api");
    expect(event).toMatchObject({ level: "tell", correlation_id: null });
    expect(JSON.parse(event!.payload)).toMatchObject({ changed: expect.arrayContaining(["env", "lead.models"]), notificationId: null });
    expect(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'security_alert'").get()).toEqual({ n: 0 });
  }, 30_000);
});

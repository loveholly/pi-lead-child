// child 的记录里的密钥和写账本的尝试（2026-10-19 审查）。
// 事故：工单 #96 的 child（Run #109）执行了 `env | grep`，AM_API_KEY 的明文进了 runtime-events/run-109.jsonl 和
// sessions/item-96/*.jsonl；它还执行了 `sqlite3 ~/.pi-lead-child/plc.db "UPDATE connections SET write_policy = 'direct' …"`，
// 没有任何记录，用户也没收到提醒。child 的环境不变（executor 和独立 CLI 一致），这里只管记录和报警。
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createItem, listEvents, listNotifications, openDb } from "@pi-lead-child/store";
import type { AgentRuntime, RuntimeEvent, RuntimeHandle } from "@pi-lead-child/runtime";
import type { RuntimeId } from "@pi-lead-child/core";
import { runItem } from "../src/children/manager.js";
import { commandOfToolEvent, detectLedgerWrite, sqlWrites } from "../src/children/ledger-write-detector.js";
import { redactRuntimeEvent, scrubSessionFiles } from "../src/children/secret-scrub.js";

const SECRET = "am-live-7Hq2Zx9Lw4Pr8Kt1Vb6Nc3Md5Fg0Js";

// 像 pi 一样：把会话写进 sessionDir，并发出 bash 的工具事件。
class LeakyRuntime implements AgentRuntime {
  readonly id: RuntimeId = "pi";
  readonly capabilities = {
    streaming: true, steering: false, resume: true, interrupt: true,
    approvals: true, mcp: true, executableReadOnlyReview: true,
  };
  constructor(private readonly dbPath: string) {}

  async start(request: Parameters<AgentRuntime["start"]>[0]): Promise<RuntimeHandle> {
    const now = new Date().toISOString();
    mkdirSync(request.sessionDir!, { recursive: true });
    writeFileSync(join(request.sessionDir!, "2026-10-19_session.jsonl"),
      `${JSON.stringify({ type: "tool_result", output: `AM_API_KEY=${SECRET}\nHOME=/Users/x` })}\n`);
    const update = `sqlite3 ${this.dbPath} "UPDATE connections SET write_policy = 'direct' WHERE provider = 'github';"`;
    const events: RuntimeEvent[] = [
      { type: "run.started", runId: request.runId, seq: 1, occurredAt: now, runtime: this.id, model: null },
      { type: "tool.started", runId: request.runId, seq: 2, occurredAt: now, callId: "c1", name: "bash", args: { command: "env | grep KEY" } },
      { type: "tool.completed", runId: request.runId, seq: 3, occurredAt: now, callId: "c1", name: "bash", result: `AM_API_KEY=${SECRET}` },
      { type: "tool.started", runId: request.runId, seq: 4, occurredAt: now, callId: "c2", name: "bash", args: { command: update } },
      { type: "tool.failed", runId: request.runId, seq: 5, occurredAt: now, callId: "c2", name: "bash", error: "no such function" },
      { type: "run.completed", runId: request.runId, seq: 6, occurredAt: now, exitCode: 0 },
    ];
    return {
      pid: null,
      events: (async function* () { yield* events; })(),
      interrupt: async () => {},
      wait: async () => ({ ok: true, exitCode: 0, signal: null, externalSessionId: null, errorCode: null, errorMessage: null }),
    };
  }
}

describe("a child that prints a key and writes the ledger", () => {
  it("keeps the key out of the event log, the run file and the session file, and alerts once for the write", async () => {
    const dir = tempDir("plc-child-secrets-");
    const dbPath = join(dir, "plc.db");
    const db = openDb(dbPath);
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    const sessionDir = join(dir, "sessions", `item-${itemId}`);

    const { runId } = await runItem(db, itemId, {
      dbPath, dataDir: dir, sessionDir, prompt: "do it", runtime: new LeakyRuntime(dbPath), lingerMs: 0,
      env: { AM_API_KEY: SECRET },
    });

    const payloads = (db.prepare("SELECT payload FROM runtime_events WHERE run_id = ?").all(runId) as Array<{ payload: string }>)
      .map((row) => row.payload).join("\n");
    expect(payloads).toContain("AM_API_KEY=[REDACTED]");
    expect(payloads).not.toContain(SECRET);
    expect(readFileSync(join(dir, "runtime-events", `run-${runId}.jsonl`), "utf8")).not.toContain(SECRET);
    for (const name of readdirSync(sessionDir)) {
      expect(readFileSync(join(sessionDir, name), "utf8"), name).not.toContain(SECRET);
    }

    const alerts = listEvents(db, { kind: "ledger.write_attempted" });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      level: "interrupt", entityKey: `run:${runId}`,
      payload: { runId, itemId, target: "plc.db", command: expect.stringContaining("UPDATE connections") },
      rootCause: { code: "ledger_write_attempted" },
    });
    const pushed = listNotifications(db, { state: ["pending"] }).filter((row) => row.kind === "security_alert");
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.title).toContain(`工单 #${itemId}`);
  });
});

describe("which commands write the ledger or the config", () => {
  const paths = { dbPath: "/Users/x/.pi-lead-child/plc.db", dataDir: "/Users/x/.pi-lead-child", home: "/Users/x" };

  it("finds the 10-19 command and other writes", () => {
    for (const command of [
      "sqlite3 ~/.pi-lead-child/plc.db \"UPDATE connections SET write_policy = 'direct' WHERE provider = 'github';\"",
      "sqlite3 /Users/x/.pi-lead-child/plc.db 'delete from approvals'",
      "sqlite3 \"$PLC_DB\" \"insert into kv values ('a','b')\"",
      "cd ~/.pi-lead-child && sqlite3 plc.db 'drop trigger plc_ledger_guard_connections_update'",
      "sqlite3 ~/.pi-lead-child/plc.db 'SELECT 1; WITH x AS (SELECT 1) UPDATE items SET stage = \"done\"'",
      "echo \"PRAGMA user_version = 3\" | sqlite3 ~/.pi-lead-child/plc.db",
      "sqlite3 ~/.pi-lead-child/plc.db <<'SQL'\nSELECT 1;\nDELETE FROM events;\nSQL",
      "python3 -c \"import sqlite3; c = sqlite3.connect('/Users/x/.pi-lead-child/plc.db'); c.execute('UPDATE connections SET roles = 1')\"",
      "rm ~/.pi-lead-child/plc.db",
      "rm -f ~/.pi-lead-child/plc.db-wal",
      // 审查发现 5 的漏报：把别的库复制成 plc.db。
      "cp /tmp/x.db ~/.pi-lead-child/plc.db",
    ]) {
      expect(detectLedgerWrite(command, paths), command).toEqual({ target: "plc.db" });
    }
    for (const command of [
      "echo '{}' > ~/.pi-lead-child/config.json",
      "sed -i '' 's/confirm/direct/' $HOME/.pi-lead-child/config.json",
      "cp /tmp/new.json ~/.pi-lead-child/config.json",
      "vim ~/.pi-lead-child/config.json",
      "jq '.lead.models = []' ~/.pi-lead-child/config.json | tee ~/.pi-lead-child/config.json",
    ]) {
      expect(detectLedgerWrite(command, paths), command).toEqual({ target: "config.json" });
    }
  });

  it("leaves reads alone (review finding 5)", () => {
    for (const command of [
      "sqlite3 -readonly ~/.pi-lead-child/plc.db 'SELECT * FROM connections'",
      "sqlite3 ~/.pi-lead-child/plc.db 'SELECT updated_at, created_at FROM items'",
      // 不带 -readonly 的 SELECT 里出现 update、delete、replace()、'CREATE TABLE%'。
      "sqlite3 ~/.pi-lead-child/plc.db \"SELECT kind FROM events WHERE kind IN ('update', 'delete')\"",
      "sqlite3 ~/.pi-lead-child/plc.db \"SELECT replace(title, 'a', 'b') FROM items\"",
      "sqlite3 ~/.pi-lead-child/plc.db \"SELECT name FROM sqlite_master WHERE sql LIKE 'CREATE TABLE%'\"",
      "ls ~/.pi-lead-child/plc.db* && grep insert notes.txt",
      "sqlite3 -readonly ~/.pi-lead-child/plc.db 'select 1'; rm -rf /tmp/x",
      "sqlite3 ~/.pi-lead-child/plc.db .schema 2>&1 | head",
      "cat ~/.pi-lead-child/config.json",
      "cp ~/.pi-lead-child/config.json /tmp/backup.json",
      "cp ~/.pi-lead-child/plc.db /tmp/plc-copy.db",
      "tail -n 50 ~/.pi-lead-child/logs/daemon.log",
      "grep -rn plc.db packages/store",
      "sqlite3 /tmp/other.db 'DELETE FROM t'",
    ]) {
      expect(detectLedgerWrite(command, paths), command).toBeNull();
    }
  });

  it("reads SQL statements by their first keyword", () => {
    expect(sqlWrites("SELECT 'DROP TABLE x' AS s")).toBe(false);
    expect(sqlWrites("select 1; -- delete later\nselect 2")).toBe(false);
    expect(sqlWrites("BEGIN; INSERT INTO kv VALUES (1, 2); COMMIT")).toBe(true);
    expect(sqlWrites(".import data.csv items")).toBe(true);
    expect(sqlWrites("PRAGMA table_info(items)")).toBe(false);
  });

  it("reads the command out of a tool event", () => {
    expect(commandOfToolEvent({ type: "tool.started", args: { command: "ls" } })).toBe("ls");
    expect(commandOfToolEvent({ type: "tool.started", args: { cmd: ["git", "status"] } })).toBe("git status");
    expect(commandOfToolEvent({ type: "tool.completed", args: { command: "ls" } })).toBeNull();
  });
});

describe("scrubbing", () => {
  it("returns the same event when there is nothing to mask", () => {
    const event = { type: "tool.completed", runId: 1, seq: 1, occurredAt: "t", callId: "c", name: "bash", result: "ok" } as RuntimeEvent;
    expect(redactRuntimeEvent(event, [SECRET])).toBe(event);
  });

  it("rewrites only the session files written since the run started", () => {
    const dir = tempDir("plc-session-scrub-");
    writeFileSync(join(dir, "a.jsonl"), `{"x":"${SECRET}"}\n`);
    writeFileSync(join(dir, "notes.txt"), SECRET);
    expect(scrubSessionFiles(dir, [SECRET], Date.now() + 60_000)).toBe(0);
    expect(scrubSessionFiles(dir, [SECRET], Date.now() - 60_000)).toBe(1);
    expect(readFileSync(join(dir, "a.jsonl"), "utf8")).toBe("{\"x\":\"[REDACTED]\"}\n");
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe(SECRET);
  });
});

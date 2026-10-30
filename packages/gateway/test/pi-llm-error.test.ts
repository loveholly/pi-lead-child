// 工单 13（spec D1，工单 02 的 Comments）：pi 的 LLM 错误。
// pi 1.1.0 的 LLM 错误是一条 stopReason=error 的助手消息，随后是 agent_end。旧 adapter 把它报成 run.completed。
// 于是认证、余额、满载这些失败没有类型：Run 记成 finished，ingest 升起没有类型的 llm_error blocker，请 lead 检查。
// 现在 adapter 把它报成类型化的 run.failed，内核按 scope 处理。llm_error blocker 只留给仍以完成结束的 Run。
// Seam 1：runItem 经启动垫片运行真实的 PiRuntime 和 fake pi CLI，库是真实的 SQLite。
// 测试从 gateway 的 HTTP 接口读用户看到的通知。
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runItem } from "@pi-lead-child/engine";
import { PiRuntime } from "@pi-lead-child/runtime";
import type { AgentRuntime } from "@pi-lead-child/runtime";
import { listInbox, openDb, type Db } from "@pi-lead-child/store";
import { createItem, getItem } from "@pi-lead-child/store";
import { executorRetryBudget } from "@pi-lead-child/store";
import { getRun } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { readGatewayNotifications } from "../testing/gateway-reader.js";
import { ReplayRuntime } from "@pi-lead-child/runtime/testing";

const dirs: string[] = [];
const dbs: Db[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function runOnFreshDb(runtime: AgentRuntime, lingerMs = 0) {
  const dir = tempDir("plc-pi-llm-error-");
  dirs.push(dir);
  const dbPath = join(dir, "plc.db");
  const db = openDb(dbPath);
  dbs.push(db);
  const itemId = createItem(db, { title: "pi llm error", brief: "b", createdBy: "user", runtime: "pi" });
  const { runId } = await runItem(db, itemId, {
    dbPath, dataDir: dir, sessionDir: join(dir, "sessions", `item-${itemId}`),
    prompt: "do the work", runtime, runtimeId: "pi", lingerMs,
  });
  return { db, itemId, run: getRun(db, runId)! };
}

function fakePi(scenario: string): PiRuntime {
  return new PiRuntime({
    bin: resolve("node_modules/.bin/tsx"), prefixArgs: [resolve("packages/runtime/testing/fake-pi.ts")],
    env: { FAKE_SCENARIO: scenario }, killGraceMs: 200,
  });
}

describe("a pi LLM error", () => {
  it("is an account failure on the health ledger when the account is out of credits: one incident, no llm_error blocker", async () => {
    const { db, itemId, run } = await runOnFreshDb(fakePi("llm_out_of_credits"));

    expect(run).toMatchObject({ state: "failed", failure_scope: "account", failure_code: "out_of_credits" });
    expect(run.failure_evidence).toContain("out of credits");
    expect(executorRetryBudget(db, itemId).failures).toBe(0);
    // 内核排了挂起的重试，工单在等 runtime 恢复，不进 blocked。
    expect(getItem(db, itemId)!.stage).toBe("active");
    const kinds = (await readGatewayNotifications(db)).map((notice) => notice.kind);
    expect(kinds.filter((kind) => kind === "runtime_incident")).toHaveLength(1);
    expect(kinds).not.toContain("llm_error");
  });

  // 内核为瞬时失败排了退避重试（spec D5）。pi 在 RPC 模式下不会自己退出。adapter 不停止它的话，
  // 它停留到 linger 到期（默认 300 秒）。在这之前 manager 不给这张工单启动新的 Run，重试因此失败。
  it("leaves no pi process behind when pi gives up on a capacity error, so the kernel's retry can start", async () => {
    const { db, itemId, run } = await runOnFreshDb(fakePi("llm_capacity"), 60_000);

    expect(run).toMatchObject({ state: "failed", failure_scope: "attempt", failure_code: "provider_overloaded" });
    expect(db.prepare("SELECT state FROM dispatch_requests WHERE item_id=? AND trigger='transient-retry'").all(itemId))
      .toEqual([{ state: "pending" }]);
    expect(() => process.kill(run.pid!, 0)).toThrow();
  });

  it("asks Lead once, with the error text, and charges the retry budget when nobody recognizes it", async () => {
    const { db, itemId, run } = await runOnFreshDb(fakePi("llm_unrecognized"));

    expect(run).toMatchObject({ state: "failed", failure_scope: "unknown", failure_code: "unknown" });
    expect(executorRetryBudget(db, itemId).failures).toBe(1);
    expect(getItem(db, itemId)!.stage).toBe("blocked");
    // 2026-10-15 起先交给 Lead：Lead 收到一条带着错误原文的 blocker，用户不收通知（Lead 处理不了时才升级给用户）。
    expect((await readGatewayNotifications(db)).filter((notice) => notice.ticketId === itemId)).toEqual([]);
    const blockers = listInbox(db, { severity: "blocker" }).filter((row) => row.item_id === itemId);
    expect(blockers).toHaveLength(1);
    expect(JSON.parse(blockers[0]!.payload)).toMatchObject({ needsUser: false, summary: expect.stringContaining("the model refused the request shape") });
  });
});

// ingest 的 llm_error 规则仍然管以完成结束的 Run，例如旧数据和其他 runtime。
describe("a run that completes after an LLM error message", () => {
  it("still raises one llm_error blocker and blocks the ticket", async () => {
    const replay = new ReplayRuntime({
      runtime: "pi",
      events: [
        { type: "run.started", runtime: "pi", model: null },
        { type: "message.completed", messageId: "m-1", role: "assistant", text: "provider exploded", stopReason: "error" },
        { type: "run.completed", exitCode: 0 },
      ],
    });
    const { db, itemId, run } = await runOnFreshDb(replay);

    expect(run.state).toBe("finished");
    expect(getItem(db, itemId)!.stage).toBe("blocked");
    // 2026-10-15 起先交给 Lead：一条 llm_error blocker 给 Lead，用户不收通知。
    expect((await readGatewayNotifications(db)).filter((notice) => notice.ticketId === itemId)).toEqual([]);
    const blockers = listInbox(db, { severity: "blocker" }).filter((row) => row.item_id === itemId);
    expect(blockers.map((row) => JSON.parse(row.payload).blockerCode)).toEqual(["llm_error"]);
    expect(JSON.parse(blockers[0]!.payload)).toMatchObject({ needsUser: false, summary: expect.stringContaining("provider exploded") });
  });
});

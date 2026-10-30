// pi 的执行 Run 交付以后，进程还会停留（linger，默认 5 分钟）等新的指令（2026-10-19 用户审查）。
//
// 问题 1：「Run 结束了，工单现在是 review」这条说明只在进程退出时才写（onChildDone）。
// inbox #134、#140、#146、#153、#167、#169 都比 runs.ended_at 晚整整 5 分钟，用户多次问「为什么完成了不告诉我」。
// 现在 Run 一结束就写，叫醒 Lead；进程退出时不再写第二条。
//
// 问题 2：停留期间的工单消息被发进那个进程。那个 Run 已经结束，新一轮的事件不再落库，用户看不到回答，
// agent 的交接工具也因为「Run 已结束」被拒（工单 #93 的 Run #106 因此直接改了数据库）。
// 现在停留中的进程不再接收新的一轮：系统停止它，开一个新的对话 Run 续接会话回答。
//
// 走完整的落库路径：daemon 用 fake pi 派发执行 Run，Lead 是假的 pi 会话，什么都不说。
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { tempDir } from "@pi-lead-child/core/testing";
import { createDispatcher, liveChildren } from "@pi-lead-child/engine";
import { runningChildren } from "@pi-lead-child/lead";
import { createItem, createPairing, getRun, listRuns, openDb, redeemPairing, type Db } from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";
import { fakePiLead } from "./fake-pi-session.js";

const FAKE_PI = { piBin: resolve("node_modules/.bin/tsx"), piArgs: [resolve("packages/runtime/testing/fake-pi.ts")] };

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

beforeEach(() => {
  dir = tempDir("plc-run-finished-linger-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  // 和线上一样长到测试等不完：通知只能来自 Run 结束的那一刻，不能来自进程退出。
  vi.stubEnv("PLC_CHILD_LINGER_MS", "120000");
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const child of liveChildren().values()) await child.handle?.interrupt("test cleanup");
  await Promise.allSettled([...runningChildren().values()]);
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

async function startWithExecution(): Promise<{ itemId: number; runId: number }> {
  const itemId = createItem(db, { title: "交付后马上告诉 Lead", brief: "implement", createdBy: "user" });
  createDispatcher(db).request({
    itemId, role: "executor", purpose: "execution", runtime: "pi",
    trigger: "test", idempotencyKey: `test-execution:${itemId}`,
  });
  const lead = fakePiLead(() => ({ say: "NO_REPLY" }));
  daemon = await startDaemon({
    dataDir: dir, dbPath, sessionFactory: lead.factory as never, childPi: FAKE_PI,
    gatewayPort: 0, log: () => {}, notifyDesktop: () => {},
  });
  // 这一轮结束了，进程还在停留。
  await vi.waitFor(() => expect(liveChildren().get(itemId)?.settled).toBe(true), { timeout: 20_000 });
  const runId = liveChildren().get(itemId)!.runId;
  expect(getRun(db, runId)).toMatchObject({ state: "finished", purpose: "execution" });
  return { itemId, runId };
}

// 读事件，不读 inbox 行：交接失败的 blocker 还没交给 Lead 时，Run 结束的说明并进那一行（2026-10-29），没有自己的行。
function runFinishedNotes(runId: number): Array<{ summary: string }> {
  return db.prepare(
    `SELECT json_extract(payload, '$.summary') AS summary FROM events
     WHERE kind = 'inbox.attention' AND json_extract(payload, '$.inboxKind')='run_finished'
       AND json_extract(payload, '$.payload.runId')=?`,
  ).all(runId) as Array<{ summary: string }>;
}

describe("a pi execution run that lingers after its turn", () => {
  it("wakes Lead as soon as the run finishes, not when the lingering process exits, and only once", async () => {
    const { itemId, runId } = await startWithExecution();

    // 进程还在，说明已经写下。工单交接失败进了 blocked，说明里就是这个阶段。
    await vi.waitFor(() => expect(runFinishedNotes(runId)).toHaveLength(1), { timeout: 5_000 });
    expect(liveChildren().get(itemId)?.runId).toBe(runId);
    expect(runFinishedNotes(runId)[0]!.summary).toContain(`Run #${runId}（执行）结束了，工单现在是 blocked`);

    // 进程退出（linger 到期）：onChildDone 收尾，不再写第二条。
    await liveChildren().get(itemId)!.handle!.interrupt("linger timeout");
    await vi.waitFor(() => expect(runningChildren().has(itemId)).toBe(false), { timeout: 10_000 });
    expect(runFinishedNotes(runId)).toHaveLength(1);
  }, 60_000);

  it("answers a ticket message sent while the process lingers in a new run, not inside the finished one", async () => {
    const { itemId, runId } = await startWithExecution();
    const issued = redeemPairing(db, createPairing(db, { name: "app", kind: "companion", scopes: ["chat", "tickets:view"] }).code);
    const socket = new WebSocket(`ws://127.0.0.1:${daemon!.pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2`);
    sockets.push(socket);
    const events: any[] = [];
    socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
    await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true), { timeout: 10_000 });

    socket.send(JSON.stringify({
      type: "chat.send", id: "linger-message", protocolVersion: 2, message: "现在做到哪了？", context: { ticketId: itemId },
    }));
    await vi.waitFor(() => expect(events.some((event) => event.type === "command.result" && event.id === "linger-message"))
      .toBe(true), { timeout: 10_000 });

    const turn = () => db.prepare(
      "SELECT state, assistant_text, error FROM channel_turns WHERE item_id=? AND origin_kind LIKE '%:ticket-agent' ORDER BY created_at DESC LIMIT 1",
    ).get(itemId) as { state: string; assistant_text: string; error: string | null } | undefined;
    await vi.waitFor(() => expect(turn()?.state).toMatch(/^(completed|failed)$/), { timeout: 30_000 });
    expect(turn()).toMatchObject({ state: "completed", assistant_text: expect.stringContaining("done:") });

    // 回答来自一个新的对话 Run，它续接执行 Run 的会话。执行 Run 保持结束。
    // 这个执行 Run 交接失败了，进程停下以后系统还会排一个补交成果的回合（outcome_repair），它和这条消息无关。
    const runs = listRuns(db, itemId)
      .filter((run) => run.purpose !== "outcome_repair")
      .map((run) => [run.id, run.purpose, run.state, run.resumed_from_run_id]);
    expect(runs).toEqual([
      [runId, "execution", "finished", null],
      [expect.any(Number), "conversation", "finished", runId],
    ]);
    await vi.waitFor(() => expect(runningChildren().has(itemId)).toBe(false), { timeout: 10_000 });
    expect(runFinishedNotes(runId)).toHaveLength(1);
  }, 90_000);
});

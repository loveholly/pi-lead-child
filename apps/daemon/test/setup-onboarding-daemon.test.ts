// 首次启动引导走完整的路径（2026-10-30，.scratch/onboarding/spec.md）：daemon 启动时大脑不能用 → GET /v1/setup 说大脑没配好；
// 接好以后 Lead 第一次上线，会话的 lead-activity 视图里有一张准备清单卡；用户自己的一轮结束时追加一张建议卡；
// 卡上的「以后再说」走操作层（POST /v1/actions/setup_hint/<编号>/snooze），卡原地变成 snoozed、按钮没了。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { LeadActivityViewSchema, SetupResponseSchema } from "@pi-lead-child/protocol";
import { createPairing, loadSetupChecklist, openDb, redeemPairing, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { Value } from "typebox/value";
import { startDaemon } from "../src/server.js";
import { fakePiLead } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

beforeEach(() => {
  dir = tempDir("plc-setup-onboarding-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

async function start(brain: { ready: boolean }) {
  const lead = fakePiLead(() => ({ say: "好的。" }));
  const factory = async (options: unknown) => ({ ...(await (lead.factory as (o: unknown) => Promise<object>)(options)), brainReady: async () => brain.ready });
  daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: factory as never, log: () => {}, notifyDesktop: () => {} });
  const issued = redeemPairing(db, createPairing(db, {
    name: "app", kind: "companion", scopes: ["chat", "tickets:view", "tickets:create"],
  }).code);
  const socket = new WebSocket(`ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2&include=lead_activity`);
  sockets.push(socket);
  const events: any[] = [];
  socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true), { timeout: 5_000 });
  const headers = { authorization: `Bearer ${issued.accessToken}`, "content-type": "application/json" };
  const get = async (path: string) => {
    const response = await fetch(`http://127.0.0.1:${daemon!.pairedPort}${path}`, { headers });
    expect(response.status).toBe(200);
    return response.json() as Promise<any>;
  };
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${daemon!.pairedPort}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  let sent = 0;
  const send = async (message: string) => {
    const id = `cmd-${++sent}`;
    socket.send(JSON.stringify({ type: "chat.send", id, protocolVersion: 2, message }));
    await vi.waitFor(() => expect(events.some((event) => event.type === "command.result" && event.id === id)).toBe(true), { timeout: 5_000 });
    return events.find((event) => event.type === "command.result" && event.id === id).data as { turnId: string };
  };
  return { get, post, send, events };
}

const turnState = (id: string) => (db.prepare("SELECT state FROM channel_turns WHERE id = ?").get(id) as { state: string }).state;

describe("first-run onboarding", () => {
  it("shows the checklist once the brain comes online, adds a hint after the user's turn, and snoozes it", async () => {
    const brain = { ready: false };
    const { get, post, send, events } = await start(brain);

    await vi.waitFor(async () => {
      const setup = await get("/v1/setup");
      expect(Value.Check(SetupResponseSchema, setup)).toBe(true);
      expect(setup.setup.items[0]).toEqual({ key: "brain", ready: false, detail: null });
    }, { timeout: 5_000 });
    expect(loadSetupChecklist(db)).toBeNull();

    // 用户在首次启动页接好了大脑：下一次重算时 Lead 第一次上线，建准备清单卡，推给会话。
    brain.ready = true;
    await vi.waitFor(() => expect(loadSetupChecklist(db)?.state).toBe("shown"), { timeout: 10_000 });
    await vi.waitFor(() => expect(events.some((event) => event.type === "snapshot.required"
      && event.payload?.resource === "lead-activity" && event.payload?.setup?.key === "setup:checklist")).toBe(true), { timeout: 5_000 });
    const view = await get("/v1/lead/activity?include=events&include=setup");
    expect(Value.Check(LeadActivityViewSchema, view)).toBe(true);
    expect(view.setup.items.map((item: any) => [item.key, item.ready])).toEqual([
      ["brain", true], ["memory", false], ["slack", false], ["profile", false], ["github", false], ["jira", false], ["notion", false],
    ]);
    expect(view.setupHints).toEqual([]);

    // 用户自己的一轮成功结束：追加一张建议卡，建议第一项没配好的（记忆）。
    const { turnId } = await send("你好");
    await vi.waitFor(() => expect(turnState(turnId)).toBe("completed"), { timeout: 5_000 });
    await vi.waitFor(async () => {
      const after = await get("/v1/lead/activity?include=events&include=setup");
      expect(after.setupHints).toEqual([expect.objectContaining({
        key: "setup_hint:1", item: "memory", state: "open",
        actions: [
          { target: { type: "setup_hint", id: "1" }, action: "snooze", label: "以后再说" },
          { target: { type: "setup_hint", id: "1" }, action: "dismiss", label: "不用再提" },
        ],
      })]);
    }, { timeout: 5_000 });

    // 卡上的「以后再说」：和 Lead 的 perform_action 是同一个操作。卡原地变成 snoozed，按钮没了；再点一次被拒绝。
    const snoozed = await post("/v1/actions/setup_hint/1/snooze", { input: {} });
    expect(snoozed.status).toBe(200);
    const view2 = await get("/v1/lead/activity?include=events&include=setup");
    expect(view2.setupHints).toEqual([expect.objectContaining({ key: "setup_hint:1", state: "snoozed", actions: [] })]);
    const again = await post("/v1/actions/setup_hint/1/snooze", { input: {} });
    expect(again.status).not.toBe(200);

    // 不带 include=setup 的旧客户端拿不到这两个字段。
    const legacy = await get("/v1/lead/activity?include=events");
    expect(legacy.setup).toBeUndefined();
    expect(legacy.setupHints).toBeUndefined();
  });

  // Core Invariants：功能上线前就能用大脑的老用户，不补发准备清单。
  it("does not show the checklist when the brain already works at startup", async () => {
    const { get } = await start({ ready: true });
    await vi.waitFor(async () => expect((await get("/v1/setup")).setup?.items[0]?.ready).toBe(true), { timeout: 5_000 });
    expect(loadSetupChecklist(db)?.state).toBe("skipped");
    expect((await get("/v1/lead/activity?include=events&include=setup")).setup).toBeNull();
  });
});

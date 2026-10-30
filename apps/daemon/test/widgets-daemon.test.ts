// 自定义控件走完用户经过的每一跳（用户 2026-10-30，.scratch/custom-views/spec.md D1、D7）：
//   用户让 Lead 做一个控件，Lead 用 perform_action（widget_board / create）建控件，放进缺省的视图；
//   用户要分类时 Lead 把它移到「投资」视图（widget / update 的 view）；
//   App 收到 snapshot.required（resource=widgets），读 GET /v1/widgets 画面板；
//   用户在面板上删它（POST /v1/actions/widget/<编号>/delete，带 confirm），面板空了。
// daemon、网关、操作层和 Lead 的工具是真的；Lead 的会话是替身。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { Value } from "typebox/value";
import { WidgetsResponseSchema } from "@pi-lead-child/protocol";
import { createLoopbackBinding, createPairing, openDb, redeemPairing, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { createLeadTools, type LeadDeps } from "@pi-lead-child/lead";
import { startDaemon } from "../src/server.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

beforeEach(() => {
  dir = tempDir("plc-widgets-daemon-");
  dbPath = join(dir, "plc.db");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(dbPath);
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await daemon?.close();
  daemon = null;
  db.close();
});

function leadSessionFactory(capture: { tools: ReturnType<typeof createLeadTools> }) {
  return async (args: LeadDeps) => {
    capture.tools = createLeadTools(args);
    return {
      modelName: "stub/lead",
      session: {
        sessionId: "lead-widgets", subscribe: () => () => {},
        prompt: async () => {}, steer: async () => {}, followUp: async () => {}, dispose: () => {},
      },
    };
  };
}

async function boot() {
  const capture = { tools: [] as ReturnType<typeof createLeadTools> };
  daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: leadSessionFactory(capture) as never, gatewayPort: 0, log: () => {} });
  const owner = createLoopbackBinding(db, { name: "test-web" });
  const base = `http://127.0.0.1:${daemon.pairedPort}`;
  const call = async (method: "GET" | "POST", path: string, body?: unknown, token: string | null = owner.accessToken) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const token = redeemPairing(db, createPairing(db, { name: "app", kind: "companion", scopes: ["chat", "tickets:view"] }).code).accessToken;
  const socket = new WebSocket(`ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${token}&protocol=2&after_seq=-1`);
  sockets.push(socket);
  const pushes: any[] = [];
  socket.on("message", (raw) => pushes.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(pushes.some((event) => event.type === "hello.v2")).toBe(true));
  await vi.waitFor(() => expect(capture.tools.length).toBeGreaterThan(0));
  const tool = (name: string) => capture.tools.find((candidate) => candidate.name === name)!;
  const run = async (name: string, params: unknown): Promise<any> => tool(name).execute("t", params as never, undefined, undefined, undefined as never);
  const reloads = () => pushes.filter((event) => event.type === "snapshot.required" && event.payload.resource === "widgets").length;
  return { call, run, reloads };
}

describe("custom widgets through the daemon", () => {
  it("lets Lead create a widget and move it to a view, pushes reloads, serves it on GET /v1/widgets, and lets the user delete it with confirm", async () => {
    const { call, run, reloads } = await boot();
    expect(await call("GET", "/v1/widgets")).toEqual({ status: 200, body: { widgets: [] } });
    expect((await call("GET", "/v1/widgets", undefined, null)).status).toBe(401);

    const created = await run("perform_action", {
      target_type: "widget_board", target_id: "widgets", action: "create", reason: "用户要一个纳斯达克指数的控件",
      input: {
        title: "纳斯达克",
        surface: {
          root: "tile",
          nodes: [{ id: "tile", type: "Tile", props: { eyebrow: "纳斯达克", value: "18,532", caption: "10-30 16:00" } }],
          fallback_text: "纳斯达克 18,532（10-30 16:00）",
        },
      },
    });
    expect(created.content[0].text).toContain("created");
    await vi.waitFor(() => expect(reloads()).toBe(1));

    const listed = await call("GET", "/v1/widgets");
    expect(listed.status).toBe(200);
    expect(Value.Check(WidgetsResponseSchema, listed.body)).toBe(true);
    const [widget] = listed.body.widgets;
    expect(widget).toMatchObject({ title: "纳斯达克", view: "default", createdBy: "lead", surface: { id: `widget_${widget.id}`, root: "tile" } });

    await run("perform_action", {
      target_type: "widget", target_id: String(widget.id), action: "update", input: { view: "投资" }, reason: "用户要按类别分视图",
    });
    await vi.waitFor(() => expect(reloads()).toBe(2));
    expect((await call("GET", "/v1/widgets")).body.widgets[0]).toMatchObject({ id: widget.id, view: "投资" });

    expect((await call("POST", `/v1/actions/widget/${widget.id}/delete`, { input: {} })).status).toBe(409);
    const deleted = await call("POST", `/v1/actions/widget/${widget.id}/delete`, { input: { confirm: true } });
    expect(deleted.status).toBe(200);
    await vi.waitFor(() => expect(reloads()).toBe(3));
    expect((await call("GET", "/v1/widgets")).body).toEqual({ widgets: [] });
  });
});

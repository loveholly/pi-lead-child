// 打开交付里的文件的页面入口（工单 07，spec 5.4）：POST /v1/tickets/:id/actions/open_delivery_file。
// 只要 tickets:view，但只接受这台电脑上的回环请求：手机（局域网上的另一台设备）看得到文件列表，打不开。
// opener 是假的，测试不真的调用 macOS 的 open。
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { tempDir } from "@pi-lead-child/core/testing";
import { TicketActionRunResponseSchema, TicketActionsResponseSchema } from "@pi-lead-child/protocol";
import {
  createItem, createPairing, createRun, insertOutcomeSnapshot, normalizeOutcomePayload, openDb, updateRun, type Db,
} from "@pi-lead-child/store";
import { liveChildren, type FileOpenApp, type FileOpener } from "@pi-lead-child/engine";
import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer } from "../src/paired-server.js";
import { createUserActionService } from "../src/user-actions.js";

let db: Db;
let dir: string;
let opened: Array<{ path: string; app: FileOpenApp }>;

beforeEach(() => {
  dir = tempDir("plc-open-file-http-");
  db = openDb(join(dir, "plc.db"));
  opened = [];
  liveChildren().clear();
});
afterEach(() => db.close());

function runtime() {
  return { model: "stub/model", sessionId: "stub-session", busy: false, runningItemIds: [], aish: null };
}

const openFile: FileOpener = { supported: true, async open(path, app) { opened.push({ path, app }); } };

// 监听所有网卡：局域网地址上来的请求就是「另一台设备」。
async function start() {
  const server = await startPairedServer({
    db,
    controlPlane: createControlPlaneService(db, { runtime, now: () => new Date() }),
    userActions: createUserActionService({ db, resumeRun: () => {}, openFile }),
    hello: runtime,
    chat: () => "started",
    addClient: () => () => {},
    log: () => {},
  }, { port: 0, host: "0.0.0.0" });
  return { ...server, base: `http://127.0.0.1:${server.port}` };
}

function viewerToken(): string {
  const { code } = createPairing(db, { name: "看工单的设备", kind: "companion", scopes: ["tickets:view"] });
  return code;
}

async function redeem(base: string, code: string): Promise<string> {
  const response = await fetch(`${base}/v1/paired/redeem`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pairing_code: code }),
  });
  return (await response.json() as { access_token: string }).access_token;
}

// 一张直接改在你目录里的工单，交付了 summary.md。
function deliveredNotes(): { itemId: number; workdir: string } {
  const workdir = join(dir, "notes");
  mkdirSync(workdir);
  writeFileSync(join(workdir, "summary.md"), "# 总结\n");
  const itemId = createItem(db, { title: "整理笔记", brief: "b", createdBy: "lead", workdir });
  const runId = createRun(db, { itemId, runtime: "claude" });
  updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
  insertOutcomeSnapshot(db, {
    itemId, executorRunId: runId, source: "system_recovered", sourceEventSeq: 1, sourceOutputSha256: "b".repeat(64),
    outcome: normalizeOutcomePayload({
      summary: "整理了。", changes: [{ kind: "file", ref: "summary.md", summary: "新增" }], deliverables: [], validations: [],
    }, { workdir }),
    now: new Date(),
  });
  db.prepare("UPDATE items SET stage='review' WHERE id=?").run(itemId);
  return { itemId, workdir };
}

function lanAddress(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254.")) return entry.address;
    }
  }
  return undefined;
}

async function openAction(base: string, token: string, itemId: number) {
  const response = await fetch(`${base}/v1/tickets/${itemId}/actions`, { headers: { authorization: `Bearer ${token}` } });
  const body = await response.json();
  expect(Value.Check(TicketActionsResponseSchema, body)).toBe(true);
  return (body as { actions: Array<{ id: string; available: boolean; reason: string | null }> }).actions
    .find((action) => action.id === "open_delivery_file")!;
}

describe("opening a delivered file from the page", () => {
  it("opens it on this computer for a caller that can only view tickets", async () => {
    const server = await start();
    try {
      const { itemId, workdir } = deliveredNotes();
      const token = await redeem(server.base, viewerToken());
      expect(await openAction(server.base, token, itemId)).toMatchObject({ available: true, reason: null });

      const response = await fetch(`${server.base}/v1/tickets/${itemId}/actions/open_delivery_file`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ input: { path: "summary.md" } }),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(Value.Check(TicketActionRunResponseSchema, body)).toBe(true);
      expect(body).toMatchObject({
        action: "open_delivery_file", result: { path: "summary.md", sequence: 1, location: "workdir", app: "text_editor" },
      });
      // 文件列表是 agent 自己报的（没有隔离分支），所以用文本编辑器打开。
      expect(opened).toEqual([{ path: realpathSync(join(workdir, "summary.md")), app: "text_editor" }]);

      // 带 .. 的路径：400，报错里没有服务器路径，没有打开任何东西。
      const outside = await fetch(`${server.base}/v1/tickets/${itemId}/actions/open_delivery_file`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ input: { path: "../plc.db" } }),
      });
      expect(outside.status).toBe(400);
      expect(JSON.stringify(await outside.json())).not.toContain(dir);
      expect(opened).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  const lan = lanAddress();
  it.skipIf(!lan)("refuses a request that does not come from loopback, and the listing says why", async () => {
    const server = await start();
    try {
      const { itemId } = deliveredNotes();
      const token = await redeem(server.base, viewerToken());
      const phone = `http://${lan}:${server.port}`;
      const reason = "手机上不能打开文件，请在电脑上打开。";
      expect(await openAction(phone, token, itemId)).toMatchObject({ available: false, reason });

      const response = await fetch(`${phone}/v1/tickets/${itemId}/actions/open_delivery_file`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ input: { path: "summary.md" } }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: { code: "conflict", message: reason, details: { reason: "unavailable" } } });
      expect(opened).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

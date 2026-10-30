// 用户返工时，工单上记着的 runtime 被用户停用了（2026-10-19 发布评审）。以前返工请求显式写了 item.requested_runtime，
// 绕过了 dispatcher 的「重新选」：请求被挂起，Lead 没有工具能改派（recover_ticket_run 要失败的 Run，spawn_child 被排队的请求挡住），
// 工单一直卡到用户重新启用。现在请求不点名 runtime，dispatcher 换一个没停用的。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer } from "../src/paired-server.js";
import { createUserActionService } from "../src/user-actions.js";
import { createItem, createPairing, createRun, getItem, openDb, transition, type Db } from "@pi-lead-child/store";
import { liveChildren } from "@pi-lead-child/engine";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-disabled-user-rework-"), "plc.db"));
  liveChildren().clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const runtime = () => ({ model: "stub/model", sessionId: "stub-session", busy: false, runningItemIds: [], aish: null });

describe("user rework with a disabled runtime", () => {
  it("dispatches the rework to a runtime that is still enabled", async () => {
    const server = await startPairedServer({
      db,
      controlPlane: createControlPlaneService(db, { runtime, now: () => new Date() }),
      userActions: createUserActionService({ db, resumeRun: () => {} }),
      hello: runtime, chat: () => "started", addClient: () => () => {}, log: () => {},
    }, { port: 0 });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const { code } = createPairing(db, { name: "app", kind: "companion", scopes: ["tickets:view", "tickets:create"] });
      const token = (await (await fetch(`${base}/v1/paired/redeem`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pairing_code: code }),
      })).json() as { access_token: string }).access_token;
      const itemId = createItem(db, { title: "t", brief: "b", createdBy: "lead", verificationPolicy: "independent_reviewer", runtime: "codex" });
      transition(db, { itemId, to: "active", actor: "system", reason: "start" });
      createRun(db, { itemId, role: "executor", purpose: "execution", runtime: "codex" });
      transition(db, { itemId, to: "review", actor: "child", reason: "done" });

      vi.stubEnv("PLC_DISABLED_RUNTIMES", "codex");
      const response = await fetch(`${base}/v1/lead/delegation`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ ticket_id: itemId, granted: true, start_rework: true, max_rework_cycles: 1 }),
      });
      expect(response.status).toBe(200);
      const request = db.prepare("SELECT runtime FROM dispatch_requests WHERE item_id=? AND trigger='user-rework'").get(itemId) as { runtime: string };
      expect(request.runtime).not.toBe("codex");
      expect(getItem(db, itemId)?.requested_runtime).toBe(request.runtime);
    } finally {
      await server.close();
    }
  });
});

// 核查证据的 HTTP 面（工单 #503）：工单详情列出核查员挂的截图和对应的标准，按编号取内容画缩略图和大图。只读，要 tickets:view。
// 附件列表里不出现核查证据：旧客户端严格校验附件列表，证据单独一个接口。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { ReviewEvidenceListSchema, TicketAttachmentContentSchema } from "@pi-lead-child/protocol";
import { addAcceptanceCriteria, addReviewEvidence, createItem, createPairing, createRun, openDb, type Db } from "@pi-lead-child/store";
import { Value } from "typebox/value";

import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer } from "../src/paired-server.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

let db: Db;
let dir: string;
beforeEach(() => {
  dir = tempDir("plc-evidence-http-");
  db = openDb(join(dir, "plc.db"));
});
afterEach(() => db.close());

function runtime() {
  return { model: "stub/model", sessionId: "stub-session", busy: false, runningItemIds: [], aish: null };
}

async function start() {
  const server = await startPairedServer({
    db,
    controlPlane: createControlPlaneService(db, { runtime, now: () => new Date(), dataDir: dir }),
    hello: runtime,
    chat: () => "started",
    addClient: () => () => {},
    log: () => {},
  }, { port: 0 });
  return { ...server, base: `http://127.0.0.1:${server.port}` };
}

async function token(base: string, scopes: string[]) {
  const { code } = createPairing(db, { name: "evidence-client", kind: "companion", scopes });
  const response = await fetch(`${base}/v1/paired/redeem`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pairing_code: code }),
  });
  return (await response.json() as { access_token: string }).access_token;
}

describe("review evidence over HTTP", () => {
  it("lists a ticket's review evidence with its criteria and returns one image's content", async () => {
    const itemId = createItem(db, { title: "截图附到工单", brief: "b", createdBy: "lead" });
    const [criterion] = addAcceptanceCriteria(db, { itemId, texts: ["桌面能打开大图"], by: "lead" });
    db.prepare("UPDATE items SET stage = 'review' WHERE id = ?").run(itemId);
    const runId = createRun(db, { itemId, role: "reviewer" });
    const { evidence } = await addReviewEvidence(db, dir, {
      itemId, runId, name: "desktop.png", mimeType: "image/png", data: PNG, sourcePath: ".scratch/review/desktop.png",
      criterionIds: [criterion!.id], caption: "桌面打开大图", addedBy: "reviewer",
    });
    const server = await start();
    try {
      const auth = { authorization: `Bearer ${await token(server.base, ["tickets:view"])}` };

      const list = await fetch(`${server.base}/v1/tickets/${itemId}/review-evidence`, { headers: auth });
      expect(list.status).toBe(200);
      const body = await list.json();
      expect(Value.Check(ReviewEvidenceListSchema, body)).toBe(true);
      expect(body.items).toEqual([expect.objectContaining({
        id: evidence.id, attemptId: runId, criterionIds: [criterion!.id], caption: "桌面打开大图", path: ".scratch/review/desktop.png",
      })]);
      // 附件列表里没有它。
      const attachments = await (await fetch(`${server.base}/v1/tickets/${itemId}/attachments`, { headers: auth })).json();
      expect(attachments.items).toEqual([]);

      const content = await fetch(`${server.base}/v1/tickets/${itemId}/review-evidence/${evidence.id}`, { headers: auth });
      expect(content.status).toBe(200);
      const image = await content.json();
      expect(Value.Check(TicketAttachmentContentSchema, image)).toBe(true);
      expect(Buffer.from(image.data, "base64")).toEqual(PNG);

      expect((await fetch(`${server.base}/v1/tickets/${itemId}/review-evidence/evd_missing`, { headers: auth })).status).toBe(404);
      expect((await fetch(`${server.base}/v1/tickets/${itemId}/review-evidence/..%2Fplc.db`, { headers: auth })).status).toBe(404);
      expect((await fetch(`${server.base}/v1/tickets/${itemId + 99}/review-evidence`, { headers: auth })).status).toBe(404);
      // 别的工单的证据编号不能借这张工单取。
      const other = createItem(db, { title: "other", brief: "b", createdBy: "lead" });
      expect((await fetch(`${server.base}/v1/tickets/${other}/review-evidence/${evidence.id}`, { headers: auth })).status).toBe(404);
      expect((await fetch(`${server.base}/v1/tickets/${itemId}/review-evidence`)).status).toBe(401);
    } finally {
      await server.close();
    }
  });
});

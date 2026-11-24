// 核查证据的存储（工单 #503）：和工单附件存在同一个地方，同样按内容认类型，只收图片；同一次核查同样的图只挂一次。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";

import {
  addReviewEvidence, createItem, createRun, listReviewEvidence, listTicketAttachments, openDb, readReviewEvidence,
  TicketAttachmentError, type Db,
} from "../src/index.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

let dir: string;
let db: Db;
let itemId: number;
let runId: number;

beforeEach(() => {
  dir = tempDir("plc-evidence-store-");
  db = openDb(join(dir, "plc.db"));
  itemId = createItem(db, { title: "t", brief: "b", createdBy: "lead" });
  db.prepare("UPDATE items SET stage = 'review' WHERE id = ?").run(itemId);
  runId = createRun(db, { itemId, role: "reviewer" });
});

const input = (overrides: Partial<Parameters<typeof addReviewEvidence>[2]> = {}) => ({
  itemId, runId, name: "desktop.png", mimeType: "image/png", data: PNG, sourcePath: ".scratch/review/desktop.png",
  criterionIds: [3, 3, 1], caption: "  桌面  ", addedBy: "reviewer" as const, ...overrides,
});

describe("review evidence storage", () => {
  it("stores the image under the ticket's attachments folder and reads it back", async () => {
    const { evidence, added } = await addReviewEvidence(db, dir, input());
    expect(added).toBe(true);
    expect(evidence).toMatchObject({ id: expect.stringMatching(/^evd_/), criterionIds: [3, 1], caption: "桌面", mimeType: "image/png" });
    expect(existsSync(join(dir, "attachments", `item-${itemId}`, `${evidence.id}.png`))).toBe(true);
    expect((await readReviewEvidence(db, dir, itemId, evidence.id)).data.equals(PNG)).toBe(true);
    // 不进附件列表。
    expect(listTicketAttachments(db, itemId)).toEqual([]);
  });

  it("attaches the same image once per review", async () => {
    const first = await addReviewEvidence(db, dir, input());
    const again = await addReviewEvidence(db, dir, input({ name: "copy.png", sourcePath: "copy.png" }));
    expect(again).toEqual({ evidence: first.evidence, added: false });
    expect(listReviewEvidence(db, itemId)).toHaveLength(1);
  });

  it("accepts images only, by content", async () => {
    await expect(addReviewEvidence(db, dir, input({ name: "notes.txt", mimeType: "text/plain", data: Buffer.from("hi") })))
      .rejects.toBeInstanceOf(TicketAttachmentError);
    await expect(addReviewEvidence(db, dir, input({ data: Buffer.from("not a png") }))).rejects.toThrow(/不是 PNG/);
    expect(listReviewEvidence(db, itemId)).toEqual([]);
  });

  it("refuses to read an id of another ticket or a malformed id", async () => {
    const { evidence } = await addReviewEvidence(db, dir, input());
    const other = createItem(db, { title: "o", brief: "b", createdBy: "lead" });
    await expect(readReviewEvidence(db, dir, other, evidence.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(readReviewEvidence(db, dir, itemId, "../plc.db")).rejects.toMatchObject({ code: "not_found" });
  });
});

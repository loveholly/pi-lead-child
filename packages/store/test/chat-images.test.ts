// 用户发给 Lead 的图片按轮次存（chat_images，由 SCHEMA 建，不占迁移号）。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";

import { getChatImage, insertChatImages, listChatImageRefs, listTurnChatImages } from "../src/chat-images.js";
import { createTurn } from "../src/conversations.js";
import { openDb, type Db } from "../src/db.js";

let path: string;
let db: Db;
beforeEach(() => {
  path = join(tempDir("plc-"), "plc.db");
  db = openDb(path);
});

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 4, 5]);

describe("chat images", () => {
  it("keeps a turn's images in the order they were sent, with their bytes intact", () => {
    const turn = createTurn(db, { originKind: "paired:companion", userText: "两张图" });
    const refs = insertChatImages(db, turn.id, [{ mimeType: "image/png", data: png }, { mimeType: "image/jpeg", data: jpeg }]);

    expect(refs.map((ref) => ref.mimeType)).toEqual(["image/png", "image/jpeg"]);
    expect(refs.every((ref) => /^img_[A-Za-z0-9_-]+$/.test(ref.id))).toBe(true);
    expect(listTurnChatImages(db, turn.id)).toEqual([{ mimeType: "image/png", data: png }, { mimeType: "image/jpeg", data: jpeg }]);
    expect(getChatImage(db, refs[1]!.id)).toEqual({ id: refs[1]!.id, turnId: turn.id, mimeType: "image/jpeg", data: jpeg });
    expect(getChatImage(db, "img_missing")).toBeNull();
  });

  it("lists the image refs of several turns, leaving out turns without images", () => {
    const first = createTurn(db, { originKind: "paired:companion", userText: "一" });
    const plain = createTurn(db, { originKind: "paired:companion", userText: "没有图" });
    const second = createTurn(db, { originKind: "paired:companion", userText: "" });
    const [a] = insertChatImages(db, first.id, [{ mimeType: "image/png", data: png }]);
    const [b, c] = insertChatImages(db, second.id, [{ mimeType: "image/jpeg", data: jpeg }, { mimeType: "image/png", data: png }]);

    const refs = listChatImageRefs(db, [first.id, plain.id, second.id]);
    expect(refs.get(first.id)).toEqual([a]);
    expect(refs.get(second.id)).toEqual([b, c]);
    expect(refs.has(plain.id)).toBe(false);
    expect(listChatImageRefs(db, []).size).toBe(0);
    expect(listTurnChatImages(db, plain.id)).toEqual([]);
  });

  it("creates the table on a database opened before images existed, and keeps rows across reopening", () => {
    db.exec("DROP TABLE chat_images");
    db.close();
    db = openDb(path);
    const turn = createTurn(db, { originKind: "paired:companion", userText: "老库" });
    const [ref] = insertChatImages(db, turn.id, [{ mimeType: "image/png", data: png }]);
    db.close();
    db = openDb(path);
    expect(getChatImage(db, ref!.id)?.data).toEqual(png);
  });
});

// Lead 的形象存在 kv（lead.avatar 一行元数据，lead.avatar.image.<id> 每张图一行 base64）。
//   - 读写：元数据和图一起写，读回来是同一份；没上传的状态没有键，没设的 emoji 没有键。
//   - 坏数据：元数据、一种状态、一张图坏了时不抛错，按缺省算。
//   - 换图、清除：不再被任何状态引用的图同一个事务里删掉；几种状态共用一张图时留着。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";

import { openDb, type Db } from "../src/db.js";
import {
  emptyLeadAvatarSlots, getLeadAvatarImage, getStoredLeadAvatar, LEAD_AVATAR_IMAGE_KEY_PREFIX, LEAD_AVATAR_KEY, leadAvatarImageId,
  listLeadAvatarImageIds, writeLeadAvatar,
} from "../src/lead-avatar.js";

// 1×1 的透明 PNG。
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
// GIF89a 的文件头加几个字节：只核对文件头，不解码。
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00]);

let db: Db;
beforeEach(() => {
  db = openDb(join(tempDir("plc-lead-avatar-"), "plc.db"));
});

const AT = new Date("2026-10-28T08:00:00.000Z");

function ref(data: Buffer, mimeType: "image/png" | "image/gif") {
  return { id: leadAvatarImageId(data), mimeType, bytes: data.length, updatedAt: AT.toISOString() };
}

function rawMetadata(): Record<string, unknown> {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(LEAD_AVATAR_KEY) as { value: string };
  return JSON.parse(row.value) as Record<string, unknown>;
}

describe("the stored Lead avatar", () => {
  it("starts empty: FairyEye off, no uploads, no emoji", () => {
    expect(getStoredLeadAvatar(db)).toEqual({
      fairyEye: false, slots: emptyLeadAvatarSlots(), slackEmoji: null, updatedAt: null, updatedBy: null,
    });
    expect(listLeadAvatarImageIds(db)).toEqual([]);
  });

  it("names an image by the first 24 hex digits of its SHA-256", () => {
    expect(leadAvatarImageId(PNG)).toMatch(/^av_[0-9a-f]{24}$/);
    expect(leadAvatarImageId(PNG)).toBe(leadAvatarImageId(Buffer.from(PNG)));
    expect(leadAvatarImageId(PNG)).not.toBe(leadAvatarImageId(GIF));
  });

  it("writes the image with the metadata and reads both back", () => {
    const slots = { ...emptyLeadAvatarSlots(), default: ref(PNG, "image/png") };
    const written = writeLeadAvatar(db, { fairyEye: true, slots, slackEmoji: ":sparkles:" }, {
      by: "user", at: AT, image: { id: slots.default.id, data: PNG },
    });
    expect(written).toEqual({ fairyEye: true, slots, slackEmoji: ":sparkles:", updatedAt: AT.toISOString(), updatedBy: "user" });
    expect(getStoredLeadAvatar(db)).toEqual(written);
    expect(getLeadAvatarImage(db, slots.default.id)).toEqual({ id: slots.default.id, mimeType: "image/png", data: PNG });
    // 没上传的状态没有键。
    expect(Object.keys(rawMetadata().slots as object)).toEqual(["default"]);
  });

  it("keeps the emoji key out when it is not set, and keeps an empty emoji (no emoji) when it is", () => {
    writeLeadAvatar(db, { fairyEye: false, slots: emptyLeadAvatarSlots(), slackEmoji: null }, { by: "user", at: AT });
    expect("slackEmoji" in rawMetadata()).toBe(false);
    writeLeadAvatar(db, { fairyEye: false, slots: emptyLeadAvatarSlots(), slackEmoji: "" }, { by: "lead", at: AT });
    expect(rawMetadata().slackEmoji).toBe("");
    expect(getStoredLeadAvatar(db)).toMatchObject({ slackEmoji: "", updatedBy: "lead" });
  });

  it("does not throw on bad data and falls back to the defaults", () => {
    const put = (key: string, value: string) => db.prepare(
      "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, value);
    put(LEAD_AVATAR_KEY, "{not json");
    expect(getStoredLeadAvatar(db)).toMatchObject({ fairyEye: false, slots: emptyLeadAvatarSlots(), slackEmoji: null });
    put(LEAD_AVATAR_KEY, "[1,2]");
    expect(getStoredLeadAvatar(db).fairyEye).toBe(false);

    const good = ref(PNG, "image/png");
    put(`${LEAD_AVATAR_IMAGE_KEY_PREFIX}${good.id}`, PNG.toString("base64"));
    put(LEAD_AVATAR_KEY, JSON.stringify({
      fairyEye: "yes",
      slots: {
        default: good,
        // id 不合写法、类型不收、字节数不对、图不在：都按没上传算。
        thinking: { ...good, id: "../../etc/passwd" },
        muted: { ...good, mimeType: "image/svg+xml" },
        offline: { ...good, id: "av_000000000000000000000000" },
      },
      slackEmoji: "Not An Emoji",
      updatedAt: 7,
      updatedBy: "mallory",
    }));
    expect(getStoredLeadAvatar(db)).toEqual({
      fairyEye: false, slots: { ...emptyLeadAvatarSlots(), default: good }, slackEmoji: null, updatedAt: null, updatedBy: null,
    });
    put(LEAD_AVATAR_KEY, JSON.stringify({ slots: { default: { ...good, bytes: 0 } } }));
    expect(getStoredLeadAvatar(db).slots.default).toBeNull();
  });

  it("refuses to read an image by a bad id or with bad data", () => {
    const id = leadAvatarImageId(PNG);
    expect(getLeadAvatarImage(db, id)).toBeNull();
    expect(getLeadAvatarImage(db, "../lead.profile")).toBeNull();
    expect(getLeadAvatarImage(db, `${id}x`)).toBeNull();
    db.prepare("INSERT INTO kv (key, value) VALUES (?, ?)").run(`${LEAD_AVATAR_IMAGE_KEY_PREFIX}${id}`, "not base64!");
    expect(getLeadAvatarImage(db, id)).toBeNull();
    // 能解码，但不是收的格式（JPEG）。
    db.prepare("UPDATE kv SET value = ? WHERE key = ?")
      .run(Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64"), `${LEAD_AVATAR_IMAGE_KEY_PREFIX}${id}`);
    expect(getLeadAvatarImage(db, id)).toBeNull();
  });

  it("deletes the images no slot uses any more, and keeps one that another slot still uses", () => {
    const png = ref(PNG, "image/png");
    const gif = ref(GIF, "image/gif");
    writeLeadAvatar(db, { fairyEye: false, slots: { ...emptyLeadAvatarSlots(), default: png }, slackEmoji: null }, {
      by: "user", at: AT, image: { id: png.id, data: PNG },
    });
    writeLeadAvatar(db, { fairyEye: false, slots: { ...emptyLeadAvatarSlots(), default: png, thinking: png }, slackEmoji: null }, {
      by: "user", at: AT, image: { id: png.id, data: PNG },
    });
    expect(listLeadAvatarImageIds(db)).toEqual([png.id]);

    // 默认换成 GIF：思考中还用着 PNG，留着。
    writeLeadAvatar(db, { fairyEye: false, slots: { ...emptyLeadAvatarSlots(), default: gif, thinking: png }, slackEmoji: null }, {
      by: "user", at: AT, image: { id: gif.id, data: GIF },
    });
    expect(listLeadAvatarImageIds(db).sort()).toEqual([png.id, gif.id].sort());

    // 清掉思考中：没有状态用 PNG 了，删掉。
    writeLeadAvatar(db, { fairyEye: false, slots: { ...emptyLeadAvatarSlots(), default: gif }, slackEmoji: null }, { by: "user", at: AT });
    expect(listLeadAvatarImageIds(db)).toEqual([gif.id]);
    expect(getLeadAvatarImage(db, png.id)).toBeNull();

    // 全清掉：一张不留，别的 kv 行不动。
    db.prepare("INSERT INTO kv (key, value) VALUES ('lead.profile', '{}')").run();
    writeLeadAvatar(db, { fairyEye: false, slots: emptyLeadAvatarSlots(), slackEmoji: null }, { by: "user", at: AT });
    expect(listLeadAvatarImageIds(db)).toEqual([]);
    expect(db.prepare("SELECT value FROM kv WHERE key = 'lead.profile'").get()).toEqual({ value: "{}" });
  });
});

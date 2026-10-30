// 改 Lead 的形象（设置 → 身份与风格 → 形象，2026-10-28）。设置页和 Lead 的 set_lead_avatar 调同一组函数：
//   - 格式按文件头核对：只收 PNG、GIF、WebP；JPEG、SVG、声明的类型和内容对不上的拒收；最大 LEAD_AVATAR_MAX_BYTES。
//   - 授权：页面放行；Lead 只能在用户这一轮明确要求时改，这一轮读过外部原文时不能改。
//   - Slack 署名 emoji 的生效值：设置页的值 > 配置 > 缺省的 :robot_face:。
//   - 只有真的变化时才写、才发 publish。FairyEye 只有 setLeadAvatarFairyEye 能改（daemon 的 /fairyeye 命令用它）。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { LEAD_AVATAR_MAX_BYTES } from "@pi-lead-child/protocol";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  completeTurn, createLoopbackBinding, createTurn, getStoredLeadAvatar, listLeadAvatarImageIds, openDb, type Db,
} from "@pi-lead-child/store";
import {
  clearLeadAvatarSlot, decodeLeadAvatarUpload, effectiveSlackBylineEmoji, fairyEyeReply, getLeadAvatar, LeadAvatarError,
  leadAvatarSlackEmoji, setLeadAvatarFairyEye, setLeadAvatarSlackEmoji, setLeadAvatarSlot, slackEmojiPreview,
} from "../src/lead-avatar.js";

// 1×1 的透明 PNG。
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
// 文件头加几个字节：只核对文件头，不解码。
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00]);
const WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

let db: Db;
beforeEach(() => {
  db = openDb(join(tempDir("plc-lead-avatar-engine-"), "plc.db"));
});

const USER = { kind: "user" } as const;

function refusal(run: () => unknown): LeadAvatarError {
  try {
    run();
  } catch (error) {
    if (error instanceof LeadAvatarError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

function userTurn(id: string) {
  const binding = createLoopbackBinding(db, { name: "本机网页" }).binding;
  createTurn(db, { id, originBindingId: binding.id, originKind: "paired:companion", userText: "把这张图换成你的头像", state: "streaming" });
  return binding;
}

describe("uploading an image for a slot", () => {
  it("takes PNG, GIF and WebP, names each by its content, and asks clients to reload", () => {
    const published: string[] = [];
    const now = new Date("2026-10-28T08:00:00.000Z");
    const outcome = setLeadAvatarSlot(db, { slot: "default", data: PNG, mimeType: "image/png", caller: USER, now, publish: (r) => published.push(r) });
    expect(outcome).toMatchObject({ changed: true, by: { actor: "user" } });
    expect(outcome.avatar).toMatchObject({
      fairyEye: false,
      slots: { default: { id: expect.stringMatching(/^av_[0-9a-f]{24}$/), mimeType: "image/png", bytes: PNG.length, updatedAt: now.toISOString() } },
      updatedAt: now.toISOString(), updatedBy: "user",
    });
    setLeadAvatarSlot(db, { slot: "thinking", data: GIF, mimeType: "image/gif", caller: USER, publish: (r) => published.push(r) });
    setLeadAvatarSlot(db, { slot: "muted", data: WEBP, mimeType: "image/webp", caller: USER, publish: (r) => published.push(r) });
    expect(getLeadAvatar(db).slots).toMatchObject({
      default: { mimeType: "image/png" }, thinking: { mimeType: "image/gif" }, muted: { mimeType: "image/webp" }, offline: null,
    });
    expect(published).toEqual(["lead-avatar", "lead-avatar", "lead-avatar"]);
  });

  it("refuses JPEG, SVG, a forged type and an unknown slot, and changes nothing", () => {
    const upload = (data: Buffer, mimeType: string, slot: unknown = "default") =>
      refusal(() => setLeadAvatarSlot(db, { slot, data, mimeType, caller: USER }));
    expect(upload(JPEG, "image/jpeg")).toMatchObject({ code: "invalid_input", message: expect.stringContaining("这张是 JPEG") });
    expect(upload(JPEG, "image/png").message).toContain("只收 PNG、GIF、WebP");
    expect(upload(SVG, "image/png").message).toContain("只收 PNG、GIF、WebP");
    // 声明成 PNG，内容是 GIF：不按文件头改类型存下，拒收。
    expect(upload(GIF, "image/png").message).toBe("图片的内容是 GIF，不是 PNG：请重新选择文件");
    expect(upload(Buffer.from("just text"), "image/webp").code).toBe("invalid_input");
    expect(upload(PNG, "image/png", "avatar").message).toContain("default、thinking、muted、offline");
    expect(upload(Buffer.alloc(0), "image/png").message).toBe("图片是空的");
    expect(getStoredLeadAvatar(db).updatedAt).toBeNull();
    expect(listLeadAvatarImageIds(db)).toEqual([]);
  });

  it("takes an image of exactly the size limit and refuses one byte more", () => {
    const sized = (bytes: number) => Buffer.concat([PNG, Buffer.alloc(bytes - PNG.length)]);
    expect(setLeadAvatarSlot(db, { slot: "offline", data: sized(LEAD_AVATAR_MAX_BYTES), mimeType: "image/png", caller: USER }).changed).toBe(true);
    expect(refusal(() => setLeadAvatarSlot(db, { slot: "default", data: sized(LEAD_AVATAR_MAX_BYTES + 1), mimeType: "image/png", caller: USER })))
      .toMatchObject({ code: "invalid_input", message: expect.stringContaining("最大 2 MB") });
  });

  it("writes and publishes nothing when the same image goes to the same slot again", () => {
    const published: string[] = [];
    setLeadAvatarSlot(db, { slot: "default", data: PNG, mimeType: "image/png", caller: USER, publish: (r) => published.push(r) });
    const before = getStoredLeadAvatar(db);
    const again = setLeadAvatarSlot(db, {
      slot: "default", data: Buffer.from(PNG), mimeType: "image/png", caller: USER, now: new Date("2030-01-01T00:00:00Z"), publish: (r) => published.push(r),
    });
    expect(again.changed).toBe(false);
    expect(getStoredLeadAvatar(db)).toEqual(before);
    expect(published).toEqual(["lead-avatar"]);
  });

  it("clears a slot, deletes its image, and does nothing for a slot that is already empty", () => {
    const published: string[] = [];
    setLeadAvatarSlot(db, { slot: "thinking", data: GIF, mimeType: "image/gif", caller: USER });
    expect(listLeadAvatarImageIds(db)).toHaveLength(1);
    expect(clearLeadAvatarSlot(db, { slot: "thinking", caller: USER, publish: (r) => published.push(r) })).toMatchObject({
      changed: true, avatar: { slots: { thinking: null } },
    });
    expect(listLeadAvatarImageIds(db)).toEqual([]);
    expect(clearLeadAvatarSlot(db, { slot: "thinking", caller: USER, publish: (r) => published.push(r) }).changed).toBe(false);
    expect(published).toEqual(["lead-avatar"]);
    expect(refusal(() => clearLeadAvatarSlot(db, { slot: "../x", caller: USER })).code).toBe("invalid_input");
  });
});

describe("who may change it", () => {
  it("lets the page change it, and Lead only inside the user's own active turn", () => {
    const lead = (turnId: string | null) => refusal(() => setLeadAvatarSlot(db, {
      slot: "default", data: PNG, mimeType: "image/png", caller: { kind: "lead", turnId },
    }));
    // Lead 自己发起的一轮（没有用户轮次）、已经结束的一轮都不算。
    expect(lead(null)).toMatchObject({ code: "needs_user_turn", message: expect.stringContaining("设置 → 身份与风格 → 形象") });
    userTurn("turn-done");
    completeTurn(db, "turn-done");
    expect(lead("turn-done").code).toBe("needs_user_turn");
    expect(refusal(() => setLeadAvatarSlackEmoji(db, { emoji: "sparkles", caller: { kind: "lead", turnId: null } })).code).toBe("needs_user_turn");
    expect(refusal(() => clearLeadAvatarSlot(db, { slot: "default", caller: { kind: "lead", turnId: null } })).code).toBe("needs_user_turn");
    expect(getStoredLeadAvatar(db).updatedAt).toBeNull();

    const binding = userTurn("turn-user");
    const outcome = setLeadAvatarSlot(db, { slot: "default", data: PNG, mimeType: "image/png", caller: { kind: "lead", turnId: "turn-user" } });
    expect(outcome.by).toEqual({ actor: "lead", onBehalfOf: { actor: "user", sourceTurnId: "turn-user", bindingId: binding.id } });
    expect(outcome.avatar.updatedBy).toBe("lead");
  });

  it("refuses Lead in a turn that read external text, even the user's own", () => {
    userTurn("turn-user");
    const external = { kind: "lead", turnId: "turn-user", external: true } as const;
    expect(refusal(() => setLeadAvatarSlot(db, { slot: "default", data: PNG, mimeType: "image/png", caller: external })))
      .toMatchObject({ code: "needs_user_turn", message: expect.stringContaining("外部通道") });
    expect(refusal(() => setLeadAvatarSlackEmoji(db, { emoji: ":mallory:", caller: external })).message).toContain("外部通道");
    expect(getStoredLeadAvatar(db).slackEmoji).toBeNull();
  });

  it("refuses bad input before asking who is calling", () => {
    // 输入不对时先说输入的问题：Lead 不在用户的一轮里也一样。
    const lead = { kind: "lead", turnId: null } as const;
    expect(refusal(() => setLeadAvatarSlot(db, { slot: "default", data: JPEG, mimeType: "image/jpeg", caller: lead })).code).toBe("invalid_input");
    expect(refusal(() => setLeadAvatarSlackEmoji(db, { emoji: "Not Valid", caller: lead })).code).toBe("invalid_input");
  });
});

describe("the Slack byline emoji", () => {
  it("is the settings value, else the config, else :robot_face:", () => {
    expect(getLeadAvatar(db)).toMatchObject({ slackEmoji: ":robot_face:", slackEmojiSource: "default" });
    expect(getLeadAvatar(db, { configSlackEmoji: ":fairy-zz:" })).toMatchObject({ slackEmoji: ":fairy-zz:", slackEmojiSource: "config" });
    // 配置也按短代码整理；不合写法时不加（空字符串）。写 "" 是不加。
    expect(effectiveSlackBylineEmoji(null, "fairy-zz")).toEqual({ slackEmoji: ":fairy-zz:", slackEmojiSource: "config" });
    expect(effectiveSlackBylineEmoji(null, "<!channel>")).toEqual({ slackEmoji: "", slackEmojiSource: "config" });
    expect(effectiveSlackBylineEmoji(null, "")).toEqual({ slackEmoji: "", slackEmojiSource: "config" });

    const outcome = setLeadAvatarSlackEmoji(db, { emoji: "  sparkles ", caller: USER, configSlackEmoji: ":fairy-zz:" });
    expect(outcome.avatar).toMatchObject({ slackEmoji: ":sparkles:", slackEmojiSource: "settings" });
    expect(leadAvatarSlackEmoji(db, ":fairy-zz:")).toBe(":sparkles:");
    // 设置页写空字符串：不加 emoji，也压过配置。
    setLeadAvatarSlackEmoji(db, { emoji: "", caller: USER });
    expect(getLeadAvatar(db, { configSlackEmoji: ":fairy-zz:" })).toMatchObject({ slackEmoji: "", slackEmojiSource: "settings" });
    // reset：去掉设置页的值，回到配置或缺省。
    expect(setLeadAvatarSlackEmoji(db, { emoji: null, reset: true, caller: USER, configSlackEmoji: ":fairy-zz:" }).avatar)
      .toMatchObject({ slackEmoji: ":fairy-zz:", slackEmojiSource: "config" });
    expect(leadAvatarSlackEmoji(db, undefined)).toBe(":robot_face:");
  });

  it("refuses a missing or malformed emoji, and publishes only real changes", () => {
    expect(refusal(() => setLeadAvatarSlackEmoji(db, { emoji: null, caller: USER })).message).toContain("reset");
    expect(refusal(() => setLeadAvatarSlackEmoji(db, { emoji: ":Two Words:", caller: USER })).message).toContain("不是 Slack 的短代码");
    expect(refusal(() => setLeadAvatarSlackEmoji(db, { emoji: "x".repeat(200), caller: USER })).code).toBe("invalid_input");
    const published: string[] = [];
    const publish = (resource: string) => published.push(resource);
    expect(setLeadAvatarSlackEmoji(db, { emoji: null, reset: true, caller: USER, publish }).changed).toBe(false);
    expect(setLeadAvatarSlackEmoji(db, { emoji: ":tada:", caller: USER, publish }).changed).toBe(true);
    expect(setLeadAvatarSlackEmoji(db, { emoji: "tada", caller: USER, publish }).changed).toBe(false);
    expect(published).toEqual(["lead-avatar"]);
  });
});

describe("the FairyEye switch", () => {
  it("turns on and off as the user's change, and publishes only real changes", () => {
    const published: string[] = [];
    const publish = (resource: string) => published.push(resource);
    expect(setLeadAvatarFairyEye(db, { on: true, publish })).toMatchObject({ changed: true, avatar: { fairyEye: true, updatedBy: "user" } });
    expect(setLeadAvatarFairyEye(db, { on: true, publish }).changed).toBe(false);
    expect(setLeadAvatarFairyEye(db, { on: false, publish })).toMatchObject({ changed: true, avatar: { fairyEye: false } });
    expect(published).toEqual(["lead-avatar", "lead-avatar"]);
  });

  it("is not touched by the other changes", () => {
    setLeadAvatarFairyEye(db, { on: true });
    setLeadAvatarSlot(db, { slot: "default", data: PNG, mimeType: "image/png", caller: USER });
    setLeadAvatarSlackEmoji(db, { emoji: ":tada:", caller: USER });
    clearLeadAvatarSlot(db, { slot: "default", caller: USER });
    expect(getLeadAvatar(db).fairyEye).toBe(true);
  });

  it("answers the command with Lead's name", () => {
    expect(fairyEyeReply(true, true, "Nova")).toBe("已打开 FairyEye：界面上的 Nova 改用 Fairy 的眼睛。发 /fairyeye off 换回形象素材。");
    expect(fairyEyeReply(false, true, "Nova")).toBe("已关掉 FairyEye：界面上的 Nova 换回形象素材（设置 → 身份与风格 → 形象）。");
    expect(fairyEyeReply(true, false, "Nova")).toContain("已经是打开的");
    expect(fairyEyeReply(false, false, "Nova")).toContain("已经是关着的");
  });
});

describe("decoding an upload request", () => {
  it("takes only mimeType and base64 data", () => {
    expect(decodeLeadAvatarUpload({ mimeType: "image/png", data: PNG.toString("base64") })).toEqual({ mimeType: "image/png", data: PNG });
    const bad = (raw: unknown) => refusal(() => decodeLeadAvatarUpload(raw)).code;
    expect(bad({ mimeType: "image/png", data: "not base64!" })).toBe("invalid_input");
    expect(bad({ mimeType: "image/svg+xml", data: PNG.toString("base64") })).toBe("invalid_input");
    expect(bad({ mimeType: "image/png", data: PNG.toString("base64"), fairyEye: true })).toBe("invalid_input");
    expect(bad(null)).toBe("invalid_input");
  });
});

describe("the Slack emoji preview", () => {
  const byline = () => "Paimon (Assistant) · auto-reply for 用户";

  it("says none for an empty code and invalid for a malformed one, without asking Slack", async () => {
    let asked = 0;
    const lookup = async () => { asked += 1; return { status: "not_found" as const, byline: "x" }; };
    expect(await slackEmojiPreview({ code: "  ", byline, lookup })).toEqual({ code: "", status: "none", imageUrl: null, reason: null, byline: byline() });
    expect(await slackEmojiPreview({ code: "Two Words", byline, lookup })).toMatchObject({ code: "", status: "invalid", reason: expect.any(String) });
    expect(asked).toBe(0);
  });

  it("maps what Slack said, and says why when it cannot ask", async () => {
    const live = "Nova (Assistant) · auto-reply for Leo";
    expect(await slackEmojiPreview({
      code: "robot_face", byline, lookup: async () => ({ status: "custom", imageUrl: "https://emoji.slack-edge.com/T0/robot_face/1.gif", byline: live }),
    })).toEqual({ code: ":robot_face:", status: "custom", imageUrl: "https://emoji.slack-edge.com/T0/robot_face/1.gif", reason: null, byline: live });
    expect(await slackEmojiPreview({ code: ":tada:", byline, lookup: async () => ({ status: "not_found", byline: live }) }))
      .toMatchObject({ code: ":tada:", status: "not_found", byline: live });
    expect(await slackEmojiPreview({ code: ":tada:", byline, lookup: async () => ({ status: "unavailable", reason: "没有 emoji:read", byline: live }) }))
      .toMatchObject({ status: "unavailable", reason: "没有 emoji:read" });
    expect(await slackEmojiPreview({ code: ":tada:", byline, lookup: null })).toMatchObject({
      status: "unavailable", reason: expect.stringContaining("Slack 没有接上"), byline: byline(),
    });
    expect(await slackEmojiPreview({ code: ":tada:", byline, lookup: async () => { throw new Error("boom"); } }))
      .toMatchObject({ status: "unavailable", reason: "查不了：boom" });
  });
});

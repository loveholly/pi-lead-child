// Lead 的形象（2026-10-28）：set_lead_avatar 和设置 → 身份与风格 → 形象调同一组函数。
//   - 用用户在对话里发的图换一种状态的图（信封的 image_ids 写着编号）；去掉图；改 Slack 署名的 emoji。
//   - 只有用户这一轮明确要求时才能改；这一轮读过外部原文时不能改。
//   - 没有 FairyEye 的参数：只有用户自己发 `/fairyeye on` 能打开它。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  createLoopbackBinding, createTurn, getStoredLeadAvatar, insertChatImages, latestGatewaySeq, openDb, type Db,
} from "@pi-lead-child/store";
import { leadUserMessage } from "../src/envelope.js";
import { LEAD_SYSTEM_PROMPT } from "../src/prompt.js";
import { LEAD_CODEMODE_TOOLS } from "../src/tool-exposure.js";
import { createLeadTools, type LeadDeps } from "../src/tools.js";
import { INTERNAL_TEXT_TOOLS, type LeadTurnOrigin } from "../src/turn-origin.js";

// 1×1 的透明 PNG。
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

let db: Db;
let deps: LeadDeps;
let turnId: string | null;
let origin: LeadTurnOrigin;

beforeEach(() => {
  const dir = tempDir("plc-lead-avatar-tool-");
  const dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  turnId = null;
  origin = { external: false, timer: null };
  deps = { db, dbPath, dataDir: dir, currentTurnId: () => turnId, turnOrigin: () => origin, configSlackEmoji: () => ":fairy-zz:" };
});

function tool(): any {
  const found = createLeadTools(deps).find((candidate: any) => candidate.name === "set_lead_avatar") as any;
  if (!found) throw new Error("set_lead_avatar not found");
  return found;
}

async function run(params: Record<string, unknown>): Promise<any> {
  const result = await tool().execute("call", params);
  return JSON.parse(result.content.map((part: { text?: string }) => part.text ?? "").join("\n"));
}

// 用户的一轮，带着他发的图。返回图的编号。
function userTurnWith(images: Buffer[], mimeType: "image/png" | "image/jpeg" = "image/png"): string[] {
  const binding = createLoopbackBinding(db, { name: "本机网页" }).binding;
  createTurn(db, { id: "turn-1", originBindingId: binding.id, originKind: "paired:companion", userText: "用这张当你思考时的头像", state: "streaming" });
  turnId = "turn-1";
  return insertChatImages(db, "turn-1", images.map((data) => ({ mimeType, data }))).map((image) => image.id);
}

describe("set_lead_avatar", () => {
  it("sets a slot from an image the user sent in the chat, and asks clients to reload", async () => {
    const [id] = userTurnWith([PNG]);
    const before = latestGatewaySeq(db);
    const result = await run({ slot: "thinking", chat_image_id: id });
    expect(result).toMatchObject({
      result: "updated", changes: ["思考中状态换成了这张图"],
      avatar: { slots: { default: null, thinking: "image/png", muted: null, offline: null }, slackEmoji: ":fairy-zz:", slackEmojiSource: "config" },
    });
    expect(getStoredLeadAvatar(db)).toMatchObject({ slots: { thinking: { mimeType: "image/png", bytes: PNG.length } }, updatedBy: "lead" });
    expect(latestGatewaySeq(db)).toBeGreaterThan(before);
    expect(await run({ slot: "thinking", chat_image_id: id })).toMatchObject({ result: "unchanged" });

    expect(await run({ slot: "thinking", clear: true })).toMatchObject({ result: "updated", changes: ["去掉了思考中状态的图"] });
    expect(await run({ slack_emoji: "sparkles" })).toMatchObject({ result: "updated", avatar: { slackEmoji: ":sparkles:", slackEmojiSource: "settings" } });
    expect(await run({ reset_slack_emoji: true })).toMatchObject({ avatar: { slackEmoji: ":fairy-zz:", slackEmojiSource: "config" } });
  });

  it("refuses a JPEG, an unknown image and a call with nothing to do", async () => {
    const [jpeg] = userTurnWith([JPEG], "image/jpeg");
    await expect(run({ slot: "default", chat_image_id: jpeg })).rejects.toThrow(/没有改：形象只收 PNG、GIF、WebP 格式的图片，这张是 JPEG/);
    await expect(run({ slot: "default", chat_image_id: "img_missing" })).rejects.toThrow(/没有编号是 img_missing 的图/);
    await expect(run({ slot: "default", chat_image_id: "../../etc/passwd" })).rejects.toThrow(/没有编号是/);
    await expect(run({ slot: "default" })).rejects.toThrow(/chat_image_id/);
    await expect(run({})).rejects.toThrow(/没有要改的内容/);
    expect(getStoredLeadAvatar(db).updatedAt).toBeNull();
  });

  it("refuses outside the user's own turn, and in a turn that read external text", async () => {
    const [id] = userTurnWith([PNG]);
    turnId = null;
    await expect(run({ slot: "default", chat_image_id: id })).rejects.toThrow(/只有用户在这一轮明确要求时/);
    turnId = "turn-1";
    origin = { external: true, timer: null };
    await expect(run({ slot: "default", chat_image_id: id })).rejects.toThrow(/外部通道/);
    await expect(run({ slack_emoji: ":mallory:" })).rejects.toThrow(/外部通道/);
    expect(getStoredLeadAvatar(db)).toMatchObject({ slots: { default: null }, slackEmoji: null, updatedAt: null });
  });

  it("has no FairyEye parameter, and cannot turn it on", async () => {
    userTurnWith([PNG]);
    const properties = Object.keys(tool().parameters.properties);
    expect(properties.sort()).toEqual(["chat_image_id", "clear", "reset_slack_emoji", "slack_emoji", "slot"]);
    expect(properties.some((name) => /fairy/i.test(name))).toBe(false);
    await expect(run({ fairyEye: true })).rejects.toThrow(/没有要改的内容/);
    await run({ slack_emoji: "tada", fairy_eye: true, fairyEye: true });
    expect(getStoredLeadAvatar(db).fairyEye).toBe(false);
    expect(tool().description).toContain("/fairyeye on");
  });

  it("is a codemode tool whose output is not external content", () => {
    expect(LEAD_CODEMODE_TOOLS.has("set_lead_avatar")).toBe(true);
    expect(INTERNAL_TEXT_TOOLS.has("set_lead_avatar")).toBe(true);
    expect(LEAD_SYSTEM_PROMPT).toContain("set_lead_avatar");
  });
});

describe("the user message envelope", () => {
  it("lists the ids of the images in order, in full, before the count", () => {
    const ids = Array.from({ length: 8 }, (_, index) => `img_${String(index).repeat(16)}`);
    const text = leadUserMessage({ via: "web", channel: "paired:companion", imageIds: ids }, "换头像");
    expect(text).toBe(`<user_message from="user" via="web" channel="paired:companion" image_ids="${ids.join(" ")}" images="8">\n换头像\n</user_message>`);
    // 不合编号写法的不写进去（编号是 daemon 给的，这里只是兜底）。
    expect(leadUserMessage({ via: "web", channel: "c", imageIds: ['img_a" onload="x'] }, "x")).not.toContain("image_ids");
    expect(LEAD_SYSTEM_PROMPT).toContain("image_ids");
  });
});

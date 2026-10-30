// Lead 的形象的路由（设置 → 身份与风格 → 形象，2026-10-28；契约在 protocol 的 lead-avatar.ts）：
//   - hello.v2 宣布 LEAD_AVATAR_CAPABILITY；GET 回严格合契约的 DTO。
//   - 上传：请求体有几 MB，超过网关缺省的 1 MB 也收；格式、状态、字段不对时 400（reason 在 details 里），改要 tickets:create。
//   - 按 id 取图（长期缓存），清除，Slack 署名 emoji，Slack 预览（daemon 给的，或者说查不了）。
//   - 没有任何路由能改 FairyEye：只有用户在 Lead 的会话里发 `/fairyeye on`（daemon 的命令）。
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { Value } from "typebox/value";
import {
  HelloV2Schema, HttpErrorResponseSchema, LEAD_AVATAR_CAPABILITY, LEAD_AVATAR_UPLOAD_MAX_BODY_BYTES, LeadAvatarImageSchema,
  LeadAvatarResponseSchema, SlackEmojiPreviewSchema, type SlackEmojiPreview,
} from "@pi-lead-child/protocol";
import { createPairing, getStoredLeadAvatar, openDb, redeemPairing, type Db } from "@pi-lead-child/store";
import { setLeadAvatarFairyEye } from "@pi-lead-child/engine";
import { tempDir } from "@pi-lead-child/core/testing";

import { createControlPlaneService } from "../src/control-plane.js";
import type { LeadAvatarService } from "../src/lead-avatar-routes.js";
import { startPairedServer } from "../src/paired-server.js";

// 1×1 的透明 PNG。
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-lead-avatar-routes-"), "plc.db"));
});

function runtime() {
  return { model: "stub/model", sessionId: "stub-session", busy: false, runningItemIds: [], aish: null };
}

function issue(scopes: string[] = ["chat", "tickets:view", "tickets:create"]) {
  const { code } = createPairing(db, { name: "web", kind: "companion", scopes: scopes as never });
  return redeemPairing(db, code).accessToken;
}

async function start(leadAvatar?: LeadAvatarService) {
  const server = await startPairedServer({
    db,
    controlPlane: createControlPlaneService(db, { runtime }),
    hello: runtime,
    chat: () => "started",
    addClient: () => () => {},
    log: () => {},
    ...(leadAvatar ? { leadAvatar } : {}),
  }, { port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) as any : null };
  };
  return { server, call };
}

const upload = (data: Buffer, mimeType = "image/png") => ({ mimeType, data: data.toString("base64") });
// 一张比网关缺省的 1 MB 上限大的 PNG（文件头对，后面补零）。
const BIG_PNG = Buffer.concat([PNG, Buffer.alloc(1_500_000)]);

describe("the Lead avatar routes", () => {
  it("are announced in hello.v2, which stays strict", async () => {
    const { server } = await start();
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/v1/paired/events?token=${issue()}&protocol=2`);
    const messages: any[] = [];
    ws.on("message", (raw) => messages.push(JSON.parse(String(raw))));
    try {
      await vi.waitFor(() => expect(messages.some((message) => message.type === "hello.v2")).toBe(true), { timeout: 5_000 });
      const hello = messages.find((message) => message.type === "hello.v2");
      expect(Value.Check(HelloV2Schema, hello)).toBe(true);
      expect(hello.capabilities).toContain(LEAD_AVATAR_CAPABILITY);
    } finally {
      ws.close();
      await server.close();
    }
  });

  it("return the avatar with the config's emoji when nothing is set", async () => {
    const token = issue(["tickets:view"]);
    const { server, call } = await start({ configSlackEmoji: () => "fairy-zz" });
    try {
      const got = await call(token, "GET", "/v1/lead/avatar");
      expect(got.status).toBe(200);
      expect(Value.Check(LeadAvatarResponseSchema, got.body)).toBe(true);
      expect(got.body.leadAvatar).toEqual({
        fairyEye: false, slots: { default: null, thinking: null, muted: null, offline: null },
        slackEmoji: ":fairy-zz:", slackEmojiSource: "config", updatedAt: null, updatedBy: null,
      });
    } finally {
      await server.close();
    }
  });

  it("take an upload larger than the 1 MB default body limit, serve it by id, and clear it", async () => {
    const token = issue();
    const { server, call } = await start();
    try {
      const uploaded = await call(token, "POST", "/v1/lead/avatar/slots/default", upload(BIG_PNG));
      expect(uploaded.status).toBe(200);
      expect(Value.Check(LeadAvatarResponseSchema, uploaded.body)).toBe(true);
      const ref = uploaded.body.leadAvatar.slots.default;
      expect(ref).toMatchObject({ id: expect.stringMatching(/^av_[0-9a-f]{24}$/), mimeType: "image/png", bytes: BIG_PNG.length });
      expect(uploaded.body.leadAvatar.updatedBy).toBe("user");

      const image = await call(token, "GET", `/v1/lead/avatar/images/${ref.id}`);
      expect(image.status).toBe(200);
      expect(Value.Check(LeadAvatarImageSchema, image.body)).toBe(true);
      expect(Buffer.from(image.body.data, "base64").equals(BIG_PNG)).toBe(true);
      expect(image.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");

      const cleared = await call(token, "POST", "/v1/lead/avatar/slots/default/clear");
      expect(cleared.status).toBe(200);
      expect(cleared.body.leadAvatar.slots.default).toBeNull();
      const gone = await call(token, "GET", `/v1/lead/avatar/images/${ref.id}`);
      expect(gone.status).toBe(404);
      expect(Value.Check(HttpErrorResponseSchema, gone.body)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("refuse a wrong format, slot, field or id with a strict error, and a body over the upload limit", async () => {
    const token = issue();
    const { server, call } = await start();
    try {
      const refused = async (method: string, path: string, body?: unknown) => {
        const result = await call(token, method, path, body);
        expect(result.status, path).toBe(400);
        expect(Value.Check(HttpErrorResponseSchema, result.body), path).toBe(true);
        expect(result.body.error.details).toEqual({ reason: "invalid_input" });
        return result.body.error.message as string;
      };
      expect(await refused("POST", "/v1/lead/avatar/slots/default", upload(JPEG, "image/jpeg"))).toContain("只收 PNG、GIF、WebP");
      expect(await refused("POST", "/v1/lead/avatar/slots/default", upload(JPEG, "image/png"))).toContain("只收 PNG、GIF、WebP");
      expect(await refused("POST", "/v1/lead/avatar/slots/avatar", upload(PNG))).toContain("状态只能是");
      expect(await refused("POST", "/v1/lead/avatar/slots/default", { ...upload(PNG), fairyEye: true })).toContain("mimeType");
      expect(await refused("POST", "/v1/lead/avatar/slots/default", { mimeType: "image/png", data: "%%%" })).toContain("base64");
      expect(await refused("POST", "/v1/lead/avatar/slots/..%2F..%2Fx/clear")).toContain("状态只能是");
      expect(await refused("GET", "/v1/lead/avatar/images/..%2F..%2Flead.profile")).toBe("图的 id 不对");
      expect((await call(token, "GET", "/v1/lead/avatar/images/av_000000000000000000000000")).status).toBe(404);

      const tooBig = await call(token, "POST", "/v1/lead/avatar/slots/default", { mimeType: "image/png", data: "A".repeat(LEAD_AVATAR_UPLOAD_MAX_BODY_BYTES) });
      expect(tooBig.status).toBe(413);
      expect(getStoredLeadAvatar(db).updatedAt).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("need tickets:create to change and tickets:view to read", async () => {
    const viewer = issue(["tickets:view"]);
    const chatOnly = issue(["chat"]);
    const { server, call } = await start();
    try {
      expect((await call(viewer, "POST", "/v1/lead/avatar/slots/default", upload(PNG))).status).toBe(403);
      expect((await call(viewer, "POST", "/v1/lead/avatar/slack-emoji", { emoji: "tada" })).status).toBe(403);
      expect((await call(viewer, "POST", "/v1/lead/avatar/slots/default/clear")).status).toBe(403);
      expect((await call(chatOnly, "GET", "/v1/lead/avatar")).status).toBe(403);
      expect(getStoredLeadAvatar(db).updatedAt).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("set and reset the Slack byline emoji", async () => {
    const token = issue();
    const { server, call } = await start({ configSlackEmoji: () => ":fairy-zz:" });
    try {
      const set = await call(token, "POST", "/v1/lead/avatar/slack-emoji", { emoji: "sparkles" });
      expect(set.status).toBe(200);
      expect(set.body.leadAvatar).toMatchObject({ slackEmoji: ":sparkles:", slackEmojiSource: "settings" });
      const bad = await call(token, "POST", "/v1/lead/avatar/slack-emoji", { emoji: "Two Words" });
      expect(bad.status).toBe(400);
      expect(bad.body.error.details).toEqual({ reason: "invalid_input" });
      expect((await call(token, "POST", "/v1/lead/avatar/slack-emoji", { emoji: "tada", extra: 1 })).status).toBe(400);
      const reset = await call(token, "POST", "/v1/lead/avatar/slack-emoji", { emoji: "", reset: true });
      expect(reset.body.leadAvatar).toMatchObject({ slackEmoji: ":fairy-zz:", slackEmojiSource: "config" });
    } finally {
      await server.close();
    }
  });

  it("preview a Slack emoji through the daemon, or say it cannot without one", async () => {
    const token = issue(["tickets:view"]);
    const asked: string[] = [];
    const preview: SlackEmojiPreview = {
      code: ":robot_face:", status: "custom", imageUrl: "https://emoji.slack-edge.com/T0/robot_face/1.gif", reason: null,
      byline: "Paimon (Assistant) · auto-reply for Leo",
    };
    const withDaemon = await start({ previewSlackEmoji: async (code) => { asked.push(code); return preview; } });
    try {
      const got = await withDaemon.call(token, "GET", `/v1/lead/avatar/slack-emoji/preview?code=${encodeURIComponent(":robot_face:")}`);
      expect(got.status).toBe(200);
      expect(got.body).toEqual(preview);
      expect(asked).toEqual([":robot_face:"]);
      expect((await withDaemon.call(token, "GET", `/v1/lead/avatar/slack-emoji/preview?code=${"x".repeat(200)}`)).status).toBe(400);
    } finally {
      await withDaemon.server.close();
    }
    const alone = await start();
    try {
      const unavailable = await alone.call(token, "GET", "/v1/lead/avatar/slack-emoji/preview?code=tada");
      expect(Value.Check(SlackEmojiPreviewSchema, unavailable.body)).toBe(true);
      expect(unavailable.body).toMatchObject({ code: ":tada:", status: "unavailable", byline: "Paimon (Assistant) · auto-reply for 用户" });
      expect((await alone.call(token, "GET", "/v1/lead/avatar/slack-emoji/preview?code=")).body.status).toBe("none");
      expect((await alone.call(token, "GET", "/v1/lead/avatar/slack-emoji/preview?code=Bad%20Code")).body.status).toBe("invalid");
    } finally {
      await alone.server.close();
    }
  });

  it("have no route that turns FairyEye on or off", async () => {
    const token = issue();
    const { server, call } = await start();
    try {
      for (const [method, path, body] of [
        ["POST", "/v1/lead/avatar", { fairyEye: true }],
        ["PUT", "/v1/lead/avatar", { fairyEye: true }],
        ["PATCH", "/v1/lead/avatar", { fairyEye: true }],
        ["POST", "/v1/lead/avatar/fairy-eye", { on: true }],
        ["POST", "/v1/lead/avatar/fairyeye", { on: true }],
        ["POST", "/v1/lead/avatar/slots/fairyEye", { ...upload(PNG), fairyEye: true }],
        ["POST", "/v1/lead/avatar/slack-emoji", { emoji: "tada", fairyEye: true }],
      ] as const) {
        const result = await call(token, method, path, body);
        expect([400, 404, 405], `${method} ${path}`).toContain(result.status);
      }
      expect(getStoredLeadAvatar(db).fairyEye).toBe(false);
      // 打开以后（只有 daemon 的命令能做），路由同样关不掉它。
      setLeadAvatarFairyEye(db, { on: true });
      expect((await call(token, "POST", "/v1/lead/avatar", { fairyEye: false })).status).toBe(404);
      expect((await call(token, "GET", "/v1/lead/avatar")).body.leadAvatar.fairyEye).toBe(true);
    } finally {
      await server.close();
    }
  });
});

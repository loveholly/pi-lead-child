// 外来消息卡里的图片（工单 #529，src/channel-routes.ts 的 GET /v1/channels/files/:fileId）：只收 Slack 的文件编号、
// 只取收到过的消息里出现过的文件、只回图片（按文件头认），带缓存头；卡上每条消息的链接是选收的（?include=links）。
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import {
  CHANNEL_FILE_MAX_BYTES, ChannelCardListResponseSchema, ChannelImageSchema, channelFilePath, type ChannelCardDto, type Scope,
} from "@pi-lead-child/protocol";
import { handleChannelRoute, type ChannelCardService } from "../src/channel-routes.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

const CARD = {
  id: 7, version: 4, source: "slack", sourceLabel: "Slack", objectKey: "slack:C0DEMO:1700000000.000100", laneLabel: "#demo 里的讨论",
  sender: { id: "U1", name: "Ethan", trust: "colleague" }, excerpt: "[图片 a.png，文件编号 slack:F0DEMO1]", messageCount: 1,
  recent: [{ at: "2026-11-25T02:00:00.000Z", text: "[图片 a.png，文件编号 slack:F0DEMO1]", url: "https://acme.slack.com/archives/C0DEMO/p1700000000000100" }],
  delivery: "card", state: "open", draft: null, gate: null, lookup: null, handling: null, sentText: null, snoozedUntil: null, revokeUntil: null,
  resolvedAt: null, actions: [], createdAt: "2026-11-25T02:00:00.000Z", updatedAt: "2026-11-25T02:00:00.000Z",
} satisfies ChannelCardDto;

type Reply = { status: number; body: any; headers: Record<string, string> };

async function get(path: string, service: ChannelCardService | undefined, scopes?: Scope[]) {
  const asked: Array<Scope | undefined> = [];
  let reply: Reply | null = null;
  const handled = await handleChannelRoute({
    req: { method: "GET", headers: {} } as IncomingMessage,
    res: {} as ServerResponse,
    url: new URL(`http://127.0.0.1${path}`),
    service,
    json: (status, body, headers = {}) => { reply = { status, body, headers }; },
    readBody: async () => ({}),
    requireAuth: (scope) => {
      asked.push(scope);
      if (scope && scopes && !scopes.includes(scope)) throw Object.assign(new Error(`missing scope: ${scope}`), { status: 403 });
    },
    perform: async () => CARD,
  });
  return { handled, asked, reply: reply as Reply | null };
}

// 假的通道 hub：记下 readFile 被问了哪些编号。
function fakeService(options: { known?: string[]; files?: Record<string, { name: string; mimeType: string; data: Uint8Array }>; error?: Error } = {}) {
  const reads: Array<[string, number]> = [];
  const service: ChannelCardService = {
    list: () => [CARD],
    fileKnown: (fileId) => (options.known ?? ["slack:F0DEMO1"]).includes(fileId),
    readFile: async (fileId, maxBytes) => {
      reads.push([fileId, maxBytes]);
      if (options.error) throw options.error;
      const file = (options.files ?? { "slack:F0DEMO1": { name: "a.png", mimeType: "image/png", data: PNG } })[fileId];
      if (!file) throw Object.assign(new Error("没有这个文件"), { code: "not_found" });
      return { id: fileId, ...file };
    },
  };
  return { service, reads };
}

describe("GET /v1/channels/files/:fileId", () => {
  it("returns a Slack image as base64 with a private cache header, read with the same limit as Lead", async () => {
    const { service, reads } = fakeService();
    const { asked, reply } = await get(channelFilePath("slack:F0DEMO1"), service);
    expect(asked).toEqual(["chat"]);
    expect(reply?.status).toBe(200);
    expect(Value.Check(ChannelImageSchema, reply?.body)).toBe(true);
    expect(reply?.body).toEqual({ id: "slack:F0DEMO1", name: "a.png", mimeType: "image/png", data: Buffer.from(PNG).toString("base64") });
    expect(reply?.headers["cache-control"]).toMatch(/^private, max-age=\d+$/);
    expect(reads).toEqual([["slack:F0DEMO1", CHANNEL_FILE_MAX_BYTES]]);
  });

  it("needs the chat scope", async () => {
    const { service, reads } = fakeService();
    await expect(get(channelFilePath("slack:F0DEMO1"), service, ["tickets:view"])).rejects.toThrow(/chat/);
    expect(reads).toEqual([]);
  });

  it("refuses anything that is not a Slack file id: URLs, local paths, other sources", async () => {
    const { service, reads } = fakeService({ known: ["slack:F0DEMO1"] });
    const ids = [
      "https://files.slack.com/files-pri/T1-F0DEMO1/a.png", "/etc/passwd", "../../etc/passwd", "file:///etc/passwd",
      "slack:../F0DEMO1", "slack:f0demo1", "slack:U0DEMO1", "hook:F0DEMO1", "F0DEMO1", "slack:F0DEMO1/../../x", "slack:F0DEMO1\n",
    ];
    for (const id of ids) {
      const { reply } = await get(channelFilePath(id), service);
      expect(reply, id).toMatchObject({ status: 404, body: { error: { code: "not_found", details: { reason: "invalid_id" } } } });
    }
    // 编码坏了的路径也不认。
    expect((await get("/v1/channels/files/%E0%A4%A", service)).reply?.status).toBe(404);
    expect(reads).toEqual([]);
  });

  it("only reads files that came in a received message", async () => {
    const { service, reads } = fakeService({ known: [] });
    const { reply } = await get(channelFilePath("slack:F0DEMO1"), service);
    expect(reply).toMatchObject({ status: 404, body: { error: { details: { reason: "unknown_file" } } } });
    expect(reads).toEqual([]);
  });

  it("only returns images, judged by the bytes and not by the type the source claims", async () => {
    const { service } = fakeService({
      known: ["slack:F0SVG", "slack:F0PDF"],
      files: {
        "slack:F0SVG": { name: "x.svg", mimeType: "image/svg+xml", data: SVG },
        "slack:F0PDF": { name: "fake.png", mimeType: "image/png", data: new TextEncoder().encode("%PDF-1.7") },
      },
    });
    for (const id of ["slack:F0SVG", "slack:F0PDF"]) {
      const { reply } = await get(channelFilePath(id), service);
      expect(reply, id).toMatchObject({ status: 404, body: { error: { details: { reason: "not_image" } } } });
    }
  });

  it("maps a file missing in Slack to 404 and other failures to 503 without the reason", async () => {
    const missing = fakeService({ error: Object.assign(new Error("Slack 里没有这个文件"), { code: "not_found" }) });
    expect((await get(channelFilePath("slack:F0DEMO1"), missing.service)).reply).toMatchObject({ status: 404, body: { error: { details: { reason: "not_found" } } } });
    const down = fakeService({ error: Object.assign(new Error("用户令牌缺 files:read 权限"), { code: "unavailable" }) });
    const { reply } = await get(channelFilePath("slack:F0DEMO1"), down.service);
    expect(reply).toMatchObject({ status: 503, body: { error: { code: "internal_error", details: { reason: "unavailable" } } } });
    expect(JSON.stringify(reply?.body)).not.toContain("files:read");
    // 没有接任何来源。
    expect((await get(channelFilePath("slack:F0DEMO1"), undefined)).reply?.status).toBe(503);
  });
});

describe("message links on the cards", () => {
  it("only go to clients that ask for them with ?include=links", async () => {
    const { service } = fakeService();
    const plain = (await get("/v1/channels/cards", service)).reply!;
    expect(plain.body.items[0].recent).toEqual([{ at: CARD.recent[0]!.at, text: CARD.recent[0]!.text }]);
    expect(Value.Check(ChannelCardListResponseSchema, plain.body)).toBe(true);
    const linked = (await get("/v1/channels/cards?include=links", service)).reply!;
    expect(linked.body.items[0].recent[0].url).toBe("https://acme.slack.com/archives/C0DEMO/p1700000000000100");
    expect(Value.Check(ChannelCardListResponseSchema, linked.body)).toBe(true);
  });
});

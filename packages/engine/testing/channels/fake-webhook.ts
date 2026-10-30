// 最小的第二个假适配器（工单 11 的验收：合约测试能被下一个适配器直接复用）：一个通用的签名 webhook 来源，
// 加上它的假服务。只在测试里用。
//   - 入站：POST 的 JSON { id, thread, from, name, text, self? }，头 x-hook-signature = sha256=HMAC(secret, body)。
//   - 出站：服务的「回复」接口按 Idempotency-Key 去重；撤回按回复的编号删，删过的再删返回 not_found。
import { createHmac, timingSafeEqual } from "node:crypto";
import { Type } from "typebox";
import {
  channelInboundPayload,
  type ChannelAdapter, type ChannelCredential, type ChannelDelivery, type ChannelInbound,
} from "../../src/index.js";

export const FAKE_HOOK_SOURCE = "hook";
export const FAKE_HOOK_TOKEN = "hook-fake-sentinel-token-4c21e8";
export const FAKE_HOOK_SECRET = "hook-fake-signing-secret-a07d55";


interface Reply { id: string; thread: string; text: string; key: string; deleted: boolean }

/** 假的 webhook 服务：投递、回复、撤回。 */
export class FakeHookService {
  readonly credential: ChannelCredential = { token: FAKE_HOOK_TOKEN, signingSecret: FAKE_HOOK_SECRET, account: "me" };
  readonly replies: Reply[] = [];
  private nextId = 1;
  private crashAfterReply = false;
  private leakNext = false;

  message(thread: string, text: string, options: { from?: string; name?: string } = {}): ChannelDelivery {
    return this.signed({ id: `hook-${this.nextId++}`, thread, from: options.from ?? "alice", name: options.name ?? "Alice", text });
  }

  selfReply(thread: string, text: string): ChannelDelivery {
    return this.signed({ id: `hook-${this.nextId++}`, thread, from: "me", name: "me", text, self: true });
  }

  redeliver(delivery: ChannelDelivery): ChannelDelivery {
    return this.sign(delivery.body, FAKE_HOOK_SECRET);
  }

  forge(delivery: ChannelDelivery): ChannelDelivery {
    return this.sign(delivery.body, "wrong-secret");
  }

  crashAfterNextReply(): void {
    this.crashAfterReply = true;
  }

  failNextReplyEchoingCredential(): void {
    this.leakNext = true;
  }

  live(thread?: string): Reply[] {
    return this.replies.filter((reply) => !reply.deleted && (!thread || reply.thread === thread));
  }

  // 服务的接口：Idempotency-Key 相同的回复只记一条。
  reply(token: string, thread: string, text: string, key: string): { id: string; duplicate: boolean } {
    if (token !== FAKE_HOOK_TOKEN) throw new Error("401 unauthorized");
    if (this.leakNext) {
      this.leakNext = false;
      throw new Error(`upstream rejected bearer ${token} signed with ${FAKE_HOOK_SECRET}`);
    }
    const existing = this.replies.find((reply) => reply.key === key);
    if (existing) return { id: existing.id, duplicate: true };
    const reply: Reply = { id: `r${this.replies.length + 1}`, thread, text, key, deleted: false };
    this.replies.push(reply);
    if (this.crashAfterReply) {
      this.crashAfterReply = false;
      throw new Error("socket hang up after the reply was stored");
    }
    return { id: reply.id, duplicate: false };
  }

  retract(token: string, id: string): "deleted" | "not_found" {
    if (token !== FAKE_HOOK_TOKEN) throw new Error("401 unauthorized");
    const reply = this.replies.find((candidate) => candidate.id === id && !candidate.deleted);
    if (!reply) return "not_found";
    reply.deleted = true;
    return "deleted";
  }

  private signed(payload: Record<string, unknown>): ChannelDelivery {
    return this.sign(JSON.stringify(payload), FAKE_HOOK_SECRET);
  }

  private sign(body: string, secret: string): ChannelDelivery {
    return { headers: { "x-hook-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` }, body };
  }
}

/** 通用 webhook 来源的适配器，接在一个假服务上。 */
export function createFakeHookAdapter(service: FakeHookService): ChannelAdapter {
  const fields = { thread: Type.String() };
  return {
    id: FAKE_HOOK_SOURCE,
    label: "Webhook",
    kind: "conversation",
    auth: { connectionProvider: "custom" },
    capabilities: { reply: true, retract: true },
    eventKinds: [
      { kind: "hook.message.received", sources: [FAKE_HOOK_SOURCE], payload: channelInboundPayload(fields), description: "webhook 送来一条消息。" },
      { kind: "hook.self.reply", sources: [FAKE_HOOK_SOURCE], payload: channelInboundPayload(fields), description: "用户本人在 webhook 的来源里回复了。" },
    ],
    standingOrders: [
      {
        id: "source.hook", seedRevision: 1, title: "来源 hook：默认进摘要，最高到 tell", priority: 100,
        condition: { sources: [FAKE_HOOK_SOURCE] },
        action: { type: "rule", rule: "source.threshold", params: { source: FAKE_HOOK_SOURCE, defaultLevel: "digest", maxLevel: "tell" } },
        limits: null, escalateTo: null, reason: "测试用的第二个来源。",
      },
      {
        id: "hook.self_reply", seedRevision: 1, title: "hook 里用户自己的回复只记录", priority: 90,
        condition: { kinds: ["hook.self.reply"] }, action: { type: "level", level: "record" },
        limits: null, escalateTo: null, reason: "测试用的第二个来源。",
      },
      {
        id: "channel.hook.delivery", seedRevision: 1, title: "hook 的消息进会话卡", priority: 100, condition: {},
        action: {
          type: "rule", rule: "channel.delivery",
          params: { source: FAKE_HOOK_SOURCE, pushWhen: null, cardWhen: { kinds: ["hook.message.received"] }, digestWhen: null },
        },
        limits: null, escalateTo: null, reason: "测试用的第二个来源。",
      },
    ],
    verify(delivery, context) {
      const signature = delivery.headers["x-hook-signature"] ?? "";
      if (!context.credential.signingSecret) return false;
      const expected = `sha256=${createHmac("sha256", context.credential.signingSecret).update(delivery.body).digest("hex")}`;
      return signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    },
    async parse(delivery): Promise<ChannelInbound[]> {
      const body = JSON.parse(delivery.body) as { id: string; thread: string; from: string; name: string; text: string; self?: boolean };
      return [{
        deliveryId: body.id,
        kind: body.self ? "hook.self.reply" : "hook.message.received",
        role: body.self ? "self_reply" : "message",
        objectKey: `${FAKE_HOOK_SOURCE}:${body.thread}`,
        laneLabel: `${body.name} 的 webhook 对话`,
        occurredAt: new Date().toISOString(),
        sender: { id: body.from, name: body.name, trust: "colleague" },
        text: body.text,
        replyTarget: { thread: body.thread },
        fields: { thread: body.thread },
      }];
    },
    async send(request, options, context) {
      if (request.action === "retract") {
        const result = service.retract(context.credential.token, request.target.id ?? "");
        return { remoteRef: { id: request.target.id ?? "" }, duplicate: result === "not_found" };
      }
      const result = service.reply(context.credential.token, request.target.thread ?? "", request.text ?? "", options.idempotencyKey);
      return { remoteRef: { id: result.id }, duplicate: result.duplicate };
    },
  };
}

// 通道适配器的共享合约测试（Lead 事件主干 spec D14，工单 11）。先例是 runtime adapter 的合约测试
// （packages/runtime/testing/runtime-adapter-contract.ts）：每个适配器用自己的假服务跑同一组用例。
// 新增一个来源时，写适配器和假服务，再给它一份 ChannelContractFake，加进 test/channel-adapter-contract.test.ts 的 FAKES。
// 用例只看外部行为：hub 写进库的事件、道和卡，假服务里留下的回复，以及日志。
import { cardIdOf } from "./cards.js";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { ENTITY_KEY_PATTERN } from "@pi-lead-child/protocol";
import { getChannelCard, getChannelLane, getEvent, openDb, type Db } from "@pi-lead-child/store";
import {
  ChannelHub, ChannelOutbox, ChannelRegistry,
  type ChannelAdapter, type ChannelCredential, type ChannelCredentialSource, type ChannelDelivery, type SmartModel,
} from "../../src/index.js";

/** 一个适配器接入合约测试时提供的东西。每个用例调用一次 setup，拿到一套新的适配器和假服务。 */
export interface ChannelContractFake {
  setup(): ChannelContractService;
}

export interface ChannelContractService {
  adapter: ChannelAdapter;
  credential: ChannelCredential;
  /** 别人在 thread 这个对话里发来一条消息。thread 是测试自己起的名字，假服务按自己的规则映射到来源里的对话。 */
  message(thread: string, text: string): ChannelDelivery;
  /** 用户本人在这个对话里回复了。 */
  selfReply(thread: string, text: string): ChannelDelivery;
  /** 同一次投递，来源又送了一次（例如重试；签名可以重新算）。 */
  redeliver(delivery: ChannelDelivery): ChannelDelivery;
  /** 签名不对的同一次投递。 */
  forge(delivery: ChannelDelivery): ChannelDelivery;
  /** 这个对话应该的对象键。 */
  objectKey(thread: string): string;
  /** 来源里系统发出去、还在的回复（这个对话里的）。 */
  liveReplies(thread: string): string[];
  /** 下一次回复在来源里做成以后、回结果之前断开（模拟进程在这时崩溃）。 */
  crashAfterNextReply(): void;
  /** 下一次回复失败，报错的文字里带着凭据（模拟一个不小心的客户端库）。 */
  failNextReplyEchoingCredential(): void;
}

const credentialsOf = (credential: ChannelCredential | null): ChannelCredentialSource => ({
  credential: async () => credential,
});

const count = (db: Db, sql: string, ...values: unknown[]) => (db.prepare(sql).get(...values) as { n: number }).n;

/** 凭据里所有不能外泄的值：令牌、签名密钥、别的密钥（例如传输用的令牌）。 */
const secretsOf = (credential: ChannelCredential): string[] =>
  [credential.token, credential.signingSecret, ...Object.values(credential.secrets ?? {})].filter((value): value is string => Boolean(value));

/** 为一个适配器跑共享的合约用例。 */
export function describeChannelAdapterContract(name: string, fake: ChannelContractFake): void {
  describe(`channel adapter contract: ${name}`, () => {
    let db: Db;
    let service: ChannelContractService;
    let hub: ChannelHub;
    let logs: string[];

    beforeEach(() => {
      db = openDb(join(tempDir("plc-channel-contract-"), "plc.db"));
      service = fake.setup();
      logs = [];
      hub = new ChannelHub({
        db, registry: new ChannelRegistry([service.adapter]), credentials: credentialsOf(service.credential),
        log: (line) => logs.push(line), outboundRetryBaseMs: 0,
      });
    });

    afterEach(async () => {
      // 后台的事（请求 A、判断用户自己的话）做完再关库。
      await hub.idle();
      db.close();
    });

    const inboundEvents = () => count(db, "SELECT COUNT(*) AS n FROM events WHERE source = ?", service.adapter.id);

    it("records one event per delivery, even when the source delivers it again", async () => {
      const delivery = service.message("t1", "第一条消息");
      const first = await hub.receive(service.adapter.id, delivery);
      expect(first).toMatchObject({ accepted: true, items: [{ inserted: true }] });
      const again = await hub.receive(service.adapter.id, service.redeliver(delivery));
      expect(again.accepted).toBe(true);
      expect(again.items.map((item) => item.inserted)).toEqual([false]);
      expect(again.items[0]!.seq).toBe(first.items[0]!.seq);
      expect(inboundEvents()).toBe(1);
      expect(getChannelCard(db, first.items[0]!.cardId!)!.messageCount).toBe(1);
    });

    it("keeps two different deliveries that carry the same text", async () => {
      const one = await hub.receive(service.adapter.id, service.message("t1", "同样的一句话"));
      const two = await hub.receive(service.adapter.id, service.message("t1", "同样的一句话"));
      expect([one.items[0]!.inserted, two.items[0]!.inserted]).toEqual([true, true]);
      expect(two.items[0]!.seq).not.toBe(one.items[0]!.seq);
      expect(inboundEvents()).toBe(2);
      // 同一个对话：同一张卡，两条消息。
      expect(two.items[0]!.cardId).toBe(one.items[0]!.cardId);
      expect(getChannelCard(db, one.items[0]!.cardId!)!.messageCount).toBe(2);
    });

    it("gives every conversation its own object key under the source's name", async () => {
      const a = await hub.receive(service.adapter.id, service.message("t1", "对话一"));
      const b = await hub.receive(service.adapter.id, service.message("t2", "对话二"));
      const keyA = a.items[0]!.objectKey;
      const keyB = b.items[0]!.objectKey;
      expect(keyA).toBe(service.objectKey("t1"));
      expect(keyB).toBe(service.objectKey("t2"));
      expect(keyA).not.toBe(keyB);
      for (const key of [keyA, keyB]) {
        expect(key.startsWith(`${service.adapter.id}:`)).toBe(true);
        expect(ENTITY_KEY_PATTERN.test(key)).toBe(true);
        expect(getChannelLane(db, key)).toBeDefined();
      }
      const stored = db.prepare("SELECT DISTINCT entity_key FROM events WHERE source = ? ORDER BY entity_key").all(service.adapter.id);
      expect(stored).toEqual([keyA, keyB].sort().map((entity_key) => ({ entity_key })));
    });

    it("recognizes the user's own reply as handled elsewhere", async () => {
      // 用户自己的话回答了没有，由内核问 SmartModel（工单 04）。这个替身说「回答了」。
      const model: SmartModel = {
        backend: "contract-model",
        async decide(_state, questions) {
          const result = Object.fromEntries(Object.keys(questions).map((question) => [question, { type: "yes_no", probability: 0.95 }]));
          return { answers: result as never, backend: "contract-model", model: null, latencyMs: 1, fallbackFrom: null };
        },
      };
      hub = new ChannelHub({
        db, registry: new ChannelRegistry([service.adapter]), credentials: credentialsOf(service.credential), smartModel: () => model,
        log: (line) => logs.push(line),
      });
      const received = await hub.receive(service.adapter.id, service.message("t1", "能看一下吗？"));
      // 有快模型时先判断要不要用户回，再开卡：等判断完。
      await hub.idle();
      const cardId = cardIdOf(db, received.items[0]!)!;
      expect(getChannelCard(db, cardId)!.state).toBe("open");
      const reply = await hub.receive(service.adapter.id, service.selfReply("t1", "我自己回了"));
      expect(reply.items[0]).toMatchObject({ inserted: true, role: "self_reply", objectKey: service.objectKey("t1"), cardId });
      await hub.idle();
      expect(getChannelCard(db, cardId)!.state).toBe("resolved_elsewhere");
      expect(db.prepare("SELECT disposition FROM events WHERE seq = ?").get(received.items[0]!.seq)).toEqual({ disposition: "resolved_elsewhere" });
      // 别的、没有道的对话里用户自己说的话不记。
      const elsewhere = await hub.receive(service.adapter.id, service.selfReply("t9", "和这里无关"));
      expect(elsewhere.items[0]).toMatchObject({ inserted: false, ignored: "no_lane" });
    });

    it("rejects deliveries that fail authentication, and deliveries without a connection", async () => {
      const forged = await hub.receive(service.adapter.id, service.forge(service.message("t1", "伪造的")));
      expect(forged).toEqual({ accepted: false, rejection: "unauthenticated", items: [] });
      const disconnected = new ChannelHub({ db, registry: new ChannelRegistry([service.adapter]), credentials: credentialsOf(null) });
      const refused = await disconnected.receive(service.adapter.id, service.message("t1", "没有连接时"));
      expect(refused).toEqual({ accepted: false, rejection: "no_connection", items: [] });
      expect(inboundEvents()).toBe(0);
    });

    it("makes outbound actions safe to repeat", async () => {
      const context = { credential: service.credential, log: (line: string) => logs.push(line) };
      const target = (await (async () => {
        const received = await hub.receive(service.adapter.id, service.message("t1", "请回复"));
        return getChannelCard(db, received.items[0]!.cardId!)!.replyTarget;
      })());
      const request = { action: "reply" as const, objectKey: service.objectKey("t1"), target, text: "收到" };
      // 适配器这一层：同一个幂等键调用两次，来源里只有一条。
      const first = await service.adapter.send(request, { idempotencyKey: "contract-key-1" }, context);
      const second = await service.adapter.send(request, { idempotencyKey: "contract-key-1" }, context);
      expect(first.duplicate).toBe(false);
      expect(second.duplicate).toBe(true);
      expect(second.remoteRef).toEqual(first.remoteRef);
      expect(service.liveReplies("t1")).toEqual(["收到"]);
      // 撤回两次也安全。
      await service.adapter.send({ action: "retract", objectKey: request.objectKey, target: first.remoteRef }, { idempotencyKey: "contract-retract-1" }, context);
      const retractAgain = await service.adapter.send(
        { action: "retract", objectKey: request.objectKey, target: first.remoteRef }, { idempotencyKey: "contract-retract-1" }, context,
      );
      expect(retractAgain.duplicate).toBe(true);
      expect(service.liveReplies("t1")).toEqual([]);

      // 内核这一层：在来源里做成以后、记下来之前崩溃，用同一个幂等键重试，来源里仍然只有一条。
      const outbox = new ChannelOutbox({ db, now: () => new Date(), log: (line) => logs.push(line) });
      service.crashAfterNextReply();
      const crashed = await outbox.perform(service.adapter, context, { key: "contract-key-2", purpose: "user_reply", cardId: null, request });
      expect(crashed.status).toBe("failed");
      const retried = await outbox.perform(service.adapter, context, { key: "contract-key-2", purpose: "user_reply", cardId: null, request });
      expect(retried).toMatchObject({ status: "sent", duplicate: true });
      const repeated = await outbox.perform(service.adapter, context, { key: "contract-key-2", purpose: "user_reply", cardId: null, request });
      expect(repeated.status).toBe("already_sent");
      expect(service.liveReplies("t1")).toEqual(["收到"]);

      // 卡上连点两下「改一下再发」：只发一次。卡上没有草稿（统一消息事件工单 06：草稿只由 Lead 写），用你自己的话。
      const card = (await hub.receive(service.adapter.id, service.message("t2", "再来一条"))).items[0]!.cardId!;
      await hub.idle();
      const clicks = await Promise.allSettled([
        hub.act(card, "send_edited", { by: "user via contract", text: "好的，马上看" }),
        hub.act(card, "send_edited", { by: "user via contract", text: "好的，马上看" }),
      ]);
      expect(clicks.filter((click) => click.status === "fulfilled")).toHaveLength(1);
      expect(service.liveReplies("t2")).toEqual(["好的，马上看"]);
      expect(getChannelCard(db, card)!.state).toBe("replied");
    });

    // 用户 2026-10-19：理解自然语言不用正则。别人发来的消息紧不紧急由内核问 SmartModel 定，对所有来源一样；
    // 适配器只交出结构化的事实（发信人、信任、文字……），不给结论。
    it("leaves urgency to the kernel: the adapter's events carry no urgent verdict", async () => {
      const context = { credential: service.credential, log: (line: string) => logs.push(line) };
      const parsed = await service.adapter.parse(service.message("t1", "紧急！ASAP！马上回我"), context);
      expect(parsed.length).toBeGreaterThan(0);
      for (const item of parsed) {
        expect(Object.keys(item.fields)).not.toContain("urgent");
        expect(Object.keys(item.fields)).not.toContain("urgency");
      }
      // 同样的文字，模型说不急就不急，说急就急；用户本人的话不问。
      const answers = [0.05, 0.95];
      const asked: string[] = [];
      const model: SmartModel = {
        backend: "contract-model",
        async decide(state, questions, opts) {
          // 别的用途（请求 A、判断用户自己的话）这里不管。
          if (opts?.purpose !== "channel_urgency") throw new Error("not this test's question");
          asked.push(state);
          const probability = answers.shift() ?? 0;
          const result = Object.fromEntries(Object.keys(questions).map((question) => [question, { type: "yes_no", probability }]));
          return { answers: result as never, backend: "contract-model", model: null, latencyMs: 1, fallbackFrom: null };
        },
      };
      const judged = new ChannelHub({
        db, registry: new ChannelRegistry([service.adapter]), credentials: credentialsOf(service.credential), smartModel: () => model,
      });
      const calm = (await judged.receive(service.adapter.id, service.message("t1", "紧急！ASAP！马上回我"))).items[0]!;
      const busy = (await judged.receive(service.adapter.id, service.message("t2", "服务挂了，客户在等"))).items[0]!;
      const self = (await judged.receive(service.adapter.id, service.selfReply("t2", "我来看"))).items[0]!;
      expect(asked).toHaveLength(2);
      expect(getEvent(db, calm.seq!)!.payload).toMatchObject({ urgent: false, urgency: { by: "smart_model", probability: 0.05 } });
      expect(getEvent(db, busy.seq!)!.payload).toMatchObject({ urgent: true, urgency: { by: "smart_model", probability: 0.95 } });
      expect(getEvent(db, self.seq!)!.payload).toMatchObject({ role: "self_reply", urgent: false });
      await judged.idle();
    });

    it("never writes the credential to logs, events or cards", async () => {
      const first = await hub.receive(service.adapter.id, service.message("t1", "一条消息"));
      await hub.receive(service.adapter.id, service.forge(service.message("t1", "伪造的")));
      await hub.idle();
      service.failNextReplyEchoingCredential();
      const failed = await hub.act(first.items[0]!.cardId!, "send_draft", { by: "user via contract" }).catch((error: Error) => error);
      expect(failed).toBeInstanceOf(Error);
      for (const secret of secretsOf(service.credential)) {
        expect((failed as Error).message).not.toContain(secret);
      }
      service.crashAfterNextReply();
      await hub.tick();
      await hub.tick();
      await hub.receive(service.adapter.id, service.selfReply("t1", "好了"));
      const stored = JSON.stringify([
        db.prepare("SELECT * FROM events").all(),
        db.prepare("SELECT * FROM channel_lanes").all(),
        db.prepare("SELECT * FROM channel_cards").all(),
        hub.listCards(),
      ]);
      for (const secret of secretsOf(service.credential)) {
        expect(stored).not.toContain(secret);
        expect(logs.join("\n")).not.toContain(secret);
      }
      expect(logs.length).toBeGreaterThan(0);
    });
  });
}

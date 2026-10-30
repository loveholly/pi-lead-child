// /v1/channels/cards 的动作路由（src/channel-routes.ts）：按动作查 scope（都要 tickets:create；发到 PR 的 post_review
// 随代查退役了，落地计划 D1），请求体的 text 只给 send_edited，400 的说明从常量生成（Slack 代查与按信心代回 spec D9，工单 01）。
// 卡上的动作经操作层（engine 的 ui-actions/ 的 channel_card，2026-10-23）：经网关的那一段用真的凭证和操作层，通道 hub 是假的；
// 卡的状态和动作在 daemon 的通道 hub（apps/daemon/test/channel-slack-scenario.test.ts）。
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  CHANNEL_CARD_ACTIONS, HttpErrorResponseSchema, UI_ACTION_PERFORMED_KIND, type ChannelCardAction, type ChannelCardDto, type Scope,
} from "@pi-lead-child/protocol";
import { createLoopbackBinding, listEvents, openChannelCard, openDb, recordChannelLaneMessage, type Db } from "@pi-lead-child/store";
import { handleChannelRoute, type ChannelCardService } from "../src/channel-routes.js";
import { startPairedServer } from "../src/paired-server.js";

const CARD = {
  id: 7, version: 4, source: "hook", sourceLabel: "Hook", objectKey: "hook:t1", laneLabel: "对话",
  sender: { id: "a", name: "A", trust: "colleague" }, excerpt: "hi", messageCount: 1, delivery: "card", state: "open",
  draft: null, gate: null, lookup: null, handling: null, sentText: null, snoozedUntil: null, revokeUntil: null, resolvedAt: null, actions: [],
  createdAt: "2026-10-19T06:00:00.000Z", updatedAt: "2026-10-19T06:00:00.000Z",
} satisfies ChannelCardDto;

// 路由交给操作层的一次调用：卡号、动作、输入、要的 scope。
type Call = [number, ChannelCardAction, { expectedVersion?: number; text?: string }, Scope];

const service: ChannelCardService = { list: () => [CARD] };

async function route(body: Record<string, unknown>, options: { scopes?: Scope[] } = {}) {
  const asked: Array<Scope | undefined> = [];
  const calls: Call[] = [];
  let response: { status: number; body: any } | null = null;
  await handleChannelRoute({
    req: { method: "POST", headers: {} } as IncomingMessage,
    res: {} as ServerResponse,
    url: new URL("http://127.0.0.1/v1/channels/cards/7/actions"),
    service,
    json: (status, value) => { response = { status, body: value }; },
    readBody: async () => body,
    requireAuth: (scope) => {
      asked.push(scope);
      if (scope && options.scopes && !options.scopes.includes(scope)) throw Object.assign(new Error(`missing scope: ${scope}`), { status: 403 });
    },
    perform: async (cardId, action, input, scope) => {
      calls.push([cardId, action, input, scope]);
      return CARD;
    },
  });
  return { asked, calls, response: response as { status: number; body: any } | null };
}

describe("the card action route", () => {
  it("checks the scope of each action: all of them need tickets:create", async () => {
    for (const action of CHANNEL_CARD_ACTIONS) {
      const body = action === "send_edited" ? { action, text: "好的" } : action === "handled" ? { action, note: "私信了 Nina" } : { action };
      const { asked, calls } = await route(body);
      // 先只认调用方，读了请求体以后再按动作查 scope。
      expect(asked, action).toEqual([undefined, "tickets:create"]);
      expect(calls[0]?.slice(0, 2)).toEqual([7, action]);
      expect(calls[0]?.[3]).toBe("tickets:create");
    }
    await expect(route({ action: "send_draft" }, { scopes: ["chat", "approvals:respond"] })).rejects.toThrow(/tickets:create/);
    await expect(route({ action: "cancel_lookup" }, { scopes: ["chat", "approvals:respond"] })).rejects.toThrow(/tickets:create/);
  });

  it("passes the user's text and the seen version to the service", async () => {
    const { calls, response } = await route({ action: "send_edited", expectedVersion: 4, text: "好的，我下午看一下" });
    expect(calls).toEqual([[7, "send_edited", { expectedVersion: 4, text: "好的，我下午看一下" }, "tickets:create"]]);
    expect(response).toEqual({ status: 200, body: { card: CARD } });
    // 不带文字的动作，交给操作层的输入里没有 text。
    expect((await route({ action: "dismiss" })).calls[0]![2]).toEqual({});
    expect((await route({ action: "handled", note: "私信了 Nina", emoji: "+1", react: true })).calls[0]![2])
      .toEqual({ note: "私信了 Nina", emoji: "+1", react: true });
  });

  it("refuses text that is missing, blank, too long, or sent with an action that does not take it", async () => {
    const cases = [
      await route({ action: "send_edited" }),
      await route({ action: "send_edited", text: "   \n" }),
      await route({ action: "send_edited", text: "" }),
      await route({ action: "send_edited", text: "字".repeat(4_001) }),
      await route({ action: "send_draft", text: "多余的字" }),
      await route({ action: "cancel_lookup", text: "多余的字" }),
      // 「已处理」要写做了什么；别的动作不收说明和表情（2026-10-26）。
      await route({ action: "handled" }),
      await route({ action: "handled", note: " " }),
      await route({ action: "handled", note: "私信了 Nina", emoji: "✅" }),
      await route({ action: "dismiss", note: "不用回" }),
      await route({ action: "send_draft", react: false }),
      // 退役的动作不再认。
      await route({ action: "post_review" }),
      await route({ action: "rerun_lookup" }),
    ];
    for (const { response, calls } of cases) {
      expect(response?.status).toBe(400);
      expect(Value.Check(HttpErrorResponseSchema, response?.body)).toBe(true);
      expect(calls).toEqual([]);
    }
  });

  it("builds the 400 message from the action list instead of a hand-written one", async () => {
    const { response, asked } = await route({ action: "approve" });
    expect(response?.status).toBe(400);
    for (const action of CHANNEL_CARD_ACTIONS) expect(response?.body.error.message).toContain(action);
    expect(response?.body.error.message).toContain("4000");
    // 请求体不合格时不查动作的 scope：只认了调用方。
    expect(asked).toEqual([undefined]);
  });
});

describe("the card action route over HTTP, with real bindings, through the action layer", () => {
  let db: Db;
  // 操作层交给通道 hub 的调用（卡上的 by 由操作层按凭证写）。
  let acts: Array<[number, ChannelCardAction, { by: string; expectedVersion?: number; text?: string }]>;
  let cardId: number;

  beforeEach(() => {
    db = openDb(join(tempDir("plc-channel-routes-http-"), "plc.db"));
    acts = [];
    const lane = recordChannelLaneMessage(db, {
      source: "hook", objectKey: "hook:t1", label: "对话", message: { at: "2026-10-19T06:00:00.000Z", seq: null, role: "them", sender: "A", text: "hi" },
    });
    cardId = openChannelCard(db, {
      laneId: lane.id, source: "hook", objectKey: "hook:t1", delivery: "card", seq: 1, sender: { id: "a", name: "A", trust: "colleague" },
      excerpt: "hi", replyTarget: {},
    }).id;
  });

  async function start() {
    const server = await startPairedServer({
      db, channels: service, hello: () => ({}), chat: () => "started", addClient: () => () => {}, log: () => {},
      uiActionServices: {
        channelCards: {
          actionsFor: () => [...CHANNEL_CARD_ACTIONS],
          act: async (id, action, options) => {
            acts.push([id, action, options]);
            return CARD;
          },
        },
      },
    }, { port: 0 });
    const post = async (token: string | null, body: unknown, id = cardId) => {
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/channels/cards/${id}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() as any };
    };
    return { ...server, post };
  }

  it("lets only tickets:create act on a card, records the action in the ledger as the user, and maps the errors", async () => {
    const server = await start();
    try {
      const owner = createLoopbackBinding(db, { name: "本机网页", scopes: ["chat", "tickets:view", "tickets:create"] });
      const approver = createLoopbackBinding(db, { name: "审批手机", scopes: ["chat", "approvals:respond"] });

      const denied = await server.post(approver.accessToken, { action: "cancel_lookup" });
      expect(denied).toMatchObject({ status: 403, body: { error: { code: "forbidden", message: "missing scope: tickets:create" } } });
      expect(acts).toEqual([]);
      expect((await server.post(owner.accessToken, { action: "post_review" })).status).toBe(400);

      const cancelled = await server.post(owner.accessToken, { action: "cancel_lookup", expectedVersion: 4 });
      expect(cancelled).toEqual({ status: 200, body: { card: CARD } });
      expect(acts).toEqual([[cardId, "cancel_lookup", { by: `user via 本机网页（binding ${owner.binding.id}）`, forUser: true, expectedVersion: 4 }]]);
      // 和 Lead 代你做的记在同一本账上（ui_action.performed），只是 actor 是你。
      expect(listEvents(db, { kind: UI_ACTION_PERFORMED_KIND }).map((event) => event.payload)).toMatchObject([{
        target: { type: "channel_card", id: String(cardId) }, action: "cancel_lookup", actor: "user", authority: "user", bindingId: owner.binding.id,
      }]);

      expect((await server.post(approver.accessToken, { action: "send_draft" })).status).toBe(403);
      expect((await server.post(owner.accessToken, { action: "send_edited", text: "改过的回复" })).status).toBe(200);
      expect(acts.at(-1)).toEqual([cardId, "send_edited", { by: `user via 本机网页（binding ${owner.binding.id}）`, forUser: true, text: "改过的回复" }]);
      // 没有这张卡：404。
      expect((await server.post(owner.accessToken, { action: "dismiss" }, 999)).status).toBe(404);
      // 没有凭证：先 401，不看请求体。
      expect((await server.post(null, { action: "approve" })).status).toBe(401);
      expect((await server.post(owner.accessToken, { action: "approve" })).status).toBe(400);
    } finally {
      await server.close();
      db.close();
    }
  });
});

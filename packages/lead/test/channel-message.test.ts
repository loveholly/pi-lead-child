// genui v3 积木 7（2026-10-27）：别人的话只能引用，不能手写。Lead 只给外部消息卡的编号，render_ui 从这张卡的对话里
// 取对方说的那几条，写进 sender、messages、total；Lead 自己写的被换掉。不能显示卡片的地方看到「发信人：最新一条」。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { openChannelCard, openDb, recordChannelLaneMessage, updateChannelCard, type Db } from "@pi-lead-child/store";
import { createLeadTools, type LeadDeps } from "../src/tools.js";

let db: Db;
let deps: LeadDeps;
let cardId: number;

const WORDS = ["明哥在吗", "想请你帮忙看个 PR", "那个 pr 是 acme/orders#12", "主要改了 OrderList 的分页", "明哥，这个 pr 记得再帮我看看"];

beforeEach(() => {
  const dir = tempDir("plc-channel-message-");
  db = openDb(join(dir, "plc.db"));
  deps = { db, dbPath: join(dir, "plc.db"), dataDir: dir } as LeadDeps;
  const lane = { source: "slack", objectKey: "slack:dm:U1", label: "王小明的私信" };
  // 卡开出来之前的一条旧消息：不属于这张卡。
  let latest = recordChannelLaneMessage(db, { ...lane, message: { at: "2026-10-26T01:00:00.000Z", seq: 1, role: "them", sender: "王小明", text: "昨天的事" } });
  recordChannelLaneMessage(db, { ...lane, message: { at: "2026-10-26T01:10:00.000Z", seq: 2, role: "me", sender: "我", text: "好" } });
  WORDS.forEach((text, index) => {
    latest = recordChannelLaneMessage(db, { ...lane, message: { at: `2026-10-27T02:0${index}:00.000Z`, seq: 10 + index, role: "them", sender: "王小明", text } });
  });
  const card = openChannelCard(db, {
    laneId: latest.id, source: "slack", objectKey: lane.objectKey, delivery: "card", seq: 10,
    sender: { id: "U1", name: "王小明", trust: "colleague" }, excerpt: WORDS[0]!, replyTarget: {},
  });
  updateChannelCard(db, card.id, { lastSeq: 14, messageCount: 5, excerpt: WORDS[4]! });
  cardId = card.id;
});

const renderUi = () => createLeadTools(deps).find((candidate: any) => candidate.name === "render_ui") as any;
const card = (props: Record<string, unknown>) => ({
  root: "m", fallback_text: "王小明连发了 5 条，想请你再看一下 PR。", asks_user: false,
  nodes: [{ id: "m", type: "Message", props: { ref: { type: "channel_card", id: cardId }, ...props } }],
});
const messageOf = (result: any) => result.details.surface.nodes.find((node: any) => node.id === "m").props;

describe("Message", () => {
  it("quotes the card's own messages from the conversation and replaces whatever Lead typed", async () => {
    const result = await renderUi().execute("c1", card({ mode: "stack", show: 3, sender: "Lead 编的", messages: [{ at: "x", text: "Lead 打的" }] }));
    expect(messageOf(result)).toMatchObject({
      sender: "王小明", total: 5,
      messages: WORDS.slice(2).map((text) => ({ text })),
    });
  });

  it("shows only the latest one in latest mode, and still counts them all", async () => {
    const props = messageOf(await renderUi().execute("c2", card({ mode: "latest" })));
    expect(props.messages).toEqual([{ at: "2026-10-27T02:04:00.000Z", text: WORDS[4] }]);
    expect(props.total).toBe(5);
  });

  it("puts the sender and the latest message after the fallback sentence", async () => {
    const result = await renderUi().execute("c3", card({ mode: "latest" }));
    expect(result.details.surface.fallbackText).toBe(`王小明连发了 5 条，想请你再看一下 PR。\n\n王小明：${WORDS[4]}`);
  });

  it("refuses a card that does not exist", async () => {
    await expect(renderUi().execute("c4", { ...card({ mode: "latest" }), nodes: [{ id: "m", type: "Message", props: { ref: { type: "channel_card", id: 999 }, mode: "latest" } }] }))
      .rejects.toThrow(/#999 不存在/);
  });
});

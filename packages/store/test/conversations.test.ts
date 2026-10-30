import { beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb, type Db } from "../src/db.js";
import {
  appendAssistantDelta,
  completeTurn,
  createTurn,
  EMPTY_ASSISTANT_REPLY_ERROR,
  failTurn,
  listConversationFeed,
  listLeadTurns,
  listTurns,
  markTurnSteered,
  reopenTurn,
  repairEmptyCompletedTurns,
  restoreQuietSystemTurns,
} from "../src/conversations.js";
import {
  ensureCheckpointCard,
  upsertItemExecutionCard,
} from "../src/conversation-cards.js";
import { insertCheckpoint } from "../src/checkpoints.js";
import { createItem } from "../src/items.js";
import { publishGatewayEvent } from "../src/gateway-events.js";

let db: Db;
beforeEach(() => { db = openDb(join(tempDir("plc-"), "plc.db")); });

describe("channel turn projection", () => {
  it("stores a user-visible item-context turn and streams assistant text", () => {
    createTurn(db, {
      id: "turn-1",
      originBindingId: 7,
      originKind: "companion",
      itemId: 42,
      userText: "继续审计",
      now: new Date("2026-07-23T05:00:00.000Z"),
    });
    appendAssistantDelta(db, "turn-1", "正在");
    appendAssistantDelta(db, "turn-1", "核对");
    completeTurn(db, "turn-1", new Date("2026-07-23T05:01:00.000Z"));

    expect(listTurns(db)).toEqual([expect.objectContaining({
      id: "turn-1",
      origin_binding_id: 7,
      origin_kind: "companion",
      item_id: 42,
      state: "completed",
      user_text: "继续审计",
      assistant_text: "正在核对",
      error: null,
      created_at: "2026-07-23T05:00:00.000Z",
      updated_at: "2026-07-23T05:01:00.000Z",
    })]);
  });

  it("filters by item and supports failed or steered turns", () => {
    createTurn(db, { id: "a", originKind: "cli", userText: "global" });
    createTurn(db, { id: "b", originKind: "companion", itemId: 8, userText: "item" });
    markTurnSteered(db, "a");
    failTurn(db, "b", "model unavailable");

    expect(listTurns(db, { itemId: 8 })).toEqual([
      expect.objectContaining({ id: "b", state: "failed", error: "model unavailable" }),
    ]);
    expect(listTurns(db).map((row) => [row.id, row.state])).toEqual([
      ["a", "steered"], ["b", "failed"],
    ]);
  });

  // 插话被受理（steer 返回）可能晚于那一轮结束：已经失败或完成的轮次不能被改回 steered。
  it("marks only an unfinished turn as steered", () => {
    createTurn(db, { id: "queued", originKind: "companion", userText: "q", state: "queued" });
    createTurn(db, { id: "failed", originKind: "companion", userText: "f", state: "queued" });
    createTurn(db, { id: "done", originKind: "companion", userText: "d", state: "queued" });
    failTurn(db, "failed", "model unavailable");
    completeTurn(db, "done");
    for (const id of ["queued", "failed", "done"]) markTurnSteered(db, id);
    expect(listTurns(db).map((row) => [row.id, row.state, row.error])).toEqual(expect.arrayContaining([
      ["queued", "steered", null], ["failed", "failed", "model unavailable"], ["done", "completed", null],
    ]));
  });

  it("repairs only completed turns whose assistant reply is empty", () => {
    createTurn(db, { id: "empty", originKind: "companion", userText: "恢复18" });
    completeTurn(db, "empty");
    createTurn(db, { id: "answered", originKind: "companion", userText: "你好" });
    appendAssistantDelta(db, "answered", "收到");
    completeTurn(db, "answered");

    expect(repairEmptyCompletedTurns(db, undefined, new Date("2026-08-07T10:00:00.000Z"))).toBe(1);
    const repaired = Object.fromEntries(listTurns(db).map((turn) => [turn.id, turn]));
    expect(repaired.empty).toEqual(expect.objectContaining({
      state: "failed", error: EMPTY_ASSISTANT_REPLY_ERROR,
      updated_at: "2026-08-07T10:00:00.000Z",
    }));
    expect(repaired.answered).toEqual(expect.objectContaining({
      state: "completed", assistant_text: "收到", error: null,
    }));
    expect(repairEmptyCompletedTurns(db)).toBe(0);
  });

  // 运行时不把 Lead 自己发起、只调了工具的一轮算失败（sealChannelTurn）；只画了卡片的一轮也有回答。
  // 启动修复要用同一条规则，否则每次重启都把它们改成「Lead 未生成回复」（2026-10-15 预览发现）。
  it("leaves a quiet Lead-initiated turn and a turn answered with a card alone", () => {
    createTurn(db, { id: "quiet", originKind: "system:blocker", userText: "" });
    completeTurn(db, "quiet");
    createTurn(db, { id: "card", originKind: "paired:companion", userText: "#66 怎么样了" });
    publishGatewayEvent(db, {
      type: "lead.tool.updated", requiredScope: "chat", turnId: "card",
      payload: { toolCallId: "c1", toolName: "render_ui", textOffset: 0, surface: { id: "s1" } },
    });
    completeTurn(db, "card");
    createTurn(db, { id: "streamed-only", originKind: "paired:companion", userText: "再看看" });
    publishGatewayEvent(db, {
      type: "lead.tool.updated", requiredScope: "chat", turnId: "streamed-only",
      payload: { toolCallId: "c2", toolName: "render_ui", textOffset: 0, partial: true, surface: { id: "s2" } },
    });
    completeTurn(db, "streamed-only");

    expect(repairEmptyCompletedTurns(db)).toBe(1);
    const turns = Object.fromEntries(listTurns(db).map((turn) => [turn.id, turn.state]));
    expect(turns).toMatchObject({ quiet: "completed", card: "completed", "streamed-only": "failed" });
  });

  // 旧的启动修复不分来源：2026-10-15 13:56 的重启把 5 个 Lead 发起、只调了工具的回合改成了失败。
  // 改回完成（会话里不再显示成失败）。只动这一种：system 来源、没有文字、错误正好是那一句。
  it("restores quiet Lead-initiated turns that the old repair marked failed, once", () => {
    createTurn(db, { id: "quiet", originKind: "system:heartbeat", userText: "" });
    failTurn(db, "quiet", EMPTY_ASSISTANT_REPLY_ERROR);
    createTurn(db, { id: "model-error", originKind: "system:blocker", userText: "" });
    failTurn(db, "model-error", "503 auth_unavailable");
    createTurn(db, { id: "user", originKind: "paired:companion", userText: "你好" });
    failTurn(db, "user", EMPTY_ASSISTANT_REPLY_ERROR);

    expect(restoreQuietSystemTurns(db)).toBe(1);
    const turns = Object.fromEntries(listTurns(db).map((turn) => [turn.id, turn]));
    expect(turns.quiet).toMatchObject({ state: "completed", error: null });
    expect(turns["model-error"]).toMatchObject({ state: "failed" });
    expect(turns.user).toMatchObject({ state: "failed" });
    expect(restoreQuietSystemTurns(db)).toBe(0);
  });

  // daemon 重试同一条通知时复用它的系统回合。重新打开的那一轮排到会话流的末尾（它是现在开始的），
  // 并且只能是已经结束的系统回合：用户的轮次、还在进行的轮次不能被清空。
  it("reopens only a finished system turn, and moves it to the end of the feed", () => {
    createTurn(db, { id: "sys-1", originKind: "system:notification", userText: "", now: new Date("2026-10-13T04:00:00.000Z") });
    failTurn(db, "sys-1", "model down", new Date("2026-10-13T04:00:05.000Z"));
    createTurn(db, { id: "user-1", originBindingId: 7, originKind: "companion", userText: "在吗", now: new Date("2026-10-13T04:01:00.000Z") });
    completeTurn(db, "user-1", new Date("2026-10-13T04:01:10.000Z"));
    createTurn(db, { id: "sys-live", originKind: "system:heartbeat", userText: "", now: new Date("2026-10-13T04:01:20.000Z") });

    expect(reopenTurn(db, "user-1", new Date("2026-10-13T04:02:00.000Z"))).toBeNull();
    expect(reopenTurn(db, "sys-live", new Date("2026-10-13T04:02:00.000Z"))).toBeNull();
    expect(listTurns(db, {}).find((turn) => turn.id === "user-1")).toMatchObject({ state: "completed", assistant_text: "" });

    const reopened = reopenTurn(db, "sys-1", new Date("2026-10-13T04:02:00.000Z"));
    expect(reopened).toMatchObject({
      state: "streaming", error: null, assistant_text: "",
      created_at: "2026-10-13T04:02:00.000Z", updated_at: "2026-10-13T04:02:00.000Z",
    });
    expect(listTurns(db, {}).map((turn) => turn.id)).toEqual(["user-1", "sys-live", "sys-1"]);
  });

  // 会话快照要的是最近的轮次：超过上限时丢掉最老的，不是最新的。顺序仍然从旧到新。
  // （实际数据库有 116 轮，按旧的写法刷新后 2026-09-04 之后的轮次全都看不到。）
  it("returns the newest turns when there are more than the limit, oldest first", () => {
    const base = Date.parse("2026-09-01T00:00:00.000Z");
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "user" });
    for (let index = 1; index <= 105; index += 1) {
      createTurn(db, {
        id: `turn-${String(index).padStart(3, "0")}`, originKind: "companion", userText: `第 ${index} 句`,
        ...(index % 2 === 0 ? { itemId } : {}),
        now: new Date(base + index * 60_000),
      });
    }
    const ids = (turns: Array<{ id: string }>) => turns.map((turn) => turn.id);
    expect(ids(listTurns(db))).toEqual(Array.from({ length: 100 }, (_, index) => `turn-${String(index + 6).padStart(3, "0")}`));
    expect(ids(listTurns(db, { limit: 3 }))).toEqual(["turn-103", "turn-104", "turn-105"]);
    expect(ids(listTurns(db, { itemId, limit: 2 }))).toEqual(["turn-102", "turn-104"]);
    expect(listConversationFeed(db, { limit: 2 }).map((entry) => entry.id)).toEqual(["turn:turn-104", "turn:turn-105"]);

    // 重试时重新打开的系统回合是现在开始的：它在最近的窗口里，排在最后。
    createTurn(db, { id: "sys-old", originKind: "system:notification", userText: "", now: new Date(base) });
    failTurn(db, "sys-old", "model down", new Date(base + 1_000));
    expect(ids(listTurns(db, { limit: 2 }))).toEqual(["turn-104", "turn-105"]);
    reopenTurn(db, "sys-old", new Date(base + 200 * 60_000));
    expect(ids(listTurns(db, { limit: 2 }))).toEqual(["turn-105", "sys-old"]);
  });

  it("merges attached and asynchronous cards with deterministic conversation ordering", () => {
    const itemId = createItem(db, { title: "feed", brief: "merge", createdBy: "lead" });
    createTurn(db, {
      id: "turn-feed",
      originKind: "companion",
      itemId,
      userText: "start",
      now: new Date("2026-07-24T05:00:00.000Z"),
    });
    const execution = upsertItemExecutionCard(db, {
      turnId: "turn-feed",
      itemId,
      operation: {
        id: "turn-feed:call-1",
        name: "create_task",
        state: "completed",
        label: `Create task #${itemId}`,
        detail: `Created task #${itemId}`,
      },
      now: new Date("2026-07-24T05:00:00.000Z"),
    });
    const checkpoint = insertCheckpoint(db, {
      itemId,
      runId: null,
      source: "system_derived",
      kind: "completed",
      title: "Finished",
      summary: "The work completed.",
      idempotencyKey: "feed-complete",
    }, { now: new Date("2026-07-24T05:00:00.000Z") });
    const asynchronous = ensureCheckpointCard(db, {
      itemId,
      checkpointId: checkpoint.id,
      now: new Date("2026-07-24T05:00:00.000Z"),
    });

    expect(listConversationFeed(db, { itemId })).toEqual([
      expect.objectContaining({
        id: "turn:turn-feed",
        stableKey: "turn:turn-feed",
        kind: "turn",
        turn: expect.objectContaining({ id: "turn-feed" }),
        cards: [expect.objectContaining({ id: execution.id, key: execution.key })],
      }),
      expect.objectContaining({
        id: `card:${asynchronous.id}`,
        stableKey: `card:${asynchronous.id}`,
        kind: "card",
        card: expect.objectContaining({ id: asynchronous.id, key: asynchronous.key }),
      }),
    ]);
  });
});

// 工单 03 的 read_lead_turns：Lead 自己的回合，不含工单 agent 的回答、daemon 合成的回执和 daemon 自己写的通知。
describe("Lead's own turns", () => {
  it("lists the turns Lead's model answered, newest first", () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 17, 1, minute));
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "user" });
    const user = createTurn(db, { originKind: "paired:companion", userText: "问", now: at(0) });
    const inTicket = createTurn(db, { originKind: "paired:companion", itemId, userText: "在工单里问 Lead", now: at(1) });
    const woken = createTurn(db, { originKind: "system:blocker", userText: "", now: at(2) });
    createTurn(db, { originKind: "paired:companion:ticket-agent", itemId, userText: "问 agent", now: at(3) });
    createTurn(db, { originKind: "paired:companion:ticket", itemId, userText: "回执", now: at(4) });
    createTurn(db, { originKind: "system:blocker-notice", userText: "", now: at(5) });
    createTurn(db, { originKind: "system:fallback-notice", userText: "", now: at(6) });

    expect(listLeadTurns(db).map((turn) => turn.id)).toEqual([woken.id, inTicket.id, user.id]);
    expect(listLeadTurns(db, { limit: 1 }).map((turn) => turn.id)).toEqual([woken.id]);
  });
});

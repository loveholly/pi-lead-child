// 用户的每条消息都有结局（Lead 事件主干 spec D6，工单 04），写在它的 user.message 事件的处置上：
//   · 插话还在路上：没有结局（markTurnInserted 不记处置），daemon 崩溃以后据此找回它；
//   · 没有自己的回答、和另一条一起答了：done，标明和哪一条一起答的（工单第 7 项，不是失败）；
//   · 没有答上：unanswered，加原因（restart、aborted、model_error）。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { LEAD_RESTART_INTERRUPTED_ERROR } from "@pi-lead-child/protocol";
import {
  createTurn, EMPTY_ASSISTANT_REPLY_ERROR, failTurn, listEvents, listUnfinishedLeadTurns, markTurnInserted, openDb,
  settleTurnAnsweredWith, unansweredReason, userMessageOutcomes,
} from "../src/index.js";

const outcome = (db: ReturnType<typeof openDb>, turnId: string) =>
  listEvents(db, { kind: "user.message" }).find((event) => event.payload.turnId === turnId);

describe("the outcome of a user's message", () => {
  it("has none while a steer is in flight, and is found again after a crash", () => {
    const db = openDb(join(tempDir("plc-input-outcome-"), "plc.db"));
    const steer = createTurn(db, { originKind: "paired:companion", userText: "插话", state: "queued" });
    expect(markTurnInserted(db, steer.id)).toBe(true);
    expect(outcome(db, steer.id)).toMatchObject({ disposition: null });
    expect(listUnfinishedLeadTurns(db, { since: new Date(Date.now() - 60_000) }).map((turn) => turn.id)).toEqual([steer.id]);
    // 工单对话和 Lead 自己发起的轮次不算。
    createTurn(db, { originKind: "paired:companion:ticket-agent", userText: "工单里问", itemId: undefined });
    createTurn(db, { originKind: "system:blocker", userText: "" });
    expect(listUnfinishedLeadTurns(db, { since: new Date(Date.now() - 60_000) })).toHaveLength(1);
    db.close();
  });

  it("is done, answered together with the next message, and never a failure", () => {
    const db = openDb(join(tempDir("plc-input-outcome-"), "plc.db"));
    const first = createTurn(db, { originKind: "paired:companion", userText: "在吗", state: "streaming" });
    const second = createTurn(db, { originKind: "paired:companion", userText: "顺便看 #77", state: "queued" });
    expect(settleTurnAnsweredWith(db, first.id, { answeredWith: second.id, note: "和后面的插话一起回答" })).toBe(true);
    expect(db.prepare("SELECT state, error FROM channel_turns WHERE id = ?").get(first.id)).toEqual({ state: "steered", error: null });
    expect(outcome(db, first.id)).toMatchObject({
      disposition: "handled", dispositionDetail: { outcome: "done", answeredWith: second.id, note: "和后面的插话一起回答" },
    });
    expect(userMessageOutcomes(db, [first.id, second.id])).toEqual(new Map([[first.id, expect.objectContaining({ answeredWith: second.id })]]));
    // 已经有结局的轮次不再改。
    failTurn(db, second.id, "model rejected the request");
    expect(settleTurnAnsweredWith(db, second.id, { answeredWith: null, note: "x" })).toBe(false);
    expect(listUnfinishedLeadTurns(db, { since: new Date(Date.now() - 60_000) })).toEqual([]);
    db.close();
  });

  it("says why a message went unanswered", () => {
    expect(unansweredReason(LEAD_RESTART_INTERRUPTED_ERROR)).toBe("restart");
    expect(unansweredReason("Lead 回复被中断，请重试。")).toBe("aborted");
    expect(unansweredReason("Run 已停止，这一轮回答没有完成。")).toBe("aborted");
    expect(unansweredReason("429 Too Many Requests")).toBe("model_error");
    expect(unansweredReason(EMPTY_ASSISTANT_REPLY_ERROR)).toBe("model_error");

    const db = openDb(join(tempDir("plc-input-outcome-"), "plc.db"));
    const turn = createTurn(db, { originKind: "paired:companion", userText: "在吗", state: "streaming" });
    failTurn(db, turn.id, LEAD_RESTART_INTERRUPTED_ERROR);
    expect(outcome(db, turn.id)).toMatchObject({
      disposition: "no_action", dispositionDetail: { outcome: "unanswered", reason: "restart", error: LEAD_RESTART_INTERRUPTED_ERROR },
    });
    db.close();
  });
});

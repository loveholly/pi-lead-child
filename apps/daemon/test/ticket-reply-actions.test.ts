// 回复下面的动作按钮由快模型判断（2026-10-19，ticket-reply-actions.ts）。这里是决策点的单元测试：
// 送给模型的文字已经脱敏、只取末尾；按阈值取动作；模型不可用、出错、超时时不记结果，也不挡别的事。
// SmartModel 用替身，不调真的 Jev 或 LLM。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  LLM_FIXED_CONFIDENCE, type SmartDecideOptions, type SmartDecision, type SmartModel, type SmartQuestionSet,
} from "@pi-lead-child/engine";
import { TICKET_REPLY_ACTION_IDS, TICKET_REPLY_ACTIONS_RESOURCE } from "@pi-lead-child/protocol";
import {
  createItem, listEvents, openDb, ticketReplyActionsByTurn, type Db, type PublishGatewayEventInput,
} from "@pi-lead-child/store";
import {
  createTicketReplyActionsJudge, judgeReplyActions, REPLY_ACTION_THRESHOLD, REPLY_ACTIONS_PURPOSE, REPLY_TAIL_CHARS,
  replyActionsState,
} from "../src/ticket-reply-actions.js";

// 假令牌，拼出来，免得测试源码里有一串像真令牌的字符。
const TOKEN = ["ghp", "_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("");

interface Call { state: string; questions: SmartQuestionSet; opts: SmartDecideOptions }

// SmartModel 的替身：按问题名给「是」的概率，记下每一次调用。
function stubModel(probabilities: Partial<Record<string, number>> | (() => Promise<never>), backend = "jev") {
  const calls: Call[] = [];
  const model: SmartModel = {
    backend,
    async decide<Q extends SmartQuestionSet>(state: string, questions: Q, opts: SmartDecideOptions = {}): Promise<SmartDecision<Q>> {
      calls.push({ state, questions, opts });
      if (typeof probabilities === "function") return probabilities();
      const answers = Object.fromEntries(Object.keys(questions).map((name) => [
        name, { type: "yes_no", probability: probabilities[name] ?? 0.05 },
      ]));
      return { answers: answers as never, backend, model: "stub", latencyMs: 1, fallbackFrom: null };
    },
  };
  return { model, calls };
}

describe("what goes to the model", () => {
  it("masks secrets before anything is sent", () => {
    const state = replyActionsState(`已经用 ${TOKEN} 推送了。你要我现在就派发独立核查吗？`)!;
    expect(state).not.toContain(TOKEN);
    expect(state).toContain("[REDACTED]");
    expect(state).toContain("你要我现在就派发独立核查吗？");
  });

  it("sends only the end of a long reply", () => {
    const reply = `${"前面的工作记录。".repeat(1_000)}\n\n最后：要我返工吗？`;
    const state = replyActionsState(reply)!;
    expect(state).toContain("Only the end of the reply is shown.");
    expect(state.endsWith("最后：要我返工吗？")).toBe(true);
    expect(state.length).toBeLessThan(REPLY_TAIL_CHARS + 300);
  });

  it("sends nothing for an empty reply", () => {
    expect(replyActionsState("  \n ")).toBeNull();
  });

  it("asks one yes/no question per action, all in one call, with its purpose", async () => {
    const { model, calls } = stubModel({ request_review: 0.9 });
    await judgeReplyActions(model, `用 ${TOKEN} 推上去了，要我派发核查吗？`);
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]!.questions)).toEqual([...TICKET_REPLY_ACTION_IDS]);
    expect(Object.values(calls[0]!.questions).every((question) => question.type === "yes_no")).toBe(true);
    expect(calls[0]!.opts.purpose).toBe(REPLY_ACTIONS_PURPOSE);
    expect(calls[0]!.state).not.toContain(TOKEN);
  });
});

describe("which actions count as asked", () => {
  it("keeps only the actions at or above the threshold", async () => {
    const { model } = stubModel({ request_review: 0.92, complete: REPLY_ACTION_THRESHOLD, rework: 0.6, cancel: 0.5 });
    expect(await judgeReplyActions(model, "二选一：派发核查，或者你直接验收？")).toEqual({
      actions: ["request_review", "complete"], backend: "jev",
    });
  });

  // LLM 兜底只回是或否，「是」的概率固定是 (1 + LLM_FIXED_CONFIDENCE) / 2。阈值高过它，Jev 不可用时永远没有按钮。
  it("lets a plain yes from the LLM fallback through, and a plain no not", () => {
    expect((1 + LLM_FIXED_CONFIDENCE) / 2).toBeGreaterThanOrEqual(REPLY_ACTION_THRESHOLD);
    expect((1 - LLM_FIXED_CONFIDENCE) / 2).toBeLessThan(REPLY_ACTION_THRESHOLD);
    // 宁可少显示：拿不准（0.5）的不算。
    expect(REPLY_ACTION_THRESHOLD).toBeGreaterThan(0.5);
  });
});

describe("the judge in the daemon", () => {
  let dir: string;
  let db: Db;
  let itemId: number;
  let published: PublishGatewayEventInput[];
  let logs: string[];

  beforeEach(() => {
    dir = tempDir("plc-reply-actions-");
    db = openDb(join(dir, "plc.db"));
    itemId = createItem(db, { title: "核查", brief: "b", createdBy: "user" });
    published = [];
    logs = [];
  });
  afterEach(() => db.close());

  const judgeWith = (model: SmartModel | null, deadlineMs?: number) => createTicketReplyActionsJudge({
    db, smartModel: () => model, publish: (event) => { published.push(event); }, log: (line) => logs.push(line),
    ...(deadlineMs ? { deadlineMs } : {}),
  });
  const recorded = () => listEvents(db, { kind: "ticket_agent.reply_actions" });

  it("records the actions as a record-level event and tells the clients", async () => {
    const judge = judgeWith(stubModel({ request_review: 0.9 }).model);
    judge.judge({ turnId: "turn_1", itemId, text: "要我派发核查吗？" });
    await judge.idle();
    expect(recorded()).toEqual([expect.objectContaining({
      source: "ticket", entityKey: `ticket:${itemId}`, level: "record", disposition: "handled_by_rule",
      payload: { turnId: "turn_1", itemId, actions: ["request_review"], backend: "jev" },
    })]);
    expect(ticketReplyActionsByTurn(db, ["turn_1", "turn_2"])).toEqual(new Map([["turn_1", ["request_review"]]]));
    expect(published).toEqual([expect.objectContaining({
      type: "snapshot.required", requiredScope: "chat", itemId,
      payload: { resource: TICKET_REPLY_ACTIONS_RESOURCE, ticketId: itemId, turnId: "turn_1" },
    })]);
  });

  it("records nothing and logs a line when the model fails", async () => {
    const judge = judgeWith(stubModel(() => Promise.reject(new Error(`jev 503 with ${TOKEN}`))).model);
    judge.judge({ turnId: "turn_1", itemId, text: "要我派发核查吗？" });
    await judge.idle();
    expect(recorded()).toEqual([]);
    expect(published).toEqual([]);
    expect(logs).toEqual([expect.stringContaining("no reply buttons")]);
    expect(logs.join("\n")).not.toContain(TOKEN);
  });

  it("records nothing and logs a line when there is no model", async () => {
    const judge = judgeWith(null);
    judge.judge({ turnId: "turn_1", itemId, text: "要我派发核查吗？" });
    await judge.idle();
    expect(recorded()).toEqual([]);
    expect(logs).toEqual([expect.stringContaining("no smart model")]);
  });

  it("gives up after its deadline", async () => {
    const hanging: SmartModel = {
      backend: "jev",
      decide: (_state, _questions, opts) => new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    };
    const judge = judgeWith(hanging, 20);
    judge.judge({ turnId: "turn_1", itemId, text: "要我派发核查吗？" });
    await judge.idle();
    expect(recorded()).toEqual([]);
    expect(logs).toEqual([expect.stringContaining("timed out after 20 ms")]);
  });

  it("stops: cancels what runs and judges nothing more", async () => {
    let started = 0;
    const hanging: SmartModel = {
      backend: "jev",
      decide: (_state, _questions, opts) => new Promise((_resolve, reject) => {
        started += 1;
        opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    };
    const judge = judgeWith(hanging);
    judge.judge({ turnId: "turn_1", itemId, text: "要我派发核查吗？" });
    await judge.stop();
    judge.judge({ turnId: "turn_2", itemId, text: "要我返工吗？" });
    await judge.idle();
    expect(started).toBe(1);
    expect(recorded()).toEqual([]);
    expect(logs).toEqual([expect.stringContaining("daemon is stopping")]);
  });

  it("does not wait for the model", () => {
    const { model, calls } = stubModel({ request_review: 0.9 });
    const judge = judgeWith(model);
    const started = Date.now();
    judge.judge({ turnId: "turn_1", itemId, text: "要我派发核查吗？" });
    // judge 同步返回；结果还没有落库。
    expect(Date.now() - started).toBeLessThan(50);
    expect(recorded()).toEqual([]);
    expect(calls).toHaveLength(1);
    return judge.idle();
  });
});

// 跑用例时用 Jev 重新打分（scripts/confidence-jev.ts）：问到的分数换掉假设值，问不成的项保持原样；
// 真实用例从库里只读地取原话、前几条消息、草稿和代查结果。
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { draftResult, readLiveCase, rescoreWithModel, type JevCase } from "../scripts/confidence-jev.js";
import type { SmartAnswer, SmartModel, SmartQuestion } from "../src/smart-model/types.js";

// 按问题名回答的替身。没写的：选择题选第一个、是否题 0.05、打分题第 0 档。
function model(answers: Record<string, number | string> = {}, fail: string[] = []): SmartModel {
  return {
    backend: "fake-jev",
    async decide(_state, questions, opts) {
      if (fail.includes(opts?.purpose ?? "")) throw new Error("boom");
      const result: Record<string, SmartAnswer> = {};
      for (const [name, question] of Object.entries(questions) as Array<[string, SmartQuestion]>) {
        const given = answers[name];
        if (question.type === "choice") {
          result[name] = { type: "choice", choice: typeof given === "string" ? given : question.options[0]!, confidence: 0.7, probabilities: {} };
        } else if (question.type === "yes_no") {
          result[name] = { type: "yes_no", probability: typeof given === "number" ? given : 0.05 };
        } else {
          result[name] = { type: "score", level: 0, label: question.levels[0]!, score: 0, confidence: 0.9, probabilities: [1] };
        }
      }
      return { answers: result as never, backend: "fake-jev", model: "jev-test", latencyMs: 1, fallbackFrom: null };
    },
  };
}

const CASE: JevCase = {
  message: "周五前能把接口文档给我吗？", recent: [], senderTrust: "colleague", laneLabel: "私信",
  result: draftResult("可以，周五前给你。"), reads: [],
};

describe("rescoreWithModel", () => {
  it("请求 A 和请求 B 的回答换成用例的分数", async () => {
    const answer = await rescoreWithModel(CASE, model({ needs_reply: 0.93, fulfills_request: 0.8, draft_commits: 0.9, topic_legal: 0.3 }));
    expect(answer.scores).toMatchObject({ needsReply: 0.93, askConfidence: 0.7, fulfills: 0.8, draftCommits: 0.9 });
    expect(answer.scores.topics).toEqual({ money: 0.05, personnel: 0.05, legal: 0.3, emotional: 0.05 });
    expect(Object.keys(answer.scores.sensitiveQueries!)).toHaveLength(6);
    expect(answer.answered).toEqual(expect.arrayContaining(["needsReply", "fulfills", "grounded", "draftCommits", "draftOvershares"]));
    expect(answer.errors).toEqual([]);
    // 意图按请求 A 认出的算。第 7 版问交接说明里的一句，替身选第一句「有人问我技术方案的细节」，推出的旧意图是咨询。
    expect(answer.intent).toEqual({ kind: "knowledge", closing: null });
  });

  it("问不成的请求不返回分数，并且记下原因", async () => {
    const answer = await rescoreWithModel(CASE, model({}, ["channel_reply_check"]));
    expect(answer.scores.needsReply).toBe(0.05);
    expect(answer.scores.fulfills).toBeUndefined();
    expect(answer.errors).toEqual([expect.stringContaining("请求 B")]);
  });

  it("没有正文时请求 A 不问", async () => {
    const answer = await rescoreWithModel({ ...CASE, message: "  " }, model());
    expect(answer.answered).not.toContain("needsReply");
    expect(answer.errors[0]).toContain("请求 A");
  });
});

describe("readLiveCase", () => {
  it("只读地取原话、前几条消息、草稿和代查结果", () => {
    const file = path.join(tempDir("plc-confidence-jev-"), "plc.db");
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE events (seq INTEGER PRIMARY KEY, entity_key TEXT, kind TEXT, payload TEXT);
      CREATE TABLE channel_cards (id INTEGER PRIMARY KEY, draft TEXT);
      CREATE TABLE channel_lookups (id INTEGER PRIMARY KEY, result TEXT, reads TEXT);`);
    const insert = db.prepare("INSERT INTO events (seq, entity_key, kind, payload) VALUES (?, ?, ?, ?)");
    insert.run(1, "lane:a", "slack.dm.received", JSON.stringify({ text: "前面一句" }));
    insert.run(2, "lane:a", "slack.self.reply", JSON.stringify({ text: "我回的一句" }));
    insert.run(3, "lane:b", "slack.dm.received", JSON.stringify({ text: "别的对话" }));
    insert.run(4, "lane:a", "slack.dm.received", JSON.stringify({ text: "帮我看看", laneLabel: "张伟的私信", sender: { trust: "colleague" } }));
    insert.run(5, "lane:a", "slack.dm.received", JSON.stringify({ text: "急" }));
    db.prepare("INSERT INTO channel_cards (id, draft) VALUES (?, ?)").run(1, JSON.stringify({ text: "好的" }));
    const result = { ...draftResult("评论链接"), review: { summary: "看过了", comments: [] } };
    db.prepare("INSERT INTO channel_lookups (id, result, reads) VALUES (?, ?, ?)").run(7, JSON.stringify(result), "[]");
    db.close();

    const live = readLiveCase(file, { seqs: [4, 5], cardId: 1 });
    expect(live).toMatchObject({
      message: "帮我看看\n急", senderTrust: "colleague", laneLabel: "张伟的私信",
      recent: [{ role: "them", text: "前面一句" }, { role: "me", text: "我回的一句" }],
    });
    expect(live.result.replyDraft).toBe("好的");
    expect(readLiveCase(file, { seqs: [4], cardId: 1, lookupId: 7 }).result.review?.summary).toBe("看过了");
    expect(() => readLiveCase(file, { seqs: [99], cardId: 1 })).toThrow();
  });
});

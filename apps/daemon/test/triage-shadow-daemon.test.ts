// Jev 分诊的影子模式走到 daemon 这一跳（Lead 事件主干 spec D12，工单 09）：轮询每一拍看一次，问 Jev 在后台进行。
//   - SmartModel 抛错或卡住时，轮询照常：别的步骤（叫醒 Lead）不受影响，影子分诊下一拍再试；
//   - SmartModel 好了以后，规则定不了的事件有了影子判断，事件自己的级别、分诊依据和处置不变；
//   - 停机时正在进行的调用被取消，daemon 照常关掉；
//   - 每次调用照常写 decision_model.called（工单 13，用途 triage_shadow），进 get_system_usage 的统计；这些事件不再被问。
// SmartModel 用替身，不连 Jev 或 LLM。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { addInbox, createItem, openDb, summarizeSystemUsage, transition, type Db } from "@pi-lead-child/store";
import {
  SmartModelBackendError, TRIAGE_SHADOW_PURPOSE,
  type SmartAnswer, type SmartDecideOptions, type SmartModel, type SmartQuestionSet,
} from "@pi-lead-child/engine";
import { startDaemon } from "../src/server.js";
import { startTriageShadow } from "../src/triage-shadow.js";

let dir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  dir = tempDir("plc-triage-shadow-daemon-");
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
});

afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
});

function stubLead(prompts: string[]) {
  return async () => ({
    modelName: "stub/model",
    session: {
      sessionId: "stub-session",
      subscribe() { return () => {}; },
      async prompt(text: string) { prompts.push(text); },
      async steer() {},
      async followUp() {},
      dispose() {},
    },
  });
}

function answersFor(questions: SmartQuestionSet): Record<string, SmartAnswer> {
  const answers: Record<string, SmartAnswer> = {};
  for (const [name, question] of Object.entries(questions)) {
    if (question.type === "choice") {
      const choice = name === "importance" ? "digest" : question.options[question.options.length - 1]!;
      const rest = 0.2 / (question.options.length - 1);
      answers[name] = {
        type: "choice", choice, confidence: 0.7,
        probabilities: Object.fromEntries(question.options.map((option) => [option, option === choice ? 0.8 : rest])),
      };
    } else if (question.type === "score") {
      answers[name] = {
        type: "score", level: 1, label: question.levels[1]!, score: 1, confidence: 1,
        probabilities: question.levels.map((_level, index) => (index === 1 ? 1 : 0)),
      };
    } else {
      answers[name] = { type: "yes_no", probability: 0.3 };
    }
  }
  return answers;
}

// mode：throw 报 503；hang 永远不回；answer 正常回答。
function fakeJev() {
  let mode: "throw" | "hang" | "answer" = "throw";
  const calls: SmartDecideOptions[] = [];
  const model: SmartModel = {
    backend: "fake-jev",
    async decide(_state, questions, opts = {}) {
      calls.push(opts);
      if (mode === "throw") throw new SmartModelBackendError("fake-jev", "fake-jev: 503 service unavailable", "http", 503);
      if (mode === "hang") return new Promise(() => {});
      return { answers: answersFor(questions) as never, backend: "fake-jev", model: "jev-test", latencyMs: 2, fallbackFrom: null };
    },
  };
  return { model, calls, set: (next: typeof mode) => { mode = next; } };
}

const facts = (target: Db) => target.prepare(
  "SELECT seq, kind, level, triage, disposition, disposition_detail FROM events WHERE kind = 'stage.changed' ORDER BY seq",
).all();

describe("the shadow triage step in the daemon's poller", () => {
  it("keeps the other steps running while the SmartModel fails or hangs, then records judgments once it answers", async () => {
    const itemId = createItem(db, { title: "修登录页", brief: "b", createdBy: "user" });
    transition(db, { itemId, to: "active", actor: "system", reason: "spawn" });
    const stageEvents = facts(db);
    expect(stageEvents.length).toBeGreaterThan(0);
    const jev = fakeJev();
    const prompts: string[] = [];
    const logs: string[] = [];
    const daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: stubLead(prompts) as never, notifyDesktop: () => {},
      log: (line) => { logs.push(line); },
      triageShadow: { smartModel: jev.model, retryBaseMs: 0, idleIntervalMs: 0, timeoutMs: 50 },
    });
    try {
      // SmartModel 报错：这一批跳过，记一行日志，下一拍再试。
      await vi.waitFor(() => expect(jev.calls.length).toBeGreaterThanOrEqual(2), { timeout: 5_000 });
      expect(jev.calls.every((opts) => opts.purpose === TRIAGE_SHADOW_PURPOSE)).toBe(true);
      expect(logs.filter((line) => line.includes("[triage-shadow] skipped a batch"))).toHaveLength(1);
      // SmartModel 卡住：每次调用到超时就放弃。轮询的别的步骤照常：新的 blocker 照样叫醒 Lead。
      jev.set("hang");
      const callsBefore = jev.calls.length;
      addInbox(db, { dedupScope: "shadow-test", severity: "blocker", source: "structural", summary: "工单 #9 执行失败" });
      await vi.waitFor(() => expect(prompts.some((text) => text.includes("工单 #9 执行失败"))).toBe(true), { timeout: 5_000 });
      await vi.waitFor(() => expect(jev.calls.length).toBeGreaterThan(callsBefore + 1), { timeout: 5_000 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM event_triage_shadow").get()).toEqual({ n: 0 });

      // SmartModel 好了：规则定不了的事件有了影子判断，事件本身不变。
      jev.set("answer");
      await vi.waitFor(() => {
        const judged = db.prepare("SELECT seq FROM event_triage_shadow ORDER BY seq").all() as Array<{ seq: number }>;
        expect(judged.map((row) => row.seq)).toEqual(expect.arrayContaining(stageEvents.map((row) => (row as { seq: number }).seq)));
      }, { timeout: 5_000 });
      expect(db.prepare("SELECT DISTINCT level FROM event_triage_shadow").all()).toEqual([{ level: "digest" }]);
      expect(facts(db)).toEqual(stageEvents);
      // blocker 自己有指令（inbox.wake_lead），不问。
      expect(db.prepare(
        "SELECT COUNT(*) AS n FROM event_triage_shadow s JOIN events e ON e.seq = s.seq WHERE e.kind LIKE 'inbox.%'",
      ).get()).toEqual({ n: 0 });
    } finally {
      jev.set("hang");
      transition(db, { itemId, to: "review", actor: "system", reason: "delivered" });
      // 停机时正在进行（或者下一拍要开始）的调用被取消，不挡住关机。
      const started = Date.now();
      await daemon.close();
      expect(Date.now() - started).toBeLessThan(5_000);
    }
  });

  it("does nothing without a decision model", async () => {
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "user" });
    transition(db, { itemId, to: "active", actor: "system", reason: "spawn" });
    const daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: stubLead([]) as never, notifyDesktop: () => {}, log: () => {},
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(db.prepare("SELECT COUNT(*) AS n FROM event_triage_shadow").get()).toEqual({ n: 0 });
    } finally {
      await daemon.close();
    }
  });
});

describe("the daemon's shadow SmartModel", () => {
  const usage = () => summarizeSystemUsage(db, { component: "decision_model" }).components[0]!;

  it("records every call as decision_model.called with the purpose triage_shadow, and never asks about those events", async () => {
    const itemId = createItem(db, { title: "修登录页", brief: "b", createdBy: "user" });
    transition(db, { itemId, to: "active", actor: "system", reason: "spawn" });
    const jev = fakeJev();
    jev.set("answer");
    const shadow = startTriageShadow({
      db, dataDir: dir, decisionModel: null, log: () => {},
      options: { smartModel: jev.model, retryBaseMs: 0, idleIntervalMs: 0, timeoutMs: 50 },
    })!;

    const first = await shadow.runBatch();
    expect(first.status).toBe("done");
    expect(first.judged.length).toBeGreaterThan(0);
    expect(usage()).toMatchObject({
      calls: first.judged.length, failures: 0,
      byPurpose: [{ name: "triage_shadow", calls: first.judged.length, failures: 0 }],
      byBackend: [{ name: "fake-jev", calls: first.judged.length, failures: 0 }],
    });

    // 失败的调用也进统计。
    transition(db, { itemId, to: "review", actor: "system", reason: "delivered" });
    jev.set("throw");
    expect(await shadow.runBatch()).toMatchObject({ status: "failed" });
    expect(usage()).toMatchObject({ calls: first.judged.length + 1, failures: 1 });

    // 下一批只问那个 stage.changed：decision_model.called 写入时就有处置，不是候选。
    jev.set("answer");
    const second = await shadow.runBatch();
    expect(second).toMatchObject({ status: "done" });
    expect(second.judged).toHaveLength(1);
    expect(db.prepare(
      `SELECT DISTINCT e.kind FROM event_triage_shadow s JOIN events e ON e.seq = s.seq ORDER BY e.kind`,
    ).all()).toEqual([{ kind: "stage.changed" }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'decision_model.called' AND disposition = 'handled_by_rule'").get())
      .toEqual({ n: usage().calls });
    await shadow.stop();
  });
});

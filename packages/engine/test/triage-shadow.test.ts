// Jev 分诊的影子模式（Lead 事件主干 spec D12，工单 09）：批处理。SmartModel 用替身，不连 Jev 或 LLM。
//   - 对照测试：同一组事件分别在有、没有影子分诊时运行，事件的级别、分诊依据和处置完全一样；
//   - SmartModel 抛错、超时、不可用时，这一批跳过，游标不动，下一拍再试；tick 不阻塞；
//   - 送出去的文字只有类型、来源、对象键、根因代码和摘要，经过脱敏；决策日志的用途是 triage_shadow；
//   - 问题集：五个级别、要不要 Lead 推理、常设指令允许的动作加「不能」、风险分档。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import type { EventEnvelope } from "@pi-lead-child/protocol";
import {
  addInbox, appendEvent, createItem, createRun, escalateOverdueEvents, getTriageShadowCursor, getTriageShadowJudgment,
  openDb, recordInboxDisposition, setEventDisposition, setTriageShadowCursor, transition, updateRun,
  type Db, type EventRecord,
} from "@pi-lead-child/store";
import {
  createTriageShadowRunner, SmartModelBackendError, SmartModelInputError, TRIAGE_SHADOW_NO_ACTION, TRIAGE_SHADOW_PURPOSE,
  triageShadowQuestions, triageShadowActionOrders, withDecisionLog,
  type ChoiceQuestion, type ScoreQuestion, type SmartAnswer, type SmartDecideOptions, type SmartModel, type SmartQuestionSet, type TriageShadowRunnerOptions,
} from "../src/index.js";

let db: Db;
beforeEach(() => {
  db = openDb(join(tempDir("plc-triage-shadow-run-"), "plc.db"));
  // 从日志开头看起（缺省也是 0；写明是为了读得懂）。
  setTriageShadowCursor(db, 0);
});

type Mode = "answer" | "throw" | "hang" | "input";

interface Call { state: string; questions: SmartQuestionSet; opts: SmartDecideOptions }

// 合法的回答：每个问题按它的类型和选项回答。摘要里有「失败」的事件判成 tell、要 Lead，其余判成 record。
function answersFor(state: string, questions: SmartQuestionSet): Record<string, SmartAnswer> {
  const alarming = state.includes("失败");
  const answers: Record<string, SmartAnswer> = {};
  for (const [name, question] of Object.entries(questions)) {
    if (question.type === "choice") {
      const choice = name === "importance" ? (alarming ? "tell" : "record") : question.options[question.options.length - 1]!;
      const rest = (1 - 0.8) / (question.options.length - 1);
      answers[name] = {
        type: "choice", choice, confidence: 0.7,
        probabilities: Object.fromEntries(question.options.map((option) => [option, option === choice ? 0.8 : rest])),
      };
    } else if (question.type === "score") {
      const probabilities = question.levels.map((_level, index) => (index === 0 ? 1 : 0));
      answers[name] = { type: "score", level: 0, label: question.levels[0]!, score: 0, confidence: 1, probabilities };
    } else {
      answers[name] = { type: "yes_no", probability: alarming ? 0.9 : 0.1 };
    }
  }
  return answers;
}

function fakeModel(mode: () => Mode = () => "answer"): { model: SmartModel; calls: Call[] } {
  const calls: Call[] = [];
  const model: SmartModel = {
    backend: "fake",
    async decide(state, questions, opts = {}) {
      calls.push({ state, questions, opts });
      const now = mode();
      if (now === "throw") throw new SmartModelBackendError("fake", "fake: 503 service unavailable", "http", 503);
      if (now === "input") throw new SmartModelInputError("state is longer than 32000 characters");
      if (now === "hang") return new Promise(() => {});
      return { answers: answersFor(state, questions) as never, backend: "fake", model: "fake-1", latencyMs: 3, fallbackFrom: null };
    },
  };
  return { model, calls };
}

const runner = (model: SmartModel | null, extra: Partial<TriageShadowRunnerOptions> = {}) =>
  createTriageShadowRunner({ db, smartModel: () => model, retryBaseMs: 0, idleIntervalMs: 0, ...extra });

const append = (target: Db, envelope: EventEnvelope): EventRecord =>
  target.transaction(() => appendEvent(target, envelope).event)();

const checkpoint = (title: string, summary: string, itemId = 1): EventEnvelope => ({
  source: "ticket",
  kind: "checkpoint.recorded",
  entityKey: `ticket:${itemId}`,
  payload: {
    checkpointId: 1, itemId, runId: null, checkpointKind: "progress", checkpointSource: "agent_reported",
    title, summary, nextStep: "继续",
  },
});

const shadowRows = (target: Db) => target.prepare("SELECT seq, level, needs_lead, auto_action, risk, error FROM event_triage_shadow ORDER BY seq").all();

describe("a shadow batch", () => {
  it("asks the fixed questions about each rule-undecided event and records the judgment beside it", async () => {
    const itemId = createItem(db, { title: "修登录页", brief: "b", createdBy: "user" });
    transition(db, { itemId, to: "active", actor: "system", reason: "spawn" });
    append(db, checkpoint("单元测试", "跑完了单元测试"));
    append(db, checkpoint("集成测试", "集成测试失败了"));
    // 有自己指令的事件（inbox.no_wake）不问。
    addInbox(db, { itemId, severity: "attention", source: "structural", summary: "进展" });
    const { model, calls } = fakeModel();

    const batch = await runner(model).runBatch();
    expect(batch).toMatchObject({ status: "done", more: false });
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.opts.purpose === TRIAGE_SHADOW_PURPOSE)).toBe(true);
    expect(calls.every((call) => call.opts.signal instanceof AbortSignal && typeof call.opts.timeoutMs === "number")).toBe(true);
    // 问题集：五个级别（没有 conversation）、要不要 Lead 推理、常设指令允许的动作加「不能」、风险分档。
    const questions = calls[0]!.questions;
    expect(Object.keys(questions).sort()).toEqual(["auto_action", "importance", "needs_lead", "risk"]);
    expect(questions.importance).toMatchObject({ type: "choice", options: ["record", "digest", "auto", "tell", "interrupt"] });
    expect(questions.needs_lead).toMatchObject({ type: "yes_no" });
    expect(questions.risk).toMatchObject({ type: "score" });
    expect((questions.risk as ScoreQuestion).levels.map((level) => level.split(":")[0])).toEqual(["low", "medium", "high"]);
    expect(questions.auto_action).toMatchObject({ type: "choice" });
    const actions = (questions.auto_action as ChoiceQuestion).options;
    expect(actions).toEqual(expect.arrayContaining(["run.transient_retry", "events.merge_root_cause", TRIAGE_SHADOW_NO_ACTION]));
    expect(actions).not.toContain("inbox.wake_lead");
    expect(actions).not.toContain("source.ticket");

    expect(shadowRows(db)).toEqual([
      { seq: batch.judged[0], level: "record", needs_lead: 0.1, auto_action: null, risk: "low", error: null },
      { seq: batch.judged[1], level: "record", needs_lead: 0.1, auto_action: null, risk: "low", error: null },
      { seq: batch.judged[2], level: "tell", needs_lead: 0.9, auto_action: null, risk: "low", error: null },
    ]);
    const judgment = getTriageShadowJudgment(db, batch.judged[2]!)!;
    expect(judgment).toMatchObject({ mode: "shadow", backend: "fake", model: "fake-1", questionVersion: 1 });
    expect(judgment.actionOptions).toEqual(triageShadowActionOrders(db).map((order) => ({ id: order.id, version: order.version })));
    // 游标走到了日志末尾（包括后面那条不用问的 inbox 事件）。
    const { v } = db.prepare("SELECT MAX(seq) AS v FROM events").get() as { v: number };
    expect(getTriageShadowCursor(db)).toBe(v);
    // 再跑一批：没有要问的。
    expect(await runner(model).runBatch()).toMatchObject({ status: "idle" });
    expect(calls).toHaveLength(3);
  });

  it("stops at the batch size, and the next batch continues from the cursor", async () => {
    for (let i = 0; i < 5; i++) append(db, checkpoint(`第 ${i} 步`, "进展"));
    const { model, calls } = fakeModel();
    const run = runner(model, { batchSize: 2 });
    expect(await run.runBatch()).toMatchObject({ status: "done", more: true });
    expect(calls).toHaveLength(2);
    await run.runBatch();
    await run.runBatch();
    expect(calls).toHaveLength(5);
    expect(shadowRows(db)).toHaveLength(5);
  });
});

describe("extra questions for some events (ticket 11)", () => {
  it("asks them after the fixed ones, keeps the fixed questions when names clash, and records every answer", async () => {
    append(db, checkpoint("要加问的", "第一件"));
    append(db, checkpoint("不加问的", "第二件"));
    const { model, calls } = fakeModel();
    const extra = (event: EventRecord) => event.payload.title === "要加问的"
      ? {
        reply_category: { type: "choice" as const, prompt: "Which kind?", options: ["acknowledgement", "other"] },
        // 和固定的问题重名：不加，照常问固定的那一个。
        risk: { type: "yes_no" as const, prompt: "Overridden?" },
      }
      : null;
    const batch = await runner(model, { extraQuestions: extra }).runBatch();
    expect(batch.status).toBe("done");
    expect(Object.keys(calls[0]!.questions).sort()).toEqual(["auto_action", "importance", "needs_lead", "reply_category", "risk"]);
    expect(calls[0]!.questions.risk).toMatchObject({ type: "score" });
    expect(Object.keys(calls[1]!.questions).sort()).toEqual(["auto_action", "importance", "needs_lead", "risk"]);
    expect(getTriageShadowJudgment(db, batch.judged[0]!)!.answers).toHaveProperty("reply_category.choice", "other");
  });

  it("asks the fixed questions when the extra ones throw", async () => {
    append(db, checkpoint("一件事", "进展"));
    const { model, calls } = fakeModel();
    const logs: string[] = [];
    await runner(model, { extraQuestions: () => { throw new Error("boom"); }, log: (line) => logs.push(line) }).runBatch();
    expect(Object.keys(calls[0]!.questions).sort()).toEqual(["auto_action", "importance", "needs_lead", "risk"]);
    expect(logs.join("\n")).toContain("extra questions");
  });
});

describe("shadow mode only records", () => {
  // 同一组写入分别在两个库里跑：一个库在每一步之间跑影子分诊，另一个不跑。
  async function play(target: Db, between: () => Promise<void>): Promise<void> {
    const itemId = createItem(target, { title: "修登录页", brief: "b", createdBy: "user" });
    transition(target, { itemId, to: "active", actor: "system", reason: "spawn" });
    const runId = createRun(target, { itemId });
    updateRun(target, runId, { state: "running" });
    append(target, checkpoint("集成测试", "集成测试失败了", itemId));
    await between();
    const blocker = addInbox(target, { itemId, severity: "blocker", source: "structural", summary: "Run 失败了" });
    addInbox(target, { itemId, dedupScope: "progress", severity: "attention", source: "structural", summary: "进展" });
    append(target, {
      source: "run", kind: "run.failed", entityKey: `run:${runId}`,
      rootCause: { code: "provider_overloaded", scope: "runtime" },
      payload: { runId, itemId, role: "executor", purpose: "work", runtime: "claude", from: "running", to: "failed" },
    });
    await between();
    recordInboxDisposition(target, [blocker.id!], { disposition: "handled", reason: "换了模型再跑" });
    // 30 分钟没有处置的 digest 升一级。
    escalateOverdueEvents(target, new Date(Date.now() + 2 * 60 * 60_000));
    await between();
    // Lead 给一个规则定不了的事件记了处置。
    const stage = target.prepare("SELECT seq FROM events WHERE kind = 'stage.changed' ORDER BY seq LIMIT 1").get() as { seq: number };
    setEventDisposition(target, stage.seq, "no_action", { reason: "例行的进展" });
    transition(target, { itemId, to: "review", actor: "system", reason: "delivered" });
    await between();
  }

  // 比较时去掉随机的编号和时间：event_id、occurred_at、received_at、disposed_at，以及抄了它们的字段。
  const facts = (target: Db) => (target.prepare(
    `SELECT seq, source, source_ref, kind, entity_key, entity_version, correlation_id, payload, root_cause,
            level, triage, disposition, disposition_detail
     FROM events ORDER BY seq`,
  ).all() as Array<Record<string, unknown>>).map((row) => {
    const payload = JSON.parse(row.payload as string) as Record<string, unknown>;
    delete payload.escalatedEventId;
    delete payload.waitedMs;
    return { ...row, payload };
  });

  it("leaves every event's level, triage basis and disposition exactly as without it", async () => {
    const plain = openDb(join(tempDir("plc-triage-shadow-plain-"), "plc.db"));
    await play(plain, async () => {});

    const { model, calls } = fakeModel();
    const shadow = runner(model);
    await play(db, async () => {
      await shadow.runBatch();
    });

    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(shadowRows(db).length).toBe(calls.length);
    expect(shadowRows(plain)).toEqual([]);
    expect(facts(db)).toEqual(facts(plain));
    // 影子判断里有和实际不同的级别（tell 对 record），实际级别没有被它改掉。
    expect(shadowRows(db).some((row) => (row as { level: string }).level === "tell")).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE level = 'tell' AND kind = 'checkpoint.recorded'").get()).toEqual({ n: 0 });
    plain.close();
  });
});

describe("when the SmartModel fails", () => {
  it("skips the batch without moving the cursor, and the next batch asks again", async () => {
    const event = append(db, checkpoint("集成测试", "集成测试失败了"));
    let mode: Mode = "throw";
    const { model, calls } = fakeModel(() => mode);
    const logs: string[] = [];
    const run = runner(model, { log: (line) => logs.push(line) });

    const failed = await run.runBatch();
    expect(failed).toMatchObject({ status: "failed", judged: [], cursor: 0 });
    expect(failed.error).toContain("503");
    expect(getTriageShadowCursor(db)).toBe(0);
    expect(shadowRows(db)).toEqual([]);
    expect(logs).toEqual([expect.stringContaining("skipped a batch")]);

    mode = "answer";
    expect(await run.runBatch()).toMatchObject({ status: "done", judged: [event.seq] });
    expect(calls).toHaveLength(2);
    expect(logs.at(-1)).toContain("recovered");
  });

  it("gives up waiting at the timeout, and tick never waits for the call", async () => {
    append(db, checkpoint("集成测试", "集成测试失败了"));
    let mode: Mode = "hang";
    const { model, calls } = fakeModel(() => mode);
    const run = runner(model, { timeoutMs: 30 });

    const started = Date.now();
    run.tick();
    // tick 同步返回：调用已经发出，还没有结果。
    expect(calls).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(25);
    // 正在跑的这一批没结束时，再 tick 也不开第二批。
    run.tick();
    expect(calls).toHaveLength(1);
    await run.idle();
    expect(shadowRows(db)).toEqual([]);
    expect(getTriageShadowCursor(db)).toBe(0);

    mode = "answer";
    run.tick();
    await run.idle();
    expect(calls).toHaveLength(2);
    expect(shadowRows(db)).toHaveLength(1);
  });

  it("waits longer after each failure before ticking again, up to the limit", async () => {
    append(db, checkpoint("集成测试", "集成测试失败了"));
    const { model, calls } = fakeModel(() => "throw");
    const run = runner(model, { retryBaseMs: 60_000 });
    run.tick();
    await run.idle();
    expect(calls).toHaveLength(1);
    // 下一次要等 retryBaseMs：这一拍不再问。
    run.tick();
    await run.idle();
    expect(calls).toHaveLength(1);
  });

  it("stops within the batch's time budget", async () => {
    for (let i = 0; i < 3; i++) append(db, checkpoint(`第 ${i} 步`, "进展"));
    const { model, calls } = fakeModel(() => "hang");
    const run = runner(model, { timeoutMs: 5_000, budgetMs: 40 });
    const started = Date.now();
    expect(await run.runBatch()).toMatchObject({ status: "failed" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(calls).toHaveLength(1);
  });

  it("records an event it cannot ask about once, and moves on", async () => {
    const first = append(db, checkpoint("集成测试", "集成测试失败了"));
    const second = append(db, checkpoint("单元测试", "跑完了单元测试"));
    let calls = 0;
    const { model } = fakeModel(() => (calls++ === 0 ? "input" : "answer"));
    expect(await runner(model).runBatch()).toMatchObject({ status: "done", judged: [first.seq, second.seq] });
    expect(getTriageShadowJudgment(db, first.seq)).toMatchObject({ level: null, answers: null, error: expect.stringContaining("32000") });
    expect(getTriageShadowJudgment(db, second.seq)).toMatchObject({ level: "record", error: null });
  });

  it("does nothing while no SmartModel is available", async () => {
    append(db, checkpoint("集成测试", "集成测试失败了"));
    const none: SmartModel = { backend: "none", decide: () => Promise.reject(new Error("must not be called")) };
    expect(await runner(none).runBatch()).toMatchObject({ status: "unavailable" });
    expect(await runner(null).runBatch()).toMatchObject({ status: "unavailable" });
    expect(shadowRows(db)).toEqual([]);
    expect(getTriageShadowCursor(db)).toBe(0);
  });

  it("cancels the call in flight when it stops", async () => {
    append(db, checkpoint("集成测试", "集成测试失败了"));
    const { model, calls } = fakeModel(() => "hang");
    const run = runner(model, { timeoutMs: 60_000 });
    const batch = run.runBatch();
    await run.stop();
    expect(await batch).toMatchObject({ status: "stopped" });
    run.tick();
    expect(calls).toHaveLength(1);
  });
});

describe("what the SmartModel sees", () => {
  const TOKEN = "ghp_0123456789abcdefghijABCDEFGHIJ012345";

  it("only the kind, source, entity, root cause code and summary, redacted", async () => {
    append(db, checkpoint("推送失败", `git push 失败：remote 拒绝了 token ${TOKEN}，password=hunter2-secret`));
    append(db, {
      source: "run", kind: "run.failed", entityKey: "run:91",
      rootCause: { code: "auth_expired", scope: "account", message: `the provider rejected key sk-ant-api03-${"x".repeat(24)}` },
      payload: { runId: 91, itemId: 7, role: "executor", purpose: "work", runtime: "claude", from: "running", to: "failed" },
    });
    const logPath = join(tempDir("plc-triage-shadow-log-"), "decisions.jsonl");
    const { model, calls } = fakeModel();
    await runner(withDecisionLog(model, { path: logPath })).runBatch();

    expect(calls).toHaveLength(2);
    const [push, failed] = calls.map((call) => call.state);
    expect(push).toContain("Event kind: checkpoint.recorded");
    expect(push).toContain("Source: ticket");
    expect(push).toContain("Entity: ticket:1");
    expect(push).toContain("Root cause code: none");
    expect(push).toContain("推送失败");
    expect(push).toContain("[REDACTED]");
    expect(push).not.toContain(TOKEN);
    expect(push).not.toContain("hunter2-secret");
    // 只有这几项：payload 的别的字段（checkpointSource、nextStep）不送出去。
    expect(push.split("\n").map((line) => line.split(":")[0])).toEqual(["Event kind", "Source", "Entity", "Root cause code", "Summary"]);
    expect(push).not.toContain("agent_reported");
    expect(push).not.toContain("继续");
    expect(failed).toContain("Root cause code: auth_expired");
    expect(failed).toContain("running → failed");
    // 根因的 message 不送出去，只送代码。
    expect(failed).not.toContain("sk-ant");
    expect(failed).not.toContain("the provider rejected key");

    // 决策日志按用途 triage_shadow 记了两行，里面没有 state 原文。
    const lines = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { purpose: string });
    expect(lines.map((line) => line.purpose)).toEqual([TRIAGE_SHADOW_PURPOSE, TRIAGE_SHADOW_PURPOSE]);
    expect(readFileSync(logPath, "utf8")).not.toContain(TOKEN);
  });

  it("offers the standing orders' actions as they are now", () => {
    const questions = triageShadowQuestions(triageShadowActionOrders(db));
    const autoAction = questions.auto_action as ChoiceQuestion;
    expect(autoAction.options.at(-1)).toBe(TRIAGE_SHADOW_NO_ACTION);
    expect(autoAction.descriptions?.["run.transient_retry"]).toContain("重试");
    // 没有允许的动作时不问这一题（选择题至少两个选项）。
    expect(Object.keys(triageShadowQuestions([])).sort()).toEqual(["importance", "needs_lead", "risk"]);
  });
});

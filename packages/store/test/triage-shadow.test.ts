// Jev 分诊的影子判断（工单 09）：一致率的纯函数、批处理的候选事件、对照报告、启用开关。
// 批处理本身（问 SmartModel、超时、脱敏、对照测试）在 packages/engine/test/triage-shadow.test.ts。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { type EventEnvelope, type StandingOrderDefinition } from "@pi-lead-child/protocol";
import {
  addInbox, appendEvent, computeTriageShadowReport, getTriageShadowCursor, isJevTriageEnabled, jevTriageSwitch,
  listTriageShadowCandidates, openDb, recordDecisionModelCall, recordMemoryRecall, recordStandingOrderVersion,
  recordTriageShadowJudgment, setEventDisposition, setTriageShadowCursor, SYSTEM_STANDING_ORDERS, triageShadowReport,
  type Db, type EventRecord, type TriageShadowComparison, type TriageShadowJudgmentInput,
} from "../src/index.js";

let db: Db;
beforeEach(() => {
  db = openDb(join(tempDir("plc-triage-shadow-"), "plc.db"));
});

const append = (envelope: EventEnvelope, options: { receivedAt?: Date } = {}): EventRecord =>
  db.transaction(() => appendEvent(db, envelope, options).event)();

const checkpoint = (summary: string, itemId = 1): EventEnvelope => ({
  source: "ticket",
  kind: "checkpoint.recorded",
  entityKey: `ticket:${itemId}`,
  payload: {
    checkpointId: 1, itemId, runId: null, checkpointKind: "progress", checkpointSource: "agent_reported",
    title: "进展", summary,
  },
});

const judgment = (event: EventRecord, extra: Partial<TriageShadowJudgmentInput> = {}): TriageShadowJudgmentInput => ({
  seq: event.seq, eventId: event.eventId, questionVersion: 1, backend: "fake", model: null, latencyMs: 5,
  level: "record", levelConfidence: 0.9, needsLead: 0.2, autoAction: null, autoActionConfidence: 0.5,
  risk: "low", riskScore: 0.1, actionOptions: [], answers: {}, error: null, ...extra,
});

describe("computeTriageShadowReport", () => {
  const row = (extra: Partial<TriageShadowComparison>): TriageShadowComparison => ({
    seq: 1, kind: "run.started", actualLevel: "record", disposition: null, shadowLevel: "record", needsLead: 0.1,
    error: null, ...extra,
  });

  it("gives the level agreement by event kind and in total", () => {
    const report = computeTriageShadowReport([
      row({ kind: "stage.changed", shadowLevel: "record" }),
      row({ kind: "stage.changed", shadowLevel: "digest" }),
      row({ kind: "stage.changed", shadowLevel: "record" }),
      row({ kind: "run.started", shadowLevel: "tell" }),
    ]);
    expect(report.kinds.map((kind) => kind.kind)).toEqual(["run.started", "stage.changed"]);
    const stage = report.kinds.find((kind) => kind.kind === "stage.changed")!;
    expect(stage.level).toEqual({ compared: 3, agreed: 2, rate: 0.667 });
    expect(stage.shadowLevels).toEqual({ record: 2, digest: 1 });
    expect(stage.actualLevels).toEqual({ record: 3 });
    expect(report.kinds.find((kind) => kind.kind === "run.started")!.level).toEqual({ compared: 1, agreed: 0, rate: 0 });
    expect(report.total.level).toEqual({ compared: 4, agreed: 2, rate: 0.5 });
    expect(report.total.judged).toBe(4);
  });

  it("compares 'needs Lead' only on events Lead itself disposed of", () => {
    const report = computeTriageShadowReport([
      // Lead 处理了、告诉用户了、延后了：要 Lead 推理。
      row({ disposition: "handled", needsLead: 0.9 }),
      row({ disposition: "told_user", needsLead: 0.2 }),
      row({ disposition: "deferred", needsLead: 0.5 }),
      // Lead 判断不用管：不要。
      row({ disposition: "no_action", needsLead: 0.1 }),
      row({ disposition: "no_action", needsLead: 0.7 }),
      // 系统记的处置、回合后补记的「看过了」、没有处置：不比较。
      row({ disposition: "seen", needsLead: 0.9 }),
      row({ disposition: "superseded", needsLead: 0.9 }),
      row({ disposition: "digested", needsLead: 0.9 }),
      row({ disposition: null, needsLead: 0.9 }),
    ]);
    // 0.5 算「要」：handled、deferred、no_action(0.1) 一致；told_user(0.2)、no_action(0.7) 不一致。
    expect(report.total.needsLead).toEqual({ compared: 5, agreed: 3, rate: 0.6 });
    expect(report.total.level.compared).toBe(9);
    expect(computeTriageShadowReport([row({ disposition: "deferred", needsLead: 0.5 })], { needsLeadThreshold: 0.6 })
      .total.needsLead).toEqual({ compared: 1, agreed: 0, rate: 0 });
  });

  it("counts judgments that could not be made apart, and has no rate when nothing could be compared", () => {
    const report = computeTriageShadowReport([
      row({ shadowLevel: null, needsLead: null, error: "state is too long" }),
      row({ actualLevel: null }),
    ]);
    expect(report.total).toMatchObject({ judged: 1, failed: 1 });
    expect(report.total.level).toEqual({ compared: 0, agreed: 0, rate: null });
    expect(report.total.needsLead).toEqual({ compared: 0, agreed: 0, rate: null });
    expect(computeTriageShadowReport([])).toEqual({
      total: {
        judged: 0, failed: 0, level: { compared: 0, agreed: 0, rate: null }, needsLead: { compared: 0, agreed: 0, rate: null },
        shadowLevels: {}, actualLevels: {},
      },
      kinds: [],
    });
  });
});

describe("the candidates of a shadow batch", () => {
  const recent = () => new Date(Date.now() - 60 * 60_000);

  it("are the events whose level came from the source's default order and have no judgment yet", () => {
    const fromDefault = append(checkpoint("跑完了单元测试"));
    expect(fromDefault.triage?.order?.id).toBe("source.ticket");
    // 有自己的指令：inbox.no_wake。
    addInbox(db, { dedupScope: "progress", severity: "attention", source: "structural", summary: "进展" });
    // 用户的消息不分诊。
    append({ source: "user", kind: "user.message", entityKey: "chat:main", payload: { turnId: "t1", originKind: "user", text: "你好" } });
    // 写入方自己给了级别：依据是 null。
    append({ ...checkpoint("写入方定的级别"), level: "digest" });
    const judged = append(checkpoint("已经问过"));
    recordTriageShadowJudgment(db, judgment(judged));
    const later = append(checkpoint("后来的一条"));

    const { events, highWater } = listTriageShadowCandidates(db, { afterSeq: 0, limit: 10, receivedSince: recent() });
    expect(events.map((event) => event.seq)).toEqual([fromDefault.seq, later.seq]);
    expect(highWater).toBe(later.seq);
    expect(listTriageShadowCandidates(db, { afterSeq: fromDefault.seq, limit: 10, receivedSince: recent() }).events
      .map((event) => event.seq)).toEqual([later.seq]);
    expect(listTriageShadowCandidates(db, { afterSeq: 0, limit: 1, receivedSince: recent() }).events
      .map((event) => event.seq)).toEqual([fromDefault.seq]);
  });

  it("skip events received before the age limit", () => {
    append(checkpoint("很久以前"), { receivedAt: new Date(Date.now() - 3 * 24 * 60 * 60_000) });
    const fresh = append(checkpoint("刚才"));
    expect(listTriageShadowCandidates(db, { afterSeq: 0, limit: 10, receivedSince: recent() }).events
      .map((event) => event.seq)).toEqual([fresh.seq]);
  });

  const candidates = () => listTriageShadowCandidates(db, { afterSeq: 0, limit: 10, receivedSince: recent() }).events
    .map((event) => event.seq);
  const callPayload = {
    component: "decision_model", purpose: "triage_shadow", backend: "jev", model: "jev-latest", latencyMs: 80, ok: true,
    error: null, errorKind: null, fallbackFrom: null,
  };

  it("skip the component telemetry of ticket 13, which is disposed of when it is written", () => {
    const seq = (value: number) => db.prepare("SELECT kind, level, triage, disposition FROM events WHERE seq = ?").get(value);
    const call = recordDecisionModelCall(db, { ...callPayload, fallbackFrom: null });
    const recall = recordMemoryRecall(db, { backend: "hindsight", latencyMs: 40, ok: true, error: null, hits: 3 });
    expect(seq(call)).toMatchObject({ kind: "decision_model.called", disposition: "handled_by_rule" });
    expect(seq(recall)).toMatchObject({ kind: "memory.recalled", disposition: "handled_by_rule" });
    const other = append(checkpoint("别的事件"));
    expect(candidates()).toEqual([other.seq]);
  });

  it("skip events the system already disposed of, but keep the ones Lead disposed of", () => {
    const byRule = append(checkpoint("规则处理掉了"));
    setEventDisposition(db, byRule.seq, "handled_by_rule", { rule: "test" });
    const merged = append(checkpoint("合并进别的事件"));
    setEventDisposition(db, merged.seq, "superseded", { reason: "merged_root_cause" });
    const byLead = append(checkpoint("Lead 判断不用管"));
    setEventDisposition(db, byLead.seq, "no_action", { reason: "例行的进展" });
    const seen = append(checkpoint("Lead 看过了"));
    setEventDisposition(db, seen.seq, "seen");
    const open = append(checkpoint("还没有处置"));
    expect(candidates()).toEqual([byLead.seq, seen.seq, open.seq]);
  });

  it("skip the decision model's and memory's call kinds even without a disposition (second guard)", () => {
    // 不经过 recordDecisionModelCall：没有写入方给的级别（依据是 source.system），也没有处置。只剩按类型的排除。
    const call = append({ source: "system", kind: "decision_model.called", entityKey: "component:decision_model", payload: callPayload });
    expect(call).toMatchObject({ disposition: null, triage: { order: { id: "source.system" } } });
    const recall = append({
      source: "system", kind: "memory.recalled", entityKey: "component:memory",
      payload: { component: "memory", backend: "hindsight", latencyMs: 40, ok: true, error: null, hits: 3 },
    });
    expect(recall).toMatchObject({ disposition: null, triage: { order: { id: "source.system" } } });
    const other = append(checkpoint("别的事件"));
    expect(candidates()).toEqual([other.seq]);
  });

  it("keep their own cursor in kv", () => {
    expect(getTriageShadowCursor(db)).toBeNull();
    setTriageShadowCursor(db, 7);
    expect(getTriageShadowCursor(db)).toBe(7);
    expect(() => setTriageShadowCursor(db, -1)).toThrow();
  });
});

describe("the shadow report", () => {
  it("puts each judgment next to the event's actual level and disposition, within the time range", () => {
    const now = new Date();
    const a = append(checkpoint("a"));
    const b = append(checkpoint("b"));
    const old = append(checkpoint("old"), { receivedAt: new Date(now.getTime() - 10 * 24 * 60 * 60_000) });
    recordTriageShadowJudgment(db, judgment(a, { level: "record", needsLead: 0.1 }));
    recordTriageShadowJudgment(db, judgment(b, { level: "tell", needsLead: 0.9 }));
    recordTriageShadowJudgment(db, judgment(old, { level: "record" }));
    setEventDisposition(db, b.seq, "handled", { reason: "Lead 看过并处理了" });

    const report = triageShadowReport(db, { since: new Date(now.getTime() - 24 * 60 * 60_000), until: new Date(now.getTime() + 60_000) });
    expect(report.truncated).toBe(false);
    expect(report.kinds).toEqual([expect.objectContaining({
      kind: "checkpoint.recorded", judged: 2,
      level: { compared: 2, agreed: 1, rate: 0.5 },
      needsLead: { compared: 1, agreed: 1, rate: 1 },
    })]);
    expect(report.switch).toMatchObject({ enabledKinds: [], approved: false, order: { id: "triage.jev", version: 1 } });
  });
});

describe("the Jev triage switch", () => {
  const seed = SYSTEM_STANDING_ORDERS.find((order) => order.id === "triage.jev")!;
  const withKinds = (enabledKinds: string[], reason: string): StandingOrderDefinition => {
    const { seedRevision: _revision, status: _status, ...definition } = seed;
    return { ...definition, action: { type: "rule", rule: "triage.jev", params: { enabledKinds } }, reason };
  };

  it("is off for every event kind by default", () => {
    expect(jevTriageSwitch(db)).toEqual({
      enabledKinds: [], requestedKinds: [], approved: false, order: { id: "triage.jev", version: 1 },
    });
    expect(isJevTriageEnabled(db, "run.started")).toBe(false);
  });

  it("opens a kind only in a version the user wrote or approved", () => {
    recordStandingOrderVersion(db, withKinds(["run.started"], "Lead 想放开"), { author: "lead" });
    expect(jevTriageSwitch(db)).toMatchObject({ enabledKinds: [], requestedKinds: ["run.started"], approved: false });
    expect(isJevTriageEnabled(db, "run.started")).toBe(false);

    recordStandingOrderVersion(db, withKinds(["run.started"], "用户批准了"), { author: "lead", approvedBy: "user" });
    expect(isJevTriageEnabled(db, "run.started")).toBe(true);

    recordStandingOrderVersion(db, withKinds(["stage.changed", "stage.changed"], "用户自己改的"), { author: "user" });
    expect(jevTriageSwitch(db)).toMatchObject({ enabledKinds: ["stage.changed"], approved: true, order: { version: 4 } });
    expect(isJevTriageEnabled(db, "run.started")).toBe(false);

    // 停用最新的一版：回到种子，全部关闭。
    recordStandingOrderVersion(db, withKinds(["stage.changed"], "停用"), { author: "user", status: "disabled" });
    expect(jevTriageSwitch(db).enabledKinds).toEqual([]);
  });
});

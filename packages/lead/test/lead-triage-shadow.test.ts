// Lead 读 Jev 分诊的影子报告（工单 09）：get_triage_shadow_report，参数是时间范围。只读。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  appendEvent, openDb, recordTriageShadowJudgment, setEventDisposition, type Db, type EventRecord,
} from "@pi-lead-child/store";
import { createLeadTools, type LeadDeps } from "../src/tools.js";
import { LEAD_QUIET_TOOLS } from "../src/session.js";
import { triageShadowRange } from "../src/triage-shadow-tool.js";

let db: Db;
let deps: LeadDeps;

beforeEach(() => {
  const dir = tempDir("plc-lead-triage-shadow-");
  const dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  deps = { db, dbPath, dataDir: dir };
});

async function call(params: Record<string, unknown>): Promise<any> {
  const tool = createLeadTools(deps).find((candidate: any) => candidate.name === "get_triage_shadow_report") as any;
  if (!tool) throw new Error("get_triage_shadow_report not found");
  const result = await tool.execute("call", params);
  return JSON.parse(result.content.map((part: { text?: string }) => part.text ?? "").join("\n"));
}

const stage = (itemId: number): EventRecord => db.transaction(() => appendEvent(db, {
  source: "ticket", kind: "stage.changed", entityKey: `ticket:${itemId}`,
  payload: { itemId, itemKind: "task", from: "ready", to: "active", actor: "system", reason: "spawn" },
}).event)();

describe("get_triage_shadow_report", () => {
  it("gives the agreement by event kind for a time range, and the switch, without changing anything", async () => {
    const a = stage(1);
    const b = stage(2);
    const judged = (event: EventRecord, level: "record" | "tell", needsLead: number) => recordTriageShadowJudgment(db, {
      seq: event.seq, eventId: event.eventId, questionVersion: 1, backend: "jev", model: "jev-latest", latencyMs: 80,
      level, levelConfidence: 0.8, needsLead, autoAction: null, autoActionConfidence: 0.6, risk: "low", riskScore: 0.1,
      actionOptions: [], answers: {}, error: null,
    });
    judged(a, "record", 0.1);
    judged(b, "tell", 0.9);
    setEventDisposition(db, b.seq, "handled", { reason: "看过" });
    const eventsBefore = db.prepare("SELECT * FROM events ORDER BY seq").all();

    const report = await call({});
    expect(report.note).toContain("影子模式");
    expect(report.kinds).toEqual([{
      kind: "stage.changed", judged: 2, failed: 0,
      level: { compared: 2, agreed: 1, rate: 0.5 },
      needs_lead: { compared: 1, agreed: 1, rate: 1 },
      shadow_levels: { record: 1, tell: 1 },
      actual_levels: { record: 2 },
    }]);
    expect(report.total).toMatchObject({ judged: 2, level: { rate: 0.5 } });
    expect(report.switch).toEqual({
      order: { id: "triage.jev", version: 1 }, enabled_kinds: [], requested_kinds: [], approved: false,
    });
    expect(db.prepare("SELECT * FROM events ORDER BY seq").all()).toEqual(eventsBefore);

    // 时间范围之外的不算。
    const empty = await call({ since: "2020-01-01T00:00:00Z", until: "2020-01-02T00:00:00Z" });
    expect(empty.kinds).toEqual([]);
    expect(empty.total.level.rate).toBeNull();
  });

  it("defaults to the last 7 days and rejects a bad range", async () => {
    const now = new Date("2026-10-17T12:00:00.000Z");
    expect(triageShadowRange({}, now)).toEqual({ since: new Date("2026-10-10T12:00:00.000Z"), until: now });
    await expect(call({ since: "昨天" })).rejects.toThrow(/不是时间/);
    await expect(call({ since: "2026-10-17T00:00:00Z", until: "2026-10-16T00:00:00Z" })).rejects.toThrow(/早于/);
    await expect(call({ since: "2026-01-01T00:00:00Z", until: "2026-10-16T00:00:00Z" })).rejects.toThrow(/90 天/);
  });

  it("is a quiet read-only tool", () => {
    expect(LEAD_QUIET_TOOLS.has("get_triage_shadow_report")).toBe(true);
  });
});

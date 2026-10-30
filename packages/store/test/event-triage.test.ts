// 分诊按常设指令定级别（工单 05）。01 的默认分诊（defaultTriageLevel）搬成了第一批常设指令，行为不变：
//   - 上半部分是 01 原来的用例，改成断言按常设指令分诊的结果；
//   - 对照测试：搬之前的函数原样抄在下面（legacyDefaultTriageLevel），对一组覆盖全部内部事件类型和 payload 组合的信封，
//     搬之后的级别和搬之前完全一样；
//   - 依据：每个事件都记着定级别的指令编号和版本。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import type { EventEnvelope, EventLevel, RootCause } from "@pi-lead-child/protocol";
import { openDb, triageEvent, type Db, type TriageEnvelope } from "../src/index.js";

const at = "2026-10-17T08:00:00.000Z";

let db: Db;
beforeEach(() => {
  db = openDb(join(tempDir("plc-triage-"), "plc.db"));
});

const triage = (envelope: EventEnvelope) =>
  triageEvent(db, { ...envelope, occurredAt: envelope.occurredAt ?? at, payload: envelope.payload ?? {} } as TriageEnvelope);
const level = (envelope: EventEnvelope) => triage(envelope).level;

// 搬之前的实现（01 的 packages/store/src/event-triage.ts，提交 8b138b0），原样保留在这里做对照。
function legacyDefaultTriageLevel(envelope: EventEnvelope): EventLevel {
  if (envelope.source === "user") return "conversation";
  const payload = envelope.payload ?? {};
  switch (envelope.kind) {
    case "inbox.blocker":
    case "inbox.attention":
      if (payload.inboxKind === "lead_followup") return "record";
      if (payload.delivery === "folded" && payload.fuseOpened !== true) return "digest";
      return payload.wakeLead === true ? "tell" : "digest";
    case "notification.created":
      return payload.urgency === "immediate" ? "tell" : "digest";
    case "timer.fired":
      return payload.wakeLead === true ? "tell" : "record";
    default:
      return "record";
  }
}

const inbox = (severity: "blocker" | "attention", extra: Record<string, unknown> = {}): EventEnvelope => ({
  source: "system",
  kind: `inbox.${severity}`,
  entityKey: "ticket:1",
  occurredAt: at,
  payload: {
    inboxId: 1, itemId: 1, scope: "item:1", severity, inboxSource: "structural", summary: "s",
    wakeLead: severity === "blocker", needsUser: false, delivery: "row", payload: {}, ...extra,
  },
});

const notification = (urgency: "immediate" | "batchable", kind = "reminder"): EventEnvelope => ({
  source: "system",
  kind: "notification.created",
  entityKey: "ticket:1",
  occurredAt: at,
  payload: { notificationId: 1, itemId: 1, notificationKind: kind, urgency, title: "t", body: "", dedupKey: null },
});

describe("triage by standing orders: the cases of 01's default triage", () => {
  it("tells Lead about a blocker", () => {
    expect(level(inbox("blocker"))).toBe("tell");
  });

  it("tells Lead about an attention that wakes it, and digests one that does not", () => {
    expect(level(inbox("attention", { wakeLead: true }))).toBe("tell");
    expect(level(inbox("attention", { wakeLead: false }))).toBe("digest");
  });

  it("tells Lead about an immediate notification, and digests a batchable one", () => {
    expect(level(notification("immediate"))).toBe("tell");
    expect(level(notification("batchable"))).toBe("digest");
  });

  it("puts a user's message in the conversation", () => {
    expect(level({
      source: "user", kind: "user.message", entityKey: "chat:main", occurredAt: at,
      payload: { turnId: "t", originKind: "paired:companion", text: "hi" },
    })).toBe("conversation");
  });

  it("only records everything else", () => {
    expect(level({
      source: "ticket", kind: "stage.changed", entityKey: "ticket:1", occurredAt: at,
      payload: { itemId: 1, itemKind: "task", from: "ready", to: "active", actor: "system", reason: "r" },
    })).toBe("record");
    expect(level({
      source: "run", kind: "run.failed", entityKey: "run:1", occurredAt: at, rootCause: { code: "x" },
      payload: { runId: 1, itemId: 1, role: "executor", purpose: "execution", runtime: "codex", from: "running", to: "failed" },
    })).toBe("record");
  });

  it("digests a blocker that is explicitly marked not to wake Lead", () => {
    expect(level(inbox("blocker", { wakeLead: false }))).toBe("digest");
  });

  it("digests a blocker folded into an open fuse, and tells the one that opens it", () => {
    expect(level(inbox("blocker", { delivery: "folded", fuseOpened: true }))).toBe("tell");
    expect(level(inbox("blocker", { delivery: "folded", fuseOpened: false }))).toBe("digest");
  });

  it("records a Lead follow-up when it is set, and tells Lead when it is due", () => {
    expect(level(inbox("attention", {
      wakeLead: true, inboxKind: "lead_followup", payload: { kind: "lead_followup", notBefore: "2026-10-17T09:00:00.000Z" },
    }))).toBe("record");
    expect(level({
      source: "timer", kind: "timer.fired", entityKey: "lead-followup:x", occurredAt: at,
      payload: { timer: "lead_followup", scheduledAt: at, inboxId: 1, wakeLead: true },
    })).toBe("tell");
    expect(level({
      source: "timer", kind: "timer.fired", entityKey: "reminder:2", occurredAt: at,
      payload: { timer: "reminder", scheduledAt: at, itemId: 2, wakeLead: false },
    })).toBe("record");
  });
});

// 对照测试的信封：每一种内部事件类型，加上分诊会看的每个 payload 字段的各种取值。
function corpus(): EventEnvelope[] {
  const envelopes: EventEnvelope[] = [];
  const rootCauses: Array<RootCause | null> = [null, { code: "process_exit" }, { code: "network_error", scope: "attempt" }];
  for (const severity of ["blocker", "attention"] as const) {
    for (const delivery of ["row", "merged", "folded"]) {
      for (const fuseOpened of [undefined, true, false]) {
        for (const wakeLead of [true, false]) {
          for (const inboxKind of [null, "lead_followup", "transient_retry", "model_catalog_changed", "conversation_run_failed"]) {
            for (const rootCause of rootCauses) {
              const envelope = inbox(severity, {
                delivery, wakeLead, inboxKind, ...(fuseOpened === undefined ? {} : { fuseOpened }),
              });
              envelopes.push(rootCause ? { ...envelope, rootCause } : envelope);
            }
          }
        }
      }
    }
  }
  for (const urgency of ["immediate", "batchable"] as const) {
    for (const kind of ["reminder", "overdue", "lead_notice", "blocked_checkpoint"]) envelopes.push(notification(urgency, kind));
  }
  for (const timer of ["reminder", "lead_followup"]) {
    for (const wakeLead of [true, false]) {
      envelopes.push({
        source: "timer", kind: "timer.fired", entityKey: "reminder:2", occurredAt: at,
        payload: { timer, scheduledAt: at, itemId: 2, wakeLead },
      });
    }
  }
  const turn = { turnId: "t", originKind: "paired:companion" };
  envelopes.push(
    { source: "user", kind: "user.message", entityKey: "chat:main", payload: { ...turn, text: "hi" } },
    { source: "lead", kind: "lead.turn_completed", entityKey: "chat:main", payload: turn },
    {
      source: "lead", kind: "lead.turn_failed", entityKey: "chat:main", rootCause: { code: "rate_limited" },
      payload: { ...turn, error: "429", willRetry: false },
    },
    { source: "ticket", kind: "ticket_agent.turn_completed", entityKey: "ticket:1", payload: { ...turn, itemId: 1 } },
    {
      source: "ticket", kind: "ticket_agent.turn_failed", entityKey: "ticket:1", rootCause: { code: "x" },
      payload: { ...turn, itemId: 1, error: "e", willRetry: false },
    },
    {
      source: "ticket", kind: "stage.changed", entityKey: "ticket:1",
      payload: { itemId: 1, itemKind: "task", from: "ready", to: "active", actor: "system", reason: "r" },
    },
    {
      source: "ticket", kind: "checkpoint.recorded", entityKey: "ticket:1",
      payload: { checkpointId: 1, itemId: 1, runId: null, checkpointKind: "blocked", checkpointSource: "system", title: "t", summary: "s" },
    },
    {
      source: "system", kind: "system.event_rejected", entityKey: "system:event-rejected",
      payload: { error: "x" },
    },
  );
  const run = { runId: 1, itemId: 1, role: "executor", purpose: "execution", runtime: "codex" };
  for (const kind of ["run.started", "run.resumed", "run.paused", "run.finished", "run.stopped"]) {
    envelopes.push({ source: "run", kind, entityKey: "run:1", payload: { ...run, from: "starting", to: "running" } });
  }
  for (const rootCause of rootCauses.filter(Boolean) as RootCause[]) {
    envelopes.push({ source: "run", kind: "run.failed", entityKey: "run:1", rootCause, payload: { ...run, from: "running", to: "failed" } });
  }
  return envelopes;
}

describe("triage by standing orders: compared with the default triage before it moved", () => {
  it("gives every internal event the same level as before", () => {
    const envelopes = corpus();
    expect(envelopes.length).toBeGreaterThan(500);
    const differences = envelopes
      .map((envelope) => ({ envelope, before: legacyDefaultTriageLevel(envelope), after: level(envelope) }))
      .filter(({ before, after }) => before !== after);
    expect(differences).toEqual([]);
  });

  it("records which standing order and version decided the level", () => {
    for (const envelope of corpus().filter((candidate) => candidate.source !== "user")) {
      const { basis } = triage(envelope);
      expect(basis?.order).toEqual({ id: expect.any(String), version: 1 });
    }
    expect(triage(inbox("blocker")).basis).toEqual({ order: { id: "inbox.wake_lead", version: 1 } });
    expect(triage(inbox("blocker", { delivery: "folded", fuseOpened: false })).basis)
      .toEqual({ order: { id: "inbox.fuse_blockers", version: 1 } });
    expect(triage(inbox("attention", { wakeLead: false, delivery: "merged" })).basis).toEqual({
      order: { id: "inbox.no_wake", version: 1 },
      applied: [{ id: "inbox.merge_attention", version: 1, effect: "inbox_merged" }],
    });
    expect(triage(inbox("attention", { wakeLead: false, inboxKind: "transient_retry" })).basis)
      .toEqual({ order: { id: "run.transient_retry", version: 1 } });
    expect(triage(notification("immediate")).basis).toEqual({ order: { id: "reminder.fire", version: 1 } });
    expect(triage({
      source: "ticket", kind: "stage.changed", entityKey: "ticket:1",
      payload: { itemId: 1, itemKind: "task", from: "ready", to: "active", actor: "system", reason: "r" },
    }).basis).toEqual({ order: { id: "source.ticket", version: 1 } });
    // 用户自己的消息不分诊，没有依据。
    expect(triage({ source: "user", kind: "user.message", entityKey: "chat:main", payload: { turnId: "t", originKind: "x", text: "" } }))
      .toEqual({ level: "conversation", basis: null });
  });
});

describe("hard safety rules", () => {
  // 审批要在过期前送到用户（spec D4）：常设指令把审批的 blocker 定得再低，它也至少是 tell。
  it("keeps an approval at tell even when a standing order would digest it", () => {
    const approval = inbox("blocker", { wakeLead: false, payload: { authorityType: "approval", authorityId: 3 } });
    expect(legacyDefaultTriageLevel(approval)).toBe("digest");
    expect(triage(approval)).toMatchObject({ level: "tell", basis: { hardRules: ["approval_reaches_user"] } });
    // 现在的审批行都会叫醒 Lead：这条规则不改变现有的行为。
    expect(triage(inbox("blocker", { payload: { authorityType: "approval", authorityId: 3 } })))
      .toEqual({ level: "tell", basis: { order: { id: "inbox.wake_lead", version: 1 } } });
  });
});

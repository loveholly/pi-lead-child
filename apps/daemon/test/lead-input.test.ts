// Lead 的输入在决策边界上的单元测试（工单 04，lead-input.ts）：事件交给 Lead 的方式、Lead 忙时插话还是排队、
// 按批叫醒的缺省判断（05 的常设指令 events.digest_batch）、按根因合并的事件 Lead 只看一次、游标只在一轮成功以后前进、
// 当前局面按预算截断并写明截断了多少。
// 走完整流程的测试在 lead-input-placement、lead-input-restart、lead-input-parity。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addInbox, addLeadFollowUp, addNotification, appendEvent, createItem, escalateOverdueEvents, listInbox, listEvents,
  loadLeadEventCursor, openDb, recordDueLeadFollowUps, recordLeadCompactionFailed, recordLeadModelSwitched, transition,
  type Db, type EventRecord,
} from "@pi-lead-child/store";
import { estimateTokens, renderLeadSituation } from "@pi-lead-child/lead";
import { SYSTEM_TURN_ORIGINS } from "@pi-lead-child/protocol";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  busyPlacement, createLeadInput, defaultDigestBatch, leadEventRoute, MAX_LEAD_SELF_LINES, SETTLED_FOLD_THRESHOLD,
} from "../src/lead-input.js";
import { ChannelHub, ChannelRegistry } from "@pi-lead-child/engine";
import { createFakeHookAdapter, FakeHookService } from "@pi-lead-child/engine/testing";

const fresh = (): Db => openDb(join(tempDir("plc-lead-input-unit-"), "plc.db"));

function event(partial: Partial<EventRecord>): EventRecord {
  return {
    seq: 1, eventId: "e", source: "system", sourceRef: null, kind: "inbox.blocker", entityKey: "ticket:1", entityVersion: null,
    occurredAt: new Date().toISOString(), receivedAt: new Date().toISOString(), causationId: null, correlationId: null,
    payload: {}, rootCause: null, level: "tell", disposition: null, dispositionDetail: null, disposedAt: null,
    triage: null,
    ...partial,
  };
}

describe("how an event reaches Lead", () => {
  it("hands tell and interrupt events over as messages, keeps the rest in the situation, and skips its own inputs", () => {
    expect(leadEventRoute(event({ level: "tell" }))).toBe("message");
    expect(leadEventRoute(event({ level: "interrupt" }))).toBe("message");
    for (const level of ["digest", "auto", "record"] as const) expect(leadEventRoute(event({ level }))).toBe("situation");
    // 用户自己的消息走会话，Lead 自己回合的结果另有一行，即时通知走播报流程。
    expect(leadEventRoute(event({ kind: "user.message", level: "conversation", source: "user" }))).toBe("skip");
    expect(leadEventRoute(event({ kind: "lead.turn_failed", level: "record", source: "lead" }))).toBe("skip");
    expect(leadEventRoute(event({ kind: "notification.created", level: "tell" }))).toBe("skip");
    expect(leadEventRoute(event({ kind: "notification.created", level: "digest" }))).toBe("situation");
    // 组件的调用记录（工单 13）是遥测，Lead 用 get_system_usage 查，不进当前局面。
    expect(leadEventRoute(event({ kind: "decision_model.called", level: "record" }))).toBe("skip");
    expect(leadEventRoute(event({ kind: "memory.recalled", level: "record" }))).toBe("skip");
    // 主人操作（工单 15）：系统自己推送、自己贴会话卡，「不是我」由用户处理。interrupt 级也不为它叫醒 Lead。
    expect(leadEventRoute(event({ kind: "owner_action.performed", level: "interrupt" }))).toBe("skip");
    expect(leadEventRoute(event({ kind: "owner_action.performed", level: "record" }))).toBe("skip");
    expect(leadEventRoute(event({ kind: "owner_action.disowned", level: "record" }))).toBe("skip");
    // 通道里只记录的消息（例如订阅频道里别人的普通消息，slack-takeover 工单 02）不进当前局面；投递了的照常。
    const channel = (level: "record" | "digest", channelDelivery: string) =>
      event({ source: "slack", kind: "slack.channel.message", level, payload: { role: "message", channelDelivery } });
    expect(leadEventRoute(channel("record", "record"))).toBe("skip");
    expect(leadEventRoute(channel("record", "card"))).toBe("situation");
    expect(leadEventRoute(channel("digest", "record"))).toBe("situation");
  });

  it("steers only urgent events from internal sources into a busy turn; external sources always queue", () => {
    const running = { origin: null };
    expect(busyPlacement(event({ level: "interrupt", source: "system" }), running)).toBe("steer");
    expect(busyPlacement(event({ level: "tell", source: "system" }), running)).toBe("queue");
    // 外部来源（以后的 Slack、webhook）永远不插话，不管级别（spec D6）。
    expect(busyPlacement(event({ level: "interrupt", source: "slack" as never }), running)).toBe("queue");
    // 整理笔记是 Lead 的内部回合，不往里插。
    expect(busyPlacement(event({ level: "interrupt", source: "run" }), { origin: SYSTEM_TURN_ORIGINS.precipitate })).toBe("queue");
  });
});

describe("the default digest batch", () => {
  const MINUTE = 60_000;
  const batchable = (db: Db, title: string) => {
    addNotification(db, { kind: "overdue", urgency: "batchable", title, createdAt: new Date().toISOString() });
    return listEvents(db, { kind: "notification.created", order: "desc", limit: 1 })[0]!;
  };

  it("follows the events.digest_batch standing order: the oldest waits 25 minutes, or the user comes back", () => {
    const db = fresh();
    const input = createLeadInput({ db });
    const first = batchable(db, "预算用了 80%");
    batchable(db, "预算用了 90%");
    const received = Date.parse(first.receivedAt);
    const decide = (now: Date, userReturnedAt: Date | null = null, lastWakeAt = new Date(received - MINUTE)) =>
      defaultDigestBatch(db, { now, pending: input.pendingDigest(), lastWakeAt, userReturnedAt });

    expect(decide(new Date(received + 24 * MINUTE))).toMatchObject({
      wake: false, events: [], dueAt: new Date(received + 25 * MINUTE),
    });
    const due = decide(new Date(received + 25 * MINUTE));
    expect(due.wake).toBe(true);
    expect(due.events).toHaveLength(2);
    // 用户回来了（上一次叫醒以后）：不等满也叫醒。回来得比上一次叫醒早，不算。
    expect(decide(new Date(received + MINUTE), new Date(received + MINUTE)).wake).toBe(true);
    expect(decide(new Date(received + MINUTE), new Date(received - 2 * MINUTE)).wake).toBe(false);
    db.close();
  });

  it("does not wake Lead for digest events before the cursor or already shown to it, so it cannot loop", () => {
    const db = fresh();
    // 工单 04 之前写的、还没有处置的摘要：游标第一次建立时放在它们后面，Lead 看不到它们，不为它们叫醒。
    const old = batchable(db, "很早以前的逾期");
    const input = createLeadInput({ db });
    const later = Date.parse(old.receivedAt) + 60 * MINUTE;
    const decide = () => defaultDigestBatch(db, {
      now: new Date(later), pending: input.pendingDigest(), lastWakeAt: new Date(0), userReturnedAt: null,
    });
    expect(decide()).toMatchObject({ wake: false, dueAt: null });

    // 游标后面的那一条从它自己的收到时间算。
    const fresh_ = batchable(db, "刚刚逾期");
    expect(decide().events.map((candidate) => candidate.seq)).toEqual([fresh_.seq]);
    // 这一批交给 Lead、成功以后记成 digested，带摘要编号。下一次判断不再为它叫醒。
    input.beginRun("digest");
    expect(input.renderSituation({ queuedUserMessages: 0 })).toContain("刚刚逾期");
    expect(input.endRun("succeeded", { digestId: "turn:t-1" })).toEqual({ digested: 1 });
    expect(listEvents(db, { kind: "notification.created" }).find((candidate) => candidate.seq === fresh_.seq)).toMatchObject({
      disposition: "digested", dispositionDetail: { digestId: "turn:t-1", standingOrder: { id: "events.digest_batch", version: 1 } },
    });
    expect(decide()).toMatchObject({ wake: false, dueAt: null });
    db.close();
  });
});

describe("events merged by root cause", () => {
  // 瞬时失败的重试说明（engine 的 transient-retry.ts 写的样子）：digest 级，同一个根因码的第二条按根因合并进第一条。
  function retryNotice(db: Db, title: string): { itemId: number; seq: number; inboxId: number } {
    const itemId = createItem(db, { title, brief: "b", createdBy: "user" });
    const { id: inboxId } = addInbox(db, {
      itemId, severity: "attention", source: "structural", summary: `工单 #${itemId}：网络中断，30 秒后自动重试`,
      payload: { kind: "transient_retry", runId: itemId * 10, attempt: 1, limit: 5, code: "network_error" }, lossless: true,
    });
    const seq = listEvents(db, { kind: "inbox.attention", order: "desc", limit: 1 })[0]!.seq;
    return { itemId, seq, inboxId: Number(inboxId) };
  }

  it("shows the merged tickets under the first one, once, and settles both", () => {
    const db = fresh();
    const input = createLeadInput({ db });
    const a = retryNotice(db, "迁移 A");
    const b = retryNotice(db, "迁移 B");
    expect(listEvents(db, { kind: "inbox.attention" }).map((candidate) => candidate.disposition)).toEqual([null, "superseded"]);

    input.beginRun("digest");
    const situation = input.renderSituation({ queuedUserMessages: 0 });
    // 第一张下面一行写明合并进来的是哪张工单；第二张不再单独列一遍。
    expect(situation).toContain(`同一个根因（network_error）合并进来 1 件：#${b.itemId}「迁移 B」`);
    expect(situation.match(/网络中断，30 秒后自动重试/gu)).toHaveLength(1);
    expect(input.endRun("succeeded", { digestId: "turn:t-2" })).toEqual({ digested: 1 });

    expect(listEvents(db, { kind: "inbox.attention" }).map((candidate) => candidate.disposition)).toEqual(["digested", "superseded"]);
    expect(listInbox(db).filter((row) => [a.inboxId, b.inboxId].includes(row.id)).map((row) => row.state)).toEqual(["consumed", "consumed"]);
    expect(input.cursor().seq).toBeGreaterThanOrEqual(b.seq);
    expect(input.pendingDigest()).toEqual([]);
    db.close();
  });

  it("hands a merged event over on its own when the first one already reached Lead", () => {
    const db = fresh();
    const input = createLeadInput({ db });
    const a = retryNotice(db, "迁移 A");
    // 第一张已经列在正在跑的这一轮里，第二张这时候才到：它合并进第一张，但这一轮的 Lead 没看到它。
    input.beginRun("user");
    input.renderSituation({ queuedUserMessages: 0 });
    const b = retryNotice(db, "迁移 B");
    input.endRun("succeeded");
    expect(input.pendingDigest().map((candidate) => candidate.seq)).toEqual([b.seq]);

    input.beginRun("user");
    const situation = input.renderSituation({ queuedUserMessages: 0 });
    expect(situation).toContain(`#${b.itemId}「迁移 B」`);
    expect(situation).toContain(`这一件和事件 #${a.seq} 是同一个根因（network_error）`);
    input.endRun("succeeded");
    expect(input.pendingDigest()).toEqual([]);
    expect(listInbox(db).find((row) => row.id === b.inboxId)!.state).toBe("consumed");
    db.close();
  });

  it("drops an event that was escalated and hands Lead the escalated one instead", () => {
    const db = fresh();
    const input = createLeadInput({ db });
    addNotification(db, { kind: "overdue", urgency: "batchable", title: "工单逾期了", createdAt: new Date().toISOString() });
    const original = listEvents(db, { kind: "notification.created" })[0]!;
    expect(escalateOverdueEvents(db, new Date(Date.now() + 31 * 60_000))).toHaveLength(1);
    expect(input.pendingDigest()).toEqual([]);
    expect(input.pendingMessages().map((candidate) => [candidate.kind, candidate.level])).toEqual([["event.escalated", "tell"]]);
    input.beginRun("events");
    input.takeMessages();
    input.endRun("succeeded");
    expect(input.cursor().seq).toBeGreaterThan(original.seq);
    expect(input.pendingMessages()).toEqual([]);
    db.close();
  });
});

describe("the event cursor", () => {
  it("moves only after a successful round, and from where it was after a failed one", () => {
    const db = fresh();
    const input = createLeadInput({ db });
    const start = input.cursor().seq;
    const itemId = createItem(db, { title: "部署", brief: "b", createdBy: "user" });
    addInbox(db, { itemId, severity: "blocker", source: "structural", summary: "交接失败" });
    const blocker = listEvents(db, { kind: "inbox.blocker" })[0]!;

    input.beginRun("events");
    expect(input.takeMessages().events.map((candidate) => candidate.seq)).toEqual([blocker.seq]);
    input.endRun("failed");
    expect(input.cursor().seq).toBe(start);
    expect(loadLeadEventCursor(db)!.seq).toBe(start);
    // 从原位置重读：同一条事件还要交给 Lead。
    expect(input.pendingMessages().map((candidate) => candidate.seq)).toEqual([blocker.seq]);

    input.beginRun("events");
    input.takeMessages();
    input.endRun("succeeded");
    expect(input.cursor().seq).toBeGreaterThanOrEqual(blocker.seq);
    expect(loadLeadEventCursor(db)!.seq).toBe(input.cursor().seq);
    expect(input.pendingMessages()).toEqual([]);
    expect(listInbox(db).map((row) => row.state)).toEqual(["consumed"]);
    db.close();
  });

  it("does not move past a tell event still waiting for its own round, but remembers what came after", () => {
    const db = fresh();
    const input = createLeadInput({ db });
    const start = input.cursor().seq;
    const itemId = createItem(db, { title: "部署", brief: "b", createdBy: "user" });
    addInbox(db, { itemId, severity: "blocker", source: "structural", summary: "交接失败" });
    addInbox(db, { itemId, severity: "attention", source: "structural", summary: "进展：第一批迁完" });

    // 用户的一轮：tell 级的事排队，当前局面里列着它和那条进展。
    input.beginRun("user");
    const situation = input.renderSituation({ queuedUserMessages: 0 });
    expect(situation).toContain("排队中");
    expect(situation).toContain("系统事件 inbox.blocker，来源 system");
    expect(situation).not.toContain("交接失败");
    expect(situation).toContain("进展：第一批迁完");
    input.endRun("succeeded");
    // 游标停在还在排队的那件事前面；后面那条进展已经处理过，不再列出。
    expect(input.cursor().seq).toBe(start);
    expect(input.cursor().settled.length).toBeGreaterThan(0);
    input.beginRun("events");
    expect(input.renderSituation({ queuedUserMessages: 0 })).not.toContain("进展：第一批迁完");
    db.close();
  });

  it("starts at the end of an existing log and carries over the inbox rows nobody handled yet, once", () => {
    const db = fresh();
    const itemId = createItem(db, { title: "部署", brief: "b", createdBy: "user" });
    addInbox(db, { itemId, severity: "blocker", source: "structural", summary: "04 之前没处理的 blocker" });
    const handled = createItem(db, { title: "旧事", brief: "b", createdBy: "user" });
    addInbox(db, { itemId: handled, severity: "blocker", source: "structural", summary: "早就处理完的 blocker" });
    const old = listInbox(db).find((row) => row.summary === "早就处理完的 blocker")!;
    db.prepare("UPDATE inbox SET state='consumed' WHERE id=?").run(old.id);

    const input = createLeadInput({ db });
    const messages = input.pendingMessages();
    expect(messages.map((candidate) => candidate.payload.summary)).toEqual(["04 之前没处理的 blocker"]);
    // 再建一次（daemon 重启）：游标已经在库里，不再转一次。
    createLeadInput({ db });
    expect(createLeadInput({ db }).pendingMessages()).toHaveLength(1);
    db.close();
  });

  // Lead 自己设的跟进：设的时候不再告诉它（它自己设的），到点之前也不算交给了它；到点时那条到点事件叫醒它。
  it("keeps a follow-up that is not due yet out of Lead's input, and wakes Lead with it once it is due", () => {
    const db = fresh();
    const input = createLeadInput({ db });
    const itemId = createItem(db, { title: "等核查", brief: "b", createdBy: "user" });
    const followUp = addLeadFollowUp(db, { at: new Date(Date.now() + 3_600_000), note: "一小时后看核查", itemId });
    input.beginRun("user");
    expect(input.renderSituation({ queuedUserMessages: 0 })).not.toContain("一小时后看核查");
    input.endRun("succeeded");
    expect(listInbox(db).find((row) => row.id === followUp)!.state).toBe("pending");
    // 游标不被它挡住。
    expect(input.cursor().seq).toBe(listEvents(db, { order: "desc", limit: 1 })[0]!.seq);
    // 到点以后它的到点事件叫醒 Lead。
    db.prepare("UPDATE inbox SET payload=json_set(payload, '$.notBefore', ?) WHERE id=?").run(new Date(Date.now() - 1_000).toISOString(), followUp);
    recordDueLeadFollowUps(db);
    expect(input.pendingMessages().map((candidate) => candidate.kind)).toEqual(["timer.fired"]);
    db.close();
  });

  // 2026-10-29 跟进 #395（11:05 到点）：#159 的预算告警 11:00 并进了这条还没到点的跟进行，
  // 11:02 那一轮按跟进行交给 Lead，带着跟进的原话；11:05 到点又交一次，Lead 只能记「重复投递」。
  it("hands a notice over on its own, not as the ticket's follow-up that is not due yet", () => {
    const db = fresh();
    const input = createLeadInput({ db });
    const itemId = createItem(db, { title: "返工", brief: "b", createdBy: "user" });
    const followUp = addLeadFollowUp(db, { at: new Date(Date.now() + 3_600_000), note: "11:05 看 Run #187", itemId });
    addInbox(db, {
      itemId, severity: "attention", source: "structural", summary: `工单 #${itemId} 预算告警：累计 tokens 已超 4000000`,
      payload: { kind: "token_budget_exceeded", wakeLead: true, needsUser: false },
    });

    input.beginRun("events");
    const taken = input.takeMessages();
    expect(taken.text).toContain("预算告警");
    expect(taken.text).not.toContain("11:05 看 Run #187");
    expect(taken.inboxIds).not.toContain(followUp);
    input.endRun("succeeded");
    expect(listInbox(db).find((row) => row.id === followUp)!.state).toBe("pending");

    // 到点时跟进交给 Lead 一次。
    db.prepare("UPDATE inbox SET payload=json_set(payload, '$.notBefore', ?) WHERE id=?").run(new Date(Date.now() - 1_000).toISOString(), followUp);
    recordDueLeadFollowUps(db);
    expect(input.pendingMessages().map((candidate) => candidate.kind)).toEqual(["timer.fired"]);
    db.close();
  });

  // 工单 14 第 6 项：关于 Lead 自己的事（压缩失败、换了模型）以前在 daemon 内存里，现在是事件，按游标交给它。
  it("tells Lead about itself from the log: in its own section, again after a failed round, then not again", () => {
    const db = fresh();
    const input = createLeadInput({ db });
    recordLeadCompactionFailed(db, { reason: "overflow", detail: "上下文压缩失败：boom。", timedOut: false });
    recordLeadModelSwitched(db, {
      from: "p/a", to: "p/b", reason: "429 限流", restored: false, restoreAt: null, note: "你的上一轮失败了：429 限流。系统把你的模型从 p/a 换成了 p/b。",
    });
    const self = "关于你自己（上一轮以后）：\n- 你的上一次上下文压缩没有成功（上下文压缩失败：boom）。上下文没有变小，接近上限时 pi 会再压缩一次。"
      + "\n- 你的上一轮失败了：429 限流。系统把你的模型从 p/a 换成了 p/b。";
    input.beginRun("user");
    const first = input.renderSituation({ queuedUserMessages: 0 });
    expect(first).toContain(self);
    // 不另外算进「上一轮以后的变化」。
    expect(first).toContain("上一轮以后的变化：没有。");
    input.endRun("failed");
    input.beginRun("user");
    expect(input.renderSituation({ queuedUserMessages: 0 })).toContain(self);
    input.endRun("succeeded");
    input.beginRun("user");
    expect(input.renderSituation({ queuedUserMessages: 0 })).not.toContain("关于你自己");
    input.endRun("succeeded");
    expect(listEvents(db, { kind: ["lead.compaction_failed", "lead.model_switched"] }).map((event) => event.level)).toEqual(["record", "record"]);
    expect(input.cursor()).toMatchObject({ settled: [], ranges: [] });
    db.close();
  });

  // 工单 14 审查：压缩反复失败时，「关于你自己」一节不能一直变长（压缩失败本来就说明上下文接近上限）。
  const selfSection = (text: string): string[] => {
    const lines = text.split("\n");
    const start = lines.indexOf("关于你自己（上一轮以后）：");
    if (start < 0) return [];
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => !line.startsWith("- "));
    return end < 0 ? rest : rest.slice(0, end);
  };

  it("folds repeated compaction failures into one line with the count and the latest reason", () => {
    const db = fresh();
    const input = createLeadInput({ db });
    for (let index = 1; index <= 10; index += 1) {
      recordLeadCompactionFailed(db, { reason: "overflow", detail: `上下文压缩失败：第 ${index} 次`, timedOut: false });
    }
    input.beginRun("user");
    const section = selfSection(input.renderSituation({ queuedUserMessages: 0 }));
    expect(section.length).toBeGreaterThan(0);
    expect(section.length).toBeLessThanOrEqual(MAX_LEAD_SELF_LINES + 1);
    expect(section).toEqual([
      "- 你的上下文压缩连续失败了 10 次（更早的 9 次没有列出，用 query_events kind=lead.* 查）。"
        + "最近一次：你的上一次上下文压缩没有成功（上下文压缩失败：第 10 次）。上下文没有变小，接近上限时 pi 会再压缩一次。",
    ]);
    input.endRun("succeeded");
    db.close();
  });

  it("lists only the latest 5 lines and folds the earlier ones into one line with how many", () => {
    const db = fresh();
    const input = createLeadInput({ db });
    // 交替出现，不会按「连续的同一种」合并：一共 8 条。
    for (let index = 1; index <= 8; index += 1) {
      if (index % 2) recordLeadCompactionFailed(db, { reason: "overflow", detail: `第 ${index} 条`, timedOut: false });
      else recordLeadModelSwitched(db, { from: "p/a", to: "p/b", reason: "429", restored: false, restoreAt: null, note: `第 ${index} 条：换了模型` });
    }
    input.beginRun("user");
    const section = selfSection(input.renderSituation({ queuedUserMessages: 0 }));
    expect(section).toHaveLength(MAX_LEAD_SELF_LINES + 1);
    expect(section[0]).toBe("- 另有 3 条更早的（用 query_events kind=lead.* 查）");
    expect(section.slice(1).map((line) => /第 (\d) 条/u.exec(line)![1])).toEqual(["4", "5", "6", "7", "8"]);
    input.endRun("succeeded");
    db.close();
  });

  it("does not count a precipitation round as having shown Lead the changes", () => {
    const db = fresh();
    const input = createLeadInput({ db });
    addNotification(db, { kind: "budget", urgency: "batchable", title: "预算用了 80%", createdAt: new Date().toISOString() });
    input.beginRun("internal");
    expect(input.renderSituation({ queuedUserMessages: 0 })).toContain("预算用了 80%");
    input.endRun("succeeded");
    expect(input.pendingDigest()).toHaveLength(1);
    input.beginRun("user");
    input.renderSituation({ queuedUserMessages: 0 });
    input.endRun("succeeded");
    expect(input.pendingDigest()).toHaveLength(0);
    expect(listEvents(db, { kind: "notification.created" })[0]).toMatchObject({ disposition: "digested" });
    db.close();
  });
});

// 工单 14 第 5 项（04 的风险第 4 条）：一件事一直挡在游标前面（例如它的那一轮一直失败）时，游标不动，
// 后面已经处理完的序号（settled）一条一条地加，没有上限；游标后面一次只读 1000 条，处理完的事件占满这个窗口以后，
// 新来的事 Lead 就看不到了。现在游标后面要看的事件超过 500 条时收紧：已经处理完的连续序号并成区间，读的时候跳过。
describe("the cursor while one event blocks it for a long time", () => {
  function stageChanges(db: Db, count: number): number[] {
    return db.transaction(() => Array.from({ length: count }, (_, index) => appendEvent(db, {
      source: "ticket", kind: "stage.changed", entityKey: "ticket:9999", level: "record",
      payload: { itemId: 9999, itemKind: "task", from: "ready", to: "active", actor: "system", reason: `第 ${index + 1} 次` },
    }).event.seq))();
  }
  function turnsCompleted(db: Db, count: number): void {
    db.transaction(() => {
      for (let index = 0; index < count; index += 1) {
        appendEvent(db, { source: "lead", kind: "lead.turn_completed", entityKey: "chat:main", payload: { turnId: `t-${index}`, originKind: "paired:companion" } });
      }
    })();
  }
  function blocker(db: Db, summary: string): number {
    const itemId = createItem(db, { title: summary, brief: "b", createdBy: "user" });
    addInbox(db, { itemId, severity: "blocker", source: "structural", summary, lossless: true });
    return listEvents(db, { kind: "inbox.blocker", order: "desc", limit: 1 })[0]!.seq;
  }
  const userRound = (input: ReturnType<typeof createLeadInput>) => {
    input.beginRun("user");
    const text = input.renderSituation({ queuedUserMessages: 0 });
    input.endRun("succeeded");
    return text;
  };

  it("keeps what it remembers bounded, and loses or repeats nothing across a restart", () => {
    const db = fresh();
    const input = createLeadInput({ db });
    const start = input.cursor().seq;
    const stuck = blocker(db, "一直排着的 blocker");
    let shown = 0;
    let most = 0;
    for (let round = 0; round < 12; round += 1) {
      stageChanges(db, 100);
      const text = userRound(input);
      shown += (text.match(/stage.changed 100/gu) ?? []).length;
      const saved = loadLeadEventCursor(db)!;
      most = Math.max(most, saved.settled.length + (saved.ranges ?? []).length);
    }
    // 每一轮的 100 条变化都在那一轮的当前局面里列过一次。
    expect(shown).toBe(12);
    const saved = loadLeadEventCursor(db)!;
    // 游标还挡在那件事前面；记住的条目没有随着轮数一直加：单个的不超过收紧的门槛，区间只有挡着的那件事后面的一段。
    expect(saved.seq).toBe(start);
    expect(most).toBeLessThanOrEqual(SETTLED_FOLD_THRESHOLD + 1);
    expect(saved.ranges).toHaveLength(1);
    expect(saved.ranges![0]![0]).toBeGreaterThan(stuck);

    // daemon 重启：那件事还要交给 Lead；已经列过的变化不再列。
    const reopened = createLeadInput({ db });
    expect(reopened.pendingMessages().map((event) => event.seq)).toEqual([stuck]);
    stageChanges(db, 1);
    const text = userRound(reopened);
    expect(text).toContain("记录 1 条（stage.changed 1）");
    // 那件事交给 Lead、这一轮成功以后，游标越过所有事件，不再记任何序号。
    reopened.beginRun("events");
    expect(reopened.takeMessages().events.map((event) => event.seq)).toEqual([stuck]);
    reopened.endRun("succeeded");
    expect(loadLeadEventCursor(db)).toMatchObject({ seq: listEvents(db, { order: "desc", limit: 1 })[0]!.seq, settled: [], ranges: [] });
    expect(userRound(reopened)).toContain("上一轮以后的变化：没有。");
    db.close();
  });

  it("still sees a new event when more than a read window of handled events sits behind the blocked cursor", () => {
    const db = fresh();
    const input = createLeadInput({ db });
    const stuck = blocker(db, "一直排着的 blocker");
    // 用户和 Lead 聊了很多轮：每一轮的结果（lead.turn_completed）不交给 Lead，处理完了，但游标越不过前面那件事。
    turnsCompleted(db, 1200);
    userRound(input);
    const fresh_ = blocker(db, "新来的 blocker");
    expect(input.pendingMessages().map((event) => event.seq)).toEqual([stuck, fresh_]);
    expect(createLeadInput({ db }).pendingMessages().map((event) => event.seq)).toEqual([stuck, fresh_]);
    db.close();
  });
});

describe("the situation budget", () => {
  it("merges an object's entries first, then drops the oldest changes and says how many", () => {
    const groups = Array.from({ length: 40 }, (_, index) => ({
      label: `#${index + 1}「工单 ${index + 1}」`,
      lines: Array.from({ length: 5 }, (__, line) => `通知 #${index * 5 + line + 1}：第 ${line + 1} 条进展，写得比较长，好把预算用掉一些`),
      latestSeq: index + 1,
    }));
    const input = {
      now: "2026-10-17T10:00:00+08:00", tickets: [], problems: [], waiting: [], queued: [],
      digest: groups, records: [], unread: 0, leadFailure: null,
    };
    const full = renderLeadSituation(input, 1_000_000);
    expect(full.truncated).toBe(0);
    const tight = renderLeadSituation(input, 600);
    expect(tight.tokens).toBeLessThanOrEqual(600);
    expect(tight.truncated).toBeGreaterThan(0);
    expect(tight.text).toContain(`最早的 ${tight.truncated} 条没有列出`);
    // 先合并：留下来的对象只写最近一条和条数。
    expect(tight.text).toContain("5 条，最近一条：");
    // 截掉的是最旧的：最新的对象还在，最旧的不在。
    expect(tight.text).toContain("#40「工单 40」");
    expect(tight.text).not.toContain("#1「工单 1」");
    expect(estimateTokens(tight.text)).toBe(tight.tokens);
    // 工单 14：写明用 query_events 从游标那里查回来；关于 Lead 自己的事不截断。
    const withCursor = renderLeadSituation({ ...input, sinceSeq: 42, self: ["你的上一次上下文压缩没有成功（超时）。"] }, 600);
    expect(withCursor.text).toContain("要看用 query_events（since_seq=42）查回来");
    expect(withCursor.text).toContain("关于你自己（上一轮以后）：\n- 你的上一次上下文压缩没有成功（超时）。");
  });

  it("keeps the queued lines to category and source", () => {
    const db = fresh();
    const input = createLeadInput({ db });
    const itemId = createItem(db, { title: "部署", brief: "b", createdBy: "user" });
    transition(db, { itemId, to: "active", actor: "system", reason: "run started" });
    addInbox(db, { itemId, severity: "blocker", source: "structural", summary: "机密的 blocker 原文" });
    input.beginRun("user");
    const text = input.renderSituation({ queuedUserMessages: 2, queuedNotifications: 1 });
    expect(text).toContain("用户的排队消息 2 条");
    expect(text).toContain("系统事件 inbox.blocker，来源 system 1 条");
    expect(text).toContain("给用户的即时通知");
    expect(text).not.toContain("机密的 blocker 原文");
    db.close();
  });
});

describe("channel lanes in the situation (ticket 11, spec D14)", () => {
  it("gives each lane one line instead of its events, and settles those events with the round", async () => {
    const db = fresh();
    const service = new FakeHookService();
    const hub = new ChannelHub({
      db, registry: new ChannelRegistry([createFakeHookAdapter(service)]), credentials: { credential: async () => service.credential },
    });
    const input = createLeadInput({ db, lanes: (keys) => hub.laneLines(keys) });
    await hub.receive("hook", service.message("t1", "第一条：请看一下合同"));
    await hub.receive("hook", service.message("t1", "第二条：明天要"));
    input.beginRun("user");
    const first = input.renderSituation({ queuedUserMessages: 0 });
    expect(first).toContain("对话通道");
    // 一行结构化摘要（slack-takeover spec D10）：几条消息、卡号和状态、代查的状态，不带原文。
    expect(first).toMatch(/Webhook · Alice 的 webhook 对话：2 条消息，卡 #\d+ 在会话卡里等用户处理，没有代查/);
    // 道里的事件不逐条列，原文一条也没有。
    expect(first).not.toContain("hook.message.received");
    expect(first).not.toContain("请看一下合同");
    expect(first).not.toContain("明天要");
    expect(first).toContain("上一轮以后的变化：没有。");
    input.endRun("succeeded");
    expect(listEvents(db, { kind: "hook.message.received" }).map((event) => event.disposition)).toEqual(["digested", "digested"]);
    // 卡还没结束：下一份当前局面里这条道仍然有一行，事件不再算变化。
    input.beginRun("user");
    expect(input.renderSituation({ queuedUserMessages: 0 })).toContain("Webhook · Alice 的 webhook 对话");
    input.endRun("succeeded");
    db.close();
  });

  it("lists at most ten lanes and says how many it left out", () => {
    const lanes = Array.from({ length: 12 }, (_value, index) => `来源 · 对话 ${index}：一行`);
    const rendered = renderLeadSituation({
      now: "2026-10-17 10:00", tickets: [], problems: [], waiting: [], queued: [], digest: [], records: [], unread: 0,
      leadFailure: null, lanes,
    });
    expect(rendered.text).toContain("来源 · 对话 9：一行");
    expect(rendered.text).not.toContain("来源 · 对话 10：一行");
    expect(rendered.text).toContain("（另有 2 条道没有列出）");
  });
});

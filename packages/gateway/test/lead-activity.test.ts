// 工单 06（Lead 事件主干 spec D10、D16）：会话里的卡片和状态。
//   · digest、auto 级的事件和常设指令的修改进「Lead 动态」，每条写明依据（常设指令的编号和版本，来自事件的 triage）；
//     record 级不进会话；interrupt 级在输入框上方的横幅上。
//   · 一个对象一张卡：后来的事件和 Lead 记下的处置原地更新同一张卡；对象安静了 2 小时以后再来的事件开一张新卡。
//   · 别处已处理（resolved_elsewhere）的卡片是结束状态，横幅不再提醒。
//   · 推送带 entityKey 和 entityVersion，版本随每一次变化变大；第一次 sync 不推，没变的不推。
//   · 用户确认横幅：有路由（要 notices），写回事件的处置，横幅收起，推送告诉别的客户端。
import { beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { Value } from "typebox/value";
import {
  gatewayEventOptIn, LEAD_ACTIVITY_OPT_IN, LEAD_ACTIVITY_RESOURCE, LeadActivityItemSchema, LeadActivityViewSchema,
  type EventEnvelope, type LeadActivityCard,
} from "@pi-lead-child/protocol";
import {
  acknowledgeInterruptEvent, addInbox, appendEvent, createCliBinding, createItem, createPairing, disposeCorrelatedEvents, findInterruptAck,
  getEvent, openDb, proposeStandingOrderChange, recordInboxDisposition, recordOwnerAction, type Db, type PublishGatewayEventInput,
} from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { createControlPlaneService } from "../src/control-plane.js";
import { buildLeadActivityView, createLeadActivityPublisher, EPISODE_GAP_MS } from "../src/lead-activity.js";
import { startPairedServer } from "../src/paired-server.js";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-lead-activity-"), "plc.db"));
});

function append(envelope: EventEnvelope, basis?: Parameters<typeof appendEvent>[2]) {
  return db.transaction(() => appendEvent(db, envelope, basis))().event;
}

function interrupt(itemId: number, title: string, occurredAt = new Date().toISOString()) {
  return append({
    source: "timer", kind: "timer.fired", entityKey: `reminder:${itemId}`, level: "interrupt", occurredAt,
    payload: { timer: "reminder", scheduledAt: occurredAt, itemId, title, wakeLead: true },
  }, { basis: { order: { id: "reminder.fire", version: 1 } } });
}

function attention(itemId: number, summary: string) {
  return addInbox(db, { itemId, severity: "attention", source: "structural", summary }).id!;
}

function cardOf(view: { cards: LeadActivityCard[] }, entityKey: string): LeadActivityCard {
  const matches = view.cards.filter((card) => card.entityKey === entityKey);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

describe("what goes into Lead activity", () => {
  it("shows digest and auto events with their basis, and leaves record and interrupt events out", () => {
    const itemId = createItem(db, { title: "迁移", brief: "b", createdBy: "lead" });
    attention(itemId, "#1 的子任务完成了");
    append({
      source: "run", kind: "run.finished", entityKey: "run:9", level: "auto",
      payload: { runId: 9, itemId: 99, role: "executor", purpose: "execution", runtime: "codex", from: "running", to: "finished", summary: "自动重试成功" },
    }, { basis: { order: { id: "run.transient_retry", version: 1 } } });
    append({
      source: "ticket", kind: "stage.changed", entityKey: `ticket:${itemId}`, level: "record",
      payload: { itemId, itemKind: "task", from: "ready", to: "active", actor: "system", reason: "派发" },
    });
    const alarm = interrupt(5, "交房租");

    const view = buildLeadActivityView(db);
    expect(Value.Check(LeadActivityViewSchema, view)).toBe(true);
    const digest = cardOf(view, `ticket:${itemId}`);
    expect(digest).toMatchObject({
      kind: "digest", state: "open", ticketId: itemId, summary: "#1 的子任务完成了", count: 1,
      basis: [{ kind: "order", id: "inbox.no_wake", version: 1 }],
    });
    // Run 的事件归到它的工单。
    expect(cardOf(view, "ticket:99")).toMatchObject({
      kind: "auto", summary: "自动重试成功", basis: [{ kind: "order", id: "run.transient_retry", version: 1 }],
    });
    expect(view.cards.every((card) => card.entries.every((entry) => entry.level !== "record" && entry.level !== "interrupt"))).toBe(true);
    expect(view.interrupts.map((item) => item.seq)).toEqual([alarm.seq]);
    expect(view.interrupts[0]).toMatchObject({
      kind: "timer.fired", summary: "提醒「交房租」到点", ticketId: 5, acknowledgedAt: null, resolvedElsewhere: false,
      basis: [{ kind: "order", id: "reminder.fire", version: 1 }],
    });
  });

  it("shows a standing-order change Lead made on its own, with the hard rule that reports it", () => {
    const result = proposeStandingOrderChange(db, {
      op: "update", id: "inbox.no_wake", reason: "这些进展用户想马上知道", patch: { action: { type: "level", level: "tell" }, escalateTo: null },
    });
    expect(result.outcome).toBe("applied");
    const card = cardOf(buildLeadActivityView(db), "standing_order:inbox.no_wake");
    expect(card.kind).toBe("standing_order");
    expect(card.summary).toMatch(/^常设指令「不叫醒 Lead 的事进摘要」修改 v1→v2（Paimon 改得更保守，直接生效）。原因：这些进展用户想马上知道。/u);
    // 10 的说明里重复的开头（「修改常设指令 inbox.no_wake「…」」）去掉了。
    expect(card.summary).not.toContain("修改常设指令 inbox.no_wake");
    expect(card.basis).toEqual([{ kind: "rule", name: "standing_order_change_reported" }]);
  });
});

describe("one object, one card", () => {
  it("updates the same card in place, and hangs Lead's later note under it", () => {
    const itemId = createItem(db, { title: "迁移", brief: "b", createdBy: "lead" });
    const inboxId = attention(itemId, "第一次重试");
    const first = cardOf(buildLeadActivityView(db), `ticket:${itemId}`);

    // 同一行 inbox 合并进来的第二条：同一张卡，位置不变，内容和版本变了。
    expect(attention(itemId, "第二次重试")).toBe(inboxId);
    const second = cardOf(buildLeadActivityView(db), `ticket:${itemId}`);
    expect(second).toMatchObject({ key: first.key, at: first.at, count: 2, summary: "第二次重试" });
    expect(second.entityVersion).toBeGreaterThan(first.entityVersion);

    // Lead 后来记下的处置挂在同一张卡下面，不另起一张。
    recordInboxDisposition(db, [inboxId], { disposition: "handled", reason: "重试成功了，不用管" });
    const view = buildLeadActivityView(db);
    const handled = cardOf(view, `ticket:${itemId}`);
    expect(handled).toMatchObject({
      key: first.key, state: "handled", lead: { disposition: "handled", reason: "重试成功了，不用管" },
    });
    expect(handled.entityVersion).toBeGreaterThan(second.entityVersion);
    expect(view.cards.filter((card) => card.key === `inbox:${inboxId}`)).toEqual([]);
  });

  it("starts a new card when the object comes back after a quiet while", () => {
    const at = Date.parse("2026-10-17T01:00:00.000Z");
    const event = (offsetMs: number, summary: string) => append({
      source: "system", kind: "inbox.attention", entityKey: "ticket:7", level: "digest",
      occurredAt: new Date(at + offsetMs).toISOString(),
      payload: {
        inboxId: 1, itemId: 7, scope: "item:7", severity: "attention", inboxSource: "structural", summary,
        wakeLead: false, needsUser: false, delivery: "row", payload: {},
      },
    });
    event(0, "早上的进展");
    event(30 * 60_000, "半小时后的进展");
    event(30 * 60_000 + EPISODE_GAP_MS + 1, "下午的进展");
    const cards = buildLeadActivityView(db).cards.filter((card) => card.entityKey === "ticket:7");
    expect(cards.map((card) => [card.count, card.summary])).toEqual([[2, "半小时后的进展"], [1, "下午的进展"]]);
  });

  it("keeps listing what Lead handled on rows that have no event in the cards", () => {
    const itemId = createItem(db, { title: "review", brief: "b", createdBy: "lead" });
    const blocker = addInbox(db, { itemId, severity: "blocker", source: "semantic", summary: "核查报了缺陷 F2", lossless: true }).id!;
    recordInboxDisposition(db, [blocker], { disposition: "deferred", reason: "等最终结论一起说" });
    const card = buildLeadActivityView(db).cards.find((item) => item.key === `inbox:${blocker}`);
    expect(card).toMatchObject({
      kind: "lead", state: "handled", summary: "核查报了缺陷 F2", lead: { disposition: "deferred", reason: "等最终结论一起说" },
      basis: [{ kind: "order", id: "inbox.wake_lead", version: 1 }],
    });
  });
});

// 改版稿第 2 组（2026-10-28）：你允许的写入和 Lead 记下的处置是同一件事。卡带上这次主人操作，会话里那一行并进来。
describe("an owner action on the same object", () => {
  it("rides on the card Lead handled, so the conversation draws the approval once", () => {
    const inbox = addInbox(db, {
      dedupScope: "connection_confirmation:cfm_1", severity: "attention", source: "structural", lossless: true,
      summary: "用户允许了写入，已经执行：GitHub 的 add_comment（在 PR #119 加第 1/2 条行内评论）。结果：ok",
      payload: { kind: "connection_confirmation", confirmation: "cfm_1", state: "done", wakeLead: true, needsUser: false },
    }).id!;
    recordInboxDisposition(db, [inbox], { disposition: "handled", reason: "已经执行，不用再说" });
    const { binding } = createCliBinding(db, { name: "plc" });
    const { event: performed } = recordOwnerAction(db, {
      action: "connection.confirm", summary: "允许GitHub写入：在 PR #119 加第 1/2 条行内评论",
      target: { key: "connection_confirmation:cfm_1", label: "GitHub 的写入确认", ticketId: null },
      detail: { approve: true, tool: "add_comment", state: "done" },
      credential: binding, source: { client: "web", deviceName: "Mac 网页", loopback: true, fromThisMachine: true },
    });
    const view = buildLeadActivityView(db);
    expect(Value.Check(LeadActivityViewSchema, view)).toBe(true);
    expect(cardOf(view, "connection_confirmation:cfm_1").ownerAction).toEqual({
      eventId: performed.eventId, action: "connection.confirm", summary: "允许GitHub写入：在 PR #119 加第 1/2 条行内评论",
      target: "GitHub 的写入确认", failed: false,
    });
  });

  // 2026-10-28 线上：#117 的几条后台记录被标成「你允许了」，挂的是 10-25 那次 Lead 代你验收。工单一直在，
  // 它上面最近一次主人操作和后来的记录没有因果。只认你本人做的、引出这一行的那一次。
  it("does not hang an owner action Lead did for you, or one from days before, on a later ticket card", () => {
    const itemId = createItem(db, { title: "review", brief: "b", createdBy: "lead" });
    const { binding } = createCliBinding(db, { name: "plc" });
    const target = { key: `ticket:${itemId}`, label: `工单 #${itemId}`, ticketId: itemId };
    recordOwnerAction(db, {
      action: "ticket.complete", summary: `代你验收了工单 #${itemId}`, target, credential: binding,
      source: { client: "lead", deviceName: "我的电脑", loopback: true, fromThisMachine: true },
    });
    recordOwnerAction(db, {
      action: "ticket.complete", summary: `验收了工单 #${itemId}`, target, credential: binding, now: new Date(Date.now() - 3 * 86_400_000),
      source: { client: "web", deviceName: "Mac 网页", loopback: true, fromThisMachine: true },
    });
    const row = addInbox(db, { itemId, severity: "attention", source: "structural", summary: "工单有新进展", lossless: true }).id!;
    recordInboxDisposition(db, [row], { disposition: "handled", reason: "进展正常" });
    const cards = buildLeadActivityView(db).cards.filter((item) => item.entityKey === `ticket:${itemId}`);
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.some((item) => "ownerAction" in item)).toBe(false);
    // 你刚验收了它，几分钟后它出了别的事：验收不是在回答一个请求，那一行说的是别的事，也不算。
    recordOwnerAction(db, {
      action: "ticket.complete", summary: `验收了工单 #${itemId}`, target, credential: binding,
      source: { client: "web", deviceName: "Mac 网页", loopback: true, fromThisMachine: true },
    });
    expect(buildLeadActivityView(db).cards.filter((item) => item.entityKey === `ticket:${itemId}`).some((item) => "ownerAction" in item)).toBe(false);
    // 最近的一次是 Lead 刚代你做的：时间对得上，也不算。
    recordOwnerAction(db, {
      action: "ticket.complete", summary: `代你验收了工单 #${itemId}`, target, credential: binding,
      source: { client: "lead", deviceName: "我的电脑", loopback: true, fromThisMachine: true },
    });
    expect(buildLeadActivityView(db).cards.filter((item) => item.entityKey === `ticket:${itemId}`).some((item) => "ownerAction" in item)).toBe(false);
  });

  // 线上的写入确认：结果行在执行时就写下了，比网关记主人操作早几毫秒。前后都算；失败的结果照样认出来。
  it("takes the owner action recorded just after the row, and says when it did not go through", () => {
    const { binding } = createCliBinding(db, { name: "plc" });
    const row = addInbox(db, {
      dedupScope: "connection_confirmation:cfm_2", severity: "attention", source: "structural", lossless: true,
      summary: "用户允许了写入，但执行失败：GitHub 的 add_comment。原因：行号不在改动里",
      payload: { kind: "connection_confirmation", confirmation: "cfm_2", state: "failed" },
    }).id!;
    const { event: performed } = recordOwnerAction(db, {
      action: "connection.confirm", summary: "允许GitHub写入：在 PR #119 加第 2/2 条行内评论",
      target: { key: "connection_confirmation:cfm_2", label: "GitHub 的写入确认", ticketId: null },
      detail: { approve: true, tool: "add_comment", state: "failed" }, credential: binding, now: new Date(Date.now() + 6),
      source: { client: "web", deviceName: "Mac 网页", loopback: true, fromThisMachine: true },
    });
    recordInboxDisposition(db, [row], { disposition: "handled", reason: "等你决定" });
    expect(cardOf(buildLeadActivityView(db), "connection_confirmation:cfm_2").ownerAction).toMatchObject({ eventId: performed.eventId, failed: true });
  });

  it("leaves the field off cards no owner action touched", () => {
    const itemId = createItem(db, { title: "review", brief: "b", createdBy: "lead" });
    const blocker = addInbox(db, { itemId, severity: "blocker", source: "semantic", summary: "核查报了缺陷 F2", lossless: true }).id!;
    recordInboxDisposition(db, [blocker], { disposition: "deferred", reason: "等最终结论一起说" });
    const card = buildLeadActivityView(db).cards.find((item) => item.key === `inbox:${blocker}`)!;
    expect("ownerAction" in card).toBe(false);
  });
});

describe("resolved elsewhere", () => {
  it("shows the card as ended, and takes the event off the banner", () => {
    const itemId = createItem(db, { title: "审批", brief: "b", createdBy: "lead" });
    const inboxId = attention(itemId, "等你批准部署");
    const alarm = append({
      source: "timer", kind: "timer.fired", entityKey: `ticket:${itemId}`, level: "interrupt", correlationId: `inbox:${inboxId}`,
      payload: { timer: "reminder", scheduledAt: new Date().toISOString(), itemId, title: "部署窗口快关了", wakeLead: true },
    });
    expect(buildLeadActivityView(db).interrupts.map((item) => item.seq)).toEqual([alarm.seq]);

    disposeCorrelatedEvents(db, `inbox:${inboxId}`, "resolved_elsewhere", { reason: "用户在 Slack 里自己批了" });
    const view = buildLeadActivityView(db);
    expect(cardOf(view, `ticket:${itemId}`).state).toBe("resolved_elsewhere");
    expect(view.interrupts).toEqual([]);
  });
});

describe("the interrupt banner", () => {
  it("stays until the user acknowledges it, and the acknowledgement survives Lead changing its mind", () => {
    const itemId = createItem(db, { title: "值班", brief: "b", createdBy: "lead" });
    const inboxId = addInbox(db, { itemId, severity: "attention", source: "structural", summary: "占位", lossless: true }).id!;
    const alarm = append({
      source: "timer", kind: "timer.fired", entityKey: `reminder:${itemId}`, level: "interrupt", correlationId: `inbox:${inboxId}`,
      payload: { timer: "reminder", scheduledAt: new Date().toISOString(), itemId, title: "开会", wakeLead: true },
    });
    const before = buildLeadActivityView(db).interrupts[0]!;

    const acked = acknowledgeInterruptEvent(db, alarm.seq, { bindingId: 3, at: new Date("2026-10-17T02:00:00.000Z") });
    expect(acked.inserted).toBe(true);
    expect(getEvent(db, alarm.seq)).toMatchObject({
      disposition: "interrupted_user",
      dispositionDetail: { acknowledgedAt: "2026-10-17T02:00:00.000Z", acknowledgedBy: "user", bindingId: 3, ackSeq: acked.ack.seq },
    });
    expect(acked.ack).toMatchObject({ kind: "event.acknowledged", level: "record", causationId: alarm.eventId, entityKey: alarm.entityKey });
    expect(buildLeadActivityView(db).interrupts).toEqual([]);

    // 重复确认是幂等的。
    expect(acknowledgeInterruptEvent(db, alarm.seq).inserted).toBe(false);
    // Lead 后来改口，覆盖了处置：横幅仍然按确认事件判断，不会回来。
    recordInboxDisposition(db, [inboxId], { disposition: "handled", reason: "会议改期了" });
    expect(getEvent(db, alarm.seq)!.disposition).toBe("handled");
    expect(findInterruptAck(db, alarm.eventId)).toBeDefined();
    expect(buildLeadActivityView(db).interrupts).toEqual([]);
    expect(before.entityVersion).toBeLessThan(acked.ack.seq + 1);
  });
});

describe("pushing projection changes", () => {
  function collect() {
    const pushed: PublishGatewayEventInput[] = [];
    return { pushed, publish: (event: PublishGatewayEventInput) => { pushed.push(event); } };
  }

  it("pushes only what changed, with entityKey and a growing entityVersion", () => {
    const itemId = createItem(db, { title: "迁移", brief: "b", createdBy: "lead" });
    const old = attention(itemId, "启动之前就有的");
    const publisher = createLeadActivityPublisher(db);
    const sink = collect();
    // 第一次只记下现在的样子：daemon 重启不该把所有卡再推一遍。
    expect(publisher.sync(sink.publish)).toBe(0);

    const other = createItem(db, { title: "文档", brief: "b", createdBy: "lead" });
    attention(other, "文档写好了");
    expect(publisher.sync(sink.publish)).toBe(1);
    const [push] = sink.pushed;
    expect(push).toMatchObject({
      type: "snapshot.required", requiredScope: "chat", itemId: other,
      payload: { resource: LEAD_ACTIVITY_RESOURCE, entityKey: `ticket:${other}` },
    });
    const card = push!.payload.card as LeadActivityCard;
    expect(push!.payload.entityVersion).toBe(card.entityVersion);
    expect(gatewayEventOptIn({ type: push!.type, payload: push!.payload })).toBe(LEAD_ACTIVITY_OPT_IN);
    // 没变的不推。
    expect(publisher.sync(sink.publish)).toBe(0);

    // 处置的变化没有新事件，下一次 sync 发现它。
    recordInboxDisposition(db, [old], { disposition: "no_action", reason: "已经过时" });
    expect(publisher.sync(sink.publish)).toBe(1);
    const later = sink.pushed.at(-1)!;
    expect(later.payload).toMatchObject({ entityKey: `ticket:${itemId}`, card: { state: "handled", lead: { reason: "已经过时" } } });

    // 到点的提醒是 interrupt 级：横幅一条，会话里的提醒卡一张（工单 07）。
    const alarm = interrupt(itemId, "开会");
    expect(publisher.sync(sink.publish)).toBe(2);
    expect(sink.pushed.at(-2)!.payload).toMatchObject({ reminder: { seq: alarm.seq, state: "fired" } });
    const shown = sink.pushed.at(-1)!.payload;
    expect(shown).toMatchObject({ interrupt: { seq: alarm.seq, acknowledgedAt: null } });
    acknowledgeInterruptEvent(db, alarm.seq);
    expect(publisher.sync(sink.publish)).toBe(1);
    const closed = sink.pushed.at(-1)!.payload;
    expect(closed).toMatchObject({ interrupt: { seq: alarm.seq, acknowledgedAt: expect.any(String) } });
    expect(closed.entityVersion as number).toBeGreaterThan(shown.entityVersion as number);
  });
});

describe("HTTP", () => {
  function runtime() {
    return { model: "stub/model", sessionId: "stub-session", busy: false, runningItemIds: [], aish: null };
  }

  async function start() {
    const controlPlane = createControlPlaneService(db, { runtime });
    const server = await startPairedServer({
      db, controlPlane,
      hello: () => runtime(), chat: () => "started", addClient: () => () => {}, log: () => {},
    }, { port: 0 });
    return { ...server, base: `http://127.0.0.1:${server.port}` };
  }

  async function redeem(base: string, scopes: string[]) {
    const { code } = createPairing(db, { name: "phone", kind: "companion", scopes });
    const response = await fetch(`${base}/v1/paired/redeem`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pairing_code: code }),
    });
    return (await response.json() as { access_token: string; binding: { id: number } });
  }

  // 完整的落库流程：事件写进日志 → 快照里有卡和横幅 → 用户确认 → 处置写回、确认事件落库、推送落进 gateway_events → 快照里没有了。
  it("serves the new shape only when asked, and lets the user acknowledge the banner", async () => {
    const itemId = createItem(db, { title: "迁移", brief: "b", createdBy: "lead" });
    attention(itemId, "进展");
    const alarm = interrupt(itemId, "开会");
    const record = append({
      source: "ticket", kind: "stage.changed", entityKey: `ticket:${itemId}`, level: "record",
      payload: { itemId, itemKind: "task", from: "ready", to: "active", actor: "system", reason: "派发" },
    });
    const server = await start();
    try {
      const reader = await redeem(server.base, ["chat"]);
      const headers = { authorization: `Bearer ${reader.access_token}` };
      const legacy = await (await fetch(`${server.base}/v1/lead/activity`, { headers })).json() as { items: unknown[] };
      expect(legacy.items.every((item) => Value.Check(LeadActivityItemSchema, item))).toBe(true);
      const view = await (await fetch(`${server.base}/v1/lead/activity?include=events`, { headers })).json();
      expect(Value.Check(LeadActivityViewSchema, view)).toBe(true);
      expect(view.cards.map((card: LeadActivityCard) => card.entityKey)).toEqual([`ticket:${itemId}`]);
      expect(view.interrupts.map((item: { seq: number }) => item.seq)).toEqual([alarm.seq]);

      // 确认要 notices，和确认通知一样。
      const denied = await fetch(`${server.base}/v1/lead/interrupts/${alarm.seq}/ack`, { method: "POST", headers });
      expect(denied.status).toBe(403);
      const user = await redeem(server.base, ["chat", "notices"]);
      const userHeaders = { authorization: `Bearer ${user.access_token}` };
      expect((await fetch(`${server.base}/v1/lead/interrupts/999999/ack`, { method: "POST", headers: userHeaders })).status).toBe(404);
      expect((await fetch(`${server.base}/v1/lead/interrupts/${record.seq}/ack`, { method: "POST", headers: userHeaders })).status).toBe(409);

      const pushesBefore = (db.prepare("SELECT COUNT(*) AS n FROM gateway_events WHERE event_type = 'snapshot.required'").get() as { n: number }).n;
      const acked = await fetch(`${server.base}/v1/lead/interrupts/${alarm.seq}/ack`, { method: "POST", headers: userHeaders });
      expect(acked.status).toBe(200);
      const body = await acked.json() as { interrupt: { seq: number; acknowledgedAt: string | null } };
      expect(body.interrupt).toMatchObject({ seq: alarm.seq, acknowledgedAt: expect.any(String) });
      expect(getEvent(db, alarm.seq)).toMatchObject({ disposition: "interrupted_user", dispositionDetail: { bindingId: user.binding.id } });
      expect(findInterruptAck(db, alarm.eventId)).toMatchObject({ kind: "event.acknowledged" });
      // 别的客户端由推送收起横幅。
      const pushes = db.prepare(
        "SELECT payload FROM gateway_events WHERE event_type = 'snapshot.required' ORDER BY seq",
      ).all() as Array<{ payload: string }>;
      expect(pushes.length).toBe(pushesBefore + 1);
      expect(JSON.parse(pushes.at(-1)!.payload)).toMatchObject({
        resource: LEAD_ACTIVITY_RESOURCE, interrupt: { seq: alarm.seq, acknowledgedAt: expect.any(String) },
      });
      const after = await (await fetch(`${server.base}/v1/lead/activity?include=events`, { headers })).json();
      expect(after.interrupts).toEqual([]);
      // 再点一次也是 200，不再推。
      expect((await fetch(`${server.base}/v1/lead/interrupts/${alarm.seq}/ack`, { method: "POST", headers: userHeaders })).status).toBe(200);
    } finally {
      await server.close();
    }
  });
});

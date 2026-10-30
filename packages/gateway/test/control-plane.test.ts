import { beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { listEvents, openDb, recordStandingOrderVersion, SYSTEM_STANDING_ORDERS, type Db } from "@pi-lead-child/store";
import { appendBody, createItem, markLightTask, setItemTime, transition } from "@pi-lead-child/store";
import { createRun, markRunStopped, updateRun } from "@pi-lead-child/store";
import { addActivity } from "@pi-lead-child/store";
import { addInbox, addLeadFollowUp, escalateLeadBacklog, listLeadBacklog, raiseBlocker } from "@pi-lead-child/store";
import { ticketNeedsUser, type StandingOrderCondition } from "@pi-lead-child/protocol";
import { createApproval } from "@pi-lead-child/store";
import { claimTriggerOccurrence, completeTriggerFire, createCronTrigger, getTrigger } from "@pi-lead-child/store";
import { createMilestone, setAgendaNote } from "@pi-lead-child/store";
import { createTurn, publishGatewayEvent } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { createControlPlaneService } from "../src/control-plane.js";
import { createCoordinator, createOrchestrator } from "@pi-lead-child/engine";
import { createProject, linkProjectRepository, mergeProjects, setItemDisplayTitle, setProjectStatus, updateProjectSummary } from "@pi-lead-child/store";
import { createRuntimeEventStore } from "@pi-lead-child/store";
import { upsertItemExecutionCard } from "@pi-lead-child/store";
import { insertCheckpoint, markInboxSeen, recordInboxDisposition } from "@pi-lead-child/store";
import { linkTickets } from "@pi-lead-child/store";
import { insertOutcomeSnapshot, normalizeOutcomePayload } from "@pi-lead-child/store";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-"), "plc.db"));
});

function runtime(runningItemIds: number[] = []) {
  return {
    model: "openai/gpt-5.6-sol",
    sessionId: "lead-session",
    busy: false,
    runningItemIds,
    aish: { connected: true, bot: "bwen_pi" },
  };
}

describe("ticket summary line", () => {
  it("regression #66: an appended reviewer report does not become the task summary", () => {
    const itemId = createItem(db, {
      title: "outcome snapshot and registry mechanism",
      brief: "User-requested real follow-up: implement the outcome snapshot mechanism.\nDo not start until #45 is done.",
      createdBy: "user",
    });
    // reviewer 按提示词用 body_append 写回的报告，以及用户返工时追加的请求（#66 的 body 就是这两段）。
    appendBody(db, itemId, "【独立核查报告】\n1. 依赖闸门 #45：通过。");
    appendBody(db, itemId, "【用户返工请求】\nreason: 用户授权 Lead 自动返工");

    const service = createControlPlaneService(db, { runtime: () => runtime() });
    expect(service.listItems().find((ticket) => ticket.id === itemId)!.summary)
      .toBe("User-requested real follow-up: implement the outcome snapshot mechanism.");
  });

  it("falls back to the body when the brief is empty, as reminders are created", () => {
    const itemId = createItem(db, { kind: "reminder", title: "call", brief: "", createdBy: "lead", remindAt: "2026-07-23T05:00:00.000Z" });
    appendBody(db, itemId, "给物业打电话\n问清楚维修时间");

    const service = createControlPlaneService(db, { runtime: () => runtime() });
    expect(service.listItems().find((ticket) => ticket.id === itemId)!.summary).toBe("给物业打电话");
  });
});

describe("control-plane snapshots", () => {
  it("maps ticket fields, runtime health, attention, activities and attempts", () => {
    const itemId = createItem(db, {
      title: "协议实现", brief: "实现 paired v2", createdBy: "system",
      priority: "high", project: "pi-lead-child", workdir: "/tmp/protocol",
    });
    transition(db, { itemId, to: "active", actor: "system", reason: "started" });
    const runId = createRun(db, { itemId });
    updateRun(db, runId, { state: "running", model: "gpt-5.6-sol" });
    db.prepare("UPDATE items SET body = ?, last_activity_at = ?, updated_at = ? WHERE id = ?")
      .run("第一阶段完成\n\n更多内容", "2026-07-23 05:00:00", "2026-07-23 05:00:00", itemId);
    addInbox(db, { itemId, severity: "blocker", source: "structural", summary: "needs input" });
    createApproval(db, { itemId, requestedBy: "child", tool: "delete", action: "删除临时资源" });
    addActivity(db, { itemId, runId, actor: "child", kind: "milestone", payload: { text: "完成" } });

    const service = createControlPlaneService(db, {
      runtime: () => runtime([itemId]),
      now: () => new Date("2026-07-23T05:02:00.000Z"),
      staleMs: 15 * 60_000,
    });
    const summary = service.listItems()[0];
    expect(summary).toEqual(expect.objectContaining({
      id: itemId,
      // 摘要说的是任务本身（brief）。body 是追加的记录，第一行是最早的那条追加，不是任务。
      summary: "实现 paired v2",
      status: "active",
      priority: "high",
      project: "pi-lead-child",
      updatedAt: "2026-07-23T05:00:00.000Z",
      runtime: { state: "running", lastActivityAt: "2026-07-23T05:00:00.000Z", activeAttemptId: runId },
      attention: { pendingApprovalCount: 1, blockerCount: 1 },
    }));

    expect(service.getItem(itemId)).toEqual(expect.objectContaining({
      ticket: summary,
      brief: "实现 paired v2",
      body: "第一阶段完成\n\n更多内容",
      workdir: "/tmp/protocol",
    }));
    expect(service.listRuns(itemId)).toEqual([
      expect.objectContaining({ id: runId, ticketId: itemId, state: "running", model: "gpt-5.6-sol" }),
    ]);
    expect(service.listActivities(itemId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ ticketId: itemId, attemptId: runId, actor: "child", kind: "milestone", payload: { text: "完成" } }),
    ]));
  });

  // 2026-10-15 用户决定：异常先交给 Lead，除非需要用户介入，UI 只给弱反馈。
  it("does not count a Lead-first blocker as needing the user until it is escalated", () => {
    const itemId = createItem(db, { title: "handoff", brief: "b", createdBy: "lead" });
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    transition(db, { itemId, to: "blocked", actor: "system", reason: "handoff failed" });
    raiseBlocker(db, { itemId, code: "terminal_handoff_failed", title: "交接失败", summary: "s", source: "structural", needsUser: false });
    const service = createControlPlaneService(db, { runtime: () => runtime() });
    const summary = () => service.listItems().find((item) => item.id === itemId)!;
    expect(summary().attention).toEqual({ pendingApprovalCount: 0, blockerCount: 0, leadHandling: true });
    expect(ticketNeedsUser(summary())).toBeNull();

    escalateLeadBacklog(db, listLeadBacklog(db).map((row) => row.id), { reason: "Lead 的模型调用失败" });
    expect(summary().attention).toEqual({ pendingApprovalCount: 0, blockerCount: 1 });
    expect(ticketNeedsUser(summary())).toBe("blocked");
  });

  // 2026-10-15 live（#66）：Lead 给自己设了 19:10 的跟进，工单就一直显示「Lead 处理中」，
  // 可是这张单返工已经用完，在等用户三选一。跟进只是 Lead 的提醒，不是它正在处理的异常。
  it("does not count Lead's own follow-up reminder as Lead handling", () => {
    const itemId = createItem(db, { title: "review", brief: "b", createdBy: "lead" });
    addLeadFollowUp(db, { at: new Date("2026-10-15T11:10:00.000Z"), note: "看 #66 核查的最终报告", itemId });
    const service = createControlPlaneService(db, { runtime: () => runtime() });
    expect(service.listItems().find((item) => item.id === itemId)!.attention).toEqual({ pendingApprovalCount: 0, blockerCount: 0 });
  });

  // 发布评审 reliability-backlog 复核：派发连续被拒、达到上限后，blocker 是交给 Lead 的。以前它没带 needsUser:false，
  // 界面显示成「等你」，不是「Lead 处理中」。
  it("shows a ticket whose dispatch was refused too often as Lead handling, not as needing the user", async () => {
    const previous = process.env.PLC_DISPATCH_REFUSED_START_LIMIT;
    process.env.PLC_DISPATCH_REFUSED_START_LIMIT = "1";
    try {
      const itemId = createItem(db, { title: "refused", brief: "b", createdBy: "lead" });
      const orchestrator = createOrchestrator(db, {
        onDispatch: (claim) => {
          markRunStopped(db, claim.runId, { errorCode: "run_start_refused", errorMessage: "item already has a live runtime" });
        },
      });
      orchestrator.dispatcher.request({
        itemId, role: "executor", purpose: "execution", runtime: "codex", trigger: "test", idempotencyKey: "refused-cap",
      });
      await orchestrator.tick();
      await orchestrator.tick();
      expect(db.prepare(
        "SELECT COUNT(*) AS n FROM inbox WHERE item_id=? AND json_extract(payload, '$.blockerCode')='dispatch_start_refused'",
      ).get(itemId)).toEqual({ n: 1 });

      const summary = createControlPlaneService(db, { runtime: () => runtime() }).listItems().find((item) => item.id === itemId)!;
      expect(summary.attention).toMatchObject({ blockerCount: 0, leadHandling: true });
      expect(ticketNeedsUser(summary)).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.PLC_DISPATCH_REFUSED_START_LIMIT;
      else process.env.PLC_DISPATCH_REFUSED_START_LIMIT = previous;
    }
  });

  it("marks a ticket Lead is handling because of a runtime incident that first appeared on it", () => {
    const itemId = createItem(db, { title: "review", brief: "b", createdBy: "lead" });
    addInbox(db, {
      dedupScope: "runtime-incident:1", severity: "attention", source: "structural", summary: "Codex 不支持该模型",
      payload: { kind: "runtime_incident", wakeLead: true, needsUser: false, openedItemId: itemId }, lossless: true,
    });
    const service = createControlPlaneService(db, { runtime: () => runtime() });
    expect(service.listItems().find((item) => item.id === itemId)!.attention.leadHandling).toBe(true);
  });

  // 工单 14 第 2 项：「Lead 处理中」以前是一份写死的 SQL（blocker，或者 payload.wakeLead=1），不跟常设指令走。
  // 常设指令 inbox.wake_lead 改了叫醒条件以后，Lead 收到的变了（事件的级别），界面却照旧。
  // 现在界面读这一行的事件有没有作为消息交给 Lead（tell、interrupt 级），和 Lead 实际收到的一致。
  describe("follows what Lead actually receives, as the standing order decides it", () => {
    const wakeOrder = () => SYSTEM_STANDING_ORDERS.find((order) => order.id === "inbox.wake_lead")!;
    const setWakeWhen = (wakeWhen: StandingOrderCondition) => recordStandingOrderVersion(db, {
      ...wakeOrder(),
      action: { type: "rule", rule: "inbox.wake_lead", params: { wakeWhen }, level: "tell" },
      reason: "测试",
    }, { author: "user", approvedBy: "user" });
    const incident = (itemId: number, payload: Record<string, unknown>) => addInbox(db, {
      dedupScope: `runtime-incident:${itemId}`, severity: "attention", source: "structural", summary: "Codex 不支持该模型",
      payload: { kind: "runtime_incident", needsUser: false, openedItemId: itemId, ...payload }, lossless: true,
    });
    const leadHandling = (itemId: number) =>
      createControlPlaneService(db, { runtime: () => runtime() }).listItems().find((item) => item.id === itemId)!.attention.leadHandling ?? false;

    it("stops showing Lead handling when the order no longer wakes Lead for a flagged attention", () => {
      // 新版本：只有 blocker 叫醒 Lead，标了 wakeLead 的 attention 也不叫醒，进摘要。
      setWakeWhen({ anyOf: [{ fields: { severity: "blocker", "payload.wakeLead": { not: false } } }] });
      const itemId = createItem(db, { title: "review", brief: "b", createdBy: "lead" });
      incident(itemId, { wakeLead: true });
      expect(listEvents(db, { kind: "inbox.attention" }).at(-1)).toMatchObject({ level: "digest" });
      expect(leadHandling(itemId)).toBe(false);
    });

    it("shows Lead handling when the order wakes Lead for a row the old rule ignored", () => {
      // 新版本：runtime 故障的说明不管标没标，都叫醒 Lead。
      setWakeWhen({
        anyOf: [
          { fields: { severity: "blocker", "payload.wakeLead": { not: false } } },
          { fields: { "payload.wakeLead": true } },
          { fields: { "payload.kind": "runtime_incident" } },
        ],
      });
      const itemId = createItem(db, { title: "review", brief: "b", createdBy: "lead" });
      incident(itemId, {});
      expect(listEvents(db, { kind: "inbox.attention" }).at(-1)).toMatchObject({ level: "tell" });
      expect(leadHandling(itemId)).toBe(true);
    });

    it("stops showing Lead handling once Lead has handled the row", () => {
      const itemId = createItem(db, { title: "review", brief: "b", createdBy: "lead" });
      const { id } = incident(itemId, { wakeLead: true });
      expect(leadHandling(itemId)).toBe(true);
      db.prepare("UPDATE inbox SET state = 'consumed' WHERE id = ?").run(id);
      expect(leadHandling(itemId)).toBe(false);
    });
  });

  // 2026-10-16 用户要求：收件箱的主按钮写「派发独立核查」，会话里的决定卡问的却是「并入 #72 / 再返工 / 取消」。
  // 工单上有等用户回答的决策请求时，摘要要说出来，每个界面才会都说「待你决定」、不另推荐别的动作。
  it("counts the blocking decisions the user can answer, until the user chooses", () => {
    const itemId = createItem(db, { title: "outcome", brief: "b", createdBy: "lead" });
    const coordinator = createCoordinator({ db });
    const ask = (audience: "user" | "lead_or_user" | "lead") => coordinator.requestDecision({
      itemId, runId: audience === "lead" ? createRun(db, { itemId, runtime: "codex" }) : null,
      origin: audience === "lead" ? "agent" : "lead", kind: "decision", audience, blocking: true,
      prompt: `${audience} 怎么办？`, options: [{ id: "merge", label: "并入 #72" }],
      checkpoint: { title: "要决定", summary: "s" },
    }).requestId;
    const service = createControlPlaneService(db, { runtime: () => runtime() });
    const summary = () => service.listItems().find((item) => item.id === itemId)!;

    ask("lead");
    expect(summary().attention).not.toHaveProperty("pendingDecisionCount");
    const owed = ask("user");
    ask("lead_or_user");
    expect(summary().attention.pendingDecisionCount).toBe(2);
    expect(ticketNeedsUser(summary())).toBe("decision");

    coordinator.resolveDecision({
      requestId: owed, decision: "select", optionId: "merge",
      actor: { kind: "user", resolvedBy: "user via paired binding:7" },
    });
    expect(summary().attention.pendingDecisionCount).toBe(1);
  });

  it("never projects historical blockers as active attention on terminal items", () => {
    const itemId = createItem(db, { title: "done", brief: "b", createdBy: "lead" });
    db.prepare("UPDATE items SET stage='done' WHERE id=?").run(itemId);
    addInbox(db, {
      itemId,
      severity: "blocker",
      source: "structural",
      summary: "historical derived warning",
    });

    const ticket = createControlPlaneService(db, { runtime: () => runtime() })
      .listItems().find((item) => item.id === itemId);

    expect(ticket).toMatchObject({
      stage: "done",
      status: "done",
      attention: { blockerCount: 0 },
    });
  });

  it("keeps child-created root fixtures out of the primary worklist", () => {
    const owner = createItem(db, { title: "E2E owner", brief: "b", createdBy: "system" });
    const runId = createRun(db, { itemId: owner });
    const fixture = createItem(db, {
      title: "root fixture",
      brief: "root semantics",
      createdBy: "child",
      createdByRunId: runId,
    });
    const service = createControlPlaneService(db, { runtime: () => runtime() });

    expect(service.listItems().find((item) => item.id === fixture)?.worklistVisibility).toBe("background");
  });

  // 实例上的 #52、#71、#73、#74、#82：系统从失败里建的「沉淀失败经验」工单，ready、没有 Run，
  // 混在用户的「进行中」里。它们是 Lead 的后台工作；Lead 自己建的学习任务和用户的工单不受影响。
  it("files the system's learning tickets as background work", () => {
    const learning = createItem(db, {
      title: "沉淀失败经验：Selected model is at capacity", brief: "b", createdBy: "system", purpose: "learning",
    });
    const leadLearning = createItem(db, { title: "整理经验", brief: "b", createdBy: "lead", purpose: "learning" });
    const userWork = createItem(db, { title: "Dialogue Returns 迁移", brief: "b", createdBy: "lead" });
    const items = createControlPlaneService(db, { runtime: () => runtime() }).listItems();
    const visibility = (id: number) => items.find((item) => item.id === id)?.worklistVisibility;

    expect(visibility(learning)).toBe("background");
    expect(visibility(leadLearning)).toBe("primary");
    expect(visibility(userWork)).toBe("primary");
  });

  // lead-tools-and-routing spec D9：Lead 派的轻子 agent 和通道派的代查不占用户的工作列表，结果由 Lead 告诉用户。
  it("files light sub-agent tickets and channel lookups as background work", () => {
    const light = createItem(db, { title: "评审 PR #217", brief: "b", createdBy: "lead" });
    markLightTask(db, light, "lead");
    const lookup = createItem(db, { title: "Slack 代查", brief: "b", createdBy: "system", purpose: "lookup" });
    const ordinary = createItem(db, { title: "修 bug", brief: "b", createdBy: "lead" });
    const items = createControlPlaneService(db, { runtime: () => runtime() }).listItems();
    const visibility = (id: number) => items.find((item) => item.id === id)?.worklistVisibility;
    expect(visibility(light)).toBe("background");
    expect(visibility(lookup)).toBe("background");
    expect(visibility(ordinary)).toBe("primary");
  });

  it("projects outcome snapshot facts without conflating review evidence and acceptance", () => {
    const itemId = createItem(db, {
      title: "Outcome projection",
      brief: "separate facts",
      createdBy: "system",
      workdir: "/tmp/outcome-projection",
    });
    transition(db, { itemId, to: "active", actor: "system", reason: "started" });
    const executorRunId = createRun(db, { itemId, runtime: "codex" });
    updateRun(db, executorRunId, { state: "finished", endedAt: true, exitCode: 0 });
    insertOutcomeSnapshot(db, {
      itemId,
      executorRunId,
      source: "system_recovered",
      sourceEventSeq: 2,
      sourceOutputSha256: "a".repeat(64),
      outcome: normalizeOutcomePayload({
        summary: "Implemented outcome projection.",
        changes: [{ kind: "file", ref: "src/coordinator/workbench.ts", summary: "Projected facts" }],
        deliverables: [{ kind: "path", ref: "src/coordinator/workbench.ts", label: "Workbench projection" }],
        validations: [{
          command: "npm run typecheck",
          outcome: "passed",
          exitCode: 0,
          summary: "typecheck passed",
          evidenceRef: null,
        }],
      }, { workdir: "/tmp/outcome-projection" }),
      now: new Date("2026-08-17T08:00:00.000Z"),
    });
    transition(db, { itemId, to: "review", actor: "system", reason: "await review" });
    const reviewerRunId = createRun(db, { itemId, role: "reviewer", runtime: "codex" });
    updateRun(db, reviewerRunId, { state: "finished", endedAt: true, exitCode: 0 });
    db.prepare(
      `INSERT INTO review_verdicts
       (run_id, item_id, verdict, evidence, evidence_refs)
       VALUES (?, ?, 'pass', 'verified independently', ?)`,
    ).run(reviewerRunId, itemId, JSON.stringify(["checkpoint:review"]));
    transition(db, { itemId, to: "done", actor: "user", reason: "accepted" });

    const service = createControlPlaneService(db, { runtime: () => runtime() });
    expect(service.getKernelTicketWorkbenchV2(itemId)?.outcomeSnapshot).toMatchObject({
      latest: {
        executorAttemptId: executorRunId,
        source: "system_recovered",
        summary: "Implemented outcome projection.",
        completeness: "complete",
      },
      historyCount: 1,
      facts: {
        implementationCompleted: true,
        independentEvidence: "complete",
        acceptance: "user",
      },
      reviewerVerdict: {
        verdict: "pass",
        attemptId: reviewerRunId,
        evidenceRefs: ["checkpoint:review"],
      },
    });
  });

  it("does not project an old acceptance as current after a new executor cycle", () => {
    const itemId = createItem(db, {
      title: "acceptance epoch",
      brief: "acceptance must follow the current outcome",
      createdBy: "system",
      workdir: "/tmp/acceptance-epoch",
    });
    transition(db, { itemId, to: "active", actor: "system", reason: "first run" });
    const firstRunId = createRun(db, { itemId, runtime: "codex" });
    updateRun(db, firstRunId, { state: "finished", endedAt: true, exitCode: 0 });
    insertOutcomeSnapshot(db, {
      itemId,
      executorRunId: firstRunId,
      source: "system_recovered",
      sourceEventSeq: 1,
      sourceOutputSha256: "b".repeat(64),
      outcome: normalizeOutcomePayload({
        summary: "first outcome",
        changes: [{ kind: "file", ref: "src/first.ts" }],
        deliverables: [{ kind: "path", ref: "src/first.ts", label: "first" }],
        validations: [],
      }, { workdir: "/tmp/acceptance-epoch" }),
    });
    transition(db, { itemId, to: "review", actor: "system", reason: "first review" });
    const reviewerId = createRun(db, { itemId, role: "reviewer", purpose: "review", runtime: "codex" });
    updateRun(db, reviewerId, { state: "finished", endedAt: true, exitCode: 0 });
    db.prepare(
      "INSERT INTO review_verdicts (run_id, item_id, verdict, evidence, evidence_refs) VALUES (?, ?, 'pass', 'first pass', '[]')",
    ).run(reviewerId, itemId);
    transition(db, { itemId, to: "done", actor: "user", reason: "accepted first outcome" });

    transition(db, { itemId, to: "active", actor: "user", reason: "rework" });
    const secondRunId = createRun(db, { itemId, runtime: "codex" });
    updateRun(db, secondRunId, { state: "finished", endedAt: true, exitCode: 0 });
    insertOutcomeSnapshot(db, {
      itemId,
      executorRunId: secondRunId,
      source: "system_recovered",
      sourceEventSeq: 2,
      sourceOutputSha256: "c".repeat(64),
      outcome: normalizeOutcomePayload({
        summary: "second outcome",
        changes: [{ kind: "file", ref: "src/second.ts" }],
        deliverables: [{ kind: "path", ref: "src/second.ts", label: "second" }],
        validations: [],
      }, { workdir: "/tmp/acceptance-epoch" }),
    });
    transition(db, { itemId, to: "review", actor: "child", reason: "second review" });

    const workbench = createControlPlaneService(db, { runtime: () => runtime() })
      .getKernelTicketWorkbenchV2(itemId);
    expect(workbench?.outcomeSnapshot?.facts.acceptance).toBe("none");
    expect(workbench?.outcomeSnapshot?.reviewerVerdict).toBeNull();
  });

  it("marks an old running attempt stale and aggregates overview counts", () => {
    const staleId = createItem(db, { title: "stale", brief: "b", createdBy: "system" });
    transition(db, { itemId: staleId, to: "active", actor: "system", reason: "started" });
    const runId = createRun(db, { itemId: staleId });
    updateRun(db, runId, { state: "running" });
    db.prepare("UPDATE items SET last_activity_at = '2026-07-23 04:00:00' WHERE id = ?").run(staleId);
    const reviewId = createItem(db, { title: "review", brief: "b", createdBy: "system" });
    db.prepare("UPDATE items SET stage = 'review' WHERE id = ?").run(reviewId);

    const service = createControlPlaneService(db, {
      runtime: () => runtime([staleId]),
      now: () => new Date("2026-07-23T05:00:00.000Z"),
      staleMs: 15 * 60_000,
    });
    expect(service.listItems().find((ticket) => ticket.id === staleId)?.runtime.state).toBe("stale");
    expect(service.overview()).toMatchObject({
      model: "openai/gpt-5.6-sol",
      sessionId: "lead-session",
      runningTicketIds: [staleId],
      counts: { activeTickets: 1, reviewTickets: 1, blockedTickets: 0, pendingApprovals: 0 },
    });
  });

  it("projects full run facts and source-labelled structured ticket relations", () => {
    const currentId = createItem(db, { title: "Current", brief: "b", createdBy: "lead" });
    const failedId = createItem(db, { title: "Failed A", brief: "b", createdBy: "system" });
    const reverseId = createItem(db, { title: "Failed B", brief: "b", createdBy: "system" });
    const runId = createRun(db, { itemId: failedId, runtime: "codex", purpose: "execution", model: "gpt-5", effort: "high" });
    updateRun(db, runId, {
      state: "failed", endedAt: true, exitCode: 17,
      errorCode: "process_exit", errorMessage: "executor crashed before producing output",
    });
    const related = linkTickets(db, {
      sourceTicketId: currentId,
      targetTicketId: failedId,
      relationType: "relates_to",
      reason: "See the failed execution ticket",
      actor: "lead",
    });
    const implementedBy = linkTickets(db, {
      sourceTicketId: reverseId,
      targetTicketId: currentId,
      relationType: "implements",
      reason: "Reverse implementation relation",
      actor: "lead",
    });

    const service = createControlPlaneService(db, { runtime: () => runtime() });
    expect(service.listRuns(failedId)).toEqual([
      expect.objectContaining({
        id: runId, ticketId: failedId, runtime: "codex", purpose: "execution",
        state: "crashed", model: "gpt-5", effort: "high", exitCode: 17,
        errorCode: "process_exit", errorMessage: "executor crashed before producing output",
      }),
    ]);
    expect(service.getItem(currentId)).toEqual(expect.objectContaining({
      createdBy: "lead",
      relations: expect.arrayContaining([
        expect.objectContaining({
          relationId: related.relation.id,
          ticketId: failedId,
          kind: "relates_to",
          sourceTicketId: currentId,
          targetTicketId: failedId,
          source: "ticket_relations",
          active: true,
          reason: "See the failed execution ticket",
        }),
        expect.objectContaining({
          relationId: implementedBy.relation.id,
          ticketId: reverseId,
          kind: "implemented_by",
          sourceTicketId: reverseId,
          targetTicketId: currentId,
          source: "ticket_relations",
          active: true,
          reason: "Reverse implementation relation",
        }),
      ]),
    }));
  });

  it("lists active canonical projects by stable id and maps unassociated tickets to unknown", () => {
    const alphaId = createProject(db, { name: "alpha", createdBy: "lead" });
    const emptyId = createProject(db, { name: "empty", createdBy: "lead" });
    const archivedId = createProject(db, { name: "archived", createdBy: "lead" });
    db.prepare("UPDATE projects SET status = 'archived' WHERE id = ?").run(archivedId);
    createItem(db, {
      title: "a", brief: "a", createdBy: "system", project: "alpha", projectId: alphaId,
    });
    createItem(db, {
      title: "legacy", brief: "legacy", createdBy: "system", project: "legacy-only",
    });
    createItem(db, {
      title: "archived", brief: "archived", createdBy: "system",
      project: "archived", projectId: archivedId,
    });
    const blocked = createItem(db, { title: "b", brief: "b", createdBy: "system" });
    db.prepare("UPDATE items SET stage = 'blocked' WHERE id = ?").run(blocked);
    createItem(db, {
      title: "unassigned child",
      brief: "child work belongs to its root instead of the unknown project",
      createdBy: "system",
      parentItemId: blocked,
      rootItemId: blocked,
    });

    const service = createControlPlaneService(db, { runtime: () => runtime() });
    expect(service.listProjects()).toEqual([
      expect.objectContaining({ id: String(alphaId), name: "alpha", ticketCount: 1 }),
      expect.objectContaining({ id: String(emptyId), name: "empty", ticketCount: 0 }),
      expect.objectContaining({
        id: "unknown", name: "unknown", ticketCount: 3, blockedCount: 1,
      }),
    ]);
  });

  // 实例上（2026-10-15）项目写「pi-lead-child 17 工单 · 3 阻塞」：数了子工单和已结束的，阻塞只看 stage。
  // 工单 tab 在这个项目里有 16 张根工单、4 张等你。项目的数字要和按项目筛选后的工单 tab 一样。
  it("counts a project's tickets with the ticket tab's rule: whose turn it is", () => {
    const projectId = createProject(db, { name: "pi-lead-child", createdBy: "lead" });
    const inProject = { createdBy: "lead" as const, project: "pi-lead-child", projectId };
    const blockedRoot = createItem(db, { title: "blocked root", brief: "b", ...inProject });
    db.prepare("UPDATE items SET stage = 'blocked' WHERE id = ?").run(blockedRoot);
    const blockedChild = createItem(db, {
      title: "blocked child", brief: "b", ...inProject, parentItemId: blockedRoot, rootItemId: blockedRoot,
    });
    db.prepare("UPDATE items SET stage = 'blocked' WHERE id = ?").run(blockedChild);
    const doneChild = createItem(db, {
      title: "done child", brief: "b", ...inProject, parentItemId: blockedRoot, rootItemId: blockedRoot,
    });
    db.prepare("UPDATE items SET stage = 'done' WHERE id = ?").run(doneChild);
    // stage 是 active，但没有任何 Run：没有人在推进它。
    const idleActive = createItem(db, { title: "active without a run", brief: "b", ...inProject });
    db.prepare("UPDATE items SET stage = 'active' WHERE id = ?").run(idleActive);
    // 交付进了 review，由你验收：等你。
    const awaitingAcceptance = createItem(db, { title: "awaiting acceptance", brief: "b", ...inProject });
    db.prepare("UPDATE items SET stage = 'review' WHERE id = ?").run(awaitingAcceptance);
    const doneRoot = createItem(db, { title: "done root", brief: "b", ...inProject });
    db.prepare("UPDATE items SET stage = 'done' WHERE id = ?").run(doneRoot);
    // 提醒不在工单 tab 里，也不算进「未归属」。
    createItem(db, {
      kind: "reminder", title: "交周报", brief: "b", createdBy: "lead", remindAt: "2026-10-16T09:00:00.000Z",
    });
    createItem(db, { title: "no project", brief: "b", createdBy: "lead" });

    const projects = createControlPlaneService(db, { runtime: () => runtime() }).listProjects();
    expect(projects).toEqual([
      expect.objectContaining({
        name: "pi-lead-child", ticketCount: 5, blockedCount: 3, runningCount: 0, reviewCount: 0,
      }),
      expect.objectContaining({ id: "unknown", ticketCount: 1 }),
    ]);
  });

  it("builds a range agenda from ticket dates and recurring schedule occurrences", () => {
    const itemId = createItem(db, { title: "交付协议", brief: "b", createdBy: "system", project: "alpha" });
    setItemTime(db, itemId, { dueAt: "2026-07-24T08:00:00.000Z" });
    // 提醒不再是挂在任务上的一个时间戳，而是自己的一条 item（约束 C3），
    // 所以 agenda 里的 ticket_reminder 现在来自一条 reminder，而不是同一张工单。
    const reminderId = createItem(db, {
      title: "交付协议提醒", brief: "b", createdBy: "system", project: "alpha",
      kind: "reminder", remindAt: "2026-07-23T08:00:00.000Z",
    });
    // 例行条目现在来自 triggers；协议里的字段名仍叫 scheduleId（本期不改名，spec §14）。
    const scheduleId = createCronTrigger(db, {
      label: "每日巡检", cronExpr: "0 9 * * *", tz: "UTC", createdBy: "user",
      action: { type: "create_item", payload: { kind: "reminder", title: "每日巡检", brief: "b" } },
    }, new Date("2026-07-22T00:00:00.000Z"));

    const service = createControlPlaneService(db, {
      runtime: () => runtime(), now: () => new Date("2026-07-22T12:00:00.000Z"),
    });
    const agenda = service.agenda({
      from: "2026-07-23T00:00:00.000Z",
      to: "2026-07-25T00:00:00.000Z",
      timezone: "UTC",
    });
    expect(agenda).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `ticket:${reminderId}:reminder`, kind: "ticket_reminder", ticketId: reminderId }),
      expect.objectContaining({ id: `ticket:${itemId}:due`, kind: "ticket_due", ticketId: itemId }),
      expect.objectContaining({ id: `schedule:${scheduleId}:2026-07-23T09:00:00.000Z`, kind: "schedule", scheduleId }),
      expect.objectContaining({ id: `schedule:${scheduleId}:2026-07-24T09:00:00.000Z`, kind: "schedule", scheduleId }),
    ]));
  });

  // 实例上（2026-10-15）今天建的每日例行，在本周一到周三也显示「09:00」，看起来像已经执行过。
  // 过去的一次只有真的触发过（trigger_fires 有记录）才出现。
  it("shows a past routine occurrence only when it really fired", () => {
    const scheduleId = createCronTrigger(db, {
      label: "每日站会摘要", cronExpr: "0 9 * * *", tz: "UTC", createdBy: "lead",
      action: { type: "create_item", payload: { title: "整理今日站会摘要", brief: "b" } },
    }, new Date("2026-10-12T00:00:00.000Z"));
    claimTriggerOccurrence(db, getTrigger(db, scheduleId)!, "2026-10-15T09:00:00.000Z", new Date("2026-10-15T09:00:01.000Z"));
    const service = createControlPlaneService(db, {
      runtime: () => runtime(), now: () => new Date("2026-10-15T15:46:00.000Z"),
    });

    const ids = service.agenda({
      from: "2026-10-12T00:00:00.000Z", to: "2026-10-17T00:00:00.000Z", timezone: "UTC",
    }).map((item) => item.id);

    expect(ids).toEqual([
      `schedule:${scheduleId}:2026-10-15T09:00:00.000Z`,
      `schedule:${scheduleId}:2026-10-16T09:00:00.000Z`,
    ]);
  });

  // 实例上的日程只取本周：7 月两条已触发、一直没确认的提醒，和两天前过了截止的 #66，都看不到。
  it("adds what is overdue before the range when the client asks for it", () => {
    const overdue = createItem(db, { title: "成果快照与登记机制", brief: "b", createdBy: "lead" });
    setItemTime(db, overdue, { dueAt: "2026-09-01T10:00:00.000Z" });
    const finished = createItem(db, { title: "已完成的工单", brief: "b", createdBy: "lead" });
    setItemTime(db, finished, { dueAt: "2026-09-02T10:00:00.000Z" });
    db.prepare("UPDATE items SET stage = 'done' WHERE id = ?").run(finished);
    const fired = createItem(db, {
      kind: "reminder", title: "重要：Working Session 会议", brief: "b", createdBy: "lead",
      remindAt: "2026-07-29T09:00:00.000Z",
    });
    db.prepare("UPDATE items SET stage = 'fired' WHERE id = ?").run(fired);
    const acked = createItem(db, {
      kind: "reminder", title: "已确认的提醒", brief: "b", createdBy: "lead", remindAt: "2026-07-30T09:00:00.000Z",
    });
    db.prepare("UPDATE items SET stage = 'acked' WHERE id = ?").run(acked);
    const service = createControlPlaneService(db, {
      runtime: () => runtime(), now: () => new Date("2026-10-15T15:46:00.000Z"),
    });
    const range = { from: "2026-10-12T00:00:00.000Z", to: "2026-10-19T00:00:00.000Z", timezone: "UTC" };

    expect(service.agenda(range)).toEqual([]);
    expect(service.agenda({ ...range, includeOverdue: true }).map((item) => item.id)).toEqual([
      `ticket:${fired}:reminder`,
      `ticket:${overdue}:due`,
    ]);
  });

  it("returns pending approvals and user-visible conversation turns", () => {
    const itemId = createItem(db, { title: "approval", brief: "b", createdBy: "system" });
    createApproval(db, { itemId, requestedBy: "child", tool: "send_email", action: "发送邮件", payload: { to: "x@example.com" } });
    createTurn(db, { id: "turn-1", originKind: "companion", itemId, userText: "批准了吗" });

    const service = createControlPlaneService(db, { runtime: () => runtime() });
    expect(service.listApprovals()).toEqual([
      expect.objectContaining({ ticketId: itemId, tool: "send_email", action: "发送邮件", payload: { to: "x@example.com" }, status: "pending" }),
    ]);
    expect(service.listConversationTurns({ itemId })).toEqual([
      expect.objectContaining({ id: "turn-1", originKind: "companion", ticketId: itemId, userText: "批准了吗" }),
    ]);
  });

  it("adds each turn's folded tool calls only when the client asks for them", () => {
    createTurn(db, { id: "turn-1", originKind: "companion", userText: "查一下" });
    createTurn(db, { id: "turn-2", originKind: "companion", userText: "没有工具" });
    publishGatewayEvent(db, { type: "lead.turn.started", requiredScope: "chat", turnId: "turn-1", payload: { mode: "started" } });
    publishGatewayEvent(db, {
      type: "lead.tool.started", requiredScope: "chat", turnId: "turn-1",
      payload: { toolCallId: "call-1", toolName: "query_tickets", args: { stage: "review", api_key: "k" }, textOffset: 4 },
    });
    publishGatewayEvent(db, {
      type: "lead.tool.completed", requiredScope: "chat", turnId: "turn-1",
      payload: { toolCallId: "call-1", toolName: "query_tickets", result: "[]", isError: false, textOffset: 4 },
    });

    const service = createControlPlaneService(db, { runtime: () => runtime() });
    expect(service.listConversationTurns()[0]).not.toHaveProperty("toolCalls");

    const [withTools, withoutTools] = service.listConversationTurns({ toolCallScopes: ["chat"] });
    expect(withTools!.toolCalls).toEqual([expect.objectContaining({
      callId: "call-1",
      name: "query_tickets",
      state: "completed",
      textOffset: 4,
      args: expect.objectContaining({ preview: '{"stage":"review","api_key":"[REDACTED]"}', redacted: true }),
      result: expect.objectContaining({ preview: "[]" }),
    })]);
    expect(withoutTools!.toolCalls).toEqual([]);
  });

  it("projects kernel projects, ticket hierarchy, and dependency edges separately from v2", () => {
    const projectId = createProject(db, {
      name: "returns", summary: "Buyer and seller returns", createdBy: "lead", maxConcurrency: 4,
    });
    const repositoryId = linkProjectRepository(db, projectId, {
      repoRoot: "/tmp/returns-buyer",
      remoteUrl: "git@github.com:example/returns-buyer.git",
      repoName: "returns-buyer",
      role: "buyer",
      confidence: 0.95,
    });
    const coordinator = createCoordinator({ db });
    const rootId = coordinator.createRootItem({
      title: "Returns orchestration",
      brief: "Coordinate buyer and seller work",
      createdBy: "system",
      projectId,
      runtime: "codex",
      verificationPolicy: "independent_reviewer",
    });
    const ownerRunId = createRun(db, {
      itemId: rootId, runtime: "codex", purpose: "execution",
    });
    updateRun(db, ownerRunId, { state: "running" });
    const revision = coordinator.beginPlanning({ itemId: rootId, runId: ownerRunId });
    const planningId = coordinator.createSubitem({ itemId: rootId, runId: ownerRunId, revision }, {
      title: "Planning", brief: "Plan the change", purpose: "execution", runtime: "pi",
    });
    const implementationId = coordinator.createSubitem({ itemId: rootId, runId: ownerRunId, revision }, {
      title: "Implementation", brief: "Implement the change", purpose: "execution", runtime: "claude",
    });
    coordinator.addDependency(
      { itemId: rootId, runId: ownerRunId, revision },
      implementationId,
      planningId,
    );
    coordinator.finishPlanning({ itemId: rootId, runId: ownerRunId, revision });

    const service = createControlPlaneService(db, { runtime: () => runtime() });
    expect(service.getKernelProject(projectId)).toEqual({
      id: projectId,
      slug: "returns",
      name: "returns",
      summary: "Buyer and seller returns",
      status: "active",
      confidence: 1,
      maxConcurrency: 4,
      mergedIntoProjectId: null,
      createdBy: "lead",
      createdAt: expect.stringMatching(/Z$/),
      updatedAt: expect.stringMatching(/Z$/),
      repositories: [{
        id: repositoryId,
        projectId,
        repoRoot: "/tmp/returns-buyer",
        remoteUrl: "git@github.com:example/returns-buyer.git",
        repoName: "returns-buyer",
        role: "buyer",
        confidence: 0.95,
        createdAt: expect.stringMatching(/Z$/),
        updatedAt: expect.stringMatching(/Z$/),
      }],
    });
    expect(service.getKernelProject(9999)).toBeUndefined();

    expect(service.getKernelTicket(rootId)).toMatchObject({
      id: rootId,
      project: "returns",
      projectId,
      parentTicketId: null,
      rootTicketId: rootId,
      orchestrationState: "waiting",
      requestedRuntime: "codex",
      verificationPolicy: "independent_reviewer",
      activePlanRevision: revision,
    });
    // TicketSummary 的键集冻结。本期按 spec §9/§11 新增 kind / stage / hasRun / deferUntil，
    // #49 追加四个 delegation policy 投影字段，供 Companion 显示授权状态：
    // stage 是 status 的新名字（两者恒等，status 保留为 deprecated），hasRun 是派生字段，
    // UI 据它决定渲不渲染执行面板。左栏改版阶段 2 追加 stageChangedAt（工单行右边的停留时间）；
    // displayTitle 只在 Lead 写过短标题时出现，不在这个键集里。
    expect(Object.keys(service.getItem(rootId)!.ticket).sort()).toEqual([
      "acceptancePolicy",
      "attention",
      "deferUntil",
      "deliveryPolicy",
      "dueAt",
      "hasRun",
      "id",
      "kind",
      "parentTicketId",
      "priority",
      "project",
      "reworkPolicy",
      "rootTicketId",
      "runtime",
      "stage",
      "stageChangedAt",
      "status",
      "summary",
      "title",
      "updatedAt",
      "verificationPolicy",
      "workflowKind",
      "workflowState",
      "worklistVisibility",
    ]);
    expect(service.listKernelChildren(rootId)).toEqual([
      expect.objectContaining({ id: planningId, parentTicketId: rootId, rootTicketId: rootId, requestedRuntime: "pi" }),
      expect.objectContaining({ id: implementationId, parentTicketId: rootId, rootTicketId: rootId, requestedRuntime: "claude" }),
    ]);
    expect(service.listKernelDependencies(implementationId)).toEqual([{
      parentTicketId: rootId,
      planRevision: revision,
      ticketId: implementationId,
      dependsOnTicketId: planningId,
      kind: "blocks",
      createdByAttemptId: ownerRunId,
      createdAt: expect.stringMatching(/Z$/),
    }]);
    expect(service.listKernelChildren(9999)).toBeUndefined();
    expect(service.listKernelDependencies(9999)).toBeUndefined();
  });

  it("keeps a merged project snapshot attached to the requested project record", () => {
    const sourceId = createProject(db, { name: "returns-buyer", createdBy: "lead" });
    const targetId = createProject(db, { name: "returns", createdBy: "lead" });
    linkProjectRepository(db, sourceId, {
      repoRoot: "/tmp/returns-buyer", repoName: "returns-buyer",
    });
    mergeProjects(db, sourceId, targetId, { actor: "lead", reason: "logical project merge" });

    const service = createControlPlaneService(db, { runtime: () => runtime() });
    expect(service.getKernelProject(sourceId)).toMatchObject({
      id: sourceId,
      status: "merged",
      mergedIntoProjectId: targetId,
      repositories: [],
    });
    expect(service.getKernelProject(targetId)?.repositories).toEqual([
      expect.objectContaining({ projectId: targetId, repoRoot: "/tmp/returns-buyer" }),
    ]);
  });

  it("projects kernel attempts, normalized events, learning candidates, and capabilities", () => {
    const dataDir = tempDir("plc-kernel-snapshot-");
    const projectId = createProject(db, { name: "kernel", createdBy: "lead" });
    const itemId = createItem(db, {
      title: "runtime", brief: "run", createdBy: "system", project: "kernel", projectId,
    });
    // reviewer 的 Run 只在 review 这个 stage 上开得出来（spec §6.5）。
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    transition(db, { itemId, to: "review", actor: "system", reason: "await review" });
    const runId = createRun(db, {
      itemId, role: "reviewer", runtime: "codex", purpose: "review", model: "gpt-5.6-codex",
    });
    updateRun(db, runId, {
      state: "running",
      runtimeVersion: "0.144.6",
      externalSessionId: "thread-1",
      eventCursor: "1",
      metadata: { sandbox: "read-only" },
      costKnown: true,
    });
    createRuntimeEventStore(db, { dataDir }).persist({
      type: "run.started",
      runId,
      seq: 1,
      occurredAt: "2026-07-23T05:00:00.000Z",
      runtime: "codex",
      model: "gpt-5.6-codex",
    });
    const candidateId = Number(db.prepare(
      `INSERT INTO learning_candidates
       (project_id, scope_key, item_id, run_id, fingerprint, kind, summary, evidence,
        occurrence_count, confidence, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      projectId,
      `project:${projectId}`,
      itemId,
      runId,
      "runtime-failure:timeout",
      "runtime_failure",
      "Runtime timed out repeatedly",
      JSON.stringify({ errorCode: "timeout" }),
      3,
      0.8,
      "drafted",
    ).lastInsertRowid);
    const capabilityId = Number(db.prepare(
      `INSERT INTO capabilities
       (project_id, scope_key, type, slug, name, version, scope, status, summary,
        asset_path, evaluator_path, asset_hash, evaluator_hash, source_candidates, provenance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      projectId,
      `project:${projectId}`,
      "runbook",
      "runtime-timeout-recovery",
      "Runtime timeout recovery",
      1,
      "project",
      "active",
      "Bounded recovery procedure",
      "/tmp/runbook.md",
      "/tmp/evaluate.sh",
      "sha256:asset",
      "sha256:evaluator",
      JSON.stringify([candidateId]),
      JSON.stringify({ promotedBy: "coordinator" }),
    ).lastInsertRowid);

    const service = createControlPlaneService(db, { runtime: () => runtime() });
    expect(service.getKernelAttempt(runId)).toMatchObject({
      id: runId,
      ticketId: itemId,
      role: "reviewer",
      runtime: "codex",
      purpose: "review",
      runtimeVersion: "0.144.6",
      externalSessionId: "thread-1",
      metadata: { sandbox: "read-only" },
      costKnown: true,
      eventLogDirty: false,
    });
    expect(service.getKernelAttempt(9999)).toBeUndefined();
    // KernelRuntimeEvent 是线上 DTO：它的身份字段叫 attemptId（protocol 冻结），
    // 尽管内部 RuntimeEvent 现在叫 runId。
    expect(service.listKernelAttemptEvents(runId)).toEqual([{
      type: "run.started",
      attemptId: runId,
      seq: 1,
      occurredAt: "2026-07-23T05:00:00.000Z",
      runtime: "codex",
      model: "gpt-5.6-codex",
    }]);
    expect(service.listKernelAttemptEvents(9999)).toBeUndefined();
    expect(service.listKernelLearningCandidates()).toEqual([
      expect.objectContaining({
        id: candidateId,
        projectId,
        evidence: { errorCode: "timeout" },
        occurrenceCount: 3,
        status: "drafted",
      }),
    ]);
    expect(service.listKernelCapabilities()).toEqual([
      expect.objectContaining({
        id: capabilityId,
        projectId,
        sourceCandidates: [candidateId],
        provenance: { promotedBy: "coordinator" },
        status: "active",
      }),
    ]);
  });

  it("projects additive checkpoint, workbench, intervention-ref, and card read models", () => {
    const coordinator = createCoordinator({ db, now: () => new Date("2026-07-24T09:00:00.000Z") });
    const itemId = coordinator.createRootItem({
      title: "additive resources", brief: "safe snapshots", createdBy: "system",
    });
    const runId = createRun(db, { itemId, runtime: "codex" });
    updateRun(db, runId, { state: "running" });
    const checkpoint = coordinator.submitCheckpoint({
      itemId,
      runId,
      kind: "milestone",
      title: "HTTP projection ready",
      summary: "The additive resources are ready for paired reads.",
    }).checkpoint;
    const decision = coordinator.requestDecision({
      itemId,
      runId,
      kind: "question",
      audience: "user",
      allowCustom: true,
      prompt: "Privileged question detail",
      options: [],
      checkpoint: { title: "Question pending", summary: "A user response is required." },
    });
    createTurn(db, {
      id: "turn-control-plane",
      originKind: "companion",
      itemId,
      userText: "run it",
    });
    upsertItemExecutionCard(db, {
      turnId: "turn-control-plane",
      itemId,
      operation: {
        id: "turn-control-plane:run",
        name: "spawn_child",
        state: "running",
        label: `Spawn child #${itemId}`,
        detail: null,
      },
    });

    const service = createControlPlaneService(db, {
      runtime: () => runtime(),
      now: () => new Date("2026-07-24T10:00:00.000Z"),
    });
    expect(service.listKernelCheckpoints(itemId)).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ id: checkpoint.id })]),
    });
    expect(service.listKernelWorkItems([itemId])).toEqual([
      expect.objectContaining({ ticketId: itemId, pendingInterventionCount: 1 }),
    ]);
    expect(service.getKernelTicketWorkbench(itemId)).toMatchObject({
      ticket: { id: itemId },
      interventionRefs: [{ id: `decision:${decision.requestId}`, requiresAction: true }],
    });
    const cards = service.listKernelConversationCards({ itemIds: [itemId] });
    expect(cards.items.length).toBeGreaterThanOrEqual(2);
    expect(cards.interventionRefs).toEqual([
      expect.objectContaining({ id: `decision:${decision.requestId}` }),
    ]);
    expect(JSON.stringify(cards)).not.toContain("Privileged question detail");
  });

  it("projects the failing agent into historical runtime failure checkpoints", () => {
    const itemId = createItem(db, { title: "auth failure", brief: "b", createdBy: "system" });
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const runId = createRun(db, { itemId, runtime: "claude", model: "claude-opus-5" });
    updateRun(db, runId, {
      state: "failed",
      endedAt: true,
      errorCode: "claude_success",
      errorMessage: "Failed to authenticate: OAuth session expired and could not be refreshed",
    });
    transition(db, { itemId, to: "blocked", actor: "system", reason: "auth failure", runId });
    const coordinator = createCoordinator({ db, now: () => new Date("2026-08-21T09:00:00.000Z") });
    const checkpoint = coordinator.recordSystemCheckpoint({
      itemId,
      runId,
      kind: "blocked",
      title: "Run crashed",
      summary: "Failed to authenticate: OAuth session expired and could not be refreshed",
      nextStep: "Recover the run",
      idempotencyKey: "run-crash:auth-failure",
      leadVisible: true,
    }).checkpoint;

    const service = createControlPlaneService(db, { runtime: () => runtime() });
    const checkpointPage = service.listKernelCheckpoints(itemId);
    const projected = checkpointPage?.items?.find((item) => item.id === checkpoint.id);
    expect(projected).toMatchObject({
      title: "Claude Code 认证失败",
      summary: expect.stringContaining("Claude Code · Run #"),
      keyFacts: expect.arrayContaining([
        { label: "Agent", value: "Claude Code" },
        { label: "Runtime", value: "claude" },
        { label: "Model", value: "claude-opus-5" },
        { label: "Failure category", value: "authentication" },
      ]),
    });
  });

  it("does not retitle a host outcome-registration defect as a Claude Code outage", () => {
    const itemId = createItem(db, { title: "invalid envelope", brief: "b", createdBy: "system" });
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const runId = createRun(db, { itemId, runtime: "claude", model: "claude-opus-5" });
    updateRun(db, runId, {
      state: "failed",
      endedAt: true,
      errorCode: "unhandled_run_exception",
      errorMessage: [
        "Error: outcome.validations[3].outcome is invalid",
        "    at normalizeValidations (/Users/alice/Workspace/AI/pi-lead-child/src/store/outcomes.ts:211:48)",
        "    at normalizeOutcomePayload (/Users/alice/Workspace/AI/pi-lead-child/src/store/outcomes.ts:249:24)",
      ].join("\n"),
    });
    transition(db, { itemId, to: "blocked", actor: "system", reason: "host registration", runId });
    const coordinator = createCoordinator({ db, now: () => new Date("2026-08-25T08:00:00.000Z") });
    const checkpoint = coordinator.recordSystemCheckpoint({
      itemId,
      runId,
      kind: "blocked",
      title: "Agent Run 未捕获异常",
      summary: `Run #${runId} 在运行边界触发未捕获异常：Error: outcome.validations[3].outcome is invalid\n    at normalizeValidations (src/store/outcomes.ts:211:48)`,
      nextStep: "Lead 应检查本次 Run 的运行日志与失败证据，判断是否可安全重试，并向用户说明原因与处理建议。",
      idempotencyKey: "run-crash:invalid-envelope",
      leadVisible: true,
    }).checkpoint;

    const service = createControlPlaneService(db, { runtime: () => runtime() });
    const projected = service.listKernelCheckpoints(itemId)?.items?.find((item) => item.id === checkpoint.id);
    expect(projected).toMatchObject({
      title: "Agent Run 未捕获异常",
      summary: expect.stringContaining("outcome.validations[3].outcome is invalid"),
      nextStep: "请确认下一步；不要在同一缺陷上再次派发。",
    });
    expect(projected?.title).not.toMatch(/Claude Code 运行失败/);
    expect(projected?.summary).not.toMatch(/\s+at\s+/);
    expect(projected?.nextStep).not.toMatch(/Lead 应/);
  });

  it("lets a new active run supersede a stale failed dispatch projection", () => {
    const itemId = createItem(db, { title: "restart", brief: "b", createdBy: "system" });
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const failedRunId = createRun(db, { itemId, runtime: "claude" });
    updateRun(db, failedRunId, {
      state: "failed",
      endedAt: true,
      errorCode: "claude_success",
      errorMessage: "OAuth session expired",
    });
    db.prepare(
      `INSERT INTO dispatch_requests
       (item_id, role, purpose, runtime, model, trigger, idempotency_key, state)
       VALUES (?, 'executor', 'execution', 'claude', NULL, 'user-rework', ?, 'failed')`,
    ).run(itemId, `user-rework:test:${itemId}`);
    const activeRunId = createRun(db, { itemId, runtime: "claude" });
    updateRun(db, activeRunId, { state: "running", model: "claude-opus-5" });

    const ticket = createControlPlaneService(db, { runtime: () => runtime([itemId]) }).getItem(itemId)!.ticket;
    expect(ticket.executionState).toMatchObject({
      kind: "recovery",
      state: "running",
      label: "执行中",
      attemptId: activeRunId,
      reason: null,
    });
  });

  // 2026-10-24 #117：Run 151–155 因为额度用完失败，健康账本重试派发；换了账号后 Run 156 跑起来了。
  // 工单头还写「正在恢复」，同一时刻 Run 行写「执行中」。新 Run 跑起来恢复就完成了：标签和 Run 行一样。
  // kind 仍是 recovery：恢复期间留下的 blocker 不算「需要你」，这个判断不变。
  it("says a recovered ticket is running once its new run runs, while waiting stays a recovery", () => {
    const itemId = createItem(db, { title: "quota", brief: "b", createdBy: "system" });
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const failedRunId = createRun(db, { itemId, runtime: "claude" });
    updateRun(db, failedRunId, {
      state: "failed",
      endedAt: true,
      errorCode: "claude_result_error",
      errorMessage: "You've hit your weekly limit",
    });
    db.prepare(
      `INSERT INTO dispatch_requests
       (item_id, role, purpose, runtime, model, trigger, idempotency_key, state)
       VALUES (?, 'executor', 'execution', 'claude', NULL, 'runtime-recovery', ?, 'pending')`,
    ).run(itemId, `runtime-recovery:test:${itemId}`);
    const service = createControlPlaneService(db, { runtime: () => runtime([itemId]) });
    expect(service.getItem(itemId)!.ticket.executionState).toMatchObject({
      kind: "recovery", state: "waiting_dispatch", label: "正在恢复 · 等待 agent",
    });

    db.prepare("UPDATE dispatch_requests SET state='started' WHERE item_id=?").run(itemId);
    const activeRunId = createRun(db, { itemId, runtime: "claude" });
    expect(service.getItem(itemId)!.ticket.executionState).toMatchObject({
      kind: "recovery", state: "starting", label: "正在恢复 · 启动中", attemptId: activeRunId,
    });

    updateRun(db, activeRunId, { state: "running", model: "sonnet" });
    expect(service.getItem(itemId)!.ticket.executionState).toMatchObject({
      kind: "recovery", state: "running", label: "执行中", attemptId: activeRunId, reason: null,
    });
  });

  it("labels an independent review as waiting until a reviewer actually starts", () => {
    const itemId = createItem(db, {
      title: "await review",
      brief: "b",
      createdBy: "system",
      verificationPolicy: "independent_reviewer",
    });
    db.prepare("UPDATE items SET stage='review' WHERE id=?").run(itemId);
    const service = createControlPlaneService(db, { runtime: () => runtime() });
    expect(service.getItem(itemId)?.ticket.reviewState).toMatchObject({
      state: "independent_review",
      label: "等待独立核查",
    });

    const reviewerRunId = createRun(db, { itemId, role: "reviewer", purpose: "review", runtime: "codex" });
    updateRun(db, reviewerRunId, { state: "running" });
    expect(service.getItem(itemId)?.ticket.reviewState).toMatchObject({
      state: "independent_review",
      label: "独立核查中",
    });
  });

  it("does not attach unrelated interventions when a card page has no intervention cards", () => {
    const coordinator = createCoordinator({ db });
    const authorityItemId = coordinator.createRootItem({
      title: "authority", brief: "unrelated", createdBy: "system",
    });
    const authorityRunId = createRun(db, { itemId: authorityItemId, runtime: "codex" });
    updateRun(db, authorityRunId, { state: "running" });
    coordinator.requestDecision({
      itemId: authorityItemId,
      runId: authorityRunId,
      kind: "question",
      audience: "user",
      prompt: "Unrelated question",
      allowCustom: true,
      checkpoint: { title: "Unrelated", summary: "Must not leak into another card page." },
    });

    const cardItemId = coordinator.createRootItem({
      title: "card", brief: "execution only", createdBy: "system",
    });
    createTurn(db, {
      id: "turn-no-intervention",
      originKind: "companion",
      itemId: cardItemId,
      userText: "run",
    });
    upsertItemExecutionCard(db, {
      turnId: "turn-no-intervention",
      itemId: cardItemId,
      operation: {
        id: "turn-no-intervention:run",
        name: "spawn_child",
        state: "running",
        label: `Spawn child #${cardItemId}`,
        detail: null,
      },
    });

    const cards = createControlPlaneService(db, { runtime: () => runtime() })
      .listKernelConversationCards({ itemIds: [cardItemId] });
    expect(cards.items).toHaveLength(1);
    expect(cards.interventionRefs).toEqual([]);
  });
});

// 收件箱（阶段 1）：每张等你的工单一行，写着为什么、从什么时候开始；Lead 自己处理掉的事另列。
describe("the inbox view", () => {
  it("says why each ticket waits for you and since when, read from the same rule as the badge", () => {
    const blocked = createItem(db, { title: "修复 review 状态投影", brief: "b", createdBy: "lead" });
    db.prepare("UPDATE items SET stage = 'blocked', stage_changed_at = '2026-08-25 08:01:12' WHERE id = ?").run(blocked);
    insertCheckpoint(db, {
      itemId: blocked, runId: null, source: "system_derived", kind: "blocked", title: "Agent Run 未捕获异常",
      summary: "Run #54 交付的成果格式不合法", nextStep: "修好后重跑", idempotencyKey: "inbox-view:blocked",
    });
    const draft = createItem(db, { title: "整理发布说明", brief: "b", createdBy: "lead", hold: true });
    const approval = createItem(db, { title: "删除临时资源", brief: "b", createdBy: "lead" });
    createApproval(db, { itemId: approval, requestedBy: "child", tool: "bash", action: "删除 /tmp/plc-demo", payload: {} });
    const done = createItem(db, { title: "已完成", brief: "b", createdBy: "lead" });
    db.prepare("UPDATE items SET stage = 'done' WHERE id = ?").run(done);
    createItem(db, { title: "排队中", brief: "b", createdBy: "lead" });

    const view = createControlPlaneService(db, { runtime: () => runtime() }).inboxView();

    expect(view.tickets).toEqual(expect.arrayContaining([
      { ticketId: blocked, reason: "Run #54 交付的成果格式不合法", since: "2026-08-25T08:01:12.000Z" },
      expect.objectContaining({ ticketId: draft, reason: "Paimon 建的草稿，等你确认才会开始" }),
      expect.objectContaining({ ticketId: approval, reason: "等你批准：删除 /tmp/plc-demo" }),
    ]));
    expect(view.tickets.map((fact) => fact.ticketId).sort((a, b) => a - b)).toEqual([blocked, draft, approval].sort((a, b) => a - b));
    expect(view.seenAt).toBeNull();
  });

  // 2026-10-16 浏览器预览：#1 在等你回答 Lead 的决定卡，收件箱的原因却写「Run #49 的交付还没有被独立核查」。
  // 等你回答决定时，原因写这条决定自己的说明，时间从决定提出时算。
  it("says what the decision is about when the ticket waits for your decision", () => {
    const itemId = createItem(db, { title: "成果快照与登记机制", brief: "b", createdBy: "lead" });
    const coordinator = createCoordinator({ db, now: () => new Date("2026-10-15T10:15:00.000Z") });
    coordinator.requestDecision({
      itemId, runId: null, origin: "lead", kind: "decision", audience: "user", blocking: true,
      prompt: "#1 接下来怎么办？", options: [{ id: "merge", label: "并入 #72" }],
      checkpoint: { title: "#1 接下来怎么办？", summary: "#1 核查不通过，返工次数已用完，需要你在并入 #72、取消里选一个。" },
    });

    const view = createControlPlaneService(db, { runtime: () => runtime() }).inboxView();

    expect(view.tickets).toEqual([{
      ticketId: itemId,
      reason: "#1 核查不通过，返工次数已用完，需要你在并入 #72、取消里选一个。",
      since: "2026-10-15T10:15:00.000Z",
    }]);
  });

  it("lists what Lead handled since a week ago, one entry per disposition, and when you last looked", () => {
    const itemId = createItem(db, { title: "成果快照与登记机制", brief: "b", createdBy: "user" });
    const first = addInbox(db, { itemId, severity: "blocker", source: "structural", summary: "核查失败：不支持 gpt-5.5", lossless: true }).id!;
    const second = addInbox(db, { itemId, severity: "blocker", source: "structural", summary: "核查失败：不支持 gpt-5.5", lossless: true }).id!;
    recordInboxDisposition(db, [first, second], {
      disposition: "handled", reason: "核查换成 Claude Code", cause: "Codex 账号不支持 gpt-5.5",
      action: "用 Claude Code 重派核查 Run #85", at: new Date("2026-10-15T07:34:00.000Z"),
    });
    markInboxSeen(db, new Date("2026-10-15T01:12:00.000Z"));

    const view = createControlPlaneService(db, {
      runtime: () => runtime(), now: () => new Date("2026-10-15T08:00:00.000Z"),
    }).inboxView();

    expect(view.leadHandled).toEqual([{
      id: `inbox:${first}`, ticketId: itemId, problem: "核查失败：不支持 gpt-5.5",
      cause: "Codex 账号不支持 gpt-5.5", action: "用 Claude Code 重派核查 Run #85", followUp: null,
      eventCount: 2, handledAt: "2026-10-15T07:34:00.000Z",
    }]);
    expect(view.seenAt).toBe("2026-10-15T01:12:00.000Z");
  });
});

// 项目卡片（左栏改版阶段 2）：分布（和工单 tab 同一组工单、同一条规则）、Lead 的一句话、最近动静、最近的截止、累计花费。
describe("the project overview", () => {
  it("summarizes each project with the ticket tab's rule, Lead's line and what it cost", () => {
    const projectId = createProject(db, { name: "pi-lead-child", createdBy: "lead" });
    const inProject = { createdBy: "lead" as const, project: "pi-lead-child", projectId };
    const blocked = createItem(db, { title: "修复 review 状态投影", brief: "b", ...inProject });
    db.prepare("UPDATE items SET stage = 'blocked', total_cost_usd = 21.84, total_tokens = 1000 WHERE id = ?").run(blocked);
    setItemTime(db, blocked, { dueAt: "2026-10-16T10:00:00.000Z" }, { actor: "user" });
    const child = createItem(db, { title: "子工单", brief: "b", ...inProject, parentItemId: blocked, rootItemId: blocked });
    db.prepare("UPDATE items SET stage = 'done', total_cost_usd = 1.16, total_tokens = 500, last_activity_at = '2026-10-15T07:43:00.000Z' WHERE id = ?").run(child);
    const running = createItem(db, { title: "在跑", brief: "b", ...inProject });
    db.prepare("UPDATE items SET stage = 'active' WHERE id = ?").run(running);
    createItem(db, { title: "排队", brief: "b", ...inProject });
    const learning = createItem(db, { title: "沉淀失败经验", brief: "b", createdBy: "system", purpose: "learning", project: "pi-lead-child", projectId });
    const done = createItem(db, { title: "已完成", brief: "b", ...inProject });
    db.prepare("UPDATE items SET stage = 'done', total_cost_usd = 13, total_tokens = 2000 WHERE id = ?").run(done);
    updateProjectSummary(db, projectId, { summary: "卡在 #72 的 review 投影", actor: "lead", reason: "r" });

    const e2e = createProject(db, { name: "pi-lead-child-e2e", createdBy: "lead" });
    const cancelled = createItem(db, { title: "e2e case", brief: "b", createdBy: "lead", project: "pi-lead-child-e2e", projectId: e2e });
    db.prepare("UPDATE items SET stage = 'cancelled' WHERE id = ?").run(cancelled);
    setProjectStatus(db, e2e, "archived", { actor: "user", reason: "测试项目" });

    const overview = createControlPlaneService(db, { runtime: () => runtime([running]) }).projectsOverview();
    const main = overview.find((project) => project.name === "pi-lead-child")!;

    expect(main).toMatchObject({
      id: String(projectId), status: "active",
      counts: { user: 1, running: 1, lead: 1, queued: 1, ended: 1 },
      nextMilestone: {
        ticketId: blocked, title: "修复 review 状态投影", kind: "due", label: "截止", at: "2026-10-16T10:00:00.000Z", allDay: false,
      },
      spend: { costUsd: 36, tokens: 3500 },
      lastActivityAt: "2026-10-15T07:43:00.000Z",
    });
    expect(main.leadStatus).toMatchObject({ text: "卡在 #72 的 review 投影" });
    expect(Date.parse(main.leadStatus!.at)).not.toBeNaN();
    expect(learning).toBeGreaterThan(0);
    expect(overview.find((project) => project.name === "pi-lead-child-e2e")).toMatchObject({
      status: "archived", counts: { user: 0, running: 0, lead: 0, queued: 0, ended: 1 }, leadStatus: null,
    });
  });

  // 实例上 Dialogue Returns 的一句话是建项目时写的，没有 project_changes。以前时间落到 1970 年，卡片写「1970/1/1 更新」。
  it("dates a line written when the project was created by the project's creation time", () => {
    const projectId = createProject(db, { name: "Dialogue Returns", summary: "11 个阶段都没有开始", createdBy: "lead" });
    db.prepare("UPDATE projects SET created_at = '2026-07-28 10:21:48' WHERE id = ?").run(projectId);
    createItem(db, { title: "迁移总工单", brief: "b", createdBy: "lead", project: "Dialogue Returns", projectId });

    const overview = createControlPlaneService(db, { runtime: () => runtime([]) }).projectsOverview();

    expect(overview.find((project) => project.name === "Dialogue Returns")!.leadStatus)
      .toEqual({ text: "11 个阶段都没有开始", at: "2026-07-28T10:21:48.000Z" });
  });

  it("carries a ticket's short title and when it entered its stage", () => {
    const itemId = createItem(db, { title: "[E2E #51 T48] FINAL #45 implementation", brief: "b", createdBy: "user" });
    setItemDisplayTitle(db, itemId, "成果快照与登记机制");
    db.prepare("UPDATE items SET stage_changed_at = '2026-08-21 10:48:04' WHERE id = ?").run(itemId);
    const [ticket] = createControlPlaneService(db, { runtime: () => runtime() }).listItems();
    expect(ticket).toMatchObject({
      title: "[E2E #51 T48] FINAL #45 implementation", displayTitle: "成果快照与登记机制", stageChangedAt: "2026-08-21T10:48:04.000Z",
    });
  });
});

// 日程（左栏改版阶段 3）：GET /v1/timeline 的投影。提醒、推迟开始和例行任务怎样进日程。
describe("the timeline", () => {
  const now = new Date("2026-10-15T07:46:00.000Z");
  const range = { from: "2026-10-12T00:00:00.000Z", to: "2026-11-02T00:00:00.000Z", timezone: "UTC" };
  const service = () => createControlPlaneService(db, { runtime: () => runtime(), now: () => now });

  it("puts a reminder that fired a week ago and is still unacknowledged in overdue, and keeps a fresh one on its day", () => {
    const old = createItem(db, { title: "Working Session 会议", brief: "b", createdBy: "user", kind: "reminder", remindAt: "2026-07-29T01:00:00.000Z" });
    const fresh = createItem(db, { title: "周会前看 #66", brief: "b", createdBy: "user", kind: "reminder", remindAt: "2026-10-15T01:00:00.000Z" });
    db.prepare("UPDATE items SET stage = 'fired' WHERE id IN (?, ?)").run(old, fresh);

    const timeline = service().timeline(range);
    expect(timeline.overdue.map((entry) => entry.id)).toEqual([`reminder:${old}`]);
    expect(timeline.entries.find((entry) => entry.id === `reminder:${fresh}`)).toMatchObject({ status: "unacked", title: "周会前看 #66" });
  });

  it("shows a deferred start until it comes, and routines from what really fired", () => {
    const deferred = createItem(db, { title: "Dialogue Returns 迁移", brief: "b", createdBy: "user" });
    db.prepare("UPDATE items SET defer_until = '2026-10-20T01:00:00.000Z' WHERE id = ?").run(deferred);
    const triggerId = createCronTrigger(db, {
      label: "每日站会摘要", cronExpr: "0 9 * * *", tz: "UTC", createdBy: "lead",
      action: { type: "create_item", payload: { title: "整理今日站会摘要", brief: "汇总昨天的进展" } },
    }, new Date("2026-10-14T00:00:00.000Z"));
    const fireId = claimTriggerOccurrence(db, getTrigger(db, triggerId)!, "2026-10-14T09:00:00.000Z", new Date("2026-10-14T09:00:01.000Z"))!;
    completeTriggerFire(db, fireId, { status: "failed", error: "runtime not configured" });

    const timeline = service().timeline(range);
    expect(timeline.entries.find((entry) => entry.id === `defer:${deferred}`)).toMatchObject({ kind: "deferred_start", status: "upcoming" });
    expect(timeline.entries.find((entry) => entry.id === `fire:${fireId}`)).toMatchObject({
      kind: "routine_fired", status: "failed", detail: "失败：runtime not configured",
    });
    const routines = timeline.entries.filter((entry) => entry.kind === "routine");
    // 将来的按 cron 展开，从现在开始；过去没触发过的不列。
    expect(routines[0]).toMatchObject({ at: "2026-10-15T09:00:00.000Z", detail: "汇总昨天的进展" });
    expect(routines.every((entry) => entry.at >= now.toISOString())).toBe(true);
  });

  it("marks a milestone close to a ticket that waits for you or has not started", () => {
    const waiting = createItem(db, { title: "等你", brief: "b", createdBy: "user" });
    db.prepare("UPDATE items SET stage = 'review' WHERE id = ?").run(waiting);
    const notStarted = createItem(db, { title: "还没开始", brief: "b", createdBy: "user" });
    const far = createItem(db, { title: "很远", brief: "b", createdBy: "user" });
    db.prepare("UPDATE items SET stage = 'blocked' WHERE id = ?").run(far);
    createMilestone(db, notStarted, { kind: "release", at: "2026-10-16T10:00:00.000Z" }, { actor: "user" });
    createMilestone(db, far, { kind: "release", at: "2026-10-25T10:00:00.000Z" }, { actor: "user" });

    const risks = Object.fromEntries(service().timeline(range).entries.map((entry) => [entry.ticketId, entry.risk]));
    expect(risks[notStarted]).toEqual({ reason: "not_started", label: "还没开始" });
    // 一周以后的节点不算风险。
    expect(risks[far]).toBeNull();
    expect(waiting).toBeGreaterThan(0);
  });

  it("carries Lead's agenda note", () => {
    setAgendaNote(db, "今天还剩 1 件：16:30 看 #66 的核查结论。", now);
    expect(service().timeline(range).leadNote).toEqual({ text: "今天还剩 1 件：16:30 看 #66 的核查结论。", at: now.toISOString() });
  });

  it("refuses a range without an end or longer than 120 days", () => {
    expect(() => service().timeline({ ...range, to: range.from })).toThrow(/invalid timeline range/);
    expect(() => service().timeline({ ...range, to: "2027-06-01T00:00:00.000Z" })).toThrow(/invalid timeline range/);
  });
});

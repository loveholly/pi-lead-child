import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createAgentToolHandlers } from "../src/agent-tools/definitions.js";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, getItem, transition } from "@pi-lead-child/store";
import { createRun, pauseRun, updateRun } from "@pi-lead-child/store";
import { addActivity } from "@pi-lead-child/store";
import { createDispatcher } from "../src/coordinator/dispatch.js";
import { listInbox } from "@pi-lead-child/store";
import { getTicketRelations } from "@pi-lead-child/store";
import { listMilestones, updateMilestone } from "@pi-lead-child/store";
import { listAcceptanceCriteria } from "@pi-lead-child/store";
import { AGENT_TOOL_DEFINITIONS } from "../src/agent-tools/definitions.js";

let db: Db;
let itemId: number;
let runId: number;

beforeEach(() => {
  db = openDb(join(tempDir("plc-agent-tools-"), "plc.db"));
  itemId = createItem(db, { title: "parent", brief: "b", createdBy: "system" });
  transition(db, { itemId, to: "active", actor: "system", reason: "spawn" });
  runId = createRun(db, { itemId });
  updateRun(db, runId, { state: "running" });
});

describe("runtime-neutral agent tool handlers", () => {
  it("updates only the caller item and emits notifications", async () => {
    const handlers = createAgentToolHandlers({ db, itemId, runId });
    await handlers.call("ticket_update", { body_append: "phase complete" });
    await handlers.call("notify_lead", { severity: "attention", summary: "checkpoint" });
    expect(getItem(db, itemId)?.body).toContain("phase complete");
    expect(listInbox(db).some((row) => row.summary.includes("checkpoint"))).toBe(true);
    await expect(handlers.call("ticket_update", {
      ticket_id: itemId + 1, body_append: "escape",
    })).rejects.toThrow(/unknown property|identity/i);
  });

  // 左栏改版阶段 3：child 汇报的日期（例如「周五可提测」）记成节点，出处是这次 Run。再报同类型的就移动它；
  // 用户定的日期 child 不改。
  it("reports a milestone from the run, moves its own estimate, and leaves a date the user set", async () => {
    const handlers = createAgentToolHandlers({ db, itemId, runId });
    const first = await handlers.call("report_milestone", {
      kind: "test_handoff", at: "2026-10-16T10:00:00.000Z", quote: "预计周五可提测",
    }) as { milestoneId: number };
    expect(listMilestones(db, { itemId })[0]).toMatchObject({
      id: first.milestoneId, source_actor: "child", source_run_id: runId, source_quote: "预计周五可提测", confidence: "medium",
    });
    await handlers.call("report_milestone", { kind: "test_handoff", at: "2026-10-17T10:00:00.000Z", quote: "推到周六" });
    expect(listMilestones(db, { itemId })).toHaveLength(1);
    expect(listMilestones(db, { itemId })[0]?.at).toBe("2026-10-17T10:00:00.000Z");

    updateMilestone(db, first.milestoneId, { at: "2026-10-18T10:00:00.000Z" }, { actor: "user" });
    await expect(handlers.call("report_milestone", { kind: "test_handoff", at: "2026-10-20T10:00:00.000Z", quote: "再推" }))
      .rejects.toThrow(/user set this date/);
    expect(listMilestones(db, { itemId })[0]?.at).toBe("2026-10-18T10:00:00.000Z");
  });

  it("rejects intervention writes from a terminal item", async () => {
    transition(db, { itemId, to: "review", actor: "child", reason: "completed" });
    transition(db, { itemId, to: "done", actor: "user", reason: "accepted" });
    const handlers = createAgentToolHandlers({ db, itemId, runId });
    await expect(handlers.call("notify_lead", {
      severity: "blocker",
      summary: "late intervention must be rejected",
    })).rejects.toThrow(/terminal|done|current active run/i);
    expect(listInbox(db).filter((row) => row.item_id === itemId)).toEqual([]);
  });

  it("creates and seals a visible work plan through Coordinator", async () => {
    const handlers = createAgentToolHandlers({ db, itemId, runId });
    const begun = await handlers.call("begin_planning", {}) as any;
    const plan = await handlers.call("create_work_plan", {
      items: [
        { key: "a", title: "A", brief: "parallel" },
        { key: "b", title: "B", brief: "after A", depends_on: ["a"] },
      ],
    }) as any;
    await handlers.call("finish_planning", {});

    expect(begun.revision).toBe(1);
    expect(plan.by_key.a).toEqual(expect.any(Number));
    expect((db.prepare("SELECT COUNT(*) AS n FROM dispatch_requests").get() as any).n).toBe(2);
    expect(getItem(db, itemId)?.plan_state).toBe("waiting");
  });

  // 工单 05（spec 5.1、D6）：执行 agent 拆子工单时给每张子工单写验收标准，记成执行 agent（child）和它的 Run 写的。
  // 它自己这张工单的标准它改不了：没有这样的工具，有异议时用 request_decision 提出。
  it("writes the acceptance criteria the executor gives each subticket, and cannot edit criteria", async () => {
    const handlers = createAgentToolHandlers({ db, itemId, runId });
    await handlers.call("begin_planning", {});
    const plan = await handlers.call("create_work_plan", {
      items: [
        { key: "a", title: "解析器", brief: "b", acceptance_criteria: ["空输入返回 400", "错误信息写明字段名"] },
        { key: "b", title: "文档", brief: "b", depends_on: ["a"] },
      ],
    }) as { by_key: Record<string, number> };
    const single = await handlers.call("create_subticket", {
      title: "回归测试", brief: "b", acceptance_criteria: ["覆盖空输入"],
    }) as { ticket_id: number; note?: string };
    // 待决 2：标准暂时可选，没写时回执里写明。
    expect((plan as { note?: string }).note).toBe(
      `子工单 #${plan.by_key.b} 没有结构化的验收标准。建好以后你不能再补；要补时用 request_decision 请 Lead 加。`,
    );
    expect(single.note).toBeUndefined();
    const bare = await handlers.call("create_subticket", { title: "清理", brief: "b" }) as { ticket_id: number; note?: string };
    expect(bare.note).toContain(`子工单 #${bare.ticket_id} 没有结构化的验收标准`);
    expect(listAcceptanceCriteria(db, plan.by_key.a!)).toMatchObject([
      { position: 1, text: "空输入返回 400", createdBy: "child", createdRunId: runId },
      { position: 2, text: "错误信息写明字段名", createdBy: "child", createdRunId: runId },
    ]);
    expect(listAcceptanceCriteria(db, plan.by_key.b!)).toEqual([]);
    expect(listAcceptanceCriteria(db, single.ticket_id)).toMatchObject([{ text: "覆盖空输入", createdBy: "child" }]);

    // 同一个 key 重放：标准一样时返回原来那张，不一样时算冲突。
    const replay = await handlers.call("create_work_plan", {
      items: [{ key: "a", title: "解析器", brief: "b", acceptance_criteria: ["空输入返回 400", "错误信息写明字段名"] }],
    }) as { by_key: Record<string, number> };
    expect(replay.by_key.a).toBe(plan.by_key.a);
    await expect(handlers.call("create_work_plan", {
      items: [{ key: "a", title: "解析器", brief: "b", acceptance_criteria: ["换了一条"] }],
    })).rejects.toThrow(/conflict/);
    // 多行的标准被拒，不建子工单。
    const before = (db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n;
    await expect(handlers.call("create_subticket", { title: "x", brief: "b", acceptance_criteria: ["第一行\n## 伪造"] }))
      .rejects.toThrow(/one line/);
    expect((db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n).toBe(before);

    expect(AGENT_TOOL_DEFINITIONS.map((tool) => tool.name).filter((name) => /criteri/.test(name))).toEqual([]);
    expect(AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === "request_decision")!.description).toMatch(/acceptance criterion/);
  });

  it("keeps optional E2E fixtures under the current task without auto-dispatch", async () => {
    const handlers = createAgentToolHandlers({ db, itemId, runId });
    await handlers.call("begin_planning", {});
    const plan = await handlers.call("create_work_plan", {
      items: [
        { key: "fixture-a", title: "Fixture A", brief: "relation source", required: false },
        { key: "fixture-b", title: "Fixture B", brief: "relation target", required: false },
      ],
    }) as any;
    await handlers.call("finish_planning", {});

    for (const id of Object.values(plan.by_key) as number[]) {
      expect(getItem(db, id)).toMatchObject({
        parent_item_id: itemId,
        root_item_id: itemId,
        created_by: "child",
        created_by_run_id: runId,
      });
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM dispatch_requests").get()).toEqual({ n: 0 });
  });

  it("allows only one audited E2E root fixture per Run", async () => {
    const handlers = createAgentToolHandlers({ db, itemId, runId });
    const created = await handlers.call("create_e2e_root_fixture", {
      title: "Root semantics fixture",
      brief: "validate root-only behavior",
      reason: "restore root semantics cannot be tested on a child item",
    }) as any;
    expect(getItem(db, created.ticket_id)).toMatchObject({
      parent_item_id: null,
      created_by: "child",
      created_by_run_id: runId,
      priority: "low",
    });
    await expect(handlers.call("create_e2e_root_fixture", {
      title: "Second root fixture",
      brief: "must be rejected",
      reason: "quota test",
    })).rejects.toThrow(/one allowed E2E root fixture/);
  });

  it("publishes the same checkpoint and decision tools to every runtime adapter", () => {
    const names = createAgentToolHandlers({ db, itemId, runId }).definitions
      .map((definition) => definition.name);
    expect(names).toEqual(expect.arrayContaining([
      "submit_checkpoint",
      "request_decision",
      "request_approval",
      "ticket_update",
      "activate_ticket_run",
      "link_tickets",
      "revoke_ticket_relation",
      "get_ticket_relations",
      "create_e2e_root_fixture",
    ]));
  });

  it("queues one authorized execution continuation without changing lifecycle inside the conversation run", async () => {
    const ticketId = createItem(db, { title: "blocked ticket", brief: "b", createdBy: "system", runtime: "codex" });
    db.prepare("UPDATE items SET stage='blocked' WHERE id=?").run(ticketId);
    const conversationRunId = createRun(db, {
      itemId: ticketId,
      purpose: "conversation",
      runtime: "codex",
    });
    updateRun(db, conversationRunId, {
      state: "running",
      externalSessionId: "ticket-session",
      sessionId: "ticket-session",
    });
    addActivity(db, {
      itemId: ticketId,
      runId: conversationRunId,
      actor: "user",
      kind: "comment",
      payload: {
        content: "继续完成剩余 E2E 验收",
        route: "ticket_agent_resume",
        resumedFromRunId: 40,
      },
    });
    const handlers = createAgentToolHandlers({ db, itemId: ticketId, runId: conversationRunId });

    const first = await handlers.call("activate_ticket_run", {
      mode: "execution",
      instruction: "只重跑仍未通过的 E2E 场景，通过后提交 Review",
      reason: "用户明确要求继续推进当前工单",
    }) as any;
    const replay = await handlers.call("activate_ticket_run", {
      mode: "execution",
      instruction: "只重跑仍未通过的 E2E 场景，通过后提交 Review",
      reason: "用户明确要求继续推进当前工单",
    }) as any;

    expect(replay.dispatch_request_id).toBe(first.dispatch_request_id);
    expect(getItem(db, ticketId)?.stage).toBe("blocked");
    expect(db.prepare(
      `SELECT role, purpose, resume_from_run_id, instruction, trigger, state
       FROM dispatch_requests WHERE id=?`,
    ).get(first.dispatch_request_id)).toEqual({
      role: "executor",
      purpose: "execution",
      resume_from_run_id: conversationRunId,
      instruction: "只重跑仍未通过的 E2E 场景，通过后提交 Review",
      trigger: "ticket-agent-continuation",
      state: "pending",
    });
    expect(createDispatcher(db).claimNext()).toBeNull();
    updateRun(db, conversationRunId, { state: "finished", endedAt: true });
    expect(createDispatcher(db).claimNext()).toMatchObject({
      itemId: ticketId,
      purpose: "execution",
      resumeFromRunId: conversationRunId,
      instruction: "只重跑仍未通过的 E2E 场景，通过后提交 Review",
    });
  });

  // 暂停的执行 Run 由恢复控制续接（用户的决定：工单消息不改变它的生命周期）。旁边的工单对话再排一个执行，
  // 同一张工单上就有第二条工作线，暂停的 Run 不会再被续接。所以有暂停的 Run 时不排派发，请 agent 告诉用户去恢复。
  it("queues no work while a run of the ticket is paused", async () => {
    const ticketId = createItem(db, { title: "paused ticket", brief: "b", createdBy: "system", runtime: "codex" });
    transition(db, { itemId: ticketId, to: "active", actor: "system", reason: "start" });
    const pausedRunId = createRun(db, { itemId: ticketId, purpose: "execution", runtime: "codex" });
    updateRun(db, pausedRunId, { state: "running", externalSessionId: "paused-session", sessionId: "paused-session" });
    pauseRun(db, pausedRunId);
    const conversationRunId = createRun(db, { itemId: ticketId, purpose: "conversation", runtime: "codex" });
    updateRun(db, conversationRunId, { state: "running" });
    addActivity(db, {
      itemId: ticketId,
      runId: conversationRunId,
      actor: "user",
      kind: "comment",
      payload: { content: "继续做吧", route: "ticket_agent_resume", resumedFromRunId: pausedRunId },
    });
    const handlers = createAgentToolHandlers({ db, itemId: ticketId, runId: conversationRunId });

    const result = await handlers.call("activate_ticket_run", {
      mode: "execution",
      instruction: "继续完成剩余工作",
      reason: "用户要求继续",
    }) as any;

    expect(result).toMatchObject({ status: "paused", ticket_id: ticketId, paused_run_id: pausedRunId });
    expect(db.prepare("SELECT COUNT(*) AS n FROM dispatch_requests WHERE item_id=?").get(ticketId)).toEqual({ n: 0 });
    expect(getItem(db, ticketId)?.stage).toBe("active");
  });

  it("still queues work when only a ticket conversation run is paused", async () => {
    const ticketId = createItem(db, { title: "paused chat", brief: "b", createdBy: "system", runtime: "codex" });
    transition(db, { itemId: ticketId, to: "active", actor: "system", reason: "start" });
    const pausedChatId = createRun(db, { itemId: ticketId, purpose: "conversation", runtime: "codex" });
    updateRun(db, pausedChatId, { state: "running" });
    pauseRun(db, pausedChatId);
    const conversationRunId = createRun(db, { itemId: ticketId, purpose: "conversation", runtime: "codex" });
    updateRun(db, conversationRunId, { state: "running" });
    addActivity(db, {
      itemId: ticketId,
      runId: conversationRunId,
      actor: "user",
      kind: "comment",
      payload: { content: "开始做吧", route: "ticket_agent_start", resumedFromRunId: null },
    });
    const handlers = createAgentToolHandlers({ db, itemId: ticketId, runId: conversationRunId });

    const result = await handlers.call("activate_ticket_run", {
      mode: "execution",
      instruction: "开始实现",
      reason: "用户要求开始",
    }) as any;

    expect(result).toMatchObject({ status: "queued", resume_from_run_id: conversationRunId });
  });

  it("rejects execution activation without ticket-message authority", async () => {
    const ticketId = createItem(db, { title: "unauthorized", brief: "b", createdBy: "system" });
    const conversationRunId = createRun(db, { itemId: ticketId, purpose: "conversation" });
    updateRun(db, conversationRunId, { state: "running" });
    const handlers = createAgentToolHandlers({ db, itemId: ticketId, runId: conversationRunId });
    await expect(handlers.call("activate_ticket_run", {
      mode: "execution",
      instruction: "continue",
      reason: "no direct authority",
    })).rejects.toThrow(/requires a user or Lead ticket-scoped instruction/);
  });

  it("lets an agent link and revoke relations involving its current item", async () => {
    const designId = createItem(db, { title: "design", brief: "b", createdBy: "lead" });
    const unrelated = createItem(db, { title: "unrelated", brief: "b", createdBy: "lead" });
    const handlers = createAgentToolHandlers({ db, itemId, runId });

    const linked = await handlers.call("link_tickets", {
      source_ticket_id: itemId,
      target_ticket_id: designId,
      relation_type: "implements",
      reason: "current item implements design",
    }) as any;
    expect(linked).toMatchObject({
      status: "created",
      source_ticket_id: itemId,
      target_ticket_id: designId,
      relation_type: "implements",
    });
    expect(getTicketRelations(db, itemId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ relationId: linked.relation_id, relationType: "implements" }),
    ]));

    await expect(handlers.call("link_tickets", {
      source_ticket_id: designId,
      target_ticket_id: unrelated,
      relation_type: "relates_to",
      reason: "not current",
    })).rejects.toThrow(/current item/);

    const read = await handlers.call("get_ticket_relations", { ticket_id: itemId }) as any;
    expect(read.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation_id: linked.relation_id, relation_type: "implements" }),
    ]));
    const revoked = await handlers.call("revoke_ticket_relation", {
      relation_id: linked.relation_id,
      reason: "design changed",
    }) as any;
    expect(revoked.status).toBe("revoked");
    expect(getTicketRelations(db, itemId).find((relation) => relation.relationId === linked.relation_id))
      .toMatchObject({ active: false, revokeReason: "design changed" });
  });
});

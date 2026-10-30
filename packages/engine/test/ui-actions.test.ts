// 工单以外的 UI 操作层（仓库 AGENTS.md「UI Actions」，.scratch/ui-action-parity/plan.md P01）：按目标类型登记的操作、四档权限、
// user_direct 的结构化拒绝、两个入口记同一条账本。执行器开关走完 daemon 和网关的那一段在 apps/daemon/test/runtime-settings-daemon.test.ts。
import { beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import type { RuntimeDisabledBy, RuntimeId, RuntimeSwitchBy } from "@pi-lead-child/core";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  UI_ACTION_INPUT_SCHEMAS, UI_ACTION_PERFORMED_KIND, UI_ACTION_TARGET_TYPES,
  type ChannelCardAction, type ChannelCardDto, type RuntimeSettingsDto, type RuntimeSettingsRequest,
} from "@pi-lead-child/protocol";
import {
  STANDING_ORDER_PROPOSAL_TOOL, UserTurnScopeError, createApproval, createCliBinding, createItem, createLoopbackBinding, createTurn,
  getApproval, getBinding, getDecisionRequest, getItem, insertDecisionRequest, openChannelCard, openDb, recordChannelLaneMessage,
  type Db,
} from "@pi-lead-child/store";
import {
  TicketActionError, createCoordinator, latestInstantOf, UI_ACTIONS, UiActionError, leadAuthorityFor, leadAuthorityMode, listLeadUiActions, listUiActions,
  resolveAuthority, runUiAction, runtimeEnablePermission, uiActionCatalogText,
  type ChannelCardActionService, type ChannelMessageService, type FollowUpEntry, type FollowUpQueueService, type MemorySettingsService,
  type ModelSettingsService,
  type RuntimeSwitchService,
  type TicketActionDefinition, type TicketActionEnv,
} from "../src/index.js";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-ui-actions-"), "plc.db"));
});

// 内存里的执行器开关：记下每次 update 收到的「谁拨的」。
function fakeRuntimeSwitch(disabled: Partial<Record<RuntimeId, RuntimeDisabledBy>> = {}) {
  const state = new Map<RuntimeId, RuntimeDisabledBy>(Object.entries(disabled) as Array<[RuntimeId, RuntimeDisabledBy]>);
  const calls: Array<[RuntimeSettingsRequest, RuntimeSwitchBy]> = [];
  const service: RuntimeSwitchService = {
    get(): RuntimeSettingsDto {
      return {
        runtimes: (["codex", "claude", "pi"] as const).map((id) => ({
          id, label: id === "codex" ? "Codex" : id === "claude" ? "Claude Code" : "pi",
          enabled: !state.has(id), installed: true, canReview: id === "codex",
        })),
        reviewer: { id: "codex", canReview: !state.has("codex") },
      };
    },
    disabledBy: (runtime) => state.get(runtime) ?? null,
    async update(request, by) {
      calls.push([request, by]);
      if (request.enabled) state.delete(request.runtime);
      else state.set(request.runtime, { by: by.actor, reason: by.actor === "lead" ? by.reason : null, at: "2026-10-22T00:00:00.000Z" });
      return service.get();
    },
  };
  return { service, calls };
}

function ledger() {
  return db.prepare("SELECT source, entity_key, payload FROM events WHERE kind=? ORDER BY seq").all(UI_ACTION_PERFORMED_KIND)
    .map((row: any) => ({ source: row.source, entityKey: row.entity_key, ...JSON.parse(row.payload) }));
}

function userTurn(state: "streaming" | "completed" = "streaming") {
  const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
  createTurn(db, { id: `turn-${state}`, originBindingId: binding.id, originKind: "paired:companion", userText: "把 claude 打开", state });
  return { binding, turnId: `turn-${state}` };
}

describe("the catalog", () => {
  it("registers every action of every target type in the protocol, and nothing else", () => {
    for (const type of UI_ACTION_TARGET_TYPES) {
      expect(Object.keys(UI_ACTIONS[type])).toEqual(Object.keys(UI_ACTION_INPUT_SCHEMAS[type]));
      for (const [id, definition] of Object.entries(UI_ACTIONS[type])) {
        expect([definition.target, definition.id]).toEqual([type, id]);
        expect(definition.where).not.toBe("");
      }
    }
  });

  it("writes the tool description from the definitions, with where the user clicks", () => {
    const text = uiActionCatalogText();
    expect(text).toContain("runtime（执行器");
    expect(text).toContain("disable（停用执行器）：你可以自己判断。用户自己点：设置 → 执行 → 执行器");
    expect(text).toContain("revoke（作废设备凭证）：只有用户本人能做：你调用总会被拒绝。用户自己点：设置 → 设备 → 已配对设备");
  });
});

describe("Lead's authority", () => {
  it("never lets Lead act on user_direct, even when it is also external or irreversible", () => {
    for (const facts of [
      { external: false, irreversible: false }, { external: true, irreversible: false }, { external: false, irreversible: true },
    ]) {
      expect(leadAuthorityFor({ permission: "user_direct", ...facts }).mode).toBe("user_direct");
    }
    expect(leadAuthorityFor({ permission: "lead_allowed", external: false, irreversible: false }).mode).toBe("own");
    expect(leadAuthorityFor({ permission: "delegated", external: false, irreversible: false, delegatedInScope: true }).mode).toBe("delegated");
  });

  // 用户 2026-10-27：UI 上能做的操作 Lead 在哪一轮都能做（定时器、Slack 事件叫醒的一轮也行）。只属于用户的、对外的、
  // 不可逆的，在用户这一轮里记成代用户做（forUser），别的时候记成 Lead 自己做的。只有标了 userTurnOnly 的还要用户这一轮。
  it("lets Lead do user_only, external and irreversible operations in any turn, unless the operation is user-turn only", () => {
    for (const facts of [
      { permission: "user_only", external: false, irreversible: false },
      { permission: "lead_allowed", external: true, irreversible: false },
      { permission: "user_only", external: true, irreversible: false },
      { permission: "user_only", external: false, irreversible: true },
    ] as const) {
      expect(leadAuthorityFor(facts)).toEqual({ mode: "own", why: null, forUser: true });
    }
    expect(leadAuthorityFor({ permission: "lead_allowed", external: false, irreversible: false })).toEqual({ mode: "own", why: null, forUser: false });
    expect(leadAuthorityFor({ permission: "user_only", external: false, irreversible: false, userTurnOnly: true }).mode).toBe("user_turn");
    expect(leadAuthorityFor({ permission: "lead_allowed", external: true, irreversible: false, userTurnOnly: true }).mode).toBe("user_turn");
  });

  it("lets Lead enable only what Lead disabled itself", () => {
    const at = "2026-10-22T00:00:00.000Z";
    expect(runtimeEnablePermission(false, null)).toBe("lead_allowed");
    expect(runtimeEnablePermission(true, { by: "lead", reason: "超时", at })).toBe("lead_allowed");
    expect(runtimeEnablePermission(true, { by: "user", reason: null, at })).toBe("user_only");
    // 来历不明的停用（手设的环境变量、旧的配置）按用户停用的算。
    expect(runtimeEnablePermission(true, null)).toBe("user_only");
  });
});

describe("runUiAction", () => {
  it("disables a runtime from both entries with the same ledger row, only the actor differs", async () => {
    const { service, calls } = fakeRuntimeSwitch();
    const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
    const page = await runUiAction(db, {
      target: { type: "runtime", id: "codex" }, action: "disable",
      caller: { kind: "user", credential: binding, source: { client: "web", deviceName: "Mac 网页", loopback: true, fromThisMachine: true } },
      services: { runtimeSettings: service },
    });
    expect(page.authority).toBe("user");
    await runUiAction(db, { target: { type: "runtime", id: "codex" }, action: "enable", caller: { kind: "user" }, services: { runtimeSettings: service } });
    const lead = await runUiAction(db, {
      target: { type: "runtime", id: "codex" }, action: "disable", reason: "Codex 账号被停用",
      caller: { kind: "lead", turnId: null }, services: { runtimeSettings: service },
    });
    expect(lead.authority).toBe("lead");
    expect(calls).toEqual([
      [{ runtime: "codex", enabled: false }, { actor: "user" }],
      [{ runtime: "codex", enabled: true }, { actor: "user" }],
      [{ runtime: "codex", enabled: false }, { actor: "lead", reason: "Codex 账号被停用" }],
    ]);
    const [byPage, , byLead] = ledger();
    const same = ({ source: _s, actor: _a, authority: _au, bindingId: _b, reason: _r, ...rest }: any) => rest;
    expect(same(byPage)).toEqual(same(byLead));
    expect(byPage).toMatchObject({
      source: "user", entityKey: "runtime:codex", actor: "user", authority: "user", bindingId: binding.id, reason: "在设置页停用",
      action: "disable", detail: { runtime: "codex", enabled: false, wasEnabled: true },
    });
    expect(byLead).toMatchObject({ source: "lead", actor: "lead", authority: "lead", bindingId: null, reason: "Codex 账号被停用" });
    expect(byLead.onBehalfOf).toBeUndefined();
  });

  it("refuses a user_direct action from Lead with a structured refusal that says where to click", async () => {
    const { binding } = createLoopbackBinding(db, { name: "iPhone" });
    const { turnId } = userTurn();
    // 用户本人这一轮也不行：user_direct 不能代做。
    for (const turn of [null, turnId]) {
      const error = await runUiAction(db, {
        target: { type: "device", id: binding.id }, action: "revoke", reason: "用户说把手机踢掉",
        caller: { kind: "lead", turnId: turn },
      }).then(() => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(UiActionError);
      expect((error as UiActionError).code).toBe("user_direct");
      expect((error as UiActionError).refusal).toEqual({
        code: "user_direct", target: { type: "device", id: String(binding.id) }, action: "revoke", label: "作废设备凭证",
        permission: "user_direct", where: "设置 → 设备 → 已配对设备", message: expect.stringContaining("请用户在 设置 → 设备 → 已配对设备 里自己点"),
      });
    }
    expect(getBinding(db, binding.id)?.status).toBe("active");
    expect(ledger()).toEqual([]);

    // 页面入口照常能做，账本记你本人。
    const outcome = await runUiAction(db, { target: { type: "device", id: binding.id }, action: "revoke", caller: { kind: "user" } });
    expect(outcome.authority).toBe("user");
    expect(getBinding(db, binding.id)?.status).toBe("revoked");
    expect(ledger()).toMatchObject([{ source: "user", entityKey: `device:${binding.id}`, actor: "user", action: "revoke" }]);
  });

  it("lets Lead do a user_only action in any turn, and records it for the user only inside the user's own active turn", async () => {
    // 每次都从「用户停用了 claude」开始（启用以后再启用就是 Lead 自己能做的了）。
    let calls: Array<[RuntimeSettingsRequest, RuntimeSwitchBy]> = [];
    const enable = (turnId: string | null) => {
      const fake = fakeRuntimeSwitch({ claude: { by: "user", reason: null, at: "2026-10-22T00:00:00.000Z" } });
      calls = fake.calls;
      return runUiAction(db, {
        target: { type: "runtime", id: "claude" }, action: "enable", reason: "用户说可以用 claude 了",
        caller: { kind: "lead", turnId }, services: { runtimeSettings: fake.service },
      });
    };

    // 被事件叫醒的一轮、已经结束的一轮：Lead 自己做，账本写 Lead。
    const ended = userTurn("completed");
    for (const turnId of [null, ended.turnId]) {
      expect((await enable(turnId)).authority).toBe("lead");
      expect(calls).toEqual([[{ runtime: "claude", enabled: true }, { actor: "lead", reason: "用户说可以用 claude 了" }]]);
    }
    expect(ledger().splice(0)).toMatchObject([{ actor: "lead", authority: "lead" }, { actor: "lead", authority: "lead" }]);

    const { binding, turnId } = userTurn();
    const outcome = await enable(turnId);
    expect(outcome.authority).toBe("on_behalf");
    expect(calls).toEqual([[
      { runtime: "claude", enabled: true },
      { actor: "lead", reason: "用户说可以用 claude 了", onBehalfOf: { actor: "user", sourceTurnId: turnId } },
    ]]);
    expect(ledger().at(-1)).toMatchObject({
      source: "lead", actor: "lead", authority: "on_behalf", onBehalfOf: "user", sourceTurnId: turnId, bindingId: binding.id,
    });
  });

  // 2026-10-26：会话输入框右下角换 Lead 的模型。你本人点就换；Lead 在哪一轮都能换（2026-10-27），你这一轮里换的记成代你换。
  it("switches Lead's model for the user and for Lead in any turn", async () => {
    const switches: unknown[] = [];
    const services = {
      leadModels: {
        state: () => ({ current: { model: "vibeproxy/claude-sonnet-5", effort: null }, selected: { model: "vibeproxy/claude-sonnet-5", effort: null } }),
        catalog: async () => { throw new Error("not used"); },
        switch: async (choice: { model: string; effort: string | null }) => {
          switches.push(choice);
          return { previous: { model: "vibeproxy/claude-sonnet-5", effort: null }, selected: choice, applied: "now" as const };
        },
      },
    };
    const choice = { model: "vibeproxy/as4/claude-sonnet-5", effort: "high" };
    const byUser = await runUiAction(db, { target: { type: "lead_model", id: "lead" }, action: "switch", input: choice, caller: { kind: "user" }, services });
    expect(byUser.result).toMatchObject({ selected: choice, applied: "now" });

    const byLead = (turnId: string | null) => runUiAction(db, {
      target: { type: "lead_model", id: "lead" }, action: "switch", input: choice, reason: "用户要换模型",
      caller: { kind: "lead", turnId }, services,
    });
    expect((await byLead(null)).authority).toBe("lead");
    const { turnId } = userTurn();
    expect((await byLead(turnId)).authority).toBe("on_behalf");
    expect(switches).toEqual([choice, choice, choice]);
    expect(ledger().map((entry) => [entry.actor, entry.authority])).toEqual([["user", "user"], ["lead", "lead"], ["lead", "on_behalf"]]);

    // 没有这个服务（Lead 的会话还没建好）：说清楚还没有启动。
    const missing = await runUiAction(db, {
      target: { type: "lead_model", id: "lead" }, action: "switch", input: choice, caller: { kind: "user" }, services: {},
    }).then(() => null, (caught: unknown) => caught as UiActionError);
    expect(missing?.message).toContain("还没有启动");
  });

  it("checks the target, the action, the input and Lead's reason before doing anything", async () => {
    const { service, calls } = fakeRuntimeSwitch();
    const services = { runtimeSettings: service };
    const codeOf = (promise: Promise<unknown>) => promise.then(() => null, (caught: unknown) => (caught as UiActionError).code);
    expect(await codeOf(runUiAction(db, { target: { type: "planet", id: "x" }, action: "disable", caller: { kind: "user" }, services })))
      .toBe("not_found");
    expect(await codeOf(runUiAction(db, { target: { type: "runtime", id: "gpt" }, action: "disable", caller: { kind: "user" }, services })))
      .toBe("not_found");
    expect(await codeOf(runUiAction(db, { target: { type: "runtime", id: "codex" }, action: "revoke", caller: { kind: "user" }, services })))
      .toBe("not_found");
    expect(await codeOf(runUiAction(db, {
      target: { type: "runtime", id: "codex" }, action: "disable", input: { force: true }, caller: { kind: "user" }, services,
    }))).toBe("invalid_input");
    expect(await codeOf(runUiAction(db, {
      target: { type: "runtime", id: "codex" }, action: "disable", reason: "  ", caller: { kind: "lead", turnId: null }, services,
    }))).toBe("invalid_input");
    expect(await codeOf(runUiAction(db, { target: { type: "runtime", id: "codex" }, action: "disable", caller: { kind: "user" } })))
      .toBe("unavailable");
    expect(await codeOf(runUiAction(db, { target: { type: "device", id: "01" }, action: "revoke", caller: { kind: "user" } })))
      .toBe("not_found");
    expect(calls).toEqual([]);
  });
});

describe("listLeadUiActions", () => {
  it("shows Lead the same answer as the page, why it cannot act and where the user clicks", async () => {
    const { service } = fakeRuntimeSwitch({ codex: { by: "user", reason: null, at: "2026-10-22T00:00:00.000Z" } });
    const runtime = await listLeadUiActions(db, { type: "runtime", id: "codex" }, { services: { runtimeSettings: service }, turnId: null });
    expect(runtime.target).toMatchObject({ type: "runtime", id: "codex", enabled: false, disabledBy: "user" });
    expect(runtime.actions.map((action) => [action.id, action.permission, action.lead, action.leadReady])).toEqual([
      ["disable", "lead_allowed", "own", true],
      ["enable", "user_only", "own", true],
    ]);
    expect(runtime.actions[1]!.leadReason).toBeNull();

    const { binding } = createLoopbackBinding(db, { name: "iPhone" });
    const device = await listLeadUiActions(db, { type: "device", id: String(binding.id) }, { turnId: null });
    expect(device.target).toEqual({ type: "device", id: binding.id, name: "iPhone", kind: "companion", status: "active" });
    expect(device.actions).toMatchObject([{
      id: "revoke", permission: "user_direct", available: true, lead: "user_direct", leadReady: false,
      leadReason: expect.stringContaining("请用户在 设置 → 设备 → 已配对设备 里自己点"),
    }]);
  });
});

// 工单操作和别的目标共用四档：一个 user_direct 的工单操作（以后的托管授予）Lead 调用时被拒，请用户在工单详情里点。
describe("ticket actions share the four tiers", () => {
  it("refuses Lead a user_direct ticket action, even in the user's own turn", () => {
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "lead" });
    const item = getItem(db, itemId)!;
    const definition = {
      id: "confirm", label: "托管给 Lead", permission: "user_direct", external: false, irreversible: false,
    } as unknown as TicketActionDefinition;
    const env = {} as TicketActionEnv;
    const { turnId } = userTurn();
    expect(leadAuthorityMode(definition, item, env)).toMatchObject({ mode: "user_direct", permission: "user_direct" });
    for (const turn of [null, turnId]) {
      let caught: unknown = null;
      try {
        resolveAuthority(db, definition, item, { kind: "lead", turnId: turn }, env);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(TicketActionError);
      expect((caught as TicketActionError).code).toBe("user_direct");
      expect((caught as Error).message).toContain("请用户在工单详情里自己点");
    }
    expect(resolveAuthority(db, definition, item, { kind: "user" }, env).authority).toBe("user");
  });
});

// P02：审批是 user_only（Lead 提议的常设指令修改是 user_direct），决定请求按受众分档。
// 2026-10-28（用户：「lead agent 能自己审批吗」）：Lead 在任何一轮都能自己批；用户本人这一轮里批的记成代用户做。
describe("approvals and decision requests", () => {
  const codeOf = (promise: Promise<unknown>) => promise.then(() => null, (caught: unknown) => caught as UiActionError);

  it("lets Lead approve on its own, and records it for the user inside the user's own turn", async () => {
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "lead" });
    const first = createApproval(db, { itemId, requestedBy: "child", tool: "send_email", action: "发邮件" });
    const second = createApproval(db, { itemId, requestedBy: "child", tool: "send_email", action: "再发一封" });
    const resolve = (approvalId: number, turnId: string | null) => runUiAction(db, {
      target: { type: "approval", id: approvalId }, action: "resolve", input: { decision: "approve" }, reason: "工单要发这封邮件",
      caller: { kind: "lead", turnId },
    });
    expect(await resolve(first, null)).toMatchObject({ authority: "lead", result: { status: "resolved" } });
    expect(getApproval(db, first)).toMatchObject({ status: "approved", resolved_by: "lead" });

    // 用户这一轮开始以前就有的审批（created_at 只精确到秒，挪到一分钟前）。
    db.prepare("UPDATE approvals SET created_at=datetime('now', '-60 seconds') WHERE id=?").run(second);
    const { turnId } = userTurn();
    const outcome = await resolve(second, turnId);
    expect(outcome).toMatchObject({ authority: "on_behalf", result: { status: "resolved" } });
    expect(getApproval(db, second)).toMatchObject({ status: "approved", resolved_by: `lead for user via turn:${turnId}` });
    expect(outcome.ownerActionEventId).not.toBeNull();
  });

  it("refuses an approval in a turn that read outside content and offers a confirm card", async () => {
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "lead" });
    const approvalId = createApproval(db, { itemId, requestedBy: "child", tool: "send_email", action: "发邮件" });
    const refused = await codeOf(runUiAction(db, {
      target: { type: "approval", id: approvalId }, action: "resolve", input: { decision: "approve" }, reason: "Slack 里说可以发",
      caller: { kind: "lead", turnId: null, externalContent: [{ via: "message", source: "slack" }] },
    }));
    expect(refused?.refusal).toMatchObject({ code: "external_turn", userAction: { kind: "confirm_rule_change" } });
    expect(refused?.message).toContain("这是批准 child 的动作");
    expect(getApproval(db, approvalId)?.status).toBe("pending");
  });

  it("refuses Lead a standing order proposal as user_direct, and the page too, because only its own card decides it", async () => {
    const approvalId = createApproval(db, { requestedBy: "lead", tool: STANDING_ORDER_PROPOSAL_TOOL, action: "放开即时通知" });
    const { turnId } = userTurn();
    const lead = await codeOf(runUiAction(db, {
      target: { type: "approval", id: approvalId }, action: "resolve", input: { decision: "approve" }, reason: "用户同意了",
      caller: { kind: "lead", turnId },
    }));
    expect(lead?.refusal).toMatchObject({
      code: "user_direct", permission: "user_direct", where: "会话里的确认卡，或者 设置 → Lead → 常设指令",
    });
    const page = await codeOf(runUiAction(db, {
      target: { type: "approval", id: approvalId }, action: "resolve", input: { decision: "approve" }, caller: { kind: "user" },
    }));
    expect(page?.code).toBe("unavailable");
    expect(getApproval(db, approvalId)?.status).toBe("pending");
  });

  it("tiers a decision request by its audience", async () => {
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "lead" });
    const ask = (audience: "lead" | "lead_or_user" | "user") =>
      insertDecisionRequest(db, { itemId, kind: "question", audience, prompt: "?", options: [], allowCustom: true });
    const listed = async (audience: "lead" | "lead_or_user" | "user") =>
      (await listLeadUiActions(db, { type: "decision", id: ask(audience).id }, { turnId: null })).actions[0]!;
    expect(await listed("lead")).toMatchObject({ permission: "lead_allowed", lead: "own", leadReady: true });
    expect(await listed("lead_or_user")).toMatchObject({ permission: "lead_allowed", lead: "own", leadReady: true });
    expect(await listed("user")).toMatchObject({ permission: "user_only", lead: "own", leadReady: true });
  });

  // 用户不能被冒充：用户的决定要写明渠道；Lead 自己做的就记成 Lead。
  it("keeps the coordinator from recording a user decision without a user channel", () => {
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "lead" });
    const approvalId = createApproval(db, { itemId, requestedBy: "child", tool: "send_email", action: "发邮件" });
    const coordinator = createCoordinator({ db });
    expect(() => coordinator.resolveApproval({
      approvalId, decision: "approve", actor: { kind: "user", resolvedBy: "lead" },
    })).toThrow(/explicit user channel/);
    expect(getApproval(db, approvalId)?.status).toBe("pending");
    const request = insertDecisionRequest(db, { itemId, kind: "question", audience: "user", prompt: "?", options: [], allowCustom: true });
    coordinator.resolveDecision({ requestId: request.id, decision: "respond", resolution: "v2", actor: { kind: "lead", resolvedBy: "lead" } });
    expect(getDecisionRequest(db, request.id)).toMatchObject({ state: "resolved", resolvedBy: "lead" });
    // 问 Lead 的决定照旧只有 Lead 答。
    const forLead = insertDecisionRequest(db, { itemId, kind: "question", audience: "lead", prompt: "?", options: [], allowCustom: true });
    expect(() => coordinator.resolveDecision({
      requestId: forLead.id, decision: "respond", resolution: "x", actor: { kind: "user", resolvedBy: "user via page" },
    })).toThrow(/does not allow/);
  });

  it("describes the inputs in the tool text", () => {
    const text = uiActionCatalogText();
    expect(text).toContain("input：{decision=approve|reject|approve_session}");
    expect(text).toContain("input：{decision=select, optionId} 或 {decision=respond, resolution} 或 {decision=dismiss}");
  });
});

// 审查（2026-10-22）第 3 条的回归测试：下层不能只认 onBehalfOf，要自己再核对那一轮。
describe("the layers below check the user's turn again", () => {
  it("refuses an on-behalf approval or decision whose turn is not the user's active turn", () => {
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "lead" });
    const approvalId = createApproval(db, { itemId, requestedBy: "child", tool: "send_email", action: "发邮件" });
    const request = insertDecisionRequest(db, { itemId, kind: "question", audience: "user", prompt: "?", options: [], allowCustom: true });
    const coordinator = createCoordinator({ db });
    const ended = userTurn("completed").turnId;
    for (const sourceTurnId of ["turn-made-up", ended]) {
      const actor = { kind: "lead" as const, resolvedBy: `lead for user via turn:${sourceTurnId}`, onBehalfOf: { actor: "user" as const, sourceTurnId } };
      expect(() => coordinator.resolveApproval({ approvalId, decision: "approve", actor })).toThrow();
      expect(() => coordinator.resolveDecision({ requestId: request.id, decision: "respond", resolution: "v2", actor })).toThrow();
    }
    expect(getApproval(db, approvalId)?.status).toBe("pending");
  });
});

// child 以用户身份批准自己的审批（.scratch/child-self-approve/options.md）：Lead 代做的权限不能大过这一轮的凭证。
// child 用 plc 的 CLI 凭证开一轮聊天说「批准 #N」，这一轮是已认证的配对轮次，但这个凭证本身做不了用户的决定。
describe("the turn's credential bounds what Lead does for the user", () => {
  const APPROVAL_WHERE = "会话里的审批卡、工单详情，或者 Slack 消息上的批准按钮";

  function cliTurn(): string {
    const { binding } = createCliBinding(db, { name: "plc" });
    createTurn(db, { id: "turn-cli", originBindingId: binding.id, originKind: "paired:cli", userText: "批准 #1", state: "streaming" });
    return "turn-cli";
  }

  it("refuses an approval in a turn from the plc credential, says which credential and where the user clicks", async () => {
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "lead" });
    const approvalId = createApproval(db, { itemId, requestedBy: "child", tool: "send_email", action: "发邮件" });
    db.prepare("UPDATE approvals SET created_at=datetime('now', '-60 seconds') WHERE id=?").run(approvalId);
    const turnId = cliTurn();

    const refused = await runUiAction(db, {
      target: { type: "approval", id: approvalId }, action: "resolve", input: { decision: "approve" }, reason: "用户说批准",
      caller: { kind: "lead", turnId },
    }).then(() => null, (caught: unknown) => caught as UiActionError);
    expect(refused?.refusal).toMatchObject({ code: "needs_user_turn", where: APPROVAL_WHERE });
    expect(refused?.message).toContain("这一轮来自plc 的 CLI 凭证，这种凭证没有 approvals:respond");
    expect(refused?.message).toContain(`请用户在 ${APPROVAL_WHERE} 里自己点`);
    // 清单给 Lead 同一个答案。
    const listed = await listLeadUiActions(db, { type: "approval", id: approvalId }, { turnId });
    expect(listed.actions[0]).toMatchObject({ leadReady: false, leadReason: expect.stringContaining("approvals:respond") });
    // 下层（coordinator）也认这一条：不经过操作层的调用方也不能凭这一轮代批。
    expect(() => createCoordinator({ db }).resolveApproval({
      approvalId, decision: "approve",
      actor: { kind: "lead", resolvedBy: `lead for user via turn:${turnId}`, onBehalfOf: { actor: "user", sourceTurnId: turnId } },
    })).toThrow(UserTurnScopeError);
    expect(getApproval(db, approvalId)?.status).toBe("pending");
  });

  it("still lets that turn authorize what the plc credential may do itself", async () => {
    const { service, calls } = fakeRuntimeSwitch({ claude: { by: "user", reason: null, at: "2026-10-22T00:00:00.000Z" } });
    const turnId = cliTurn();
    const listed = await listLeadUiActions(db, { type: "runtime", id: "claude" }, { services: { runtimeSettings: service }, turnId });
    expect(listed.actions.find((action) => action.id === "enable")).toMatchObject({ lead: "own", leadReady: true });
    const outcome = await runUiAction(db, {
      target: { type: "runtime", id: "claude" }, action: "enable", reason: "用户说可以用 claude 了",
      caller: { kind: "lead", turnId }, services: { runtimeSettings: service },
    });
    expect(outcome.authority).toBe("on_behalf");
    expect(calls).toHaveLength(1);
  });
});

// approvals.created_at 是 SQLite 的 datetime('now')，只精确到秒：读成那一秒的最后一毫秒，和这一轮开始落在同一秒的不算更早。
describe("when a target appeared", () => {
  it("reads second-precision times as the last millisecond of that second, and ISO times as they are", () => {
    expect(latestInstantOf("2026-10-22 10:00:00")).toBe(Date.UTC(2026, 9, 22, 10, 0, 0, 999));
    expect(latestInstantOf("2026-10-22T10:00:00.123Z")).toBe(Date.UTC(2026, 9, 22, 10, 0, 0, 123));
    expect(Number.isNaN(latestInstantOf("not a time"))).toBe(true);
  });

  it("does not count an approval from the same second as the turn's start as seen by the user", async () => {
    // Lead 自己批得了（2026-10-28），只是不记成代用户做。
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "lead" });
    const approvalId = createApproval(db, { itemId, requestedBy: "child", tool: "send_email", action: "发邮件" });
    const { created_at: createdAt } = getApproval(db, approvalId)!;
    const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
    // 这一轮在审批那一秒的第 500 毫秒开始：审批可能在它之前，也可能在它之后，一律不算用户见过。
    createTurn(db, {
      id: "turn-same-second", originBindingId: binding.id, originKind: "paired:companion", userText: "批", state: "streaming",
      now: new Date(Date.parse(`${createdAt.replace(" ", "T")}Z`) + 500),
    });
    const outcome = await runUiAction(db, {
      target: { type: "approval", id: approvalId }, action: "resolve", input: { decision: "approve" }, reason: "用户说批",
      caller: { kind: "lead", turnId: "turn-same-second" },
    });
    expect(outcome.authority).toBe("lead");
    expect(getApproval(db, approvalId)).toMatchObject({ status: "approved", resolved_by: "lead" });
  });
});

// 外部消息卡（用户 2026-10-23：「不想离开工作界面，直接用自然语言让 agent 代我回复」）。卡上的按钮和 Lead 代你回复是同一个操作；
// 经过 daemon、通道 hub 和假 Slack 的整条路在 apps/daemon/test/channel-reply-for-user-daemon.test.ts。
describe("channel cards", () => {
  function card(at: Date) {
    const lane = recordChannelLaneMessage(db, {
      source: "slack", objectKey: "slack:D0ZHANG:main", label: "张三的私信",
      message: { at: at.toISOString(), seq: null, role: "them", sender: "张三", text: "周五的评审你能来吗？" },
    });
    return openChannelCard(db, {
      // 没有这条来源事件：最新消息的时间按卡自己的时间算（真的卡指向来源里那条消息）。
      laneId: lane.id, source: "slack", objectKey: "slack:D0ZHANG:main", delivery: "card", seq: 99_999,
      sender: { id: "U0ZHANG", name: "张三", trust: "colleague" }, excerpt: "周五的评审你能来吗？", replyTarget: {}, at,
    });
  }

  // 通道 hub 的替身：记下操作层交给它的每一次调用。
  function fakeCards(actions: ChannelCardAction[] = ["send_draft", "send_edited", "reply_myself", "snooze", "dismiss"]) {
    const acts: Array<[number, ChannelCardAction, Parameters<ChannelCardActionService["act"]>[2]]> = [];
    const channelCards: ChannelCardActionService = {
      actionsFor: () => actions,
      act: async (cardId, action, options) => {
        acts.push([cardId, action, options]);
        const state = action === "snooze" ? "snoozed" : "replied";
        return { id: cardId, state, sentText: options.text ?? null, actions: [] } as unknown as ChannelCardDto;
      },
    };
    return { channelCards, acts };
  }

  it("lets Lead reply in any turn, and records it as done for the user inside the user's own turn", async () => {
    const opened = card(new Date(Date.now() - 60_000));
    const { channelCards, acts } = fakeCards();
    const target = { type: "channel_card", id: opened.id };
    // 被事件叫醒的一轮（用户 2026-10-27）：Lead 自己发，账本写 Lead。
    const woken = await runUiAction(db, {
      target, action: "send_draft", reason: "张三在等回复", caller: { kind: "lead", turnId: null }, services: { channelCards },
    });
    expect(woken.authority).toBe("lead");
    // 不是用户这一轮：forUser 是 false，hub 让这条回复先过出站的信心检验（统一消息事件 spec D9）。
    expect(acts.splice(0)).toEqual([[opened.id, "send_draft", { by: "lead", forUser: false }]]);
    // 稍后 Lead 可以自己判断。
    await runUiAction(db, { target, action: "snooze", reason: "用户在开会", caller: { kind: "lead", turnId: null }, services: { channelCards } });
    expect(acts).toEqual([[opened.id, "snooze", { by: "lead", forUser: false }]]);

    // 用户本人这一轮里说「回他：能来」：Lead 把原话发出去，账本写 Lead 代用户做、凭哪一轮。
    const { turnId } = userTurn();
    const outcome = await runUiAction(db, {
      target, action: "send_edited", input: { text: "能来，三点以后到" }, reason: "用户说回张三：能来，三点以后到",
      caller: { kind: "lead", turnId }, services: { channelCards },
    });
    expect(acts.at(-1)).toEqual([opened.id, "send_edited", { by: `lead for user via turn:${turnId}`, forUser: true, text: "能来，三点以后到" }]);
    expect(outcome.forLead).toEqual({ card: { id: opened.id, state: "replied", sentText: "能来，三点以后到", actions: [] } });
    expect(ledger().at(-1)).toMatchObject({
      entityKey: `channel_card:${opened.id}`, action: "send_edited", actor: "lead", authority: "on_behalf", onBehalfOf: "user",
      sourceTurnId: turnId, detail: { cardId: opened.id, from: "open", to: "replied" },
    });
    // 卡上现在没有的动作（这张卡没有自动回复可撤）：不能做。
    await expect(runUiAction(db, {
      target, action: "undo_auto_reply", reason: "用户说撤回", caller: { kind: "lead", turnId }, services: { channelCards },
    })).rejects.toMatchObject({ code: "unavailable" });
    // 没有接任何来源：不能做。
    await expect(runUiAction(db, { target, action: "dismiss", caller: { kind: "user" } })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("does not count it as the user's when the other person wrote again after the user started talking", async () => {
    const opened = card(new Date());
    const { channelCards, acts } = fakeCards();
    const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
    createTurn(db, {
      id: "turn-before-the-message", originBindingId: binding.id, originKind: "paired:companion", userText: "回张三：能来",
      state: "streaming", now: new Date(Date.now() - 10_000),
    });
    // 用户说话时还没见过这条新消息：发不发由 Lead 判断，发了记成 Lead 自己做的，不写代用户做。
    const outcome = await runUiAction(db, {
      target: { type: "channel_card", id: opened.id }, action: "send_edited", input: { text: "能来" }, reason: "用户说回张三：能来",
      caller: { kind: "lead", turnId: "turn-before-the-message" }, services: { channelCards },
    });
    expect(outcome).toMatchObject({ by: { actor: "lead" }, authority: "lead" });
    expect(acts).toEqual([[opened.id, "send_edited", { by: "lead", forUser: false, text: "能来" }]]);
  });

  it("marks a card handled in any turn, passing what was done and the emoji", async () => {
    const opened = card(new Date(Date.now() - 60_000));
    const { channelCards, acts } = fakeCards(["send_draft", "dismiss", "handled"]);
    const target = { type: "channel_card", id: opened.id };
    // 被事件叫醒的一轮（定时器、Slack 事件）：Lead 自己做，账本写 Lead。
    const woken = await runUiAction(db, {
      target, action: "handled", input: { note: "私信了 Nina" }, reason: "Ivy 让转告", caller: { kind: "lead", turnId: null }, services: { channelCards },
    });
    expect(woken).toMatchObject({ by: { actor: "lead" }, authority: "lead" });
    expect(acts.splice(0)).toEqual([[opened.id, "handled", { by: "lead", forUser: false, note: "私信了 Nina" }]]);
    const { turnId } = userTurn();
    await expect(runUiAction(db, {
      target, action: "handled", input: {}, reason: "用户说按 Ivy 说的去发", caller: { kind: "lead", turnId }, services: { channelCards },
    })).rejects.toMatchObject({ code: "invalid_input" });
    await runUiAction(db, {
      target, action: "handled", input: { note: "私信了 Nina 和 Lucas", emoji: "+1" }, reason: "用户说按 Ivy 说的去发",
      caller: { kind: "lead", turnId }, services: { channelCards },
    });
    expect(acts).toEqual([[opened.id, "handled", { by: `lead for user via turn:${turnId}`, forUser: true, note: "私信了 Nina 和 Lucas", emoji: "+1" }]]);
  });
});

// 往外部来源的一个对话里直接发消息，不经过卡片（用户 2026-10-23）。hub 和 Slack 那一段在 channel-direct-message.test.ts。
describe("channel conversations", () => {
  function fakeMessages() {
    const sends: Array<[string, Parameters<ChannelMessageService["send"]>[1]]> = [];
    const reacts: Array<[string, Parameters<ChannelMessageService["react"]>[1]]> = [];
    const channelMessages: ChannelMessageService = {
      canSend: (source) => source === "slack",
      send: async (conversationId, input) => {
        sends.push([conversationId, input]);
        return { conversation: conversationId, label: "oliver.z的私信", objectKey: "slack:D0OLIVER:main", text: input.text, card: null, outcome: "sent" };
      },
      react: async (conversationId, input) => {
        reacts.push([conversationId, input]);
        return { conversation: conversationId, label: "oliver.z的私信", objectKey: "slack:D0OLIVER:main", seq: 7, emoji: input.emoji, card: null };
      },
      openCards: () => [{ id: 3, sender: "Ivy Lin", conversation: "Ivy Lin的私信", state: "open", since: "2026-10-26T08:35:00.000Z" }],
    };
    return { channelMessages, sends, reacts };
  }

  // 回归（用户 2026-10-27）：Lead 定了一个定时器去 Slack 频道发消息，到点那一轮（不是用户的一轮）被拒，发不出去。
  it("lets Lead send a message in a turn woken by a timer or a Slack event, recorded as Lead's own", async () => {
    const { channelMessages, sends } = fakeMessages();
    const target = { type: "channel_conversation", id: "slack:C0STANDUP:main" };
    const input = { text: "今天的站会改到 10 点半。", words: "assistant" };
    const outcome = await runUiAction(db, {
      target, action: "send_message", input, reason: "用户昨天让我今天 9 点在 #standup 通知站会改时间",
      caller: { kind: "lead", turnId: null }, services: { channelMessages },
    });
    // 不是用户这一轮：forUser 是 false，hub 写 auto-reply 署名（统一消息事件 spec D9）。
    expect(sends).toEqual([["slack:C0STANDUP:main", { ...input, by: "lead", forUser: false, seenBefore: null }]]);
    expect(outcome).toMatchObject({ by: { actor: "lead" }, authority: "lead" });
    expect(ledger().at(-1)).toMatchObject({
      entityKey: "channel_conversation:slack:C0STANDUP:main", action: "send_message", actor: "lead", authority: "lead",
      reason: "用户昨天让我今天 9 点在 #standup 通知站会改时间",
    });
    expect(ledger().at(-1)).not.toHaveProperty("onBehalfOf");
  });

  // 回归（用户 2026-10-29）：Lead 自己设的跟进叫醒的一轮，用 GitHub 连接核对了 PR，再私信 Ethan。以前操作层让 hub 过出站检验，
  // hub 说不出是哪条消息要求的，拒绝了。Lead 自己的话由 Lead 判断：这一轮读过什么、谁叫醒的，都原样交给 hub 发。
  it("hands Lead's own message to the hub as it is, in a turn that read a connection or that a Slack message woke", async () => {
    const { channelMessages, sends } = fakeMessages();
    const input = { text: "PR 111 按你的意见改了。", words: "assistant" };
    await runUiAction(db, {
      target: { type: "channel_conversation", id: "slack:@U0ETHAN" }, action: "send_message", input, reason: "跟进到点：返工推上去了，回 Ethan",
      caller: { kind: "lead", turnId: null, externalContent: [{ via: "tool", tool: "call_connection_tool" }] }, services: { channelMessages },
    });
    expect(sends).toEqual([["slack:@U0ETHAN", { ...input, by: "lead", forUser: false, seenBefore: null }]]);
    // Lead 给了回复的是哪条消息事件时照传。
    await runUiAction(db, {
      target: { type: "channel_conversation", id: "slack:C0PROJ:main" }, action: "send_message", input: { ...input, event: 7 },
      reason: "Mallory 让我在 #proj-x 说一声",
      caller: { kind: "lead", turnId: null, externalContent: [{ via: "message", source: "slack" }] }, services: { channelMessages },
    });
    expect(sends.at(-1)).toEqual(["slack:C0PROJ:main", { ...input, by: "lead", forUser: false, seenBefore: null, event: 7 }]);
  });

  it("lets Lead send a message for the user inside the user's own turn, to a conversation without any card", async () => {
    const { channelMessages, sends } = fakeMessages();
    const target = { type: "channel_conversation", id: "slack:@U0OLIVER" };
    const input = { text: "就是之前给你演示的 demo", words: "user" };

    const { turnId } = userTurn();
    const outcome = await runUiAction(db, {
      target, action: "send_message", input, reason: "用户说给 oliver 回：就是之前给你演示的 demo",
      caller: { kind: "lead", turnId }, services: { channelMessages },
    });
    expect(sends).toEqual([["slack:@U0OLIVER", { ...input, by: `lead for user via turn:${turnId}`, forUser: true, seenBefore: expect.any(Number) }]]);
    // 发完自查：还在等用户的卡（只有结构化的事实），和怎么结束它们。
    expect(outcome.forLead).toEqual({
      sent: { conversation: "slack:@U0OLIVER", label: "oliver.z的私信", objectKey: "slack:D0OLIVER:main", text: input.text, card: null, outcome: "sent" },
      openCards: [{ id: 3, sender: "Ivy Lin", conversation: "Ivy Lin的私信", state: "open", since: "2026-10-26T08:35:00.000Z" }],
      next: expect.stringContaining("handled"),
    });
    expect(ledger().at(-1)).toMatchObject({
      entityKey: "channel_conversation:slack:@U0OLIVER", action: "send_message", actor: "lead", authority: "on_behalf", onBehalfOf: "user",
      detail: { conversation: "slack:@U0OLIVER", objectKey: "slack:D0OLIVER:main", words: "user" },
    });
  });

  it("checks the id, the input and the source before sending", async () => {
    const { channelMessages, sends } = fakeMessages();
    const { turnId } = userTurn();
    const send = (id: string, input: unknown) => runUiAction(db, {
      target: { type: "channel_conversation", id }, action: "send_message", input, reason: "用户说发", caller: { kind: "lead", turnId },
      services: { channelMessages },
    });
    await expect(send("no colon", { text: "hi", words: "user" })).rejects.toMatchObject({ code: "not_found" });
    await expect(send("slack:@U0OLIVER", { text: "", words: "user" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(send("slack:@U0OLIVER", { text: "hi", words: "lead" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(send("jira:PROJ-1", { text: "hi", words: "user" })).rejects.toMatchObject({ code: "unavailable" });
    expect(sends).toEqual([]);
  });

  it("passes the card the message does and the user's turn start, so the hub can end the card", async () => {
    const { channelMessages, sends } = fakeMessages();
    const { turnId } = userTurn();
    await runUiAction(db, {
      target: { type: "channel_conversation", id: "slack:@U0NINA" }, action: "send_message",
      input: { text: "麻烦更新一下 PROJ-34469 的状态", words: "assistant", cardId: 3 }, reason: "用户说按 Ivy 说的去发",
      caller: { kind: "lead", turnId }, services: { channelMessages },
    });
    expect(sends[0]![1]).toMatchObject({ cardId: 3, seenBefore: expect.any(Number) });
  });

  it("reacts in any turn, for the user inside the user's own turn, with a valid emoji name", async () => {
    const { channelMessages, reacts } = fakeMessages();
    const target = { type: "channel_conversation", id: "slack:@U0OLIVER" };
    const woken = await runUiAction(db, {
      target, action: "react", input: { emoji: "white_check_mark" }, reason: "收尾", caller: { kind: "lead", turnId: null }, services: { channelMessages },
    });
    expect(woken.authority).toBe("lead");
    expect(reacts.splice(0)).toEqual([["slack:@U0OLIVER", { emoji: "white_check_mark", by: "lead", seenBefore: null }]]);
    const { turnId } = userTurn();
    await expect(runUiAction(db, {
      target, action: "react", input: { emoji: "✅" }, reason: "用户说加个 ✅", caller: { kind: "lead", turnId }, services: { channelMessages },
    })).rejects.toMatchObject({ code: "invalid_input" });
    const outcome = await runUiAction(db, {
      target, action: "react", input: { emoji: "white_check_mark" }, reason: "用户说给李雷最后一条加 ✅",
      caller: { kind: "lead", turnId }, services: { channelMessages },
    });
    expect(reacts).toEqual([["slack:@U0OLIVER", { emoji: "white_check_mark", by: `lead for user via turn:${turnId}`, seenBefore: expect.any(Number) }]]);
    expect(outcome.forLead).toMatchObject({ reacted: { seq: 7, emoji: "white_check_mark" }, openCards: [{ id: 3 }] });
    expect(ledger().at(-1)).toMatchObject({ action: "react", authority: "on_behalf", detail: { seq: 7, emoji: "white_check_mark" } });
  });
});

// 工单 10：主对话输入框上方的排队状态栏。「排到下一个」「移出队列」是一个操作、两个入口（页面的路由和 Lead 的 perform_action），
// 排队在 daemon 里（lead-input.ts），这里经 services.leadQueue 调它。
describe("the queue of external messages while Lead is busy (ticket 10)", () => {
  const codeOf = (promise: Promise<unknown>) => promise.then(() => null, (caught: unknown) => (caught as UiActionError).code);

  function fakeQueue() {
    const entry = (key: string, next: boolean) => ({
      key, conversation: `${key} 的私信`, source: "slack", sourceLabel: "Slack", senders: [key], count: 1, excerpt: "别人的原话",
      cardIds: [key === "slack:@A" ? 1 : 2], firstAt: "2026-10-27T01:00:00.000Z", lastAt: "2026-10-27T01:00:00.000Z", next,
      actions: next ? ["remove" as const] : ["move_next" as const, "remove" as const],
    });
    let keys = ["slack:@A", "slack:@B"];
    const calls: string[] = [];
    const snapshot = () => ({ busy: true, entries: keys.map((key, index) => entry(key, index === 0)) });
    return {
      calls,
      service: {
        snapshot,
        moveNext: (key: string) => { calls.push(`next ${key}`); keys = [key, ...keys.filter((other) => other !== key)]; return snapshot(); },
        remove: async (key: string, by: string) => { calls.push(`remove ${key} by ${by}`); keys = keys.filter((other) => other !== key); return snapshot(); },
      },
    };
  }

  it("moves a conversation to the front for the user and for Lead, and refuses the one already next", async () => {
    const { service, calls } = fakeQueue();
    const services = { leadQueue: service };
    const moved = await runUiAction(db, { target: { type: "lead_queue", id: "slack:@B" }, action: "move_next", caller: { kind: "user" }, services });
    expect((moved.result as { entries: Array<{ key: string }> }).entries.map((entry) => entry.key)).toEqual(["slack:@B", "slack:@A"]);
    // 已经是下一个：停用，写明原因（P5.8）。
    expect(await codeOf(runUiAction(db, { target: { type: "lead_queue", id: "slack:@B" }, action: "move_next", caller: { kind: "user" }, services })))
      .toBe("unavailable");
    // Lead 自己能排（lead_allowed），账本写 actor=lead。给 Lead 的结果里没有对方的原话。
    const byLead = await runUiAction(db, {
      target: { type: "lead_queue", id: "slack:@A" }, action: "move_next", reason: "用户说先看李雷的", caller: { kind: "lead", turnId: null }, services,
    });
    expect(byLead.authority).toBe("lead");
    expect(JSON.stringify(byLead.forLead)).not.toContain("别人的原话");
    expect(calls).toEqual(["next slack:@B", "next slack:@A"]);
    expect(ledger().map((row) => [row.target.type, row.target.id, row.action, row.actor])).toEqual([
      ["lead_queue", "slack:@B", "move_next", "user"], ["lead_queue", "slack:@A", "move_next", "lead"],
    ]);
  });

  it("removes a conversation from the queue in the user's name, and says so when nothing of it is queued", async () => {
    const { service, calls } = fakeQueue();
    const services = { leadQueue: service };
    const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
    await runUiAction(db, {
      target: { type: "lead_queue", id: "slack:@A" }, action: "remove",
      caller: { kind: "user", credential: binding, source: { client: "web", deviceName: "Mac 网页", loopback: true, fromThisMachine: true } }, services,
    });
    expect(calls).toEqual([`remove slack:@A by user via Mac 网页（binding ${binding.id}）`]);
    const gone = await runUiAction(db, { target: { type: "lead_queue", id: "slack:@A" }, action: "remove", caller: { kind: "user" }, services })
      .then(() => null, (caught: unknown) => caught as UiActionError);
    expect(gone?.code).toBe("not_found");
    // 没有这个服务（Lead 的会话还没建好）：说清楚还没有启动。
    const missing = await runUiAction(db, { target: { type: "lead_queue", id: "slack:@B" }, action: "remove", caller: { kind: "user" }, services: {} })
      .then(() => null, (caught: unknown) => caught as UiActionError);
    expect(missing?.message).toContain("还没有启动");
  });
});

// 用户 2026-10-28：Lead 忙时用户排着的追问，状态栏每一行的「Steer」和「×」。一个操作、两个入口（页面的路由和 Lead 的 perform_action），
// 排队在 daemon 里，这里经 services.followUps 调它。插进这一轮只属于用户，读过外部内容的一轮里 Lead 不能做（externalTurnFloor）；
// 不再发给 Lead 是 user_direct：Lead 永远不能删掉用户说过的话。
describe("follow-ups the user queued while Lead is busy", () => {
  const WHERE = "主对话输入框上方的状态栏";
  const refusalOf = (promise: Promise<unknown>) => promise.then(() => null, (caught: unknown) => caught as UiActionError);

  function followUp(turnId: string, held = false): FollowUpEntry {
    return {
      turnId, text: `用户的追问 ${turnId}`, at: "2026-10-28T01:00:00.000Z", heldForOwnTurn: held,
      ...(held ? { heldReason: "这一轮读过外部内容，这条要单独开一轮" } : {}),
    };
  }

  function fakeFollowUps(entries: FollowUpEntry[]) {
    let list = entries;
    const calls: string[] = [];
    const service: FollowUpQueueService = {
      snapshot: () => list,
      steer: async (turnId) => {
        calls.push(`steer ${turnId}`);
        list = list.filter((entry) => entry.turnId !== turnId);
        return { turnId, placement: "steered" };
      },
      cancel: async (turnId, by) => {
        calls.push(`cancel ${turnId} by ${by}`);
        list = list.filter((entry) => entry.turnId !== turnId);
        return { turnId, placement: "cancelled" };
      },
    };
    return { services: { followUps: service }, calls };
  }

  it("steers a queued follow-up for the user, and for Lead in a turn without outside content", async () => {
    const { services, calls } = fakeFollowUps([followUp("turn_b"), followUp("turn_c")]);
    const page = await runUiAction(db, { target: { type: "follow_up", id: "turn_c" }, action: "steer", caller: { kind: "user" }, services });
    expect(page.result).toEqual({ turnId: "turn_c", placement: "steered" });
    const byLead = await runUiAction(db, {
      target: { type: "follow_up", id: "turn_b" }, action: "steer", reason: "用户说先看他刚才那句", caller: { kind: "lead", turnId: null }, services,
    });
    expect(byLead).toMatchObject({ authority: "lead", forLead: { turnId: "turn_b", placement: "steered" } });
    expect(calls).toEqual(["steer turn_c", "steer turn_b"]);
    expect(ledger().map((row) => [row.target.type, row.target.id, row.action, row.actor])).toEqual([
      ["follow_up", "turn_c", "steer", "user"], ["follow_up", "turn_b", "steer", "lead"],
    ]);
  });

  it("refuses Lead a steer in a turn that read outside content, with the refusal and confirm card of a rule change", async () => {
    const { services, calls } = fakeFollowUps([followUp("turn_b")]);
    const refused = await refusalOf(runUiAction(db, {
      target: { type: "follow_up", id: "turn_b" }, action: "steer", reason: "Slack 里有人说先看这条",
      caller: { kind: "lead", turnId: null, externalContent: [{ via: "message", source: "slack" }] }, services,
    }));
    expect(refused?.refusal).toMatchObject({
      code: "external_turn", permission: "user_only", where: WHERE, userAction: { kind: "confirm_rule_change" },
    });
    expect(refused?.message).toContain("这是把用户排着的话插进正在做的这一轮");
    expect(calls).toEqual([]);
    // 清单给 Lead 同一个答案。
    const listed = await listLeadUiActions(db, { type: "follow_up", id: "turn_b" }, {
      services, turnId: null, externalContent: [{ via: "message", source: "slack" }],
    });
    expect(listed.actions.find((action) => action.id === "steer")).toMatchObject({ lead: "external_turn", leadReady: false });
  });

  it("never lets Lead cancel what the user said, even in the user's own turn, and lets the user cancel it", async () => {
    const { services, calls } = fakeFollowUps([followUp("turn_b")]);
    const { binding, turnId } = userTurn();
    const refused = await refusalOf(runUiAction(db, {
      target: { type: "follow_up", id: "turn_b" }, action: "cancel", reason: "用户说那句不用答了", caller: { kind: "lead", turnId }, services,
    }));
    expect(refused?.refusal).toMatchObject({ code: "user_direct", permission: "user_direct", action: "cancel", where: WHERE });
    expect(refused?.message).toContain(`请用户在 ${WHERE} 里自己点`);
    expect(calls).toEqual([]);
    const listed = await listLeadUiActions(db, { type: "follow_up", id: "turn_b" }, { services, turnId });
    expect(listed.actions.map((action) => [action.id, action.lead, action.leadReady])).toEqual([
      ["steer", "own", true], ["cancel", "user_direct", false],
    ]);

    await runUiAction(db, {
      target: { type: "follow_up", id: "turn_b" }, action: "cancel",
      caller: { kind: "user", credential: binding, source: { client: "web", deviceName: "Mac 网页", loopback: true, fromThisMachine: true } }, services,
    });
    expect(calls).toEqual([`cancel turn_b by user via Mac 网页（binding ${binding.id}）`]);
    expect(ledger().at(-1)).toMatchObject({ action: "cancel", actor: "user", detail: { turnId: "turn_b", placement: "cancelled" } });
  });

  it("says a follow-up held for its own turn cannot be steered, and still lets the user cancel it", async () => {
    const { services, calls } = fakeFollowUps([followUp("turn_b", true)]);
    const views = await listUiActions(db, { type: "follow_up", id: "turn_b" }, { services });
    expect(views.map((view) => [view.id, view.available, view.reason])).toEqual([
      ["steer", false, "这一轮读过外部内容，这条要单独开一轮。"], ["cancel", true, null],
    ]);
    const steer = await refusalOf(runUiAction(db, { target: { type: "follow_up", id: "turn_b" }, action: "steer", caller: { kind: "user" }, services }));
    expect(steer?.code).toBe("unavailable");
    await runUiAction(db, { target: { type: "follow_up", id: "turn_b" }, action: "cancel", caller: { kind: "user" }, services });
    expect(calls).toEqual(["cancel turn_b by user via page"]);
  });

  it("says when the follow-up is gone, and when Lead's session has not started", async () => {
    const { services } = fakeFollowUps([]);
    const gone = await refusalOf(runUiAction(db, { target: { type: "follow_up", id: "turn_x" }, action: "steer", caller: { kind: "user" }, services }));
    expect(gone?.code).toBe("not_found");
    const missing = await refusalOf(runUiAction(db, { target: { type: "follow_up", id: "turn_x" }, action: "cancel", caller: { kind: "user" }, services: {} }));
    expect(missing?.message).toContain("还没有启动");
  });
});

// 设置 → 模型（2026-10-29，.scratch/model-settings/spec.md D10）：带 key 的操作只有用户本人能做；key 不进账本。
describe("model settings", () => {
  function fakeModelSettings() {
    const calls: Array<[string, unknown]> = [];
    const service: ModelSettingsService = {
      summary: () => ({
        brain: { chain: ["vibeproxy/as4/claude-sonnet-5-5"], current: "vibeproxy/as4/claude-sonnet-5-5", providers: ["vibeproxy"] },
        fast: { chain: ["jev"], models: [{ id: "jev", name: "jev", host: "api.typesafe.ai", keySet: true }], llmFallback: null },
        maxBackups: 3,
      }),
      get: async () => { throw new Error("not used"); },
      setBrainChain: async (request) => { calls.push(["setBrainChain", request]); return { summary: "大脑：主用 x", applied: "now" }; },
      saveProvider: async (request) => { calls.push(["saveProvider", request]); return { summary: `接入了服务商 ${request.name}` }; },
      removeProvider: async (name) => { calls.push(["removeProvider", name]); return { summary: `删掉了服务商 ${name}` }; },
      saveFastModel: async (request) => { calls.push(["saveFastModel", request]); return { summary: "添加了直觉", id: "decision-1" }; },
      removeFastModel: async (id) => { calls.push(["removeFastModel", id]); return { summary: "删掉了直觉" }; },
      setFastChain: async (request) => { calls.push(["setFastChain", request]); return { summary: "直觉：主用 jev" }; },
      testFastModel: async () => ({ ok: true, message: "决策模型可用", latencyMs: 12 }),
    };
    return { service, calls };
  }

  it("refuses Lead every operation that carries a key, and tells it where the user clicks", async () => {
    const { service, calls } = fakeModelSettings();
    const { turnId } = userTurn();
    for (const [action, input] of [
      ["save_provider", { name: "openai", baseUrl: "https://api.openai.com/v1", api: "openai-completions", apiKey: "sk-test-123" }],
      ["remove_provider", { name: "openai" }],
      ["save_fast_model", { name: "decision-1", baseUrl: "https://jev.example.com", model: "jev-latest", apiKey: "tsk-123" }],
      ["remove_fast_model", { id: "decision-1" }],
    ] as const) {
      const error = await runUiAction(db, {
        target: { type: "model_settings", id: "models" }, action, input, reason: "用户说接入 OpenAI",
        caller: { kind: "lead", turnId }, services: { modelSettings: service },
      }).then(() => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(UiActionError);
      expect((error as UiActionError).code).toBe("user_direct");
      expect((error as UiActionError).refusal?.where).toBe("设置 → 模型");
    }
    expect(calls).toEqual([]);
  });

  it("lets the user save a provider, and keeps the key out of the ledger", async () => {
    const { service, calls } = fakeModelSettings();
    const input = { name: "openai", baseUrl: "https://api.openai.com/v1", api: "openai-completions", apiKey: "sk-secret-0123456789" };
    const outcome = await runUiAction(db, {
      target: { type: "model_settings", id: "models" }, action: "save_provider", input,
      caller: { kind: "user" }, services: { modelSettings: service },
    });
    expect(outcome.authority).toBe("user");
    expect(calls).toEqual([["saveProvider", input]]);
    expect(JSON.stringify(ledger())).not.toContain("sk-secret");
    expect(ledger()).toMatchObject([{ actor: "user", action: "save_provider", detail: { name: "openai", summary: "接入了服务商 openai" } }]);
  });

  it("lets Lead change the chains and test a decision model, and refuses a chain over the limit before the service runs", async () => {
    const { service, calls } = fakeModelSettings();
    const lead = { kind: "lead" as const, turnId: null };
    await runUiAction(db, {
      target: { type: "model_settings", id: "models" }, action: "set_fast_chain", input: { chain: ["jev"] }, reason: "用户说只用 jev",
      caller: lead, services: { modelSettings: service },
    });
    const tested = await runUiAction(db, {
      target: { type: "model_settings", id: "models" }, action: "test_fast_model", input: { id: "jev" }, reason: "看看 jev 能不能用",
      caller: lead, services: { modelSettings: service },
    });
    expect(tested.eventId).toBeNull();
    const five = Array.from({ length: 5 }, (_, i) => ({ model: `vibeproxy/m${i}`, effort: null }));
    const error = await runUiAction(db, {
      target: { type: "model_settings", id: "models" }, action: "set_brain_chain", input: { models: five }, reason: "试试",
      caller: lead, services: { modelSettings: service },
    }).then(() => null, (caught: unknown) => caught);
    expect((error as UiActionError).code).toBe("invalid_input");
    expect(calls).toEqual([["setFastChain", { chain: ["jev"] }]]);
  });
});

// 设置 → 记忆的摘要模型（2026-10-29，.scratch/hindsight-primary-memory/spec.md D16）：设置页的选项算改规则。
// Lead 在自己的回合里可以改；读过外部内容的回合里被拒，拒绝里带确认卡。重试失败的写入不改规则。
describe("memory settings", () => {
  function fakeMemorySettings(failed = 0) {
    const calls: Array<[string, unknown]> = [];
    const service: MemorySettingsService = {
      summary: () => ({
        enabled: true,
        summaryModels: [
          { slot: "default", model: "vibeproxy/claude-haiku-5-5", source: "auto", problem: null },
          { slot: "consolidation", model: "vibeproxy/claude-haiku-5-5", source: "inherit", problem: null },
        ],
        writes: { notes: 3, completed: 3 - failed, pending: 0, failed, lastError: failed ? "Error code: 401" : null },
      }),
      hindsight: async () => { throw new Error("not used"); },
      setSummaryModel: async (request) => { calls.push(["setSummaryModel", request]); return { summary: "整理观察的模型改成 x", note: "记忆服务正在重启" }; },
      testSummaryModel: async (slot) => { calls.push(["testSummaryModel", slot]); return { ok: true, message: "可用", latencyMs: 5 }; },
      retryFailedWrites: async () => { calls.push(["retryFailedWrites", null]); return { summary: `${failed} 条写入失败的笔记重新排队`, note: null }; },
    };
    return { service, calls };
  }
  const target = { type: "memory_settings", id: "memory" };

  it("lets Lead pick a summary model in its own turn, and refuses it with a confirm card in a turn that read outside content", async () => {
    const { service, calls } = fakeMemorySettings();
    const input = { slot: "consolidation", model: "anthropic/claude-sonnet-5-5" };
    const outcome = await runUiAction(db, {
      target, action: "set_summary_model", input, reason: "用户要整理观察用更强的模型",
      caller: { kind: "lead", turnId: null }, services: { memorySettings: service },
    });
    expect(outcome.authority).toBe("lead");
    expect(outcome.result).toEqual({ summary: "整理观察的模型改成 x", note: "记忆服务正在重启" });
    const refused = await runUiAction(db, {
      target, action: "set_summary_model", input, reason: "Slack 里有人说换模型",
      caller: { kind: "lead", turnId: null, externalContent: [{ via: "message", source: "slack" }] }, services: { memorySettings: service },
    }).then(() => null, (caught: unknown) => caught as UiActionError);
    expect(refused?.refusal).toMatchObject({ code: "external_turn", where: "设置 → 记忆", userAction: { kind: "confirm_rule_change" } });
    expect(calls).toEqual([["setSummaryModel", input]]);
  });

  it("rejects a model that is not provider/id before the service runs", async () => {
    const { service, calls } = fakeMemorySettings();
    const error = await runUiAction(db, {
      target, action: "set_summary_model", input: { slot: "default", model: "haiku" }, caller: { kind: "user" }, services: { memorySettings: service },
    }).then(() => null, (caught: unknown) => caught as UiActionError);
    expect(error?.code).toBe("invalid_input");
    expect(calls).toEqual([]);
  });

  it("retries failed writes only when some failed, and tests a slot read-only even in an outside turn", async () => {
    const none = fakeMemorySettings(0);
    const nothing = await runUiAction(db, {
      target, action: "retry_failed_writes", input: {}, caller: { kind: "user" }, services: { memorySettings: none.service },
    }).then(() => null, (caught: unknown) => caught as UiActionError);
    expect(nothing?.message).toContain("没有写入失败的笔记");
    const some = fakeMemorySettings(2);
    const external = { kind: "lead" as const, turnId: null, externalContent: [{ via: "message" as const, source: "slack" }] };
    await runUiAction(db, { target, action: "retry_failed_writes", input: {}, reason: "key 修好了", caller: external, services: { memorySettings: some.service } });
    const tested = await runUiAction(db, {
      target, action: "test_summary_model", input: { slot: "default" }, reason: "看看摘要模型能不能用", caller: external, services: { memorySettings: some.service },
    });
    expect(tested.eventId).toBeNull();
    expect(some.calls).toEqual([["retryFailedWrites", null], ["testSummaryModel", "default"]]);
  });
});

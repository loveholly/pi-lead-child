// 改规则被拦下以后的确认卡（统一的消息事件 spec D10 的「放行」，工单 09）。
// 外部的一轮里改规则的操作被拒绝时（工单 07），系统存下这一个操作（参数原样），拒绝里带着确认卡的 user_action。
// 用户在 Companion 的卡上点「确认这一次」：系统只执行存下的这一个操作，参数不能换，账本记成 Lead 代用户做、用户确认过；
// 点「不改」：记下来，告诉 Lead。确认的入口是操作层的 rule_change.resolve，权限 user_direct：Lead 不能替用户点。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { CHANNEL_POLICY_DEFAULTS, UI_ACTION_PERFORMED_KIND } from "@pi-lead-child/protocol";
import {
  channelPolicy, createItem, createLoopbackBinding, createTurn, getItem, getStandingOrder, listActivities, listEvents, openDb, type Binding, type Db,
} from "@pi-lead-child/store";
import { getRuleChangeConfirmation, requestRuleChangeConfirmation, runUiAction } from "../src/index.js";

let db: Db;
let owner: Binding;

beforeEach(() => {
  db = openDb(join(tempDir("plc-rule-change-confirm-"), "plc.db"));
  owner = createLoopbackBinding(db, { name: "Mac 网页" }).binding;
});

const policy = { type: "channel_policy", id: "slack" } as const;
const tightened = { ...CHANNEL_POLICY_DEFAULTS, autoReply: false };
const external = [{ via: "tool", tool: "read_channel_conversation" }] as const;
// 定时器叫醒的一轮（不是用户的一轮），读过 Slack 对话。
const leadInExternalTurn = { kind: "lead", turnId: null, externalContent: external } as const;
const user = (binding: Binding = owner) => ({
  kind: "user", credential: binding, source: { client: "web", deviceName: binding.display_name, loopback: true, fromThisMachine: true },
}) as const;

async function refuseTighten(): Promise<any> {
  return runUiAction(db, {
    target: policy, action: "tighten", input: tightened, reason: "定时器「每天 9 点」的安排：先别自动回复", caller: leadInExternalTurn,
  }).catch((error: unknown) => error);
}

function resolve(id: string, decision: "confirm" | "decline", caller: any = user(), now?: Date) {
  return runUiAction(db, {
    target: { type: "rule_change", id }, action: "resolve", input: { decision }, reason: "在确认卡上决定", caller, ...(now ? { now } : {}),
  });
}

function ledger() {
  return listEvents(db, { kind: UI_ACTION_PERFORMED_KIND, limit: 1000 }).map((event) => event.payload as any);
}

function inboxFor(id: string) {
  return db.prepare("SELECT severity, summary, payload FROM inbox WHERE dedup_scope = ?").all(`rule_change:${id}`)
    .map((row: any) => ({ ...row, payload: JSON.parse(row.payload) }));
}

describe("the confirm card for a refused rule change", () => {
  it("keeps the one refused operation with its exact parameters, and the refusal carries the card's user_action", async () => {
    const refused = await refuseTighten();
    const id = refused.refusal.confirm.id as string;
    expect(id).toMatch(/^rcc_[A-Za-z0-9_-]{8,40}$/);
    expect(refused.refusal.userAction).toEqual({
      kind: "confirm_rule_change", target: `rule_change:${id}`, title: "确认这一次", reason: "定时器「每天 9 点」的安排：先别自动回复",
    });
    // 卡上的内容都从系统读：要改什么、参数、为什么改（Lead 写的）、为什么被拦（这一轮读过的外部内容）。
    expect(getRuleChangeConfirmation(db, id)).toMatchObject({
      id, state: "pending", label: "收紧自动代你处理", name: "slack 的自动代你处理", where: "设置 → 消息通道 → 自动代你处理",
      operation: { kind: "ui_action", target: policy, action: "tighten" },
      params: expect.arrayContaining([{ name: "autoReply", value: "false" }]),
      reason: "定时器「每天 9 点」的安排：先别自动回复",
      why: "这一轮用 read_channel_conversation 读了外部内容",
      externalContent: external,
      resolvedAt: null, resultPreview: null,
    });
    // 再试一次同样的操作：还是那一张卡，不再存一份。
    const again = await refuseTighten();
    expect(again.refusal.confirm.id).toBe(id);
    expect(listEvents(db, { kind: "rule_change.requested" })).toHaveLength(1);
    expect(getStandingOrder(db, "channel.authority")!.version).toBe(1);
  });

  // 场景 12 的后半（工单 09）：用户点「确认这一次」，只执行这一个操作，参数和卡上的一样。
  it("runs exactly that operation once when the user confirms, recorded as Lead on the user's behalf", async () => {
    const id = (await refuseTighten()).refusal.confirm.id as string;
    const outcome = await resolve(id, "confirm");
    expect(outcome.result).toMatchObject({ confirmation: { id, state: "done", resolvedBy: expect.stringContaining("Mac 网页") } });
    expect(getStandingOrder(db, "channel.authority")).toMatchObject({ version: 2, author: "lead" });
    expect(channelPolicy(db, "slack")!.params.autoReply).toBe(false);

    // 账本：Lead 代用户做了收紧（凭的是这张确认卡和点它的那台设备），用户确认了这张卡。
    expect(ledger()).toMatchObject([
      {
        target: policy, action: "tighten", actor: "lead", authority: "on_behalf", onBehalfOf: "user",
        sourceTurnId: `rule_change:${id}`, bindingId: owner.id,
      },
      { target: { type: "rule_change", id }, action: "resolve", actor: "user", authority: "user", detail: { decision: "confirm", state: "done" } },
    ]);
    expect(listEvents(db, { kind: "rule_change.executed" }).map((event) => event.payload)).toMatchObject([
      { id, actor: "lead", onBehalfOf: "user", sourceTurnId: `rule_change:${id}`, bindingId: owner.id, state: "done" },
    ]);
    // 告诉 Lead 结果。
    expect(inboxFor(id)).toMatchObject([
      { severity: "attention", summary: expect.stringContaining("已经执行"), payload: { kind: "rule_change", confirmation: id, state: "done", wakeLead: true } },
    ]);

    // 再点一次不会再执行。
    await expect(resolve(id, "confirm")).rejects.toMatchObject({ code: "unavailable" });
    expect(getStandingOrder(db, "channel.authority")!.version).toBe(2);
    expect(ledger().filter((payload) => payload.action === "tighten")).toHaveLength(1);
  });

  it("records 不改, tells Lead, and changes nothing", async () => {
    const id = (await refuseTighten()).refusal.confirm.id as string;
    const outcome = await resolve(id, "decline");
    expect(outcome.result).toMatchObject({ confirmation: { id, state: "declined" } });
    expect(getStandingOrder(db, "channel.authority")!.version).toBe(1);
    expect(channelPolicy(db, "slack")!.params.autoReply).toBe(CHANNEL_POLICY_DEFAULTS.autoReply);
    expect(ledger()).toMatchObject([{ target: { type: "rule_change", id }, action: "resolve", actor: "user", detail: { decision: "decline", state: "declined" } }]);
    expect(listEvents(db, { kind: "rule_change.executed" })).toEqual([]);
    expect(inboxFor(id)).toMatchObject([
      { summary: expect.stringContaining("不改"), payload: { kind: "rule_change", confirmation: id, state: "declined", wakeLead: true } },
    ]);
    await expect(resolve(id, "confirm")).rejects.toMatchObject({ code: "unavailable" });
  });

  // 回归（工单 09）：Lead 自己调确认动作，结构化地拒绝，即使在用户本人这一轮里。
  it("refuses Lead pressing it with a structured user_direct refusal, even in the user's own turn", async () => {
    const id = (await refuseTighten()).refusal.confirm.id as string;
    createTurn(db, { id: "turn-user", originBindingId: owner.id, originKind: "paired:companion", userText: "确认吧", state: "streaming" });
    for (const turnId of [null, "turn-user"]) {
      await expect(resolve(id, "confirm", { kind: "lead", turnId })).rejects.toMatchObject({
        code: "user_direct",
        refusal: { code: "user_direct", target: { type: "rule_change", id }, action: "resolve", permission: "user_direct", where: expect.stringContaining("确认卡") },
      });
    }
    expect(getRuleChangeConfirmation(db, id)!.state).toBe("pending");
    expect(getStandingOrder(db, "channel.authority")!.version).toBe(1);
    expect(ledger()).toEqual([]);
  });

  it("cannot be confirmed after it expires", async () => {
    const id = (await refuseTighten()).refusal.confirm.id as string;
    const later = new Date(Date.now() + 25 * 3_600_000);
    expect(getRuleChangeConfirmation(db, id, later)!.state).toBe("expired");
    await expect(resolve(id, "confirm", user(), later)).rejects.toMatchObject({ code: "unavailable" });
    expect(getStandingOrder(db, "channel.authority")!.version).toBe(1);
  });

  it("needs a credential that carries the operation's own scope", async () => {
    const id = (await refuseTighten()).refusal.confirm.id as string;
    const viewer = createLoopbackBinding(db, { name: "只看的设备", scopes: ["tickets:view", "approvals:respond"] }).binding;
    await expect(resolve(id, "confirm", user(viewer))).rejects.toMatchObject({ code: "forbidden" });
    expect(getRuleChangeConfirmation(db, id)!.state).toBe("pending");
    expect(getStandingOrder(db, "channel.authority")!.version).toBe(1);
  });

  // 投递规则（常设指令）还没登记成 UI 动作：确认以后照存下的参数调同一个提议函数，分档照旧。
  it("runs a refused delivery-rule change with the card's parameters", async () => {
    const input = { op: "update", id: "run.transient_retry", limits: { count: 0 } };
    const { id } = requestRuleChangeConfirmation(db, {
      confirm: {
        operation: { kind: "lead_tool", tool: "propose_standing_order_change", input },
        reason: "定时器的安排：先别自动重试", why: "这一轮用 read_channel_conversation 读了外部内容", externalContent: external,
      },
      label: "改常设指令", name: null, where: "设置 → Lead → 常设指令",
    });
    expect(getRuleChangeConfirmation(db, id)).toMatchObject({
      operation: { kind: "lead_tool", tool: "propose_standing_order_change" },
      params: [{ name: "op", value: "update" }, { name: "id", value: "run.transient_retry" }, { name: "limits", value: '{"count":0}' }],
    });
    const outcome = await resolve(id, "confirm");
    expect(outcome.result).toMatchObject({ confirmation: { state: "done", resultPreview: expect.stringContaining("生效") } });
    expect(getStandingOrder(db, "run.transient_retry")).toMatchObject({ version: 2, author: "lead", limits: { count: 0 } });
    expect(listEvents(db, { kind: "rule_change.executed" }).map((event) => event.payload)).toMatchObject([
      { id, actor: "lead", onBehalfOf: "user", bindingId: owner.id, state: "done", operation: { kind: "lead_tool", tool: "propose_standing_order_change" } },
    ]);
  });

  // 执行用的那条路（Lead 代用户、凭这张确认卡）只认卡上存下的操作：参数换了、卡还没确认，都不行。
  it("does not let the confirmed path run anything but the stored operation", async () => {
    const id = (await refuseTighten()).refusal.confirm.id as string;
    const viaCard = { kind: "lead", turnId: null, confirmation: { id, bindingId: owner.id } } as const;
    await expect(runUiAction(db, {
      target: policy, action: "tighten", input: tightened, reason: "凭确认卡", caller: viaCard,
    })).rejects.toMatchObject({ code: "forbidden" });
    await expect(runUiAction(db, {
      target: policy, action: "tighten", input: { ...tightened, autoReply: true }, reason: "凭确认卡", caller: viaCard,
    })).rejects.toMatchObject({ code: "forbidden" });
    expect(getStandingOrder(db, "channel.authority")!.version).toBe(1);
  });
});

// 兜底授权卡（用户 2026-10-29：「最差最差没考虑到的场景应该弹一个授权卡给我授权 lead 处理」）：同一套确认卡，存下
// Lead 被拦下的工单操作，或者一条要在沙箱外跑的命令。用户点了才执行。
describe("the authorization card for what Lead cannot do itself", () => {
  const card = (tool: string, input: unknown) => requestRuleChangeConfirmation(db, {
    confirm: { operation: { kind: "lead_tool", tool, input }, reason: "用户要清理残留进程", why: "沙箱里做不了", externalContent: [] },
    label: tool === "run_on_host" ? "在你的 Mac 上跑一条命令（沙箱外）" : "确认开跑（工单 #1）", name: null, where: "会话里的确认卡",
  });

  it("runs the stored command outside the sandbox only after the user confirms, and keeps the output for Lead", async () => {
    const dir = tempDir("plc-host-command-");
    process.env.PLC_DATA_DIR = dir;
    const marker = join(dir, "ran.txt");
    const declined = card("run_on_host", { command: `touch ${marker}`, cwd: dir, timeout_seconds: 30 });
    expect(getRuleChangeConfirmation(db, declined.id)!.params).toEqual([
      { name: "command", value: `touch ${marker}` }, { name: "cwd", value: dir }, { name: "timeout_seconds", value: "30" },
    ]);
    await resolve(declined.id, "decline");
    expect(existsSync(marker)).toBe(false);

    const { id } = card("run_on_host", { command: `echo hello-from-host && touch ${marker}`, cwd: dir, timeout_seconds: 30 });
    expect(existsSync(marker)).toBe(false);
    const outcome = await resolve(id, "confirm");
    expect(outcome.result).toMatchObject({ confirmation: { state: "done", resultPreview: expect.stringContaining("退出码 0") } });
    expect(existsSync(marker)).toBe(true);
    const output = join(dir, "lead-scratch", "host-commands", `${id}.log`);
    expect(readFileSync(output, "utf8")).toContain("hello-from-host");
    expect(inboxFor(id)[0]!.payload).toMatchObject({ kind: "rule_change", state: "done", wakeLead: true });
  }, 60_000);

  it("refuses to store a command too long to show in full on the card", async () => {
    const { id } = card("run_on_host", { command: `echo ${"x".repeat(500)}` });
    const outcome = await resolve(id, "confirm");
    expect(outcome.result).toMatchObject({ confirmation: { state: "failed", resultPreview: expect.stringContaining("卡上显示不全") } });
  });

  it("does a refused ticket action as the user once the user confirms", async () => {
    const itemId = createItem(db, { title: "草稿", brief: "b", createdBy: "lead", hold: true });
    const { id } = card("ticket_action", { ticket_id: itemId, action: "confirm" });
    const outcome = await runUiAction(db, {
      target: { type: "rule_change", id }, action: "resolve", input: { decision: "confirm" }, reason: "在确认卡上决定", caller: user(),
      services: { ticketActions: { host: {} as never } },
    });
    expect((outcome.result as any).confirmation.resultPreview).toContain("已经执行");
    expect(getItem(db, itemId)!.stage).toBe("ready");
    expect(listActivities(db, itemId).some((row) => row.actor === "user" && row.kind === "transition")).toBe(true);
  });
});


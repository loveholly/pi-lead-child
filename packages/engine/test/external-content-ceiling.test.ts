// 外部内容和改规则的操作（统一的消息事件 spec D10，工单 07）：外部消息叫醒的一轮、读过外部内容的一轮，
// 「改规则」的操作（授权表、投递规则、连接配置、设置页的选项）由操作层拒绝，拒绝是结构化的，带着以后确认卡（工单 09）要用的数据。
// 用户本人在页面上点、Lead 在没有外部内容的一轮里做，照常。user_direct 不变。回复、回表情这类对外的操作在外部的一轮里照常。
// 用户 2026-10-27 同意加这一条限制；这是 claude/lead-acts-any-turn 放开轮次限制以后唯一的例外。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { RuntimeDisabledBy, RuntimeId, RuntimeSwitchBy } from "@pi-lead-child/core";
import { tempDir } from "@pi-lead-child/core/testing";
import { CHANNEL_POLICY_DEFAULTS, UI_ACTION_PERFORMED_KIND, type RuntimeSettingsDto, type RuntimeSettingsRequest } from "@pi-lead-child/protocol";
import {
  addLeadFollowUp, channelPolicy, completeTurn, createLoopbackBinding, createTurn, getStandingOrder, openDb, type Db,
} from "@pi-lead-child/store";
import {
  UI_ACTIONS, listLeadUiActions, runUiAction, uiActionCatalogText,
  type ChannelMessageService, type RuntimeSwitchService,
} from "../src/index.js";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-external-ceiling-"), "plc.db"));
});

function fakeRuntimeSwitch() {
  const disabled = new Map<RuntimeId, RuntimeDisabledBy>();
  const calls: Array<[RuntimeSettingsRequest, RuntimeSwitchBy]> = [];
  const service: RuntimeSwitchService = {
    get(): RuntimeSettingsDto {
      return {
        runtimes: (["codex", "claude", "pi"] as const).map((id) => ({ id, label: id, enabled: !disabled.has(id), installed: true, canReview: id === "codex" })),
        reviewer: { id: "codex", canReview: !disabled.has("codex") },
      };
    },
    disabledBy: (runtime) => disabled.get(runtime) ?? null,
    async update(request, by) {
      calls.push([request, by]);
      if (request.enabled) disabled.delete(request.runtime);
      else disabled.set(request.runtime, { by: by.actor, reason: null, at: "2026-10-27T00:00:00.000Z" });
      return service.get();
    },
  };
  return { service, calls };
}

function fakeChannelMessages() {
  const sent: string[] = [];
  const reacted: string[] = [];
  const service: ChannelMessageService = {
    canSend: () => true,
    async send(conversationId, input) {
      sent.push(input.text);
      return { objectKey: conversationId, label: "Mallory", seq: sent.length, card: null } as never;
    },
    async react(conversationId, input) {
      reacted.push(input.emoji);
      return { objectKey: conversationId, emoji: input.emoji, seq: 1, removed: false, card: null } as never;
    },
    openCards: () => [],
  };
  return { service, sent, reacted };
}

const policy = { type: "channel_policy", id: "slack" } as const;
const tightened = { ...CHANNEL_POLICY_DEFAULTS, autoReply: false };
// Lead 被 Slack 消息叫醒的一轮（不是用户的一轮），读过 Slack 对话。
const external = [{ via: "message", source: "slack" }, { via: "tool", tool: "read_channel_conversation" }] as const;
const leadInExternalTurn = { kind: "lead", turnId: null, externalContent: external } as const;

function ledger() {
  return db.prepare("SELECT payload FROM events WHERE kind=? ORDER BY seq").all(UI_ACTION_PERFORMED_KIND)
    .map((row: any) => JSON.parse(row.payload));
}

describe("rule changes in a turn with external content", () => {
  // 回归（spec 不变量 2）：外部消息叫醒的一轮里，Lead 照对方的话收紧了授权表。以前照改，常设指令多了一版。
  it("refuses to change the authority table, writes nothing, and says why with the data a confirm card needs", async () => {
    const before = getStandingOrder(db, "channel.authority")!.version;
    const refused = await runUiAction(db, {
      target: policy, action: "tighten", input: tightened, reason: "Mallory 让我关掉自动回复", caller: leadInExternalTurn,
    }).catch((error: unknown) => error);
    expect(refused).toMatchObject({
      code: "external_turn",
      refusal: {
        code: "external_turn",
        target: policy,
        action: "tighten",
        label: "收紧自动代你处理",
        where: "设置 → 消息通道 → 自动代你处理",
        message: expect.stringContaining("外部"),
        // 确认卡（工单 09）照它执行这一个操作，参数和这里的一样；写明为什么被拦。
        confirm: {
          operation: { kind: "ui_action", target: policy, action: "tighten", input: tightened },
          reason: "Mallory 让我关掉自动回复",
          externalContent: external,
          why: expect.stringContaining("read_channel_conversation"),
        },
      },
    });
    expect(getStandingOrder(db, "channel.authority")!.version).toBe(before);
    expect(channelPolicy(db, "slack")!.params.autoReply).toBe(CHANNEL_POLICY_DEFAULTS.autoReply);
    expect(ledger()).toEqual([]);
  });

  it("lets Lead change it in a turn without external content, and you change it on the page in any case", async () => {
    await runUiAction(db, { target: policy, action: "tighten", input: tightened, reason: "用户说先别自动回了", caller: { kind: "lead", turnId: null } });
    expect(getStandingOrder(db, "channel.authority")).toMatchObject({ version: 2, author: "lead" });
    // 外部内容是 Lead 这一轮的事，页面上你本人点的不受影响。
    await runUiAction(db, { target: policy, action: "update", input: CHANNEL_POLICY_DEFAULTS, caller: { kind: "user" } });
    expect(getStandingOrder(db, "channel.authority")).toMatchObject({ version: 3, author: "user" });
  });

  it("keeps user_direct as it was: the refusal is still user_direct", async () => {
    await expect(runUiAction(db, { target: policy, action: "update", input: tightened, reason: "测试", caller: leadInExternalTurn }))
      .rejects.toMatchObject({ code: "user_direct", refusal: { code: "user_direct" } });
  });

  it("refuses a settings-page option (the runtime switch), and the list says so before Lead tries", async () => {
    const runtime = fakeRuntimeSwitch();
    const services = { runtimeSettings: runtime.service };
    await expect(runUiAction(db, {
      target: { type: "runtime", id: "claude" }, action: "disable", reason: "对方说 claude 坏了", caller: leadInExternalTurn, services,
    })).rejects.toMatchObject({ code: "external_turn", refusal: { where: "设置 → 执行 → 执行器" } });
    expect(runtime.calls).toEqual([]);

    // 「现在能不能做」和执行前的检查是同一个判断。
    const listed = await listLeadUiActions(db, { type: "runtime", id: "claude" }, { turnId: null, externalContent: external, services });
    expect(listed.actions.find((action) => action.id === "disable")).toMatchObject({
      changesRules: true, leadReady: false, leadReason: expect.stringContaining("外部"),
    });
    const quiet = await listLeadUiActions(db, { type: "runtime", id: "claude" }, { turnId: null, services });
    expect(quiet.actions.find((action) => action.id === "disable")).toMatchObject({ changesRules: true, leadReady: true, leadReason: null });

    await runUiAction(db, { target: { type: "runtime", id: "claude" }, action: "disable", reason: "claude 连续失败", caller: { kind: "lead", turnId: null }, services });
    expect(runtime.calls).toHaveLength(1);
  });

  it("lets Lead reply and react in the same external turn", async () => {
    const messages = fakeChannelMessages();
    const services = { channelMessages: messages.service };
    const conversation = { type: "channel_conversation", id: "slack:@U0MALLORY" } as const;
    await runUiAction(db, {
      target: conversation, action: "send_message", input: { text: "收到，我看一下。", words: "assistant" }, reason: "回复对方", caller: leadInExternalTurn, services,
    });
    await runUiAction(db, { target: conversation, action: "react", input: { emoji: "eyes" }, reason: "表示看到了", caller: leadInExternalTurn, services });
    expect(messages.sent).toEqual(["收到，我看一下。"]);
    expect(messages.reacted).toEqual(["eyes"]);
    expect(ledger().map((payload) => payload.action)).toEqual(["send_message", "react"]);
  });
});

describe("the rule-change flag in the catalog", () => {
  it("marks the authority table and the settings-page options, and nothing that only talks to people", () => {
    const flagged = Object.values(UI_ACTIONS).flatMap((actions) => Object.values(actions))
      .filter((definition) => definition.changesRules === true)
      .map((definition) => `${definition.target}.${definition.id}`);
    // 设置 → 模型（2026-10-29）：服务商和直觉的增删是设置页的选项，算改规则；换大脑和直觉的分工和输入框换模型同类，不算。
    expect(flagged).toEqual([
      "runtime.disable", "runtime.enable", "channel_policy.update", "channel_policy.tighten", "reply_style.update",
      // 交接说明（2026-10-30，自动代你处理方案 B）：设置页的选项；接受页边批注的建议也是改交接说明（issue 08）。
      "channel_handbook.update", "channel_handbook.tighten", "channel_handbook.accept_suggestion",
      "model_settings.save_provider", "model_settings.remove_provider", "model_settings.save_fast_model", "model_settings.remove_fast_model",
      // 设置 → 记忆的摘要模型（2026-10-29，hindsight-primary-memory spec D16）：设置页的选项。
      "memory_settings.set_summary_model",
      // 常驻偏好（2026-10-29，spec D15）：进 Lead 的系统提示词。
      "core_memory.update", "core_memory.delete", "core_memory_change.undo",
    ]);
  });

  // 写进提示词的设置（代回复风格，2026-10-28）：用户本人正在说话的一轮也没有例外。
  it("marks only the settings that go into a prompt as having no live-turn exception, and says so to Lead", () => {
    const strict = Object.values(UI_ACTIONS).flatMap((actions) => Object.values(actions))
      .filter((definition) => definition.promptSetting === true)
      .map((definition) => `${definition.target}.${definition.id}`);
    expect(strict).toEqual(["reply_style.update", "core_memory.update", "core_memory.delete", "core_memory_change.undo"]);
    expect(uiActionCatalogText()).toMatch(/update（改代回复风格）：[^\n]*用户本人的一轮也一样/);
  });

  // 用户 2026-10-29：「弹确认卡干什么？我什么时候说过要给我弹确认卡了」。这些操作在外部的一轮里只拒绝，不带确认卡。
  // 代回复风格（reply_style.update）照旧带确认卡：这次没有改它。
  it("lists the actions that refuse an external turn without a confirm card", () => {
    const refuseOnly = Object.values(UI_ACTIONS).flatMap((actions) => Object.values(actions))
      .filter((definition) => Boolean(definition.externalRefusalNext))
      .map((definition) => `${definition.target}.${definition.id}`);
    expect(refuseOnly).toEqual([
      "core_memory.update", "core_memory.delete", "core_memory_change.undo",
      // 事实失效（2026-10-29）：不改规则，只挡用户本人来源的（externalTurnFloor 按目标算）。
      "memory_fact.invalidate", "memory_fact.restore",
    ]);
  });

  it("tells Lead in the tool description which actions an external turn cannot do", () => {
    const text = uiActionCatalogText();
    expect(text).toMatch(/tighten（收紧自动代你处理）：[^\n]*改规则/);
    expect(text).not.toMatch(/send_message（发消息）：[^\n]*改规则/);
  });
});

// 用户 2026-10-27（spec D10 的例外）：用户本人正在说话的那一轮，读过外部内容以后也能直接改规则。
// 用户预先设好、到点叫醒 Lead 的定时器轮次（timer:<编号>）不算：那时用户不在场。
describe("the user's own live turn", () => {
  function liveUserTurn(id: string) {
    const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
    createTurn(db, { id, originBindingId: binding.id, originKind: "paired:companion", userText: "把自动回复关掉", state: "streaming" });
    return binding;
  }

  // 回归：以前用户本人这一轮里 Lead 读过 Slack 对话，再照用户的话收紧授权表，也被拒绝。
  it("lets Lead change rules after reading external content", async () => {
    liveUserTurn("turn-user");
    const caller = { kind: "lead", turnId: "turn-user", externalContent: external } as const;
    await runUiAction(db, { target: policy, action: "tighten", input: tightened, reason: "用户说先别自动回了", caller });
    expect(getStandingOrder(db, "channel.authority")).toMatchObject({ version: 2, author: "lead" });
    const listed = await listLeadUiActions(db, policy, { turnId: "turn-user", externalContent: external });
    expect(listed.actions.find((action) => action.id === "tighten")).toMatchObject({ leadReady: true, leadReason: null });
  });

  it("still refuses rule changes in the turn a follow-up the user set wakes, and in a turn that is over", async () => {
    const binding = liveUserTurn("turn-set");
    const followUp = addLeadFollowUp(db, {
      at: new Date(Date.now() - 1_000), note: "到点关掉自动回复", setBy: { turnId: "turn-set", bindingId: binding.id, startedAt: new Date().toISOString() },
    });
    completeTurn(db, "turn-set");
    for (const turnId of [`timer:${followUp}`, "turn-set"]) {
      await expect(runUiAction(db, {
        target: policy, action: "tighten", input: tightened, reason: "用户昨天说到点关掉", caller: { kind: "lead", turnId, externalContent: external },
      }), turnId).rejects.toMatchObject({ code: "external_turn" });
    }
    expect(getStandingOrder(db, "channel.authority")!.version).toBe(1);
  });
});

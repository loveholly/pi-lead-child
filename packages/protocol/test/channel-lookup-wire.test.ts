// 代查的线上契约（Slack 代查与按信心代回 spec D2、D9，工单 01）：卡的 DTO 带上代查、卡上的新动作和文字、新的内核事件、
// 两条新规则 channel.lookup、channel.reply 的参数和改它们的档位。
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";

import {
  CHANNEL_CARD_ACTION_SCOPES, CHANNEL_CARD_ACTIONS, CHANNEL_CARD_TEXT_ACTIONS, CHANNEL_EVENT_KINDS, ChannelCardActionRequestSchema,
  ChannelCardDtoSchema, ChannelCardListResponseSchema, classifyStandingOrderChange, eventKindDefinition, validateEventEnvelope,
  validateStandingOrderDefinition, validLookupReads, validLookupResult, validLookupScope,
  type ChannelCardDto, type ChannelLookupDto, type StandingOrderState,
} from "../src/index.ts";

// 一张卡的固定样例：同事问了一个项目里的逻辑，代查查到了，信心不够，卡上问用户（spec 工单 05 的卡片样例）。
const LOOKUP: ChannelLookupDto = {
  id: 12,
  state: "finished",
  playbook: "lookup",
  repos: ["acme/orders"],
  ticketId: 482,
  startedAt: "2026-10-19T06:30:00.000Z",
  finishedAt: "2026-10-19T06:32:10.000Z",
  result: {
    found: "yes",
    answer: "订单 123 的 webhook 只在支付成功以后触发；这一单停在待支付，所以没有触发。",
    sources: [
      {
        via: "local", repo: "acme/orders", path: "src/webhooks/dispatch.ts", startLine: 40, endLine: 44,
        quote: "if (order.status !== 'paid') return;", ref: "3f2c1a0", verified: true,
      },
      { via: "github", repo: "acme/orders", path: "docs/webhooks.md", startLine: 3, endLine: 3, quote: "只在支付成功后发送", verified: false },
    ],
    connectionSources: [],
    actions: [],
    checked: ["acme/orders 的 src/webhooks", "acme/orders 的 docs"],
    caveats: ["没有查订单 123 的实际状态，只查了代码"],
  },
  review: null,
  reads: {
    count: 3,
    items: [
      { tool: "search", repo: "acme/orders", bytes: 812, at: "2026-10-19T06:30:20.000Z" },
      { tool: "read_file", repo: "acme/orders", path: "src/webhooks/dispatch.ts", lines: [1, 120], ref: "3f2c1a0", bytes: 4_210, at: "2026-10-19T06:30:40.000Z" },
      { tool: "read_file", repo: "acme/orders", path: ".env", bytes: 0, refused: "禁止名单里的文件", at: "2026-10-19T06:31:00.000Z" },
    ],
  },
  confidence: {
    value: 0.71,
    threshold: 0.9,
    checks: [
      { id: "sources_verified", label: "出处核实", status: "pass", value: null, detail: "2 处出处，1 处核实通过" },
      { id: "answers_question", label: "答案对题", status: "pass", value: 0.92, detail: "" },
      { id: "supported_by_sources", label: "出处支撑", status: "weak", value: 0.71, detail: "" },
      { id: "ask_kind", label: "分类", status: "pass", value: 0.8, detail: "lookup" },
    ],
    vetoes: [],
    calibration: { bucket: 0.7, samples: 15, agreed: 13, minSamples: 20 },
  },
  reply: { decision: "ask_user", reasons: ["样本不够（15/20），冷启动要信心不低于 0.9"], at: "2026-10-19T06:32:12.000Z" },
  audience: { label: "#proj-x", externalShared: false },
  ownerName: "李雷",
  newerMessages: 0,
  deniedReasons: [],
  error: null,
};

function card(overrides: Partial<ChannelCardDto> = {}): ChannelCardDto {
  return {
    id: 7, version: 9, source: "slack", sourceLabel: "Slack", objectKey: "slack:C0PROJ:1760855400.000100", laneLabel: "#proj-x",
    sender: { id: "U0ZHANG", name: "张三", trust: "colleague" }, excerpt: "订单 123 的 webhook 为什么没触发？", messageCount: 1,
    delivery: "card", state: "open", draft: { text: "订单 123 还在待支付，webhook 只在支付成功以后发。", drafter: "lookup" },
    gate: null, lookup: LOOKUP, handling: null, sentText: null, snoozedUntil: null, revokeUntil: null, resolvedAt: null,
    actions: ["send_draft", "send_edited", "reply_myself", "dismiss"],
    createdAt: "2026-10-19T06:29:58.000Z", updatedAt: "2026-10-19T06:32:12.000Z",
    ...overrides,
  };
}

describe("the card DTO with a lookup", () => {
  it("accepts a card that carries its latest lookup, and an old card whose lookup is null", () => {
    expect(Value.Check(ChannelCardDtoSchema, card())).toBe(true);
    expect(Value.Check(ChannelCardDtoSchema, card({ lookup: null }))).toBe(true);
    expect(Value.Check(ChannelCardListResponseSchema, { items: [card(), card({ id: 8, lookup: null })] })).toBe(true);
    // 被拒的代查：没有工单、没有结果，卡上写明原因。
    const denied: ChannelLookupDto = {
      ...LOOKUP, state: "denied", ticketId: null, finishedAt: LOOKUP.startedAt, result: null, reads: { count: 0, items: [] },
      confidence: null, reply: null, deniedReasons: ["有人提了敏感请求（别人的薪资），没有查"],
    };
    expect(Value.Check(ChannelCardDtoSchema, card({ lookup: denied }))).toBe(true);
    // review 剧本的结果。
    const review: ChannelLookupDto = {
      ...LOOKUP, playbook: "review",
      review: { summary: "一处空指针", commentCount: 1, comments: [{ path: "src/a.ts", line: 12, side: "RIGHT", body: "这里可能是 null" }] },
    };
    expect(Value.Check(ChannelCardDtoSchema, card({ lookup: review }))).toBe(true);
  });

  it("is strict: the lookup field is required, and unknown or malformed fields are refused", () => {
    const { lookup: _lookup, ...withoutLookup } = card();
    expect(Value.Check(ChannelCardDtoSchema, withoutLookup)).toBe(false);
    expect(Value.Check(ChannelCardDtoSchema, card({ lookup: { ...LOOKUP, extra: 1 } as never }))).toBe(false);
    // 主人名（披露前缀里的名字）必须有这个字段；取不到时是 null。
    const { ownerName: _ownerName, ...withoutOwner } = LOOKUP;
    expect(Value.Check(ChannelCardDtoSchema, card({ lookup: withoutOwner as never }))).toBe(false);
    expect(Value.Check(ChannelCardDtoSchema, card({ lookup: { ...LOOKUP, ownerName: null } }))).toBe(true);
    expect(Value.Check(ChannelCardDtoSchema, card({ lookup: { ...LOOKUP, state: "paused" } as never }))).toBe(false);
    expect(Value.Check(ChannelCardDtoSchema, card({ lookup: { ...LOOKUP, playbook: "approve" } as never }))).toBe(false);
    expect(Value.Check(ChannelCardDtoSchema, card({
      lookup: { ...LOOKUP, confidence: { ...LOOKUP.confidence!, value: 1.5 } },
    }))).toBe(false);
    expect(Value.Check(ChannelCardDtoSchema, card({
      lookup: { ...LOOKUP, reply: { ...LOOKUP.reply!, decision: "send" as never } },
    }))).toBe(false);
    expect(Value.Check(ChannelCardDtoSchema, card({ actions: ["send_draft", "approve_review" as never] }))).toBe(false);
  });
});

describe("card actions", () => {
  it("keeps send_edited and cancel_lookup after the lookup retired, each with the scope the gateway checks", () => {
    // 重查（rerun_lookup）和发到 PR（post_review）随代查退役了（落地计划 D1）：工单由 Lead 派，PR 上的 review 由子 agent 写。
    // handled（2026-10-26）：Lead 照你的话在别处做完了卡上的事。
    expect(CHANNEL_CARD_ACTIONS).toEqual([
      "send_draft", "reply_myself", "snooze", "dismiss", "undo_auto_reply", "send_edited", "cancel_lookup", "handled",
    ]);
    expect(Object.keys(CHANNEL_CARD_ACTION_SCOPES).sort()).toEqual([...CHANNEL_CARD_ACTIONS].sort());
    expect(new Set(Object.values(CHANNEL_CARD_ACTION_SCOPES))).toEqual(new Set(["tickets:create"]));
    expect(CHANNEL_CARD_TEXT_ACTIONS).toEqual(["send_edited"]);
  });

  it("takes optional text from 1 to 4000 characters", () => {
    const ok = (body: unknown) => Value.Check(ChannelCardActionRequestSchema, body);
    expect(ok({ action: "send_edited", expectedVersion: 9, text: "好的，我下午看一下" })).toBe(true);
    expect(ok({ action: "send_edited", text: "字".repeat(4_000) })).toBe(true);
    expect(ok({ action: "send_draft" })).toBe(true);
    expect(ok({ action: "send_edited", text: "" })).toBe(false);
    expect(ok({ action: "send_edited", text: "字".repeat(4_001) })).toBe(false);
    expect(ok({ action: "send_edited", text: 42 })).toBe(false);
    expect(ok({ action: "post_review", by: "lead" })).toBe(false);
  });
});

describe("the lookup kernel events", () => {
  const envelope = (kind: string, payload: Record<string, unknown>) => ({
    source: "system" as const, kind, entityKey: "slack:C0PROJ:1760855400.000100", payload,
  });
  const base = { channel: "slack", cardId: 7, lookupId: 12, playbook: "lookup", summary: "s" };

  it("are registered from the system source with payload schemas", () => {
    for (const kind of [
      CHANNEL_EVENT_KINDS.intakeDecided, CHANNEL_EVENT_KINDS.lookupStarted, CHANNEL_EVENT_KINDS.lookupFinished,
      CHANNEL_EVENT_KINDS.lookupDenied, CHANNEL_EVENT_KINDS.replyDecided, CHANNEL_EVENT_KINDS.reviewPosted,
    ]) {
      expect(eventKindDefinition(kind), kind).toMatchObject({ kind, sources: ["system"] });
    }
    expect(CHANNEL_EVENT_KINDS).toMatchObject({
      intakeDecided: "channel.intake.decided", lookupStarted: "channel.lookup.started", lookupFinished: "channel.lookup.finished",
      lookupDenied: "channel.lookup.denied", replyDecided: "channel.reply.decided", reviewPosted: "channel.review.posted",
    });
  });

  it("accept well-formed payloads and refuse malformed ones", () => {
    const valid = [
      envelope(CHANNEL_EVENT_KINDS.intakeDecided, {
        channel: "slack", cardId: 7, forSeq: 301, status: "answered", askKind: "lookup", askConfidence: 0.8, targetRepo: "acme/orders",
        sensitive: { query_personal_info: 0.02 }, topics: { money: 0.01 }, summary: "张三问了一个能查到的问题",
      }),
      envelope(CHANNEL_EVENT_KINDS.intakeDecided, {
        channel: "slack", cardId: 7, forSeq: 301, status: "unavailable", askKind: null, askConfidence: null, targetRepo: null,
        sensitive: {}, error: "timeout", summary: "快模型不可用，没有代查",
      }),
      envelope(CHANNEL_EVENT_KINDS.lookupStarted, { ...base, itemId: 482, runId: 901, repos: ["acme/orders"] }),
      envelope(CHANNEL_EVENT_KINDS.lookupFinished, {
        ...base, status: "finished", found: "yes", itemId: 482, sources: 2, verifiedSources: 1, reads: 3, error: null,
      }),
      envelope(CHANNEL_EVENT_KINDS.lookupDenied, {
        channel: "slack", cardId: 7, lookupId: null, playbook: null, failed: ["sensitive_query"],
        checks: [{ condition: "sensitive_query", pass: false, detail: "query_hr_compensation 0.93" }], order: { id: "channel.slack.lookup", version: 1 },
        summary: "有人提了敏感请求，没有查",
      }),
      envelope(CHANNEL_EVENT_KINDS.replyDecided, {
        ...base, decision: "ask_user", confidence: 0.6, threshold: 0.9, checks: [], vetoes: [], order: null,
      }),
      envelope(CHANNEL_EVENT_KINDS.reviewPosted, {
        ...base, playbook: "review", owner: "acme", repo: "orders", number: 17, comments: 2, foldedComments: 1,
        url: "https://github.com/acme/orders/pull/17", by: "user via 手机（binding 3）",
      }),
    ];
    for (const event of valid) expect(validateEventEnvelope(event, "record"), event.kind).toEqual([]);
    const invalid = [
      envelope(CHANNEL_EVENT_KINDS.intakeDecided, { channel: "slack", cardId: 7, forSeq: 301, status: "maybe", summary: "s" }),
      envelope(CHANNEL_EVENT_KINDS.lookupStarted, { ...base, playbook: "approve", itemId: 482, runId: 901, repos: [] }),
      envelope(CHANNEL_EVENT_KINDS.lookupFinished, { ...base, status: "running", found: null, itemId: null, sources: 0, verifiedSources: 0, reads: 0, error: null }),
      envelope(CHANNEL_EVENT_KINDS.replyDecided, { ...base, decision: "auto_send", confidence: 2, threshold: 0.9, checks: [], vetoes: [], order: null }),
    ];
    for (const event of invalid) expect(validateEventEnvelope(event, "record").length, event.kind).toBeGreaterThan(0);
    // 只有 system 能写。
    expect(validateEventEnvelope({ ...valid[2]!, source: "lead" as const }, "record").length).toBeGreaterThan(0);
  });
});

describe("the store-side validators", () => {
  it("check the scope, the result and the read records against the shared contract", () => {
    expect(validLookupScope({ local: [{ repo: "acme/orders", root: "/Users/me/Workspace/orders" }], github: [] })).toBe(true);
    expect(validLookupScope({})).toBe(false);
    expect(validLookupResult({
      found: "no", answer: "", sources: [], checked: ["acme/orders"], caveats: [], replyDraft: "",
    })).toBe(true);
    expect(validLookupResult({ found: "maybe", answer: "", sources: [], checked: [], caveats: [], replyDraft: "" })).toBe(false);
    expect(validLookupReads(LOOKUP.reads.items)).toBe(true);
    expect(validLookupReads([{ tool: "read_file" }])).toBe(false);
    expect(validLookupReads("[]")).toBe(false);
  });
});

// ── 常设指令 ──────────────────────────────────────────────────────────────────────

const LOOKUP_ORDER: StandingOrderState = {
  id: "channel.test.lookup", title: "代查", priority: 100, condition: {},
  action: {
    type: "rule", rule: "channel.lookup",
    params: {
      source: "test", playbooks: ["lookup", "review"], allowedTrust: ["trusted", "colleague"], minAskConfidence: 0.5,
      maxSensitiveQuery: 0.5, perRequesterDaily: 10, dailyMax: 40, concurrent: 2, timeoutMs: 15 * 60_000, maxRepos: 2,
    },
  },
  limits: null, escalateTo: null, reason: "spec D2 的缺省值", status: "active",
};

const REPLY_ORDER: StandingOrderState = {
  id: "channel.test.reply", title: "代回", priority: 100, condition: {},
  action: {
    type: "rule", rule: "channel.reply",
    params: {
      source: "test", autoReply: { lookup: true, review: false }, threshold: 0.85, coldStartMin: 0.9, calibrationMinSamples: 20,
      calibrationMinAgreement: 0.9, maxSensitivity: 0.2, maxResultAgeMs: 30 * 60_000, revokeWindowMs: 10 * 60_000,
    },
  },
  limits: null, escalateTo: null, reason: "spec D2 的缺省值", status: "active",
};

const active = [LOOKUP_ORDER, REPLY_ORDER];
const withParams = (order: StandingOrderState, params: Record<string, unknown>): StandingOrderState => {
  if (order.action.type !== "rule") throw new Error(order.id);
  return { ...order, action: { ...order.action, params: { ...order.action.params, ...params } }, reason: "测试" };
};
const classify = (before: StandingOrderState, params: Record<string, unknown>) =>
  classifyStandingOrderChange({ active, before, after: withParams(before, params) });
const tier = (before: StandingOrderState, params: Record<string, unknown>) => classify(before, params).tier;

describe("the channel.lookup and channel.reply rules", () => {
  it("validate the spec D2 defaults and refuse out-of-range params", () => {
    expect(validateStandingOrderDefinition(LOOKUP_ORDER)).toEqual([]);
    expect(validateStandingOrderDefinition(REPLY_ORDER)).toEqual([]);
    for (const params of [
      { playbooks: ["lookup", "approve"] }, { allowedTrust: ["nobody"] }, { minAskConfidence: 1.2 }, { concurrent: 0 },
      { timeoutMs: 1_000 }, { maxRepos: 5 }, { perRequesterDaily: -1 }, { extra: true },
    ]) expect(validateStandingOrderDefinition(withParams(LOOKUP_ORDER, params)), JSON.stringify(params)).not.toEqual([]);
    for (const params of [
      { autoReply: { lookup: true } }, { autoReply: { lookup: true, review: false, other: true } }, { threshold: -0.1 },
      { calibrationMinSamples: 0 }, { revokeWindowMs: 1_000 }, { maxResultAgeMs: 59_999 },
    ]) expect(validateStandingOrderDefinition(withParams(REPLY_ORDER, params)), JSON.stringify(params)).not.toEqual([]);
  });

  it("loosening the lookup gate needs the user's approval; tightening is conservative", () => {
    // 重新开放一个剧本。
    expect(classify(withParams(LOOKUP_ORDER, { playbooks: ["lookup"] }), { playbooks: ["lookup", "review"] }).tier).toBe("permissive");
    expect(tier(LOOKUP_ORDER, { allowedTrust: ["trusted", "colleague", "external"] })).toBe("permissive");
    expect(tier(LOOKUP_ORDER, { minAskConfidence: 0.4 })).toBe("permissive");
    expect(tier(LOOKUP_ORDER, { maxSensitiveQuery: 0.6 })).toBe("permissive");
    expect(tier(LOOKUP_ORDER, { perRequesterDaily: 20 })).toBe("permissive");
    expect(tier(LOOKUP_ORDER, { dailyMax: 100 })).toBe("permissive");
    expect(tier(LOOKUP_ORDER, { concurrent: 3 })).toBe("permissive");
    expect(tier(LOOKUP_ORDER, { timeoutMs: 30 * 60_000 })).toBe("permissive");
    expect(tier(LOOKUP_ORDER, { maxRepos: 3 })).toBe("permissive");
    expect(tier(LOOKUP_ORDER, { source: "other" })).toBe("permissive");

    expect(tier(LOOKUP_ORDER, { playbooks: ["lookup"] })).toBe("conservative");
    expect(tier(LOOKUP_ORDER, { allowedTrust: ["trusted"] })).toBe("conservative");
    expect(tier(LOOKUP_ORDER, {
      minAskConfidence: 0.7, maxSensitiveQuery: 0.3, perRequesterDaily: 5, dailyMax: 20, concurrent: 1, timeoutMs: 10 * 60_000, maxRepos: 1,
    })).toBe("conservative");
  });

  it("refuses to look anything up for customers", () => {
    expect(classify(LOOKUP_ORDER, { allowedTrust: ["colleague", "customer"] })).toMatchObject({
      tier: "forbidden", findings: [{ hardRule: "customers_never_looked_up" }],
    });
  });

  it("opening auto replies or lowering a reply bar needs the user's approval; the reverse is conservative", () => {
    expect(tier(REPLY_ORDER, { autoReply: { lookup: true, review: true } })).toBe("permissive");
    expect(tier(REPLY_ORDER, { threshold: 0.8 })).toBe("permissive");
    expect(tier(REPLY_ORDER, { coldStartMin: 0.85 })).toBe("permissive");
    expect(tier(REPLY_ORDER, { calibrationMinSamples: 10 })).toBe("permissive");
    expect(tier(REPLY_ORDER, { calibrationMinAgreement: 0.8 })).toBe("permissive");
    expect(tier(REPLY_ORDER, { maxSensitivity: 0.3 })).toBe("permissive");
    expect(tier(REPLY_ORDER, { maxResultAgeMs: 60 * 60_000 })).toBe("permissive");
    expect(tier(REPLY_ORDER, { revokeWindowMs: 5 * 60_000 })).toBe("permissive");

    expect(tier(REPLY_ORDER, { autoReply: { lookup: false, review: false } })).toBe("conservative");
    expect(tier(REPLY_ORDER, {
      threshold: 0.9, coldStartMin: 0.95, calibrationMinSamples: 30, calibrationMinAgreement: 0.95, maxSensitivity: 0.1,
      maxResultAgeMs: 15 * 60_000, revokeWindowMs: 20 * 60_000,
    })).toBe("conservative");
    // 一放一收：有一项更放开就要批准。
    expect(tier(REPLY_ORDER, { autoReply: { lookup: false, review: true } })).toBe("permissive");
  });
});
